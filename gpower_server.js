/**
 * gpower_server.js  —  Local web dashboard
 *
 * Serves a live dashboard at http://localhost:3000
 * Data is fetched fresh from Georgia Power on each page load (or on demand).
 *
 * Usage:
 *   npm install southern-company-api express
 *   GP_USERNAME=you@email.com  GP_PASSWORD=pass  node gpower_server.js
 *
 * Env vars:
 *   GP_USERNAME   (required)
 *   GP_PASSWORD   (required)
 *   GP_ACCOUNT    (optional)
 *   CITY_LIMITS   inside | outside   (default: inside)
 *   PORT          (default: 3000)
 */

import express        from 'express';
import multer         from 'multer';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { loadEcobeeData, parseEcobeeCSV, aggregateHvacKwh, compressorKw, getSystemConfig } from './ecobee_core.js';
import { fetchAndProcessWithCache, sumDays, BASE_RATES, RIDERS } from './gpower_core.js';
import { fetchEmporiaEV } from './emporia_core.js';

const USERNAME    = process.env.GP_USERNAME  ?? (() => { throw new Error('GP_USERNAME is not set. Copy .env.example to .env and fill in your credentials.'); })();
const PASSWORD    = process.env.GP_PASSWORD  ?? (() => { throw new Error('GP_PASSWORD is not set. Copy .env.example to .env and fill in your credentials.'); })();
const ACCOUNT     = process.env.GP_ACCOUNT;
const CITY_LIMITS = (process.env.CITY_LIMITS ?? 'inside').toLowerCase();
const PORT            = parseInt(process.env.PORT ?? '3000');
const START_DATE      = new Date(2026, 1, 28);
const EMPORIA_ENABLED = !!(process.env.EMPORIA_USERNAME && process.env.EMPORIA_PASSWORD);

// ─── In-memory cache (avoids hammering GP's API on every browser refresh) ────
let cache = null;
let evCache = null;   // { 'YYYY-MM-DD': kWh } from Emporia
let cacheTime = null;
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 minutes

