/**
 * gpower_core.js
 * Shared rate logic and data fetching for Georgia Power Overnight Advantage analysis.
 * Used by both gpower_cli.js and gpower_server.js.
 */

import { SouthernCompanyAPI } from 'southern-company-api';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// BASE RATES  (TOU-OA-14, effective January 2025)
// Source: georgiapower.com/…/tariffs/2025/tou-oa-14.pdf
// ─────────────────────────────────────────────────────────────────────────────
export const BASE_RATES = {
  SUPER_OFF_PEAK : 0.021859,   // $/kWh — 11pm–7am, every day, all months
  OFF_PEAK       : 0.101676,   // $/kWh — all non-Super-Off-Peak, non-On-Peak hours
  ON_PEAK        : 0.297868,   // $/kWh — 2pm–7pm Mon–Fri, June–Sept, excl. holidays
  BASIC_SERVICE  : 0.4603,     // $/day — fixed daily meter/service charge
};

// ─────────────────────────────────────────────────────────────────────────────
// RIDER RATES — edit here when GP files updated tariffs with PSC
// ─────────────────────────────────────────────────────────────────────────────
export const RIDERS = {

  // ── Fuel Cost Recovery (TOU-FCR-6, Secondary Distribution, effective May 2024)
  // TOU-FCR has only two tiers; Super Off-Peak kWh use the Off-Peak fuel rate.
  // NOTE: GP filed Feb 2026 (Docket 56765) to lower fuel rates starting summer 2026.
  //       Update ON_PEAK and OFF_PEAK when the new TOU-FCR tariff is published.
  FCR: {
    ON_PEAK  : 0.066871,   // $/kWh  (6.6871¢)
    OFF_PEAK : 0.042398,   // $/kWh  (4.2398¢) — also used for Super Off-Peak
  },

  // ── Environmental Compliance Cost Recovery (ECCR-11, effective August 2023)
  // 16.2813% of (base bill + FCR)
  ECCR: {
    RATE: 0.162813,
  },

  // ── Demand Side Management Residential (DSM-R-15, effective January 2025)
  // 1.2165% of (base bill + FCR) — updated annually each January
  DSM_R: {
    RATE: 0.012165,
  },

  // ── Municipal Franchise Fee (MFF-10, effective January 2024)
  // Applied to (base bill + FCR + ECCR + DSM-R). Updated annually each November.
  // Roswell GA is incorporated → INSIDE_CITY applies.
  MFF: {
    INSIDE_CITY  : 0.030701,   // 3.0701%
    OUTSIDE_CITY : 0.011852,   // 1.1852%
  },
};

// ─── Holiday Logic ────────────────────────────────────────────────────────────

function getLaborDay(year) {
  const sep1   = new Date(year, 8, 1);
  const dow    = sep1.getDay();
  const offset = dow === 1 ? 0 : (8 - dow) % 7;
  return new Date(year, 8, 1 + offset);
}

export function isOaHoliday(date) {
  if (date.getMonth() === 6 && date.getDate() === 4) return true;
  const ld = getLaborDay(date.getFullYear());
  return date.getMonth() === ld.getMonth() && date.getDate() === ld.getDate();
}

// ─── Hour Classification ──────────────────────────────────────────────────────

export function classifyHour(date, hour) {
  if (hour >= 23 || hour < 7) return 'SUPER_OFF_PEAK';
  const month     = date.getMonth();
  const weekday   = date.getDay();
  const isSummer  = month >= 5 && month <= 8;
  const isWeekday = weekday >= 1 && weekday <= 5;
  if (isSummer && isWeekday && !isOaHoliday(date) && hour >= 14 && hour < 19) return 'ON_PEAK';
  return 'OFF_PEAK';
}

// ─── Cost Calculation ─────────────────────────────────────────────────────────

