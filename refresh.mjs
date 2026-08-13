#!/usr/bin/env node
/**
 * Daily refresh for the AI Stock Tracker.
 *
 * Runs once a day at 00:00 Singapore time (16:00 UTC) from GitHub Actions,
 * writes data/quotes.json, and commits it. Vercel redeploys on that commit.
 *
 * BUDGET IS THE DESIGN CONSTRAINT.
 * Alpha Vantage's free tier allows 25 requests per day.
 *   TIME_SERIES_DAILY (compact)      -> 100 daily closes  -> 1D, 30D, 90D
 *   TIME_SERIES_WEEKLY_ADJUSTED      -> 260 weekly closes -> 1Y, 5Y
 *
 * Daily prices must be fresh every day, so that is N calls. Weekly bars only
 * change once a week, so they are refreshed on a rotation with whatever budget
 * is left over - each symbol comes round every few days, which costs nothing in
 * accuracy. That gives N + ceil(N/7) <= 25, so N = 20 fits comfortably at 23.
 *
 * SPLITS. TIME_SERIES_WEEKLY and TIME_SERIES_DAILY return RAW prices with no
 * split adjustment. Left uncorrected, Alphabet's 20:1 split makes its 5Y return
 * read -88% instead of +138%. We request the ADJUSTED weekly series, and run a
 * de-splitting pass over both series as a backstop.
 *
 * Output:
 *   { meta:{generatedAt, asOf, source, schedule, coverage, missing[], callsUsed},
 *     quotes:{ NVDA:{ d:[...90], w:[...260] }, ... } }
 *
 * Switch provider with DATA_PROVIDER (alphavantage | twelvedata | fmp).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT  = join(ROOT, 'data', 'quotes.json');

const D_PTS = 90;    // daily closes  -> 30D and 90D
const W_PTS = 260;   // weekly closes -> 1Y and 5Y

const PROVIDER = (process.env.DATA_PROVIDER || 'alphavantage').toLowerCase();
const DRY = process.argv.includes('--dry-run');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log('[refresh]', ...a);
const tail  = (a, n) => a.slice(Math.max(0, a.length - n));
const round = a => a.map(v => +Number(v).toFixed(2));

/* The universe lives in index.html so the page and this pipeline cannot drift. */
function readUniverse(){
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<script type="application\/json" id="universe">([\s\S]*?)<\/script>/);
  if(!m) throw new Error('universe block not found in index.html');
  const list = JSON.parse(m[1]);
  if(!Array.isArray(list) || !list.length) throw new Error('universe block is empty');
  return list.map(u => u.s);
}

/* Hard budget guard. Every provider call goes through this. */
function makeBudget(limit){
  let used = 0;
  return {
    get used(){ return used; },
    left(){ return limit - used; },
    spend(n = 1){
      if(used + n > limit) throw Object.assign(new Error('budget exhausted'), { budget:true });
      used += n;
    }
  };
}