async function getData() {
  const now = Date.now();
  if (cache && cacheTime && (now - cacheTime) < CACHE_TTL_MS) {
    return { accounts: cache, evByDay: evCache ?? {} };
  }
  console.log('[cache miss] Fetching from Georgia Power…');
  const dateRange = { startDate: START_DATE, endDate: new Date() };
  const [accounts, evByDay] = await Promise.all([
    fetchAndProcessWithCache({
      username: USERNAME, password: PASSWORD,
      account: ACCOUNT, cityLimits: CITY_LIMITS,
      ...dateRange,
    }),
    EMPORIA_ENABLED
      ? fetchEmporiaEV(dateRange).catch(e => { console.warn('[emporia]', e.message); return {}; })
      : Promise.resolve({}),
  ]);
  cache    = accounts;
  evCache  = evByDay;
  cacheTime = now;
  console.log('[cache] Data refreshed.' + (EMPORIA_ENABLED ? ` Emporia: ${Object.keys(evByDay).length} days.` : ''));
  return { accounts, evByDay };
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// JSON API endpoint — used by the dashboard via fetch()
app.get('/api/data', async (req, res) => {
  try {
    if (req.query.refresh === '1') { cache = null; evCache = null; }
    const { accounts, evByDay } = await getData();
    res.json({ ok: true, accounts, evByDay, emporiaEnabled: EMPORIA_ENABLED, rates: { BASE_RATES, RIDERS }, cityLimits: CITY_LIMITS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Force-refresh endpoint
app.post('/api/refresh', async (req, res) => {
  cache = null; evCache = null;
  try {
    await getData();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Multer: save uploaded Ecobee CSVs directly to the project folder ─────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, '.'),
    filename   : (req, file, cb) => cb(null, file.originalname),
  }),
  fileFilter: (req, file, cb) => {
    // Only accept CSV files with ecobee-style names
    const ok = file.originalname.match(/report-\d+.*\.csv$/i);
    cb(null, !!ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 },  // 20 MB max per file
});

// ── Ecobee data endpoint ──────────────────────────────────────────────────────
let ecobeeCache = null;

function rebuildEcobeeCache() {
  ecobeeCache = loadEcobeeData('.');
}

app.get('/api/ecobee', (req, res) => {
  try {
    if (!ecobeeCache || req.query.refresh === '1') rebuildEcobeeCache();
    res.json({ ok: true, ...ecobeeCache });
  } catch (err) {
    console.error('[ecobee]', err.message);
    res.json({ ok: false, error: err.message, byDay: {}, thermostats: [] });
  }
});

// ── Ecobee CSV import endpoint ────────────────────────────────────────────────
// Accepts one or more CSV files via multipart upload, saves to project folder,
// re-processes all ecobee data, returns updated summary.
app.post('/api/ecobee/import', upload.array('files', 10), (req, res) => {
  try {
    const saved = (req.files ?? []).map(f => f.originalname);
    if (saved.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid Ecobee CSV files received. File names must match: report-XXXXXXXXXX-YYYY-MM-DD-to-YYYY-MM-DD.csv' });
    }

    // Validate each file is actually an ecobee CSV before accepting
    const validated = [];
    for (const file of req.files) {
      try {
        const { meta, intervals } = parseEcobeeCSV(file.path);
        if (!meta.identifier || intervals.length === 0) {
          return res.status(400).json({ ok: false, error: file.originalname + ' does not appear to be a valid Ecobee runtime report.' });
        }
        validated.push({ filename: file.originalname, thermostatName: meta.name ?? 'Unknown', identifier: meta.identifier, intervals: intervals.length });
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Could not parse ' + file.originalname + ': ' + e.message });
      }
    }

    // Re-build the full ecobee dataset from all CSVs now in the folder
    rebuildEcobeeCache();
    console.log('[ecobee] Imported:', saved.join(', '));

    res.json({
      ok       : true,
      imported : validated,
      summary  : {
        totalDays      : Object.keys(ecobeeCache.byDay).length,
        thermostats    : ecobeeCache.thermostats.map(t => t.name + ' (' + t.dayCount + ' days)'),
      },
      ...ecobeeCache,
    });
  } catch (err) {
    console.error('[ecobee import]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Main dashboard page
app.get('/', (req, res) => {
  res.send(getDashboardHTML());
});

app.listen(PORT, () => {
  console.log(`\n🔌 Georgia Power Dashboard running at http://localhost:${PORT}`);
  console.log(`   City limits : ${CITY_LIMITS}`);
  console.log(`   Data period : ${START_DATE.toDateString()} → today`);
  console.log(`   Cache TTL   : 30 min\n`);
});

// ─── Dashboard HTML (single-file, no build step needed) ──────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Georgia Power — Energy Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap');

  :root {
    --bg:       #0d1117;
    --surface:  #161b22;
    --border:   #21262d;
    --text:     #e6edf3;
    --muted:    #7d8590;
    --sup:      #58a6ff;   /* super off-peak — cool blue */
    --off:      #3fb950;   /* off-peak — green */
    --on:       #f85149;   /* on-peak — red */
    --total:    #d29922;   /* cost — amber */
    --ev:       #bc8cff;   /* EV charger — purple */
    --accent:   #58a6ff;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }

  /* ── Layout ── */
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header h1 {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--accent);
  }
  header .meta { font-size: 12px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }

  .refresh-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    transition: all .15s;
  }
  .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
  .refresh-btn:disabled { opacity: .4; cursor: default; }

  main { max-width: 1400px; margin: 0 auto; padding: 24px; }

  /* ── Loading / Error ── */
  #loading {
    display: flex; align-items: center; justify-content: center;
    height: 60vh; flex-direction: column; gap: 16px;
    font-family: 'IBM Plex Mono', monospace; color: var(--muted);
  }
  .spinner {
    width: 32px; height: 32px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── KPI cards ── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .kpi .label {
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .kpi .value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 22px;
    font-weight: 600;
  }
  .kpi .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .kpi.sup   .value { color: var(--sup); }
  .kpi.off   .value { color: var(--off); }
  .kpi.on    .value { color: var(--on);  }
  .kpi.total .value { color: var(--total); }
  .kpi.ev    .value { color: var(--ev); }
  .kpi.avg   .value { color: var(--muted); font-size: 18px; }
  .kpi-avg-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .kpi-avg-grid .kpi { border-style: dashed; }
  .kpi-avg-label {
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 10px;
  }

  /* ── Window tabs ── */
  .window-tabs {
    display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap;
  }
  .tab {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    transition: all .15s;
  }
  .tab:hover { border-color: var(--accent); color: var(--accent); }
  .tab.active { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }

  /* ── Tab mode toggle ── */
  .tab-mode-toggle {
    display: flex; gap: 0; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; width: fit-content;
  }
  .mode-btn {
    padding: 5px 14px; background: transparent; border: none;
    color: var(--muted); cursor: pointer;
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    transition: all .15s; border-right: 1px solid var(--border);
  }
  .mode-btn:last-child { border-right: none; }
  .mode-btn.active { background: var(--surface); color: var(--accent); font-weight: 600; }
  .mode-btn:hover:not(.active) { color: var(--text); }

  /* ── Charts section ── */
  .charts-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 24px;
  }
  @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }

  .chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .chart-card h2 {
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .chart-card canvas { max-height: 260px; }

  /* ── Cost breakdown section ── */
  .breakdown-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .breakdown-card h2 {
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .breakdown-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
  }
  .breakdown-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--bg);
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .breakdown-row .name { font-size: 13px; }
  .breakdown-row .amt  { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 14px; }
  .breakdown-row .pct  { font-size: 11px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; margin-left: 8px; }

  /* ── Day table ── */
  .table-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    overflow-x: auto;
  }
  .table-card h2 {
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 14px;
  }
  table { width: 100%; border-collapse: collapse; font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
  th {
    text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--border);
    color: var(--muted); font-weight: 600; white-space: nowrap;
  }
  th:first-child { text-align: left; }
  td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  td:first-child { text-align: left; color: var(--text); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(88,166,255,.05); }
  .sup-cell { color: var(--sup); }
  .off-cell { color: var(--off); }
  .on-cell  { color: var(--on);  }
  .tot-cell { color: var(--total); font-weight: 600; }

  /* ── Rates sidebar ── */
  .rates-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .rates-card h2 {
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .rate-table { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .rate-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .rate-item .rt-label { font-size: 11px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; margin-bottom: 4px; }
  .rate-item .rt-val { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 600; }
  .rate-item .rt-desc { font-size: 11px; color: var(--muted); margin-top: 3px; }
  @media (max-width: 700px) { .rate-table { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>

<header>
  <div>
    <h1>⚡ Georgia Power — Overnight Advantage Dashboard</h1>
    <div class="meta" id="header-meta">Loading…</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <button class="refresh-btn" id="evBtn"   onclick="toggleEv()"   style="border-color:var(--ev);color:var(--ev);display:none">⚡ EV</button>
    <button class="refresh-btn" id="hvacBtn" onclick="toggleHvac()" style="border-color:var(--sup);color:var(--sup)">⚡ HVAC</button>
    <button class="refresh-btn" id="hvacRefreshBtn" onclick="refreshHvac()" style="display:none;border-color:var(--sup);color:var(--sup)" title="Reload Ecobee CSV data">↻ HVAC</button>
    <button class="refresh-btn" id="refreshBtn" onclick="refreshData()">↻ Refresh</button>
  </div>
</header>

<main>
  <div id="loading"><div class="spinner"></div><div>Fetching data from Georgia Power…</div></div>
  <div id="dashboard" style="display:none">

    <!-- Tab mode toggle -->
    <div class="tab-mode-toggle">
      <button class="mode-btn active" id="mode30" onclick="setMode('30day')">30-Day</button>
      <button class="mode-btn" id="modeBilling" onclick="setMode('billing')">Billing Cycles</button>
    </div>

    <!-- Window tabs -->
    <div class="window-tabs" id="windowTabs"></div>

    <!-- KPI cards -->
    <div class="kpi-grid" id="kpiGrid"></div>

    <!-- Daily averages -->
    <div class="kpi-avg-label" id="avgLabel"></div>
    <div class="kpi-avg-grid" id="avgGrid"></div>

    <!-- Charts -->
    <div class="charts-grid">
      <div class="chart-card">
        <h2>Daily kWh by Rate Tier</h2>
        <canvas id="kwhChart"></canvas>
      </div>
      <div class="chart-card">
        <h2>Daily Estimated Cost</h2>
        <canvas id="costChart"></canvas>
      </div>
    </div>

    <!-- Cost breakdown -->
    <div class="breakdown-card">
      <h2>Charge Breakdown — Window Total</h2>
      <div class="breakdown-grid" id="breakdownGrid"></div>
    </div>

    <!-- Day table -->
    <div class="table-card">
      <h2>Daily Detail</h2>
      <table id="dayTable"></table>
    </div>

    <!-- Rate reference -->
    <div class="rates-card" style="margin-top:16px">
      <h2>Active Rate Schedule — TOU-OA-14 (Jan 2025)</h2>
      <div class="rate-table" id="rateTable"></div>
    </div>

    <!-- EV Analysis -->
    <div id="evSection" style="margin-top:24px;display:none">
      <div class="breakdown-card">
        <h2 id="evTitle">EV Charging Analysis</h2>

        <!-- EV KPI row -->
        <div class="kpi-grid" id="evKpiGrid" style="margin-bottom:16px"></div>

        <!-- Load split chart -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="chart-card">
            <h2>Daily Load Split — EV vs Baseline</h2>
            <canvas id="evSplitChart"></canvas>
          </div>

          <!-- Savings panel -->
          <div class="chart-card">
            <h2>TOU-OA-14 vs Flat Rate — EV Savings</h2>
            <div id="evSavingsGrid" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px"></div>
            <div style="font-size:11px;color:var(--muted);margin-top:auto;padding-top:8px">
              Flat rate baseline: RS-1 standard residential (~13¢/kWh all-in).<br>
              TOU-OA-14 super off-peak all-in: ~7.8¢/kWh. Savings = cost difference on EV kWh.
            </div>
          </div>
        </div>

        <!-- EV day table -->
        <div class="table-card">
          <h2>Daily EV Charging Detail</h2>
          <table id="evTable"></table>
        </div>
      </div>
    </div>

    <!-- HVAC Analysis -->
    <div id="hvacSection" style="margin-top:24px;display:none">
      <div class="breakdown-card">
        <h2 id="hvacTitle">HVAC Energy Analysis</h2>
        <div id="hvacStatus" style="font-size:12px;color:var(--muted);font-family:'IBM Plex Mono',monospace;margin-bottom:12px"></div>

        <!-- HVAC KPI row -->
        <div class="kpi-grid" id="hvacKpiGrid" style="margin-bottom:16px"></div>

        <!-- HVAC + baseline stacked chart -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="chart-card">
            <h2>Daily kWh — HVAC vs Baseline</h2>
            <canvas id="hvacStackChart"></canvas>
          </div>
          <div class="chart-card">
            <h2>HVAC Cost by Rate Tier</h2>
            <canvas id="hvacTierChart"></canvas>
          </div>
        </div>

        <!-- Optimization panel -->
        <div id="hvacOptPanel" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px">
          <div style="font-size:12px;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:12px">
            On-Peak Cost Breakdown (June–Sept only)
          </div>
          <div id="hvacOptGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px"></div>
          <div style="font-size:11px;color:var(--muted);margin-top:10px">
            💡 Pre-cooling before 2pm and running AC after 7pm moves load to Off-Peak (10.2¢) vs On-Peak (29.8¢) — a 3× cost difference.
          </div>
        </div>

        <!-- HVAC day table -->
        <div class="table-card" style="margin-top:16px">
          <h2>Daily HVAC Detail</h2>
          <table id="hvacTable"></table>
        </div>

        <!-- Thermostat specs -->
        <div id="hvacSpecs" style="margin-top:12px;font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace"></div>
      </div>

      <!-- CSV Import card -->
      <div class="breakdown-card" style="margin-top:16px">
        <h2>Import Ecobee Runtime CSVs</h2>
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px">
          Download runtime reports from <strong style="color:var(--text)">ecobee.com → My Reports</strong> and import them here.
          Each thermostat needs its own CSV. Multiple months can be imported at once — data is merged automatically.
        </div>

        <div id="importDropzone"
          style="border:2px dashed var(--border);border-radius:8px;padding:32px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:14px"
          onclick="document.getElementById('csvFileInput').click()"
          ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
          ondragleave="this.style.borderColor='var(--border)'"
          ondrop="handleDrop(event)">
          <div style="font-size:24px;margin-bottom:8px">📂</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--muted)">
            Click to select CSVs or drag &amp; drop here
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px">
            Accepts: report-XXXXXXXXXXXX-YYYY-MM-DD-to-YYYY-MM-DD.csv
          </div>
          <input type="file" id="csvFileInput" accept=".csv" multiple
            style="display:none" onchange="handleFileSelect(this.files)">
        </div>

        <div id="importStatus" style="display:none;padding:12px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:12px;margin-bottom:10px"></div>
        <div id="importResults" style="display:none"></div>
      </div>
    </div>

  </div>
</main>

<script>
let allData = null;
let currentWindowIdx = 0;
let tabMode = '30day';   // '30day' | 'billing'
let kwhChartInst = null;
let costChartInst = null;

// EV — all kWh attributed to Super Off-Peak (charger enforces 11pm–7am window)
// All-in rate: base(2.1859¢) + FCR(4.2398¢), then ×(1+ECCR+DSM-R)×(1+MFF-inside)
// = 0.064257 × 1.174978 × 1.030701 ≈ 7.78¢/kWh
const EV_RATE_ALLIN = 0.07782;   // $/kWh all-in super off-peak
const FLAT_RATE     = 0.13;      // $/kWh — RS-1 standard residential comparison

let evVisible   = false;
let evSplitInst = null;

function toggleEv() {
  evVisible = !evVisible;
  document.getElementById('evSection').style.display = evVisible ? 'block' : 'none';
  document.getElementById('evBtn').style.opacity = evVisible ? '1' : '0.6';
  if (evVisible) renderEv();
}

function renderEv() {
  if (!allData) return;
  const evByDay  = allData.evByDay ?? {};
  const gpDays   = allData.accounts[0].days;
  const chunks   = getChunks(gpDays, allData.accounts[0].billingCycles ?? []);
  const windowDays = currentWindowIdx === -1
    ? chunks.flatMap(c => c.days)
    : (chunks[currentWindowIdx]?.days ?? []);

  const combined = windowDays.map(gp => {
    const evKwh    = evByDay[gp.date] ?? 0;
    const baseline = Math.max(0, gp.kWhTotal - evKwh);
    return { ...gp, evKwh, baseline };
  });

  const totEv       = combined.reduce((s, d) => s + d.evKwh, 0);
  const totGP       = combined.reduce((s, d) => s + d.kWhTotal, 0);
  const n           = Math.max(1, combined.length);
  const chargeDays  = combined.filter(d => d.evKwh > 0.5).length;
  const evCost      = totEv * EV_RATE_ALLIN;
  const flatCost    = totEv * FLAT_RATE;
  const savings     = flatCost - evCost;

  const label = currentWindowIdx === -1 ? 'All' : (chunks[currentWindowIdx]?.label ?? '');
  document.getElementById('evTitle').textContent = \`EV Charging Analysis — \${label}\`;

  // KPI cards
  document.getElementById('evKpiGrid').innerHTML = [
    { cls:'ev',    label:'EV kWh (window)',       value: totEv.toFixed(1),                          sub: (totGP > 0 ? (totEv/totGP*100).toFixed(0) : '0') + '% of total GP usage' },
    { cls:'ev',    label:'Est. EV Cost',           value: usd(evCost),                               sub: (EV_RATE_ALLIN*100).toFixed(2) + '¢/kWh all-in (super off-peak)' },
    { cls:'off',   label:'Flat-Rate Cost (RS-1)',  value: usd(flatCost),                             sub: (FLAT_RATE*100).toFixed(0) + '¢/kWh standard residential' },
    { cls:'sup',   label:'TOU Savings (window)',   value: usd(savings),                              sub: savings > 0 ? 'saved vs flat rate this window' : '' },
    { cls:'total', label:'Charge Days',            value: chargeDays + ' / ' + n,                   sub: 'days with > 0.5 kWh EV load' },
    { cls:'ev',    label:'Avg kWh / Charge Day',  value: chargeDays > 0 ? (totEv/chargeDays).toFixed(1) + ' kWh' : '—', sub: '' },
  ].map(k => \`
    <div class="kpi \${k.cls}">
      <div class="label">\${k.label}</div>
      <div class="value">\${k.value}</div>
      <div class="sub">\${k.sub}</div>
    </div>
  \`).join('');

  // Savings breakdown rows
  document.getElementById('evSavingsGrid').innerHTML = [
    { name: 'EV kWh this window',       amt: totEv.toFixed(1) + ' kWh',                          color: 'var(--ev)' },
    { name: 'TOU-OA-14 EV cost',        amt: usd(evCost) + '  (' + (EV_RATE_ALLIN*100).toFixed(2) + '¢/kWh)', color: 'var(--ev)' },
    { name: 'RS-1 flat-rate cost',      amt: usd(flatCost) + '  (' + (FLAT_RATE*100).toFixed(0) + '¢/kWh)',   color: 'var(--off)' },
    { name: 'Savings from TOU plan',    amt: usd(savings),                                         color: 'var(--sup)' },
  ].map(r => \`
    <div class="breakdown-row">
      <span class="name">\${r.name}</span>
      <span class="amt" style="color:\${r.color}">\${r.amt}</span>
    </div>
  \`).join('');

  // Load split chart
  if (evSplitInst) evSplitInst.destroy();
  const ctx = document.getElementById('evSplitChart').getContext('2d');
  evSplitInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: combined.map(d => d.date.slice(5)),
      datasets: [
        { label: 'EV',       data: combined.map(d => +d.evKwh.toFixed(2)),   backgroundColor: 'rgba(188,140,255,.8)', stack: 's' },
        { label: 'Baseline', data: combined.map(d => +d.baseline.toFixed(2)), backgroundColor: 'rgba(63,185,80,.55)',   stack: 's' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: '#7d8590', boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { stacked: true, ticks: { color: '#7d8590', maxTicksLimit: 10, font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#21262d' } },
        y: { stacked: true, ticks: { color: '#7d8590', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#21262d' } },
      },
    },
  });

  // Day table
  document.getElementById('evTable').innerHTML = \`
    <thead><tr>
      <th style="text-align:left">Date</th>
      <th>GP kWh</th>
      <th style="color:var(--ev)">EV kWh</th>
      <th>Baseline kWh</th>
      <th style="color:var(--ev)">EV Cost</th>
      <th style="color:var(--off)">Flat Cost</th>
      <th style="color:var(--sup)">Saved</th>
    </tr></thead>
    <tbody>\${combined.map(d => {
      const cost  = d.evKwh * EV_RATE_ALLIN;
      const flat  = d.evKwh * FLAT_RATE;
      const saved = flat - cost;
      const charged = d.evKwh > 0.5;
      return \`<tr>
        <td>\${d.date}</td>
        <td>\${d.kWhTotal.toFixed(2)}</td>
        <td style="color:var(--ev)">\${d.evKwh.toFixed(2)}</td>
        <td>\${d.baseline.toFixed(2)}</td>
        <td style="color:var(--ev)">\${charged ? usd(cost) : '—'}</td>
        <td style="color:var(--off)">\${charged ? usd(flat) : '—'}</td>
        <td style="color:var(--sup)">\${charged ? usd(saved) : '—'}</td>
      </tr>\`;
    }).join('')}</tbody>\`;
}

const usd  = n  => '$' + n.toFixed(2);
const u4   = n  => '$' + n.toFixed(4);
const pct  = (v, t) => t > 0 ? (v / t * 100).toFixed(1) + '%' : '—';

function chunkBy30(days) {
  const chunks = [];
  for (let i = 0; i < days.length; i += 30) chunks.push(days.slice(i, i + 30));
  return chunks;
}

function sumDays(days) {
  return days.reduce((s, r) => ({
    kWh: s.kWh + r.kWhTotal, kWhSup: s.kWhSup + r.kWhSuperOffPeak,
    kWhOff: s.kWhOff + r.kWhOffPeak, kWhOn: s.kWhOn + r.kWhOnPeak,
    baseEnergy: s.baseEnergy + r.baseEnergy, basicSvc: s.basicSvc + r.basicSvc,
    fcr: s.fcr + r.fcrCharge, eccr: s.eccr + r.eccrCharge,
    dsmr: s.dsmr + r.dsmrCharge, mff: s.mff + r.mffCharge,
    total: s.total + r.totalEstimated,
  }), { kWh:0,kWhSup:0,kWhOff:0,kWhOn:0,baseEnergy:0,basicSvc:0,fcr:0,eccr:0,dsmr:0,mff:0,total:0 });
}

function setMode(mode) {
  tabMode = mode;
  currentWindowIdx = 0;  // 0 = latest chunk after reversal
  document.getElementById('mode30').classList.toggle('active', mode === '30day');
  document.getElementById('modeBilling').classList.toggle('active', mode === 'billing');
  // Hide billing toggle if no cycles available
  const cycles = allData?.accounts?.[0]?.billingCycles ?? [];
  document.getElementById('modeBilling').disabled = cycles.length === 0;
  render();
}

// Returns chunks based on current tab mode, newest first
function getChunks(days, billingCycles) {
  if (tabMode === 'billing' && billingCycles && billingCycles.length > 0) {
    return billingCycles.map(cycle => ({
      label    : cycle.label,
      startDate: cycle.startDate,
      endDate  : cycle.endDate,
      days     : days.filter(d => d.date >= cycle.startDate && d.date <= cycle.endDate),
    })).filter(c => c.days.length > 0).reverse();  // newest billing cycle first
  }
  // Default: 30-day chunks, reversed so most recent is index 0
  const chunks = [];
  for (let i = 0; i < days.length; i += 30) chunks.push(days.slice(i, i + 30));
  return chunks.map(c => ({
    label    : c[0].date.slice(0, 7),
    startDate: c[0].date,
    endDate  : c[c.length-1].date,
    days     : c,
  })).reverse();
}

async function loadData() {
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('dashboard').style.display = 'none';
  try {
    const res = await fetch('/api/data');
    allData = await res.json();
    if (!allData.ok) throw new Error(allData.error);
    render();
  } catch(e) {
    document.getElementById('loading').innerHTML =
      '<div style="color:#f85149;font-family:monospace">Error: ' + e.message + '</div>';
  }
}

async function refreshData() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true; btn.textContent = '↻ Refreshing…';
  await fetch('/api/refresh', { method: 'POST' });
  await loadData();
  btn.disabled = false; btn.textContent = '↻ Refresh';
}

function render() {
  const acct   = allData.accounts[0];
  const days   = acct.days;
  const cycles = acct.billingCycles ?? [];
  const chunks = getChunks(days, cycles);
  const rates  = allData.rates;

  // Show/hide billing mode button
  document.getElementById('modeBilling').style.opacity = cycles.length > 0 ? '1' : '0.35';
  document.getElementById('modeBilling').title = cycles.length === 0 ? 'No billing cycle data available' : '';

  // Header meta
  document.getElementById('header-meta').textContent =
    acct.name + ' · ' + acct.accountNumber + ' · ' +
    (days[0]?.date ?? '') + ' → ' + (days.at(-1)?.date ?? '') +
    ' · city: ' + allData.cityLimits;

  // Build window tabs
  const tabsEl = document.getElementById('windowTabs');
  tabsEl.innerHTML = '';
  chunks.forEach((chunk, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (i === currentWindowIdx ? ' active' : '');
    const isPartial = tabMode === '30day' && chunk.days.length < 30;
    btn.textContent = chunk.label + (isPartial ? ' (partial)' : '');
    btn.onclick = () => { currentWindowIdx = i; renderWindow(chunks, rates, cycles); updateTabs(chunks); };
    tabsEl.appendChild(btn);
  });
  if (chunks.length > 1) {
    const allBtn = document.createElement('button');
    allBtn.className = 'tab' + (currentWindowIdx === -1 ? ' active' : '');
    allBtn.textContent = 'All';
    allBtn.onclick = () => { currentWindowIdx = -1; renderWindow(chunks, rates, cycles); updateTabs(chunks); };
    tabsEl.appendChild(allBtn);
  }

  // Show EV button only when Emporia data is available
  const hasEv = allData.emporiaEnabled && Object.keys(allData.evByDay ?? {}).length > 0;
  document.getElementById('evBtn').style.display = hasEv ? 'inline-block' : 'none';

  renderWindow(chunks, rates, cycles);
  renderRates(rates);
  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
}

function updateTabs(chunks) {
  document.querySelectorAll('#windowTabs .tab').forEach((btn, i) => {
    const idx = i === chunks.length ? -1 : i;
    btn.classList.toggle('active', idx === currentWindowIdx);
  });
}

function renderWindow(chunks, rates, cycles) {
  const windowChunk = currentWindowIdx === -1
    ? { days: chunks.flatMap(c => c.days), label: 'All' }
    : (chunks[currentWindowIdx] ?? { days: [], label: '' });
  const windowDays = windowChunk.days;
  const tot = sumDays(windowDays);
  const n   = Math.max(1, windowDays.length);

  // KPIs — totals for window
  document.getElementById('kpiGrid').innerHTML = [
    { cls:'sup',   label:'Super Off-Peak kWh', value: tot.kWhSup.toFixed(1),  sub: pct(tot.kWhSup, tot.kWh) + ' of total' },
    { cls:'off',   label:'Off-Peak kWh',        value: tot.kWhOff.toFixed(1),  sub: pct(tot.kWhOff, tot.kWh) + ' of total' },
    { cls:'on',    label:'On-Peak kWh',          value: tot.kWhOn.toFixed(1),   sub: pct(tot.kWhOn, tot.kWh) + ' of total' },
    { cls:'total', label:'Total kWh',            value: tot.kWh.toFixed(1),     sub: windowDays.length + ' days' },
    { cls:'total', label:'Est. Energy Cost',     value: usd(tot.total),          sub: 'avg ' + usd(tot.total / n) + '/day' },
    { cls:'total', label:'Blended Rate',         value: tot.kWh > 0 ? (tot.total / tot.kWh * 100).toFixed(2) + '¢' : '—', sub: 'per kWh all-in' },
  ].map(k => \`
    <div class="kpi \${k.cls}">
      <div class="label">\${k.label}</div>
      <div class="value">\${k.value}</div>
      <div class="sub">\${k.sub}</div>
    </div>
  \`).join('');

  // Daily averages row
  const avgSupKwh  = tot.kWhSup  / n;
  const avgOffKwh  = tot.kWhOff  / n;
  const avgOnKwh   = tot.kWhOn   / n;
  const avgTotKwh  = tot.kWh     / n;
  const avgSupCost = (tot.baseEnergy > 0 ? windowDays.reduce((s,d) => s + d.baseEnergy * (d.kWhSuperOffPeak / Math.max(0.001, d.kWhTotal)), 0) : 0) / n;
  const avgOffCost = (tot.baseEnergy > 0 ? windowDays.reduce((s,d) => s + d.baseEnergy * (d.kWhOffPeak / Math.max(0.001, d.kWhTotal)), 0) : 0) / n;
  const avgOnCost  = (tot.baseEnergy > 0 ? windowDays.reduce((s,d) => s + d.baseEnergy * (d.kWhOnPeak / Math.max(0.001, d.kWhTotal)), 0) : 0) / n;
  const avgTotal   = tot.total / n;

  document.getElementById('avgLabel').textContent = \`Daily Averages — \${windowChunk.label}\`;
  document.getElementById('avgGrid').innerHTML = [
    { cls:'sup', label:'Avg Super Off-Pk/day', value: avgSupKwh.toFixed(2) + ' kWh', sub: usd(avgSupCost) + '/day est.' },
    { cls:'off', label:'Avg Off-Peak/day',      value: avgOffKwh.toFixed(2) + ' kWh', sub: usd(avgOffCost) + '/day est.' },
    { cls:'on',  label:'Avg On-Peak/day',       value: avgOnKwh.toFixed(2)  + ' kWh', sub: usd(avgOnCost)  + '/day est.' },
    { cls:'total',label:'Avg Total kWh/day',    value: avgTotKwh.toFixed(2) + ' kWh', sub: '' },
    { cls:'total',label:'Avg Daily Cost',        value: usd(avgTotal),                  sub: (avgTotKwh > 0 ? (avgTotal/avgTotKwh*100).toFixed(2) + '¢/kWh' : '') },
  ].map(k => \`
    <div class="kpi \${k.cls}">
      <div class="label">\${k.label}</div>
      <div class="value">\${k.value}</div>
      <div class="sub">\${k.sub}</div>
    </div>
  \`).join('');

  // Breakdown
  const breakdownItems = [
    { name: 'Base Energy (TOU-OA-14)', amt: tot.baseEnergy },
    { name: 'Basic Service Charge',    amt: tot.basicSvc   },
    { name: 'Fuel Cost Recovery (FCR)', amt: tot.fcr       },
    { name: 'ECCR (16.28%)',           amt: tot.eccr       },
    { name: 'DSM-R (1.22%)',           amt: tot.dsmr       },
    { name: 'Municipal Franchise Fee', amt: tot.mff        },
  ];
  document.getElementById('breakdownGrid').innerHTML = breakdownItems.map(b => \`
    <div class="breakdown-row">
      <span class="name">\${b.name}</span>
      <span><span class="amt">\${usd(b.amt)}</span><span class="pct">\${pct(b.amt, tot.total)}</span></span>
    </div>
  \`).join('');

  // Charts
  const labels = windowDays.map(d => d.date.slice(5));  // MM-DD
  renderKwhChart(labels, windowDays);
  renderCostChart(labels, windowDays);

  // Table
  const thead = \`<thead><tr>
    <th>Date</th><th>kWh</th>
    <th class="sup-cell">Super Off-Pk</th>
    <th class="off-cell">Off-Peak</th>
    <th class="on-cell">On-Peak</th>
    <th>Base Energy</th><th>FCR</th><th>ECCR</th><th>DSM-R</th><th>MFF</th>
    <th class="tot-cell">Total Est.</th><th>¢/kWh</th>
  </tr></thead>\`;

  const tbody = windowDays.map(r => {
    const avg = r.kWhTotal > 0 ? (r.totalEstimated / r.kWhTotal * 100).toFixed(2) : '—';
    return \`<tr>
      <td>\${r.date}</td>
      <td>\${r.kWhTotal.toFixed(2)}</td>
      <td class="sup-cell">\${r.kWhSuperOffPeak.toFixed(2)}</td>
      <td class="off-cell">\${r.kWhOffPeak.toFixed(2)}</td>
      <td class="on-cell">\${r.kWhOnPeak.toFixed(2)}</td>
      <td>\${usd(r.baseEnergy)}</td>
      <td>\${usd(r.fcrCharge)}</td>
      <td>\${usd(r.eccrCharge)}</td>
      <td>\${usd(r.dsmrCharge)}</td>
      <td>\${usd(r.mffCharge)}</td>
      <td class="tot-cell">\${usd(r.totalEstimated)}</td>
      <td>\${avg}¢</td>
    </tr>\`;
  }).join('');

  document.getElementById('dayTable').innerHTML = thead + '<tbody>' + tbody + '</tbody>';
}

function renderKwhChart(labels, days) {
  if (kwhChartInst) kwhChartInst.destroy();
  const ctx = document.getElementById('kwhChart').getContext('2d');
  kwhChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Super Off-Peak', data: days.map(d => d.kWhSuperOffPeak), backgroundColor: 'rgba(88,166,255,.75)',  stack: 'k' },
        { label: 'Off-Peak',       data: days.map(d => d.kWhOffPeak),      backgroundColor: 'rgba(63,185,80,.75)',   stack: 'k' },
        { label: 'On-Peak',        data: days.map(d => d.kWhOnPeak),       backgroundColor: 'rgba(248,81,73,.75)',   stack: 'k' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: '#7d8590', boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { stacked: true, ticks: { color: '#7d8590', maxTicksLimit: 10, font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#21262d' } },
        y: { stacked: true, ticks: { color: '#7d8590', font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#21262d' } }
      }
    }
  });
}

function renderCostChart(labels, days) {
  if (costChartInst) costChartInst.destroy();
  const ctx = document.getElementById('costChart').getContext('2d');
  costChartInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Est. Daily Cost',
        data: days.map(d => d.totalEstimated),
        borderColor: '#d29922',
        backgroundColor: 'rgba(210,153,34,.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: days.length > 60 ? 0 : 3,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: '#7d8590', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#7d8590', maxTicksLimit: 10, font: { family: 'IBM Plex Mono', size: 10 } }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#7d8590', font: { family: 'IBM Plex Mono', size: 10 }, callback: v => '$' + v.toFixed(2) }, grid: { color: '#21262d' } }
      }
    }
  });

  // Keep EV and HVAC panels in sync with the current window
  if (evVisible) renderEv();
  if (typeof hvacVisible !== 'undefined' && hvacVisible && typeof hvacData !== 'undefined' && hvacData) {
    renderHvac();
  }
}

function renderRates(rates) {
  const br = rates.BASE_RATES;
  const ri = rates.RIDERS;
  document.getElementById('rateTable').innerHTML = [
    { label: 'Super Off-Peak', val: (br.SUPER_OFF_PEAK * 100).toFixed(4) + '¢', desc: '11pm–7am · all year' },
    { label: 'Off-Peak',       val: (br.OFF_PEAK       * 100).toFixed(4) + '¢', desc: 'all non-peak hours' },
    { label: 'On-Peak',        val: (br.ON_PEAK        * 100).toFixed(4) + '¢', desc: '2–7pm Mon–Fri Jun–Sep' },
    { label: 'FCR On-Peak',    val: (ri.FCR.ON_PEAK    * 100).toFixed(4) + '¢', desc: 'TOU-FCR-6 adder' },
    { label: 'FCR Off-Peak',   val: (ri.FCR.OFF_PEAK   * 100).toFixed(4) + '¢', desc: 'also Super Off-Peak' },
    { label: 'ECCR',           val: (ri.ECCR.RATE      * 100).toFixed(4) + '%',  desc: '% of base+FCR' },
    { label: 'DSM-R',          val: (ri.DSM_R.RATE     * 100).toFixed(4) + '%',  desc: '% of base+FCR' },
    { label: 'MFF (inside)',   val: (ri.MFF.INSIDE_CITY  * 100).toFixed(4) + '%', desc: 'Roswell incorporated' },
    { label: 'Basic Service',  val: '$' + br.BASIC_SERVICE.toFixed(4),            desc: 'per day flat' },
  ].map(r => \`
    <div class="rate-item">
      <div class="rt-label">\${r.label}</div>
      <div class="rt-val">\${r.val}</div>
      <div class="rt-desc">\${r.desc}</div>
    </div>
  \`).join('');
}

// ── HVAC Analysis ────────────────────────────────────────────────────────────
let hvacData = null;
let hvacVisible = false;
let hvacStackInst = null;
let hvacTierInst = null;

async function toggleHvac() {
  hvacVisible = !hvacVisible;
  document.getElementById('hvacSection').style.display = hvacVisible ? 'block' : 'none';
  document.getElementById('hvacBtn').style.opacity    = hvacVisible ? '1' : '0.6';
  document.getElementById('hvacRefreshBtn').style.display = hvacVisible ? 'inline-block' : 'none';
  if (hvacVisible) await loadHvacData();  // always reload when opening
}

async function refreshHvac() {
  const btn = document.getElementById('hvacRefreshBtn');
  btn.disabled = true;
  btn.textContent = '↻ Loading…';
  await loadHvacData();
  btn.disabled = false;
  btn.textContent = '↻ HVAC';
}

async function loadHvacData() {
  document.getElementById('hvacStatus').textContent = 'Loading Ecobee CSV data…';
  try {
    // Always force a fresh fetch from server (?refresh=1 busts the server-side cache)
    const res  = await fetch('/api/ecobee?refresh=1');
    hvacData   = await res.json();
    if (!hvacData.ok && !hvacData.byDay) {
      document.getElementById('hvacStatus').textContent = 'Error: ' + (hvacData.error ?? 'unknown');
      return;
    }
    // Make HVAC panel visible if it isn't already (e.g. called from import handler)
    if (!hvacVisible) {
      hvacVisible = true;
      document.getElementById('hvacSection').style.display = 'block';
      document.getElementById('hvacBtn').style.opacity = '1';
    }
    renderHvac();
  } catch(e) {
    document.getElementById('hvacStatus').textContent = 'Error: ' + e.message;
  }
}

function renderHvac() {
  if (!hvacData || !allData) return;
  const gpDays   = allData.accounts[0].days;    // GP hourly data
  const ecoDays  = hvacData.byDay ?? {};         // ecobee data

  // Match ecobee days to current window
  const chunks     = getChunks(gpDays, allData.accounts[0].billingCycles ?? []);
  const windowDays = currentWindowIdx === -1 ? chunks.flatMap(c => c.days) : (chunks[currentWindowIdx]?.days ?? []);

  // Build combined day array — GP total + HVAC estimate + baseline
  const combined = windowDays.map(gp => {
    const eco      = ecoDays[gp.date] ?? { totalKwh:0, coolKwh:0, fanKwh:0, coolMin:0, heatMin:0, peakCoolKwh:0, offPeakCoolKwh:0, supOffPeakCoolKwh:0 };
    const baseline = Math.max(0, gp.kWhTotal - eco.totalKwh);
    return { ...gp, hvacKwh: eco.totalKwh, coolKwh: eco.coolKwh, fanKwh: eco.fanKwh,
             coolMin: eco.coolMin, heatMin: eco.heatMin,
             peakHvac: eco.peakCoolKwh, offPeakHvac: eco.offPeakCoolKwh, supHvac: eco.supOffPeakCoolKwh,
             baseline };
  });

  // Totals
  const totHvac     = combined.reduce((s,d) => s + d.hvacKwh, 0);
  const totBaseline = combined.reduce((s,d) => s + d.baseline, 0);
  const totGP       = combined.reduce((s,d) => s + d.kWhTotal, 0);
  const totPeakHvac = combined.reduce((s,d) => s + d.peakHvac, 0);
  const totOffHvac  = combined.reduce((s,d) => s + d.offPeakHvac, 0);
  const totSupHvac  = combined.reduce((s,d) => s + d.supHvac, 0);
  const n           = Math.max(1, combined.length);

  // HVAC cost estimates (using GP rate tiers)
  const PEAK_RATE = 0.297868 + 0.066871; // base + FCR on-peak
  const OFF_RATE  = 0.101676 + 0.042398;
  const SUP_RATE  = 0.021859 + 0.042398;
  const totHvacCost = totPeakHvac * PEAK_RATE + totOffHvac * OFF_RATE + totSupHvac * SUP_RATE;

  // Status line
  const therms = (hvacData.thermostats ?? []).map(t => t.name + ' (' + t.tons + 't ' + t.seer + ' SEER)').join(', ');
  document.getElementById('hvacStatus').textContent = 'Data: ' + therms;
  document.getElementById('hvacTitle').textContent = 'HVAC Energy Analysis — ' + (currentWindowIdx === -1 ? 'All' : chunks[currentWindowIdx]?.label ?? '');

  // KPI cards
  const hvacPct = totGP > 0 ? (totHvac / totGP * 100).toFixed(0) : '—';
  document.getElementById('hvacKpiGrid').innerHTML = [
    { cls:'sup',   label:'HVAC kWh (window)',     value: totHvac.toFixed(1),         sub: hvacPct + '% of total GP usage' },
    { cls:'off',   label:'Baseline kWh',           value: totBaseline.toFixed(1),     sub: (100 - parseInt(hvacPct || 0)) + '% of total (non-HVAC)' },
    { cls:'on',    label:'On-Peak HVAC Cost',      value: usd(totPeakHvac * PEAK_RATE), sub: totPeakHvac.toFixed(1) + ' kWh @ 36.5¢ (Jun–Sep only)' },
    { cls:'total', label:'Est. HVAC Cost',         value: usd(totHvacCost),           sub: 'avg ' + usd(totHvacCost / n) + '/day' },
    { cls:'sup',   label:'Avg Cool Runtime/Day',   value: (combined.reduce((s,d) => s+d.coolMin,0)/n).toFixed(0) + ' min', sub: '' },
    { cls:'total', label:'Avg HVAC kWh/Day',       value: (totHvac / n).toFixed(2),  sub: '' },
  ].map(k => \`<div class="kpi \${k.cls}"><div class="label">\${k.label}</div><div class="value">\${k.value}</div><div class="sub">\${k.sub}</div></div>\`).join('');

  // Stacked bar: HVAC vs Baseline
  if (hvacStackInst) hvacStackInst.destroy();
  const ctx1 = document.getElementById('hvacStackChart').getContext('2d');
  const labels = combined.map(d => d.date.slice(5));
  hvacStackInst = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'HVAC',     data: combined.map(d => +d.hvacKwh.toFixed(2)),   backgroundColor: 'rgba(248,81,73,.8)',  stack: 's' },
        { label: 'Baseline', data: combined.map(d => +d.baseline.toFixed(2)),  backgroundColor: 'rgba(63,185,80,.6)', stack: 's' },
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:true,
      plugins:{ legend:{ labels:{ color:'#7d8590', boxWidth:12, font:{size:11} } } },
      scales:{
        x:{ stacked:true, ticks:{color:'#7d8590',maxTicksLimit:10,font:{family:'IBM Plex Mono',size:10}}, grid:{color:'#21262d'} },
        y:{ stacked:true, ticks:{color:'#7d8590',font:{family:'IBM Plex Mono',size:10}}, grid:{color:'#21262d'} }
      }
    }
  });

  // Tier cost bar chart
  if (hvacTierInst) hvacTierInst.destroy();
  const ctx2 = document.getElementById('hvacTierChart').getContext('2d');
  hvacTierInst = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'On-Peak HVAC',      data: combined.map(d => +(d.peakHvac * PEAK_RATE).toFixed(3)),  backgroundColor:'rgba(248,81,73,.8)',  stack:'t' },
        { label:'Off-Peak HVAC',     data: combined.map(d => +(d.offPeakHvac * OFF_RATE).toFixed(3)),backgroundColor:'rgba(63,185,80,.7)',  stack:'t' },
        { label:'Super Off-Pk HVAC', data: combined.map(d => +(d.supHvac * SUP_RATE).toFixed(3)),    backgroundColor:'rgba(88,166,255,.7)', stack:'t' },
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:true,
      plugins:{ legend:{ labels:{ color:'#7d8590', boxWidth:12, font:{size:11} } } },
      scales:{
        x:{ stacked:true, ticks:{color:'#7d8590',maxTicksLimit:10,font:{family:'IBM Plex Mono',size:10}}, grid:{color:'#21262d'} },
        y:{ stacked:true, ticks:{color:'#7d8590',font:{family:'IBM Plex Mono',size:10}, callback: v => '$' + v.toFixed(2)}, grid:{color:'#21262d'} }
      }
    }
  });

  // Optimization panel (only relevant June–Sept)
  const hasSummer = combined.some(d => { const m = parseInt(d.date.slice(5,7)); return m >= 6 && m <= 9; });
  document.getElementById('hvacOptPanel').style.display = hasSummer ? 'block' : 'none';
  if (hasSummer) {
    document.getElementById('hvacOptGrid').innerHTML = [
      { label:'On-Peak HVAC kWh',     value: totPeakHvac.toFixed(1) + ' kWh' },
      { label:'On-Peak HVAC Cost',    value: usd(totPeakHvac * PEAK_RATE) },
      { label:'Savings if shifted',   value: usd(totPeakHvac * (PEAK_RATE - OFF_RATE)) + ' saved' },
      { label:'Optimal AC window',    value: '7am–1:59pm & 7pm–11pm' },
    ].map(b => \`<div class="breakdown-row"><span class="name">\${b.label}</span><span class="amt">\${b.value}</span></div>\`).join('');
  }

  // Day table
  const thead = \`<thead><tr>
    <th style="text-align:left">Date</th>
    <th>GP kWh</th><th>HVAC kWh</th><th>Baseline kWh</th>
    <th>Cool min</th><th>Heat min</th>
    <th style="color:var(--on)">OnPk HVAC $</th>
    <th style="color:var(--off)">OffPk HVAC $</th>
    <th style="color:var(--sup)">Sup HVAC $</th>
    <th style="color:var(--total)">HVAC Cost</th>
  </tr></thead>\`;

  const tbody = combined.map(d => {
    const pkCost  = (d.peakHvac   * PEAK_RATE).toFixed(2);
    const offCost = (d.offPeakHvac * OFF_RATE).toFixed(2);
    const supCost = (d.supHvac    * SUP_RATE).toFixed(2);
    const tot     = (parseFloat(pkCost) + parseFloat(offCost) + parseFloat(supCost)).toFixed(2);
    return \`<tr>
      <td>\${d.date}</td>
      <td>\${d.kWhTotal.toFixed(2)}</td>
      <td>\${d.hvacKwh.toFixed(2)}</td>
      <td>\${d.baseline.toFixed(2)}</td>
      <td>\${d.coolMin.toFixed(0)}</td>
      <td>\${d.heatMin.toFixed(0)}</td>
      <td style="color:var(--on)">\$\${pkCost}</td>
      <td style="color:var(--off)">\$\${offCost}</td>
      <td style="color:var(--sup)">\$\${supCost}</td>
      <td style="color:var(--total);font-weight:600">\$\${tot}</td>
    </tr>\`;
  }).join('');

  document.getElementById('hvacTable').innerHTML = thead + '<tbody>' + tbody + '</tbody>';

  // Thermostat specs
  const specs = (hvacData.thermostats ?? []).map(t =>
    t.name + ': ' + t.tons + 't · ' + t.seer + ' SEER · compressor ' + t.compKw + ' kW'
  ).join('   |   ');
  document.getElementById('hvacSpecs').textContent = specs + '   |   blower 0.65 kW ea (gas system)   |   Note: estimates require calibration against actual bills';
}

// ── CSV Import UI ────────────────────────────────────────────────────────────

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('importDropzone').style.borderColor = 'var(--border)';
  handleFileSelect(event.dataTransfer.files);
}

async function handleFileSelect(files) {
  if (!files || files.length === 0) return;

  const statusEl  = document.getElementById('importStatus');
  const resultsEl = document.getElementById('importResults');
  const dropzone  = document.getElementById('importDropzone');

  // Show pending state
  statusEl.style.display  = 'block';
  resultsEl.style.display = 'none';
  statusEl.style.background = 'rgba(88,166,255,.1)';
  statusEl.style.color      = 'var(--accent)';
  statusEl.style.border     = '1px solid rgba(88,166,255,.3)';
  statusEl.textContent = '⏳ Uploading ' + files.length + ' file(s)…';
  dropzone.style.opacity = '0.5';

  const form = new FormData();
  for (const f of files) form.append('files', f);

  try {
    const res  = await fetch('/api/ecobee/import', { method: 'POST', body: form });
    const data = await res.json();
    dropzone.style.opacity = '1';

    if (!data.ok) {
      statusEl.style.background = 'rgba(248,81,73,.1)';
      statusEl.style.color      = 'var(--on)';
      statusEl.style.border     = '1px solid rgba(248,81,73,.3)';
      statusEl.textContent = '✗ ' + data.error;
      return;
    }

    // Success
    statusEl.style.background = 'rgba(63,185,80,.1)';
    statusEl.style.color      = 'var(--off)';
    statusEl.style.border     = '1px solid rgba(63,185,80,.3)';
    statusEl.textContent = '✓ Imported ' + data.imported.length + ' file(s) · ' +
      data.summary.totalDays + ' total days · ' +
      data.summary.thermostats.join(', ');

    // Show import details
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = data.imported.map(f =>
      '<div style="font-size:11px;color:var(--muted);font-family:IBM Plex Mono,monospace;padding:4px 0">' +
      '  ✓ ' + f.filename + ' — ' + f.thermostatName + ' · ' + f.intervals.toLocaleString() + ' intervals' +
      '</div>'
    ).join('');

    // Refresh HVAC data in the dashboard.
    // Re-fetch from /api/ecobee rather than using the import response directly
    // so the data shape is guaranteed consistent with what renderHvac() expects.
    hvacData = null;  // clear stale data
    await loadHvacData();  // re-fetch and re-render

  } catch(e) {
    dropzone.style.opacity = '1';
    statusEl.style.background = 'rgba(248,81,73,.1)';
    statusEl.style.color      = 'var(--on)';
    statusEl.style.border     = '1px solid rgba(248,81,73,.3)';
    statusEl.textContent = '✗ Upload failed: ' + e.message;
  }
}

// Kick off
loadData();
</script>
</body>
</html>`;
}