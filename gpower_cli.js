/**
 * gpower_cli.js  —  Command-line runner
 *
 * Usage:
 *   GP_USERNAME=you@email.com  GP_PASSWORD=pass  node gpower_cli.js
 *
 * Env vars:
 *   GP_USERNAME   (required)
 *   GP_PASSWORD   (required)
 *   GP_ACCOUNT    (optional – account number; omit to pull all)
 *   CITY_LIMITS   inside | outside   (default: inside)
 *
 * Outputs:
 *   gpower_hourly_costs.csv   — one row per day, all charge components
 *   console                   — 30-day windowed summaries + last-14-day detail table
 */

import { createWriteStream } from 'fs';
import { fetchAndProcess, sumDays, RIDERS, BASE_RATES } from './gpower_core.js';

const USERNAME    = process.env.GP_USERNAME  ?? (() => { throw new Error('GP_USERNAME is not set. Copy .env.example to .env and fill in your credentials.'); })();
const PASSWORD    = process.env.GP_PASSWORD  ?? (() => { throw new Error('GP_PASSWORD is not set. Copy .env.example to .env and fill in your credentials.'); })();
const ACCOUNT     = process.env.GP_ACCOUNT;
const CITY_LIMITS = (process.env.CITY_LIMITS ?? 'inside').toLowerCase();
const START_DATE  = new Date(2026, 1, 28);   // Feb 28 2026
const END_DATE    = new Date();
const OUTPUT_CSV  = 'gpower_hourly_costs.csv';

// ─── Console formatting helpers ───────────────────────────────────────────────

const usd  = n  => `$${n.toFixed(2)}`;
const pct  = (v, tot) => `(${(v / tot * 100).toFixed(1)}%)`;
const pad  = (s, n) => String(s).padStart(n);
const hr   = c  => c.repeat(66);

function printWindowSummary(label, days) {
  if (!days.length) return;
  const t = sumDays(days);
  console.log(`\n${hr('─')}`);
  console.log(`  ${label}   [${days[0].date} → ${days.at(-1).date}]  (${days.length} days)`);
  console.log(hr('─'));
  console.log(`  Total kWh           : ${t.kWh.toFixed(1).padStart(8)}  Super Off-Pk: ${t.kWhSup.toFixed(1).padStart(7)}  Off-Pk: ${t.kWhOff.toFixed(1).padStart(7)}  On-Pk: ${t.kWhOn.toFixed(1).padStart(6)}`);
  console.log(hr('─'));
  console.log(`  Base energy charge  : ${pad(usd(t.baseEnergy), 10)}  ${pct(t.baseEnergy, t.total)}`);
  console.log(`  Basic service       : ${pad(usd(t.basicSvc),   10)}  ${pct(t.basicSvc,   t.total)}`);
  console.log(`  Fuel Cost Recovery  : ${pad(usd(t.fcr),        10)}  ${pct(t.fcr,        t.total)}`);
  console.log(`  ECCR  (16.28%)      : ${pad(usd(t.eccr),       10)}  ${pct(t.eccr,       t.total)}`);
  console.log(`  DSM-R  (1.22%)      : ${pad(usd(t.dsmr),       10)}  ${pct(t.dsmr,       t.total)}`);
  console.log(`  Muni Franchise Fee  : ${pad(usd(t.mff),        10)}  ${pct(t.mff,        t.total)}`);
  console.log(hr('─'));
  console.log(`  TOTAL (estimated)   : ${pad(usd(t.total),      10)}   avg/day: ${usd(t.total / days.length)}   avg/kWh: $${(t.total / t.kWh).toFixed(4)}`);
  console.log(`  (excl. sales tax)`);
}

function chunkBy30(days) {
  const chunks = [];
  for (let i = 0; i < days.length; i += 30) chunks.push(days.slice(i, i + 30));
  return chunks;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(hr('═'));
  console.log('  Georgia Power — Overnight Advantage (TOU-OA-14) Cost Estimator');
  console.log(hr('═'));
  console.log(`  City limits : ${CITY_LIMITS}  |  Period: ${START_DATE.toDateString()} → today`);
  console.log('  Connecting…');

  const accounts = await fetchAndProcess({
    username: USERNAME, password: PASSWORD,
    account: ACCOUNT, cityLimits: CITY_LIMITS,
    startDate: START_DATE, endDate: END_DATE,
  });

  for (const acct of accounts) {
    const { days } = acct;
    console.log(`\n  Account: ${acct.name}  (${acct.accountNumber})  — ${days.length} days of data`);

    // ── 30-day windows ────────────────────────────────────────────────────────
    const chunks = chunkBy30(days);
    chunks.forEach((chunk, i) => {
      printWindowSummary(`30-Day Window ${i + 1} of ${chunks.length}`, chunk);
    });

    // ── Full period summary ───────────────────────────────────────────────────
    if (chunks.length > 1) printWindowSummary('FULL PERIOD TOTAL', days);

    // ── Last 14 days detail table ─────────────────────────────────────────────
    console.log(`\n${hr('─')}`);
    console.log('  Last 14 Days — Detail');
    console.log(hr('─'));
    console.log('  Date        | kWh    | SuperOffPk | OffPeak | OnPeak | Est. Cost | Avg¢/kWh');
    console.log(`  ${hr('─').slice(0, 64)}`);
    days.slice(-14).forEach(r => {
      const avgCent = r.kWhTotal > 0 ? (r.totalEstimated / r.kWhTotal * 100).toFixed(2) : '—';
      console.log(
        `  ${r.date}  | ${pad(r.kWhTotal.toFixed(1), 6)} | ` +
        `${pad(r.kWhSuperOffPeak.toFixed(1), 10)} | ` +
        `${pad(r.kWhOffPeak.toFixed(1), 7)} | ` +
        `${pad(r.kWhOnPeak.toFixed(1), 6)} | ` +
        `${pad(usd(r.totalEstimated), 9)} | ${pad(avgCent, 5)}¢`
      );
    });

    // ── Write CSV ─────────────────────────────────────────────────────────────
    const mffLabel = CITY_LIMITS === 'outside' ? '1.19pct' : '3.07pct';
    const header = [
      'Date','kWh_Total','kWh_SuperOffPeak_11p-7a','kWh_OffPeak',
      'kWh_OnPeak_JunSep_Wkdy_2p-7p','Base_Energy_Charge','Basic_Service_Charge',
      'Base_Bill_Subtotal','Fuel_Cost_Recovery_TOU-FCR-6','ECCR_16.28pct_ECCR-11',
      `DSM-R_1.22pct_DSM-R-15`,`MFF_${mffLabel}_MFF-10`,'Total_Estimated_Cost',
    ].join(',');

    const rows = days.map(r => [
      r.date, r.kWhTotal, r.kWhSuperOffPeak, r.kWhOffPeak, r.kWhOnPeak,
      r.baseEnergy, r.basicSvc, r.baseBill, r.fcrCharge,
      r.eccrCharge, r.dsmrCharge, r.mffCharge, r.totalEstimated,
    ].join(','));

    const ws = createWriteStream(OUTPUT_CSV);
    ws.write([header, ...rows].join('\n'));
    ws.end();
    console.log(`\n  CSV → ${OUTPUT_CSV}`);
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
