/**
 * ecobee_core.js
 * Parses Ecobee CSV runtime exports and estimates HVAC energy consumption.
 * Integrates with the existing GP dashboard data pipeline.
 *
 * HOW TO USE:
 *   1. In ecobee.com → My Reports → download runtime CSV for each thermostat
 *   2. Drop the CSV files in your GPwr folder (any filename ending in .csv works)
 *   3. Configure your system specs in .env (see .env.example)
 *   4. Restart the server — HVAC data appears automatically in the dashboard
 *
 * HVAC kWh ESTIMATION METHOD:
 *   Cooling kWh = (compressor runtime seconds / 3600) × compressor kW
 *   Fan kWh     = (fan runtime seconds / 3600) × blower kW
 *   Heat kWh    = 0  (gas furnace — no electric heating load)
 *
 *   Compressor kW = (tons × 12000 BTU/hr) / (SEER × EER_RATIO × 1000)
 *   EER_RATIO = 0.875  (industry standard seasonal→peak correction)
 *
 * CALIBRATION:
 *   After a few weeks of summer data, compare estimated HVAC kWh against your
 *   GP totals. If HVAC + baseline doesn't track well, adjust ECOBEE_CAL_FACTOR
 *   in .env (e.g. 1.1 to increase estimates by 10%).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// ─── System Configuration ────────────────────────────────────────────────────
// These come from .env — see .env.example for documentation

export function getSystemConfig() {
  return {
    // Thermostat 1 (e.g. Upstairs)
    therm1: {
      name   : process.env.ECOBEE_THERM1_NAME   ?? 'Upstairs',
      tons   : parseFloat(process.env.ECOBEE_THERM1_TONS   ?? '2.0'),
      seer   : parseFloat(process.env.ECOBEE_THERM1_SEER   ?? '14.3'),
      csvFile: process.env.ECOBEE_THERM1_CSV    ?? null,  // filename in GPwr folder
    },
    // Thermostat 2 (e.g. Main Floor)
    therm2: {
      name   : process.env.ECOBEE_THERM2_NAME   ?? 'Main Floor',
      tons   : parseFloat(process.env.ECOBEE_THERM2_TONS   ?? '3.0'),
      seer   : parseFloat(process.env.ECOBEE_THERM2_SEER   ?? '14.3'),
      csvFile: process.env.ECOBEE_THERM2_CSV    ?? null,
    },
    // Shared settings
    blowerKw    : parseFloat(process.env.ECOBEE_BLOWER_KW   ?? '0.65'),  // ECM blower draw
    eerRatio    : parseFloat(process.env.ECOBEE_EER_RATIO    ?? '0.875'), // SEER→EER correction
    calFactor   : parseFloat(process.env.ECOBEE_CAL_FACTOR   ?? '1.0'),  // calibration multiplier
    csvDir      : process.env.ECOBEE_CSV_DIR    ?? '.',                   // folder containing CSVs
  };
}

// ─── kW draw calculations ─────────────────────────────────────────────────────

export function compressorKw(tons, seer, eerRatio = 0.875) {
  return (tons * 12000) / (seer * eerRatio * 1000);
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse an Ecobee runtime CSV export.
 * Returns array of interval objects with date, time, runtime seconds, temps, setpoints.
 */
export function parseEcobeeCSV(filePath) {
  const raw   = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  // Extract metadata from comment lines
  const meta = {};
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    const parts = line.split(',');
    if (parts.length >= 4) meta[parts[2].trim()] = parts[3].trim();
  }

  // Find data lines (skip # comments and blank lines)
  const dataLines = lines.filter(l => l.trim() && !l.startsWith('#'));
  if (dataLines.length < 2) return { meta, intervals: [] };

  // Parse CSV with header row
  const headers = dataLines[0].split(',').map(h => h.trim());

  const intervals = [];
  for (let i = 1; i < dataLines.length; i++) {
    const vals = dataLines[i].split(',');
    if (vals.length < 3) continue;

    const row = {};
    headers.forEach((h, idx) => { if (h) row[h] = vals[idx]?.trim() ?? ''; });

    const date = row['Date'];
    const time = row['Time'];
    if (!date || !time) continue;

    // Parse hour from time string "HH:MM:SS" — local thermostat time, no conversion needed
    const hour = parseInt(time.slice(0, 2), 10);

    intervals.push({
      date,
      time,
      hour,
      systemSetting : row['System Setting'] ?? '',
      systemMode    : row['System Mode']    ?? '',
      programMode   : row['Program Mode']   ?? '',
      calendarEvent : row['Calendar Event'] ?? '',
      coolSetF      : parseFloat(row['Cool Set Temp (F)'] || 0),
      heatSetF      : parseFloat(row['Heat Set Temp (F)'] || 0),
      indoorTempF   : parseFloat(row['Current Temp (F)']  || 0),
      outdoorTempF  : parseFloat(row['Outdoor Temp (F)']  || 0),
      // Runtime in seconds (0–300 per 5-min interval)
      coolSec       : parseFloat(row['Cool Stage 1 (sec)'] || 0),
      heatSec       : parseFloat(row['Heat Stage 1 (sec)'] || 0)
                    + parseFloat(row['Heat Stage 2 (sec)'] || 0),  // aux heat
      fanSec        : parseFloat(row['Fan (sec)']          || 0),
    });
  }

  return { meta, intervals };
}

