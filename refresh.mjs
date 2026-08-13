#!/usr/bin/env node
/**
 * Daily refresh for the AI Stock Tracker.
 *
 * Runs once a day at 00:00 Singapore time (16:00 UTC) from GitHub Actions,
 * writes data/quotes.json, and commits it. Vercel redeploys on that commit.
 *
 * BUDGET IS THE DESIGN CONSTRAINT.
 * Alpha Vantage's free tier allows 25 requests per day. Each ticker needs two:
 *   TIME_SERIES_DAILY  (outputsize=compact) -> 100 daily closes  -> 30D and 90D
 *   TIME_SERIES_WEEKLY (full history)       -> 260 weekly closes -> 1Y and 5Y
 * So the universe is capped at 12 tickers = 24 calls, one spare. Adding a
 * thirteenth ticker will silently starve the run - the script refuses instead.
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
async function alphavantage(symbols, key, budget){
  const out = {};
  const SPACING = 13000;   // ~4.5 calls/min, comfortably under any burst limit

  const series = async (fn, sym, node) => {
    budget.spend();
    const j = await getJSON(`https://www.alphavantage.co/query?function=${fn}&symbol=${sym}`
                          + `&outputsize=compact&apikey=${key}`);
    const gate = j && (j.Note || j.Information || j['Error Message']);
    if(gate) throw new Error(String(gate).slice(0, 140));
    const block = j && j[node];
    if(!block) return null;
    return Object.entries(block)
      .map(([t, v]) => ({ t, c: Number(v['4. close']) }))
      .filter(r => isFinite(r.c))
      .sort((a, b) => a.t < b.t ? -1 : 1);
  };

  for(const sym of symbols){
    try{
      const d = await series('TIME_SERIES_DAILY', sym, 'Time Series (Daily)');
      await sleep(SPACING);
      const w = await series('TIME_SERIES_WEEKLY', sym, 'Weekly Time Series');
      if(!d || !w){ log(`  miss ${sym}`); }
      else {
        out[sym] = { d: round(tail(d.map(r => r.c), D_PTS)),
                     w: round(tail(w.map(r => r.c), W_PTS)) };
        log(`  ok ${sym} (${out[sym].d.length}d / ${out[sym].w.length}w) - ${budget.used} calls used`);
      }
    }catch(err){
      if(err.budget){ log(`  stopping at ${sym}: daily request budget reached`); break; }
      log(`  fail ${sym}: ${err.message}`);
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
                  limit:Number(process.env.ALPHAVANTAGE_DAILY_CAP || 25), perTicker:2 },
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
  const need = symbols.length * adapter.perTicker;
  log(`${adapter.label} - ${symbols.length} symbols, ${need} calls, budget ${adapter.limit}/day`);

  if(need > adapter.limit){
    throw new Error(
      `${need} calls needed but ${adapter.label} allows ${adapter.limit}/day. ` +
      `Trim the universe in index.html to ${Math.floor(adapter.limit / adapter.perTicker)} tickers, ` +
      `or set DATA_PROVIDER to a provider with more headroom.`
    );
  }

  const budget = makeBudget(adapter.limit);
  const fresh = await adapter.fn(symbols, key, budget);

  // Carry forward anything this run missed, so one bad symbol never blanks the page.
  let prev = {};
  if(existsSync(OUT)){
    try{ prev = JSON.parse(readFileSync(OUT,'utf8')).quotes || {}; }catch{}
  }
  const quotes = {}, missing = [];
  for(const sym of symbols){
    const f = fresh[sym];
    if(f && f.d?.length && f.w?.length) quotes[sym] = { d:f.d, w:f.w };
    else if(prev[sym]) { quotes[sym] = prev[sym]; missing.push(`${sym} (kept previous)`); }
    else missing.push(`${sym} (no data)`);
  }

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