export function calculateDayCost(kWhSuperOffPeak, kWhOffPeak, kWhOnPeak, cityLimits = 'inside') {
  const baseEnergy = (kWhSuperOffPeak * BASE_RATES.SUPER_OFF_PEAK)
                   + (kWhOffPeak      * BASE_RATES.OFF_PEAK)
                   + (kWhOnPeak       * BASE_RATES.ON_PEAK);
  const basicSvc   = BASE_RATES.BASIC_SERVICE;
  const baseBill   = baseEnergy + basicSvc;

  const fcrCharge  = (kWhOnPeak                        * RIDERS.FCR.ON_PEAK)
                   + ((kWhOffPeak + kWhSuperOffPeak)    * RIDERS.FCR.OFF_PEAK);

  const prePctBase = baseBill + fcrCharge;
  const eccrCharge = prePctBase * RIDERS.ECCR.RATE;
  const dsmrCharge = prePctBase * RIDERS.DSM_R.RATE;

  const preMff     = prePctBase + eccrCharge + dsmrCharge;
  const mffRate    = cityLimits === 'outside' ? RIDERS.MFF.OUTSIDE_CITY : RIDERS.MFF.INSIDE_CITY;
  const mffCharge  = preMff * mffRate;

  return {
    baseEnergy,
    basicSvc,
    baseBill,
    fcrCharge,
    eccrCharge,
    dsmrCharge,
    mffCharge,
    totalEstimated: preMff + mffCharge,
  };
}

// ─── Data Fetching + Processing ───────────────────────────────────────────────

