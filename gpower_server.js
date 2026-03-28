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

import express  from 'express';
import { fetchAndProcessWithCache, sumDays, BASE_RATES, RIDERS } from './gpower_core.js';

const USERNAME    = process.env.GP_USERNAME  ?? (() => { throw new Error('GP_USERNAME is not set. Copy .env.example to .env and fill in your credentials.'); })();
const PASSWORD    = process.env.GP_PASSWORD  ?? (() => { throw new Error('GP_PASSWORD is not set. Copy .env.example to .env and fill in your credentials.'); })();
const ACCOUNT     = process.env.GP_ACCOUNT;
const CITY_LIMITS = (process.env.CITY_LIMITS ?? 'inside').toLowerCase();
const PORT        = parseInt(process.env.PORT ?? '3000');
const START_DATE  = new Date(2026, 1, 28);

// ─── In-memory cache (avoids hammering GP's API on every browser refresh) ────
let cache = null;
let cacheTime = null;
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 minutes

async function getData() {
  const now = Date.now();
  if (cache && cacheTime && (now - cacheTime) < CACHE_TTL_MS) return cache;
  console.log('[cache miss] Fetching from Georgia Power…');
  cache = await fetchAndProcessWithCache({
    username: USERNAME, password: PASSWORD,
    account: ACCOUNT, cityLimits: CITY_LIMITS,
    startDate: START_DATE, endDate: new Date(),
  });
  cacheTime = now;
  console.log('[cache] Data refreshed.');
  return cache;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// JSON API endpoint — used by the dashboard via fetch()
app.get('/api/data', async (req, res) => {
  try {
    const accounts = await getData();
    // Optionally force refresh with ?refresh=1
    if (req.query.refresh === '1') { cache = null; }
    res.json({ ok: true, accounts, rates: { BASE_RATES, RIDERS }, cityLimits: CITY_LIMITS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Force-refresh endpoint
app.post('/api/refresh', async (req, res) => {
  cache = null;
  try {
    await getData();
    res.json({ ok: true });
  } catch (err) {
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
  <button class="refresh-btn" id="refreshBtn" onclick="refreshData()">↻ Refresh</button>
</header>

<main>
  <div id="loading"><div class="spinner"></div><div>Fetching data from Georgia Power…</div></div>
  <div id="dashboard" style="display:none">

    <!-- Window tabs -->
    <div class="window-tabs" id="windowTabs"></div>

    <!-- KPI cards -->
    <div class="kpi-grid" id="kpiGrid"></div>

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

  </div>
</main>

<script>
let allData = null;
let currentWindowIdx = 0;
let kwhChartInst = null;
let costChartInst = null;

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
  const acct  = allData.accounts[0];
  const days  = acct.days;
  const chunks = chunkBy30(days);
  const rates  = allData.rates;

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
    btn.textContent = chunk[0].date.slice(0, 7) + (chunk.length < 30 ? ' (partial)' : '');
    btn.onclick = () => { currentWindowIdx = i; renderWindow(chunks, rates); updateTabs(chunks); };
    tabsEl.appendChild(btn);
  });
  if (chunks.length > 1) {
    const allBtn = document.createElement('button');
    allBtn.className = 'tab' + (currentWindowIdx === -1 ? ' active' : '');
    allBtn.textContent = 'All';
    allBtn.onclick = () => { currentWindowIdx = -1; renderWindow(chunks, rates); updateTabs(chunks); };
    tabsEl.appendChild(allBtn);
  }

  renderWindow(chunks, rates);
  renderRates(rates);
  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
}

function updateTabs(chunks) {
  document.querySelectorAll('.tab').forEach((btn, i) => {
    const idx = i === chunks.length ? -1 : i;
    btn.classList.toggle('active', idx === currentWindowIdx);
  });
}

function renderWindow(chunks, rates) {
  const windowDays = currentWindowIdx === -1
    ? chunks.flat()
    : (chunks[currentWindowIdx] ?? []);
  const tot = sumDays(windowDays);

  // KPIs
  document.getElementById('kpiGrid').innerHTML = [
    { cls:'sup',   label:'Super Off-Peak kWh', value: tot.kWhSup.toFixed(1),  sub: pct(tot.kWhSup, tot.kWh) + ' of total' },
    { cls:'off',   label:'Off-Peak kWh',        value: tot.kWhOff.toFixed(1),  sub: pct(tot.kWhOff, tot.kWh) + ' of total' },
    { cls:'on',    label:'On-Peak kWh',          value: tot.kWhOn.toFixed(1),   sub: pct(tot.kWhOn, tot.kWh) + ' of total' },
    { cls:'total', label:'Total kWh',            value: tot.kWh.toFixed(1),     sub: windowDays.length + ' days' },
    { cls:'total', label:'Est. Energy Cost',     value: usd(tot.total),          sub: 'avg ' + usd(tot.total / Math.max(1, windowDays.length)) + '/day' },
    { cls:'total', label:'Blended Rate',         value: tot.kWh > 0 ? (tot.total / tot.kWh * 100).toFixed(2) + '¢' : '—', sub: 'per kWh all-in' },
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

// Kick off
loadData();
</script>
</body>
</html>`;
}