// ─── HVAC kWh Aggregation ────────────────────────────────────────────────────

/**
 * Given parsed intervals + system spec, compute per-hour and per-day HVAC kWh.
 * Returns { byHour, byDay } where keys are 'YYYY-MM-DD' and 'YYYY-MM-DD-HH'.
 */
export function aggregateHvacKwh(intervals, tons, seer, blowerKw, eerRatio, calFactor) {
  const ckw = compressorKw(tons, seer, eerRatio) * calFactor;
  const fkw = blowerKw * calFactor;

  const byHour = {};  // key: 'YYYY-MM-DD|HH'
  const byDay  = {};  // key: 'YYYY-MM-DD'

  for (const iv of intervals) {
    const coolKwh = (iv.coolSec / 3600) * ckw;
    const fanKwh  = (iv.fanSec  / 3600) * fkw;
    // Gas heat: furnace draws no significant electric (only blower, already in fanKwh)
    const totalKwh = coolKwh + fanKwh;

    const hourKey = `${iv.date}|${String(iv.hour).padStart(2,'0')}`;
    if (!byHour[hourKey]) byHour[hourKey] = { date: iv.date, hour: iv.hour, coolKwh: 0, fanKwh: 0, totalKwh: 0, coolSec: 0, heatSec: 0, fanSec: 0, outdoorTempF: iv.outdoorTempF, indoorTempF: iv.indoorTempF };
    byHour[hourKey].coolKwh  += coolKwh;
    byHour[hourKey].fanKwh   += fanKwh;
    byHour[hourKey].totalKwh += totalKwh;
    byHour[hourKey].coolSec  += iv.coolSec;
    byHour[hourKey].heatSec  += iv.heatSec;
    byHour[hourKey].fanSec   += iv.fanSec;

    if (!byDay[iv.date]) byDay[iv.date] = {
      date: iv.date, coolKwh: 0, fanKwh: 0, totalKwh: 0,
      coolMin: 0, heatMin: 0, fanMin: 0,
      peakCoolKwh: 0, offPeakCoolKwh: 0, supOffPeakCoolKwh: 0,
    };
    byDay[iv.date].coolKwh  += coolKwh;
    byDay[iv.date].fanKwh   += fanKwh;
    byDay[iv.date].totalKwh += totalKwh;
    byDay[iv.date].coolMin  += iv.coolSec / 60;
    byDay[iv.date].heatMin  += iv.heatSec / 60;
    byDay[iv.date].fanMin   += iv.fanSec  / 60;

    // Rate tier allocation (mirrors gpower_core.js classifyHour logic)
    const dateObj = new Date(iv.date + 'T12:00:00');
    const month   = dateObj.getMonth();   // 0-indexed
    const weekday = dateObj.getDay();
    const isSummer  = month >= 5 && month <= 8;
    const isWeekday = weekday >= 1 && weekday <= 5;
    const isHoliday = isOaHoliday(dateObj);
    const isOnPeak  = isSummer && isWeekday && !isHoliday && iv.hour >= 14 && iv.hour < 19;
    const isSupOff  = iv.hour >= 23 || iv.hour < 7;

    if (isOnPeak)       byDay[iv.date].peakCoolKwh    += totalKwh;
    else if (isSupOff)  byDay[iv.date].supOffPeakCoolKwh += totalKwh;
    else                byDay[iv.date].offPeakCoolKwh  += totalKwh;
  }

  return { byHour, byDay };
}

// Replicate holiday logic from gpower_core (can't import across modules easily)
function getLaborDay(year) {
  const sep1 = new Date(year, 8, 1);
  const dow  = sep1.getDay();
  return new Date(year, 8, 1 + (dow === 1 ? 0 : (8 - dow) % 7));
}
function isOaHoliday(date) {
  if (date.getMonth() === 6 && date.getDate() === 4) return true;
  const ld = getLaborDay(date.getFullYear());
  return date.getMonth() === ld.getMonth() && date.getDate() === ld.getDate();
}

// ─── Auto-detect CSV files ───────────────────────────────────────────────────

/**
 * Scan csvDir for Ecobee CSV files. Returns array of { path, thermostatId, name }.
 * Matches files with ecobee-style names: report-XXXXXXXXXXXX-YYYY-MM-DD-to-YYYY-MM-DD.csv
 */
export function findEcobeeCSVs(csvDir = '.') {
  if (!existsSync(csvDir)) return [];
  const files = readdirSync(csvDir).filter(f => f.match(/report-\d+-\d{4}-\d{2}-\d{2}.*\.csv$/i));
  return files.map(f => {
    const match = f.match(/report-(\d+)-/);
    return { path: join(csvDir, f), thermostatId: match?.[1] ?? 'unknown', filename: f };
  });
}