async function getJSON(url, tries = 2){
  for(let attempt = 1; attempt <= tries; attempt++){
    try{
      const res = await fetch(url, { headers:{ 'User-Agent':'ai-stock-tracker/1.0 (educational)' } });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(err){
      if(attempt === tries) throw err;
      await sleep(4000 * attempt);
    }
  }
}

/* Undo split cliffs in a raw close series.
   A split shows up as a single step whose ratio is close to a known split
   factor. We snap to the nearest known factor rather than the observed ratio,
   so genuine price movement in that period is preserved. */
const SPLIT_FACTORS = [2, 3, 4, 5, 10, 20];   // what companies actually declare
const MIN_RATIO = 1.9;                        // below this it is price action, not a split
const TOLERANCE = 0.12;                       // the step also carries that day's real move
function deSplit(series){
  const out = series.slice();
  const notes = [];
  for(let i = out.length - 1; i > 0; i--){
    const ratio = out[i-1] / out[i];
    if(!isFinite(ratio) || ratio < MIN_RATIO) continue;
    let best = null, bestErr = Infinity;
    for(const f of SPLIT_FACTORS){
      const err = Math.abs(ratio - f) / f;
      if(err < bestErr){ bestErr = err; best = f; }
    }
    if(best == null || bestErr > TOLERANCE) continue;   // not split-shaped, leave it alone
    for(let k = 0; k < i; k++) out[k] /= best;
    notes.push(`${best}:1 at index ${i} (observed ${ratio.toFixed(2)}x)`);
  }
  return { series: out, notes };
}

/* Report-only variant for the ADJUSTED weekly series. If Alpha Vantage's
   adjustment is doing its job there is nothing to find; if a cliff survives we
   want it shouting in the Actions log rather than quietly patched, because on a
   weekly bar a real 50% drawdown and a 2:1 split look identical. */
function findCliffs(series){
  const hits = [];
  for(let i = 1; i < series.length; i++){
    const ratio = series[i-1] / series[i];
    if(isFinite(ratio) && ratio >= MIN_RATIO) hits.push(`index ${i} drops ${ratio.toFixed(2)}x`);
  }
  return hits;
}

function toWeekly(dailyOldestFirst){
  const byWeek = new Map();
  for(const row of dailyOldestFirst){
    const d = new Date(row.t + 'T00:00:00Z');
    const th = new Date(d); th.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const key = `${th.getUTCFullYear()}-${Math.ceil((((th - Date.UTC(th.getUTCFullYear(),0,1))/86400000)+1)/7)}`;
    byWeek.set(key, row.c);
  }
  return [...byWeek.values()];
}

/* ===============================================================
   ADAPTERS - each returns { SYM: { d:[...], w:[...] } }
   =============================================================== */

/* --- Alpha Vantage (default) -----------------------------------
   Free: 25 requests/day. outputsize=full is paid, so the daily
   series caps at 100 bars - which is exactly what the 30D and 90D
   horizons need. TIME_SERIES_WEEKLY is free with full history and
   covers 1Y and 5Y. Two calls per ticker, 12 tickers, 24 calls.   */
async function alphavantage(symbols, key, budget, prev){
  const out = {};
  const SPACING = 13000;   // ~4.5 calls/min, comfortably under any burst limit

  const series = async (fn, sym, node, closeField) => {
    budget.spend();
    const j = await getJSON(`https://www.alphavantage.co/query?function=${fn}&symbol=${sym}`
                          + `&outputsize=compact&apikey=${key}`);
    const gate = j && (j.Note || j.Information || j['Error Message']);
    if(gate) throw new Error(String(gate).slice(0, 140));
    const block = j && j[node];
    if(!block) return null;
    return Object.entries(block)
      .map(([t, v]) => ({ t, c: Number(v[closeField] ?? v['4. close']) }))
      .filter(r => isFinite(r.c) && r.c > 0)
      .sort((a, b) => a.t < b.t ? -1 : 1);
  };

  // --- pass 1: daily closes for every symbol, every day ---
  for(const sym of symbols){
    try{
      const d = await series('TIME_SERIES_DAILY', sym, 'Time Series (Daily)', '4. close');
      if(!d){ log(`  miss ${sym} (daily)`); }
      else {
        const fixed = deSplit(d.map(r => r.c));
        out[sym] = { d: round(tail(fixed.series, D_PTS)) };
        if(fixed.notes.length) log(`  ${sym} daily de-split: ${fixed.notes.join(', ')}`);
      }
    }catch(err){
      if(err.budget){ log(`  stopping at ${sym}: request budget reached`); break; }
      log(`  fail ${sym} (daily): ${err.message}`);
    }
    await sleep(SPACING);
  }

  // --- pass 2: weekly, rotated. Missing first, then oldest. ---
  const now = Date.now();
  const ageOf = sym => {
    const at = prev[sym] && prev[sym].wAt ? Date.parse(prev[sym].wAt) : 0;
    return isFinite(at) ? now - at : Infinity;
  };
  const queue = symbols
    .filter(s => out[s])                                   // only ones whose daily worked
    .sort((a, b) => ageOf(b) - ageOf(a))                   // stalest (and missing) first
    .filter(s => !prev[s] || !prev[s].w || !prev[s].w.length || ageOf(s) > 6 * 864e5);

  log(`  weekly rotation: ${queue.length} due, ${budget.left()} calls left`);
  for(const sym of queue){
    if(budget.left() < 1) { log('  weekly rotation stops here, budget spent'); break; }
    try{
      const w = await series('TIME_SERIES_WEEKLY_ADJUSTED', sym, 'Weekly Adjusted Time Series', '5. adjusted close');
      if(!w){ log(`  miss ${sym} (weekly)`); }
      else {
        const closes = w.map(r => r.c);
        const cliffs = findCliffs(closes);
        if(cliffs.length) log(`  WARNING ${sym}: adjusted weekly still has cliffs - ${cliffs.join('; ')}`);
        out[sym].w = round(tail(closes, W_PTS));
        out[sym].wAt = new Date().toISOString();
        log(`  ok ${sym} weekly (${out[sym].w.length}w)`);
      }
    }catch(err){
      if(err.budget){ log('  weekly rotation stops here, budget spent'); break; }
      log(`  fail ${sym} (weekly): ${err.message}`);
    }
    await sleep(SPACING);
  }
  return out;
}

/* --- Twelve Data ------------------------------------------------
   Free Basic: 800 credits/day, 8/minute. Batches of 8 symbols sit
   exactly on the per-minute cap. Kept here so DATA_PROVIDER can
   move to it without a code change if the universe grows.          */
async function twelvedata(symbols, key, budget){
  const BATCH = 8, WAIT = 62000, out = {};
  const pull = async (interval, size, field) => {
    for(let i = 0; i < symbols.length; i += BATCH){
      const chunk = symbols.slice(i, i + BATCH);
      budget.spend(chunk.length);
      const j = await getJSON(`https://api.twelvedata.com/time_series?symbol=${chunk.join(',')}`
                            + `&interval=${interval}&outputsize=${size}&order=ASC&apikey=${key}&format=JSON`);
      if(j && j.code && j.code !== 200) throw new Error(`Twelve Data: ${j.message || j.code}`);
      for(const sym of chunk){
        const node = chunk.length === 1 ? j : j[sym];
        const vals = node && node.values;
        if(!Array.isArray(vals) || !vals.length){ log(`  miss ${sym} (${interval})`); continue; }
        (out[sym] ||= {})[field] = round(vals.map(v => Number(v.close)));
      }
      if(i + BATCH < symbols.length) await sleep(WAIT);
    }
  };
  await pull('1day', D_PTS, 'd');
  await sleep(WAIT);
  await pull('1week', W_PTS, 'w');
  return out;
}

/* --- Financial Modeling Prep ------------------------------------
   Free: 250 calls/day, exactly 5 years of history, US only.        */
async function fmp(symbols, key, budget){
  const out = {};
  const from = new Date(Date.now() - 5.2 * 365 * 86400000).toISOString().slice(0,10);
  const to   = new Date().toISOString().slice(0,10);
  for(const sym of symbols){
    try{
      budget.spend();
      const j = await getJSON(`https://financialmodelingprep.com/stable/historical-price-eod/light`
                            + `?symbol=${sym}&from=${from}&to=${to}&apikey=${key}`);
      const rows = (Array.isArray(j) ? j : j && j.historical) || [];
      if(!rows.length){ log(`  miss ${sym}`); continue; }
      const daily = rows.map(r => ({ t:r.date, c:Number(r.close ?? r.price) }))
                        .filter(r => r.t && isFinite(r.c))
                        .sort((a,b) => a.t < b.t ? -1 : 1);
      out[sym] = { d: round(tail(daily.map(r=>r.c), D_PTS)), w: round(tail(toWeekly(daily), W_PTS)) };
    }catch(err){
      if(err.budget){ log('  stopping: budget reached'); break; }
      log(`  fail ${sym}: ${err.message}`);
    }
    await sleep(400);
  }
  return out;
}

const ADAPTERS = {
  alphavantage: { fn:alphavantage, env:'ALPHAVANTAGE_API_KEY', label:'Alpha Vantage',
                  limit:Number(process.env.ALPHAVANTAGE_DAILY_CAP || 25), rotates:true },
  twelvedata:   { fn:twelvedata,   env:'TWELVEDATA_API_KEY',   label:'Twelve Data',
                  limit:800, perTicker:2 },
  fmp:          { fn:fmp,          env:'FMP_API_KEY',          label:'Financial Modeling Prep',
                  limit:250, perTicker:1 }
};

/* =============================================================== */
async function main(){
  const adapter = ADAPTERS[PROVIDER];
  if(!adapter) throw new Error(`Unknown DATA_PROVIDER "${PROVIDER}". Use: ${Object.keys(ADAPTERS).join(', ')}`);

  const key = process.env[adapter.env];
  if(!key){
    log(`No ${adapter.env} set. Nothing written - the site stays on its built-in sample data.`);
    log(`Add ${adapter.env} as a repository secret to switch it live.`);
    process.exit(0);
  }

  const symbols = readUniverse();

  // Previous snapshot is an input now: it tells the rotation which weeklies are stale.
  let prev = {};
  if(existsSync(OUT)){
    try{ prev = JSON.parse(readFileSync(OUT,'utf8')).quotes || {}; }catch{}
  }

  const need = adapter.rotates
    ? symbols.length + Math.ceil(symbols.length / 7)   // daily every day + weekly on rotation
    : symbols.length * adapter.perTicker;
  log(`${adapter.label} - ${symbols.length} symbols, ~${need} calls, budget ${adapter.limit}/day`);

  if(need > adapter.limit){
    const max = adapter.rotates
      ? Math.floor(adapter.limit * 7 / 8)
      : Math.floor(adapter.limit / adapter.perTicker);
    throw new Error(
      `~${need} calls needed but ${adapter.label} allows ${adapter.limit}/day. ` +
      `Trim the universe in index.html to ${max} tickers, ` +
      `or set DATA_PROVIDER to a provider with more headroom.`
    );
  }

  const budget = makeBudget(adapter.limit);
  const fresh = await adapter.fn(symbols, key, budget, prev);

  // Merge per field: a symbol whose weekly was not due this run keeps the stored one.
  const quotes = {}, missing = [];
  let staleWeek = 0;
  for(const sym of symbols){
    const f = fresh[sym] || {}, p0 = prev[sym] || {};
    const d = (f.d && f.d.length) ? f.d : p0.d;
    const w = (f.w && f.w.length) ? f.w : p0.w;
    const wAt = f.wAt || p0.wAt || null;
    if(d && d.length && w && w.length){
      quotes[sym] = { d, w, wAt };
      if(!f.d || !f.d.length) missing.push(`${sym} (daily kept from previous)`);
      if(!f.w || !f.w.length) staleWeek++;
    } else if(d && d.length){
      quotes[sym] = { d, w: [], wAt };          // short horizons work, 1Y/5Y read n/a
      missing.push(`${sym} (no weekly yet)`);
    } else {
      missing.push(`${sym} (no data)`);
    }
  }
  if(staleWeek) log(`${staleWeek} symbols kept their stored weekly series (not due this rotation)`);

  const covered = Object.keys(quotes).length;
  if(covered === 0) throw new Error('No symbols returned data - refusing to write an empty snapshot.');

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      asOf: new Date().toISOString().slice(0,10),
      source: adapter.label,
      schedule: 'Daily at 00:00 SGT (16:00 UTC)',
      coverage: `${covered}/${symbols.length}`,
      callsUsed: `${budget.used}/${adapter.limit}`,
      splitAdjusted: true,
      missing
    },
    quotes
  };

  if(DRY){ log('dry run, not writing'); log(JSON.stringify(payload.meta, null, 1)); return; }
  mkdirSync(dirname(OUT), { recursive:true });
  writeFileSync(OUT, JSON.stringify(payload));
  log(`wrote data/quotes.json - ${covered}/${symbols.length} symbols, ${budget.used}/${adapter.limit} calls`);
}

main().catch(err => { console.error('[refresh] FAILED:', err.message); process.exit(1); });
