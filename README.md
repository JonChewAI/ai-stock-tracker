# AI Stock Tracker

An educational dashboard tracking twenty AI-exposed stocks across five layers of the
AI stack. Static single page, refreshed once a day.

Built for [AI Minimalist](https://www.ai-minimalist.com/) by Jonathan Chew.

**This is a teaching demonstration, not investment advice.** Prices are end-of-day
closes pulled once daily. Nothing here is live or intraday.

---

## How it works

No server, no database, no build step. Three files do the work:

| file | role |
|---|---|
| `index.html` | the entire app - markup, styles, logic, and the ticker universe |
| `refresh.mjs` | pulls end-of-day closes, writes `data/quotes.json` |
| `.github/workflows/daily-refresh.yml` | runs the script daily and commits the result |

A commit to `data/` triggers a Vercel redeploy, so the site stays fully static.

### Refresh schedule

**Daily at 00:00 Singapore time (16:00 UTC).** Singapore has no daylight saving, so
that cron line is a fixed local time all year.

16:00 UTC is midday in New York, so a run always publishes the **last completed** US
session rather than the one in progress. The page states the as-of date it is showing.

### The call budget

The free Alpha Vantage tier allows **25 requests per day**. Two free endpoints between
them cover all four horizons:

| call | returns | drives |
|---|---|---|
| `TIME_SERIES_DAILY` (`outputsize=compact`) | 100 daily closes | 1D, 30D, 90D, last price |
| `TIME_SERIES_WEEKLY_ADJUSTED` | full weekly history | 1Y, 5Y |

`outputsize=full` is a paid feature, but the 100 compact bars already cover everything
shorter than a year, and free weekly history covers everything longer.

Two calls per ticker would cap the universe at twelve. Weekly bars only change once a
week, so they do not need refreshing daily:

- **Daily closes**: every symbol, every run. That is N calls.
- **Weekly closes**: a rotation. Each run refreshes whichever symbols are missing or
  more than six days stale, with whatever budget is left.

That makes the steady-state cost `N + ceil(N / 7)`. At twenty tickers that is 23 of 25,
two spare. `refresh.mjs` refuses to run if the universe grows past what the budget
allows, rather than silently truncating.

### Splits

`TIME_SERIES_DAILY` and `TIME_SERIES_WEEKLY` return **raw, unadjusted** prices. On a
five-year window that is not a rounding error, it is a sign error: GOOGL's 20:1 split
turns a real +138% into a reported -88%.

Three defences:

1. The weekly series uses `TIME_SERIES_WEEKLY_ADJUSTED` and reads `5. adjusted close`.
2. `deSplit()` scans the daily series for a one-session drop that lands within 12% of
   a real declared split factor (2, 3, 4, 5, 10, 20) and rescales history behind it.
   Anything short of a 1.9x step is treated as price action, not a split.
3. `healWeekly()` does the same to the weekly series, but only for 3:1 and wider, and
   it runs over the **merged** output rather than only what was fetched this run.

That third one matters because of the rotation. Only about five weeklies refresh a
night, so a series stored before the adjusted endpoint was wired up would otherwise sit
there wrong for days waiting its turn - GOOGL read -88% over five years when the real
figure was +138%. Healing the merged output fixes it on the next run instead, at no
extra API cost. On an already-adjusted series there is no split-shaped step, so it is a
no-op.

The threshold is 3:1 and not 2:1 because on a weekly bar a genuine 50% drawdown and a
2:1 split are the same shape. Those stay report-only: `findCliffs()` shouts them into
the Actions log rather than quietly patching them.

### Data shape

`data/quotes.json` carries two arrays per symbol:

- `d` - 90 daily closes
- `w` - 260 weekly closes

Every figure on the page - price, 1D, 30D, 90D, 1Y, 5Y, the chart, the sparklines - is
derived from those two arrays at render time, so the chart and the table cannot
disagree.

Names listed for less than a full window are indexed from their first available
session, so their line starts partway across and longer horizons read `n/a`.
GE Vernova is the worked example.

A symbol with no data yet is omitted from its category rather than drawn as a broken
row, so a partially-filled feed shows fewer than four names until the next run catches
up.

### The universe

All twenty tickers live in one place: a `<script type="application/json" id="universe">`
block inside `index.html`. `refresh.mjs` reads that same block, so the page and the
pipeline can never drift apart. Edit that block only.

Five categories, four names each:

| category | names |
|---|---|
| Chips & Semiconductors | NVDA, AVGO, TSM, AMD |
| Cloud & Hyperscalers | MSFT, GOOGL, AMZN, META |
| AI Software & Platforms | PLTR, CRM, NOW, SNOW |
| Infrastructure & Networking | ANET, DELL, VRT, SMCI |
| Power & Energy | GEV, ETN, CEG, VST |

There are no market-cap or P/E columns. Those are fundamentals, not price history;
this feed cannot supply them, and hardcoding them means shipping numbers that quietly
go stale.

---

## Going live

The site works immediately with built-in sample data and says so on the page: grey
beacon, `SAMPLE DATA - FEED NOT CONNECTED`. To switch it to real data:

1. Claim a free key at
   [alphavantage.co/support/#api-key](https://www.alphavantage.co/support/#api-key).
   It is issued on the page, no card, no approval wait.
2. Add it as a repository secret named `ALPHAVANTAGE_API_KEY`
   (Settings, then Secrets and variables, then Actions).
3. Run **Daily refresh** once from the Actions tab, or wait for the next scheduled run.

The badge flips to `REFRESHED DAILY - 00:00 SGT` and the beacon turns green.

### Switching provider

Set a repository **variable** `DATA_PROVIDER`. No code change needed.

| value | secret | free tier | ticker ceiling |
|---|---|---|---|
| `alphavantage` (default) | `ALPHAVANTAGE_API_KEY` | 25 calls/day | 21 |
| `twelvedata` | `TWELVEDATA_API_KEY` | 800 credits/day, 8/min | ~400 |
| `fmp` | `FMP_API_KEY` | 250 calls/day, 5yr history, US only | 250 |

### Licensing

Free tiers of every provider checked restrict use to personal, internal or non-display
purposes, which does not squarely cover a public website. This runs on a free tier as a
short educational demonstration. If it becomes a permanent public fixture, move to a
licensed end-of-day feed - EODHD at roughly USD 20/month with written display approval
is the cheapest clean route.

---

## Local development

```bash
python3 -m http.server 8000    # http://localhost:8000
```

Opening `index.html` over `file://` also works: the fetch of `data/quotes.json` fails,
and the page falls back to sample data and labels itself accordingly.

Dry run the refresh without writing:

```bash
ALPHAVANTAGE_API_KEY=xxx node refresh.mjs --dry-run
```

---

## Design notes

- Montserrat with JetBrains Mono for all figures. Zero border radius, hairline borders,
  crimson `#891B29` as the only accent. Matches
  [ai-trends.ai-minimalist.com](https://ai-trends.ai-minimalist.com/).
- Two filled bands break up the white: the status strip is near-black `#1a1a1a` with
  inverted type, the control bar is forest `#14392c`. Every foreground on them was
  contrast-checked - `#c8d6d0` on forest is 8.5:1, `#b3b3b3` on the strip is 8.3:1, and
  crimson is stepped to `#e0798c` on dark to clear 6.0:1.
- The five chart colours were validated for colour-vision deficiency against a white
  surface: worst all-pairs CVD delta-E 8.4, worst normal-vision 16.3, all above 3:1
  contrast. Comparison is capped at five series because no sixth hue clears that gate
  against the orange already in use.
- Below 900px the table becomes an accordion, so nothing scrolls sideways at any width.
- The chart tooltip pins to the card on narrow screens rather than following the finger,
  and survives lifting it. A touch fires a compatibility `mouseleave` that used to wipe
  it instantly; mouse handlers now stand down for 900ms after any touch.