// ─── Main loader ─────────────────────────────────────────────────────────────

/**
 * Load all configured Ecobee CSVs and return merged daily HVAC data.
 * Returns { byDay: { 'YYYY-MM-DD': { totalKwh, coolKwh, fanKwh, ... } }, thermostats: [...] }
 */
export function loadEcobeeData(csvDir = '.') {
  const cfg    = getSystemConfig();
  const result = { byDay: {}, thermostats: [] };

  const thermConfigs = [
    { ...cfg.therm1, csvFile: cfg.therm1.csvFile },
    { ...cfg.therm2, csvFile: cfg.therm2.csvFile },
  ];

  // Find all ecobee CSVs in the folder
  const autoCSVs = findEcobeeCSVs(csvDir);

  for (const therm of thermConfigs) {
    // Collect ALL CSV paths for this thermostat (may span multiple months)
    let csvPaths = [];

    // Explicit file configured in .env — just use that one
    if (therm.csvFile) {
      const explicit = join(csvDir, therm.csvFile);
      if (existsSync(explicit)) csvPaths = [explicit];
    }

    // Auto-detect: match ALL CSVs whose metadata name matches this thermostat
    if (csvPaths.length === 0 && autoCSVs.length > 0) {
      for (const csv of autoCSVs) {
        try {
          const { meta } = parseEcobeeCSV(csv.path);
          if (meta.name?.toLowerCase() === therm.name.toLowerCase()) {
            csvPaths.push(csv.path);
          }
        } catch(e) { /* skip unreadable files */ }
      }
    }

    // Last resort: assign remaining unmatched CSVs by position
    if (csvPaths.length === 0) {
      const usedPaths = new Set(result.thermostats.flatMap(t => t.csvPaths ?? []));
      const unused    = autoCSVs.filter(c => !usedPaths.has(c.path));
      if (unused.length > 0) csvPaths = [unused[0].path];
    }

    if (csvPaths.length === 0) {
      console.log(`  [ecobee] No CSV found for ${therm.name} — skipping`);
      continue;
    }

    // Load and merge ALL CSVs for this thermostat
    console.log(`  [ecobee] Loading ${therm.name}: ${csvPaths.map(p => basename(p)).join(', ')}`);
    let allIntervals = [];
    let lastMeta     = {};
    for (const csvPath of csvPaths) {
      try {
        const { meta, intervals } = parseEcobeeCSV(csvPath);
        allIntervals = allIntervals.concat(intervals);
        lastMeta     = meta;
      } catch(e) {
        console.warn(`  [ecobee] Could not parse ${basename(csvPath)}: ${e.message}`);
      }
    }

    const { byDay } = aggregateHvacKwh(
      allIntervals, therm.tons, therm.seer,
      cfg.blowerKw, cfg.eerRatio, cfg.calFactor
    );

    result.thermostats.push({
      name     : lastMeta.name ?? therm.name,
      id       : lastMeta.identifier ?? 'unknown',
      tons     : therm.tons,
      seer     : therm.seer,
      compKw   : +compressorKw(therm.tons, therm.seer, cfg.eerRatio).toFixed(3),
      csvPaths,
      csvPath  : csvPaths[csvPaths.length - 1],   // most recent for backwards compat
      dayCount : Object.keys(byDay).length,
    });

    // Merge into combined byDay (sum both thermostats)
    for (const [date, d] of Object.entries(byDay)) {
      if (!result.byDay[date]) {
        result.byDay[date] = {
          date, totalKwh: 0, coolKwh: 0, fanKwh: 0,
          coolMin: 0, heatMin: 0, fanMin: 0,
          peakCoolKwh: 0, offPeakCoolKwh: 0, supOffPeakCoolKwh: 0,
        };
      }
      result.byDay[date].totalKwh          += d.totalKwh;
      result.byDay[date].coolKwh           += d.coolKwh;
      result.byDay[date].fanKwh            += d.fanKwh;
      result.byDay[date].coolMin           += d.coolMin;
      result.byDay[date].heatMin           += d.heatMin;
      result.byDay[date].fanMin            += d.fanMin;
      result.byDay[date].peakCoolKwh       += d.peakCoolKwh;
      result.byDay[date].offPeakCoolKwh    += d.offPeakCoolKwh;
      result.byDay[date].supOffPeakCoolKwh += d.supOffPeakCoolKwh;
    }
  }

  // Round all values
  for (const d of Object.values(result.byDay)) {
    for (const k of ['totalKwh','coolKwh','fanKwh','peakCoolKwh','offPeakCoolKwh','supOffPeakCoolKwh']) {
      d[k] = +d[k].toFixed(3);
    }
    for (const k of ['coolMin','heatMin','fanMin']) {
      d[k] = +d[k].toFixed(1);
    }
  }

  console.log(`  [ecobee] Loaded ${Object.keys(result.byDay).length} days across ${result.thermostats.length} thermostat(s)`);
  return result;
}