// Format a Date as MM/DD/YYYY zero-padded — required by GP's hourly API
function fmtDate(d) {
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// Fetch hourly data directly from the GP API for one account.
// URL format confirmed via browser DevTools:
//   ?OPCO=GPC&StartDate=MM/DD/YYYY&EndDate=MM/DD/YYYY&intervalBehavior=Automatic&ServicePointNumber=XXXXX
// Response shape: { Data: { Data: '{"xAxis":…,"series":{"usage":{"data":[{"x":0,"y":kWh,"name":"ISO timestamp"},...]},...}}' } }
async function fetchHourlyForAccount(jwt, accountNumber, servicePointNumber, startDate, endDate) {
  const base   = `https://customerservice2api.southerncompany.com/api/MyPowerUsage/MPUData/${accountNumber}/Hourly`;
  // The GP API returns null when StartDate === EndDate (single-day requests always fail).
  // Fix: always request StartDate to StartDate+1. The response returns only StartDate's hours
  // (24 records). We then filter to only keep records matching the target date string.
  const nextDay = new Date(startDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const url = `${base}?OPCO=GPC&StartDate=${fmtDate(startDate)}&EndDate=${fmtDate(nextDay)}&intervalBehavior=Automatic&ServicePointNumber=${servicePointNumber}`;

  const response = await fetch(url, {
    headers: { Authorization: `bearer ${jwt}` },
  });

  if (!response.ok) {
    throw new Error(`Hourly API error ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();

  if (!json?.Data?.Data) {
    throw new Error(`Hourly API returned no data. StatusCode=${json.StatusCode} Message=${json.Message}`);
  }

  // Inner payload is a JSON string; series.usage.data holds kWh readings
  // Each point: { x: <index>, y: <kWh>, name: "2026-03-23T00:00:00", resolution: "hourly" }
  const inner     = JSON.parse(json.Data.Data);
  const usageData = inner?.series?.usage?.data ?? [];

  const targetDate = fmtDate(startDate).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2'); // MM/DD/YYYY → YYYY-MM-DD

  return usageData.map(r => {
    // r.name is "2026-03-23T00:00:00" — NO timezone suffix.
    // NEVER pass this to new Date(): JS treats bare ISO strings as UTC,
    // then .getHours() returns UTC hour, shifting every tier assignment by
    // the local UTC offset (EDT = -4h, EST = -5h).
    // Fix: parse the hour directly from the string — it IS local time.
    const hour = parseInt(r.name.slice(11, 13), 10);   // chars 11-12 = HH
    const date = r.name.slice(0, 10);                   // chars 0-9  = YYYY-MM-DD
    return { date, hour, kWh: parseFloat(r.y) || 0 };
  }).filter(r => !isNaN(r.hour) && r.date === targetDate);
}

// Build an array of individual calendar dates between start and end (inclusive)
function eachDay(startDate, endDate) {
  const days = [];
  const d = new Date(startDate);
  d.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export async function fetchAndProcess({ username, password, account, cityLimits = 'inside', startDate, endDate }) {
  const config = { username, password };
  if (account) config.accounts = [account];

  const api = new SouthernCompanyAPI(config);
  const accounts = await api.login(config);   // returns Account[]

  const jwt = api.jwt;
  if (!jwt) throw new Error('Login succeeded but no JWT was returned.');

  // getAccounts() in v4 returns objects with servicePoints[].servicePointNumber
  const fullAccounts = await api.getAccounts();
  const results = [];

  // Filter to primary account only — avoids fetching irrelevant secondary accounts
  // and ensures the dashboard always shows the right one (Sandtrap).
  const targetAccounts = fullAccounts.filter(a => a.primary === 'Y');
  if (targetAccounts.length === 0) {
    console.warn('  No primary account found, falling back to all accounts.');
    targetAccounts.push(...fullAccounts);
  }
  console.log(`  Accounts to fetch: ${targetAccounts.map(a => a.name).join(', ')}`);

  for (const acct of targetAccounts) {
    const spn = acct.servicePoints?.[0]?.servicePointNumber
             ?? acct.servicePointNumber
             ?? '';

    if (!spn) {
      console.warn(`  Warning: no servicePointNumber found for account ${acct.number}, skipping.`);
      continue;
    }

    // The GP API silently truncates responses for multi-day requests.
    // The browser portal fetches one day at a time — we do the same.
    const days = eachDay(startDate, endDate);
    console.log(`  Fetching ${days.length} days of hourly data for account ${acct.number} (SP: ${spn})…`);

    let hourlyRecords = [];
    for (const day of days) {
      try {
        const records = await fetchHourlyForAccount(jwt, acct.number, spn, day, day);
        hourlyRecords = hourlyRecords.concat(records);
      } catch (e) {
        // A single day failing (e.g. data not yet available) shouldn't abort everything
        console.warn(`  Warning: could not fetch ${fmtDate(day)}: ${e.message}`);
      }
    }
    console.log(`  → ${hourlyRecords.length} hourly records total`);

    const byDay = {};
    for (const record of hourlyRecords) {
      // record.date is already a YYYY-MM-DD string, record.hour is the local hour integer
      // Both were parsed directly from the GP timestamp string to avoid UTC conversion.
      const hour = record.hour;
      const key  = record.date;                      // YYYY-MM-DD string
      // classifyHour needs a Date for weekday/month checks — construct one in local noon
      // to avoid any DST boundary flipping the date. Hour/minute don't matter here.
      const dt   = new Date(key + 'T12:00:00');
      const tier = classifyHour(dt, hour);
      const kwh  = record.kWh ?? 0;
      if (!byDay[key]) byDay[key] = { date: key, SUPER_OFF_PEAK: 0, OFF_PEAK: 0, ON_PEAK: 0 };
      byDay[key][tier] += kwh;
    }

    const dailyResults = Object.values(byDay)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => {
        const costs = calculateDayCost(d.SUPER_OFF_PEAK, d.OFF_PEAK, d.ON_PEAK, cityLimits);
        return {
          date            : d.date,
          kWhTotal        : +(d.SUPER_OFF_PEAK + d.OFF_PEAK + d.ON_PEAK).toFixed(3),
          kWhSuperOffPeak : +d.SUPER_OFF_PEAK.toFixed(3),
          kWhOffPeak      : +d.OFF_PEAK.toFixed(3),
          kWhOnPeak       : +d.ON_PEAK.toFixed(3),
          ...Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, +v.toFixed(4)])),
        };
      });

    results.push({ name: acct.name, accountNumber: acct.number, days: dailyResults });
  }

  return results;
}

// ─── Aggregate helper ─────────────────────────────────────────────────────────

// ─── Billing cycles ──────────────────────────────────────────────────────────
// Fetches billing period boundaries from getMonthlyData() and caches them
// in gpower_cache.json under a '_billingCycles' key.

export async function fetchBillingCycles(api, accountNumber, diskCache) {
  const cacheKey = '_billingCycles_' + accountNumber;

  // Re-use cached cycles if fetched today
  const cached = diskCache[cacheKey];
  const today  = new Date().toISOString().slice(0, 10);
  if (cached && cached._fetchedDate === today) {
    console.log(`  [billing cycles] Using cached cycles (${cached.cycles.length} periods)`);
    return cached.cycles;
  }

  try {
    console.log('  [billing cycles] Fetching from getMonthlyData()…');
    const monthlyData = await api.getMonthlyData();

    // getMonthlyData returns an array of arrays (one per account)
    // Each element has { startDate, endDate, kWh, cost }
    const accountData = monthlyData[0] ?? [];

    const cycles = accountData
      .filter(m => m.startDate && m.endDate)
      .map(m => ({
        // startDate/endDate are Date objects from the library
        startDate : m.startDate instanceof Date
          ? m.startDate.toISOString().slice(0, 10)
          : String(m.startDate).slice(0, 10),
        endDate   : m.endDate instanceof Date
          ? m.endDate.toISOString().slice(0, 10)
          : String(m.endDate).slice(0, 10),
      }))
      // Sort chronologically
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      // Label each cycle e.g. "Jan 2026"
      .map(c => ({
        ...c,
        label: new Date(c.startDate + 'T12:00:00')
          .toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      }));

    // Persist
    diskCache[cacheKey] = { _fetchedDate: today, cycles };
    console.log(`  [billing cycles] ${cycles.length} billing periods found`);
    return cycles;
  } catch (e) {
    console.warn(`  [billing cycles] Could not fetch: ${e.message}`);
    return [];
  }
}

export function sumDays(days) {
  return days.reduce((s, r) => ({
    kWh       : s.kWh        + r.kWhTotal,
    kWhSup    : s.kWhSup     + r.kWhSuperOffPeak,
    kWhOff    : s.kWhOff     + r.kWhOffPeak,
    kWhOn     : s.kWhOn      + r.kWhOnPeak,
    baseEnergy: s.baseEnergy + r.baseEnergy,
    basicSvc  : s.basicSvc   + r.basicSvc,
    fcr       : s.fcr        + r.fcrCharge,
    eccr      : s.eccr       + r.eccrCharge,
    dsmr      : s.dsmr       + r.dsmrCharge,
    mff       : s.mff        + r.mffCharge,
    total     : s.total      + r.totalEstimated,
  }), { kWh:0, kWhSup:0, kWhOff:0, kWhOn:0, baseEnergy:0, basicSvc:0, fcr:0, eccr:0, dsmr:0, mff:0, total:0 });
}

// ─── Disk cache ───────────────────────────────────────────────────────────────
// Persists processed daily results to gpower_cache.json so server restarts
// only fetch days not already stored. Re-fetches the last 2 days on every
// startup since GP data can arrive with up to 48h delay.

const DISK_CACHE_FILE = './gpower_cache.json';

export function loadDiskCache() {
  if (!existsSync(DISK_CACHE_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(DISK_CACHE_FILE, 'utf8'));
    console.log(`  [disk cache] Loaded ${Object.keys(raw).length} cached days from ${DISK_CACHE_FILE}`);
    return raw;   // { accountNumber: { 'YYYY-MM-DD': dailyResultObject, … } }
  } catch (e) {
    console.warn(`  [disk cache] Could not read cache file: ${e.message}`);
    return {};
  }
}

export function saveDiskCache(cacheByAccount) {
  try {
    writeFileSync(DISK_CACHE_FILE, JSON.stringify(cacheByAccount, null, 2));
  } catch (e) {
    console.warn(`  [disk cache] Could not write cache file: ${e.message}`);
  }
}

// Returns the ISO date string for N days ago
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function fetchAndProcessWithCache({ username, password, account, cityLimits = 'inside', startDate, endDate }) {
  // Load whatever we already have on disk
  const diskCache = loadDiskCache();

  const config = { username, password };
  if (account) config.accounts = [account];

  const api = new SouthernCompanyAPI(config);
  await api.login(config);
  const jwt = api.jwt;
  if (!jwt) throw new Error('Login succeeded but no JWT was returned.');

  const fullAccounts = await api.getAccounts();
  const targetAccounts = fullAccounts.filter(a => a.primary === 'Y');
  if (targetAccounts.length === 0) targetAccounts.push(...fullAccounts);
  console.log(`  Accounts to fetch: ${targetAccounts.map(a => a.name).join(', ')}`);

  const results = [];

  for (const acct of targetAccounts) {
    const spn = acct.servicePoints?.[0]?.servicePointNumber ?? acct.servicePointNumber ?? '';
    if (!spn) { console.warn(`  No SPN for ${acct.number}, skipping.`); continue; }

    const accountKey  = String(acct.number);
    const cachedDays  = diskCache[accountKey] ?? {};

    // Always re-fetch the last 2 days — GP data can arrive late
    const refetchCutoff = daysAgo(2);

    const allDays    = eachDay(startDate, endDate);
    const toFetch    = allDays.filter(d => {
      const key = d.toISOString().slice(0, 10);
      return !(key in cachedDays) || key >= refetchCutoff;
    });

    console.log(`  ${acct.name}: ${Object.keys(cachedDays).length} days cached, fetching ${toFetch.length} new/recent days…`);

    // Fetch missing + recent days
    for (const day of toFetch) {
      try {
        const records = await fetchHourlyForAccount(jwt, acct.number, spn, day, day);
        if (records.length === 0) continue;

        // Aggregate into a daily result and store in cache
        const byHour = { date: day.toISOString().slice(0,10), SUPER_OFF_PEAK: 0, OFF_PEAK: 0, ON_PEAK: 0 };
        for (const r of records) {
          const dt   = new Date(r.date + 'T12:00:00');
          const tier = classifyHour(dt, r.hour);
          byHour[tier] += r.kWh ?? 0;
        }
        const costs = calculateDayCost(byHour.SUPER_OFF_PEAK, byHour.OFF_PEAK, byHour.ON_PEAK, cityLimits);
        cachedDays[byHour.date] = {
          date            : byHour.date,
          kWhTotal        : +(byHour.SUPER_OFF_PEAK + byHour.OFF_PEAK + byHour.ON_PEAK).toFixed(3),
          kWhSuperOffPeak : +byHour.SUPER_OFF_PEAK.toFixed(3),
          kWhOffPeak      : +byHour.OFF_PEAK.toFixed(3),
          kWhOnPeak       : +byHour.ON_PEAK.toFixed(3),
          ...Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, +v.toFixed(4)])),
        };
      } catch (e) {
        console.warn(`  Warning: could not fetch ${fmtDate(day)}: ${e.message}`);
      }
    }

    // Persist updated cache to disk
    diskCache[accountKey] = cachedDays;
    saveDiskCache(diskCache);

    // Build final sorted results from cache, filtered to requested date range
    const startKey = startDate.toISOString().slice(0, 10);
    const endKey   = endDate.toISOString().slice(0, 10);
    const dailyResults = Object.values(cachedDays)
      .filter(d => d.date >= startKey && d.date <= endKey)
      .sort((a, b) => a.date.localeCompare(b.date));

    console.log(`  → ${dailyResults.length} days total in results`);

    // Fetch billing cycles (uses monthly data — different endpoint, fast)
    const billingCycles = await fetchBillingCycles(api, acct.number, diskCache);
    saveDiskCache(diskCache);  // persist billing cycles too

    results.push({ name: acct.name, accountNumber: acct.number, days: dailyResults, billingCycles });
  }

  return results;
}
