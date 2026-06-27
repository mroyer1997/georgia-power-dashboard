/**
 * emporia_core.js
 * Node.js wrapper around emporia_fetch.py.
 * Manages a disk cache (emporia_cache.json) keyed by YYYY-MM-DD,
 * spawns the Python script only for uncached / recently-stale days,
 * and exports fetchEmporiaEV() for use by gpower_server.js.
 *
 * Returns an empty object silently when EMPORIA_USERNAME is not set,
 * so the feature is fully opt-in.
 */

import { spawn }                             from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath }                     from 'url';
import { dirname, join }                     from 'path';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE  = join(__dirname, 'emporia_cache.json');
const FETCH_SCRIPT = join(__dirname, 'emporia_fetch.py');

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.warn('[emporia] Could not read cache:', e.message);
    return {};
  }
}

function saveCache(cache) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('[emporia] Could not write cache:', e.message);
  }
}

// ISO date string for N days ago
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Array of YYYY-MM-DD strings between two date strings, inclusive
function eachDay(startKey, endKey) {
  const days = [];
  const d = new Date(startKey + 'T12:00:00');
  const e = new Date(endKey   + 'T12:00:00');
  while (d <= e) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// Async wrapper around child_process.spawn — resolves with stdout string
function runPython(startKey, endKey) {
  const gid = process.env.EMPORIA_DEVICE_GID ?? '572839';
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      FETCH_SCRIPT,
      '--start', startKey,
      '--end',   endKey,
      '--gid',   gid,
    ], { env: process.env });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', code => {
      if (stderr.trim()) console.log('[emporia py]', stderr.trim().slice(0, 800));
      if (code !== 0) return reject(new Error(`emporia_fetch.py exited ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout);
    });
    proc.on('error', err => reject(new Error(`Could not spawn python3: ${err.message}`)));
  });
}

/**
 * Fetch daily EV kWh for the given date range.
 * Returns { 'YYYY-MM-DD': kWh, … } filtered to the requested range.
 * Always re-fetches the last 2 days (Emporia data can arrive late).
 */
export async function fetchEmporiaEV({ startDate, endDate }) {
  if (!process.env.EMPORIA_USERNAME || !process.env.EMPORIA_PASSWORD) return {};

  const cache    = loadCache();
  const cutoff   = daysAgo(2);
  const startKey = startDate.toISOString().slice(0, 10);
  const endKey   = endDate.toISOString().slice(0, 10);
  const allDays  = eachDay(startKey, endKey);
  const toFetch  = allDays.filter(d => !(d in cache) || d >= cutoff);

  if (toFetch.length > 0) {
    const fetchStart = toFetch[0];
    const fetchEnd   = toFetch[toFetch.length - 1];
    console.log(`[emporia] Fetching ${toFetch.length} days (${fetchStart} → ${fetchEnd})…`);
    try {
      const raw     = await runPython(fetchStart, fetchEnd);
      const records = JSON.parse(raw);
      for (const r of records) cache[r.date] = r.evKwh;
      saveCache(cache);
      console.log(`[emporia] ${records.length} days cached → emporia_cache.json`);
    } catch (e) {
      console.warn('[emporia] Fetch failed:', e.message);
    }
  } else {
    console.log(`[emporia] All ${allDays.length} days already cached`);
  }

  return Object.fromEntries(
    allDays.filter(d => d in cache).map(d => [d, cache[d]])
  );
}
