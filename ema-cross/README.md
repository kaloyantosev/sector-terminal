# EMA 200/300 staggered cross: longs and shorts

Event study of one rule on every symbol in `public/data/daily/` (Yahoo Finance daily OHLC, refreshed weekly by this repo's GitHub Action).

## Rules

- Daily Heikin Ashi candles. EMA 200 and EMA 300 are on the HA close.
- **Long:** the HA candle broke below both lines (any part of the HA body under both counts), then the whole HA body (open and close) is above both. Enter at that day's real close.
- **Short:** the mirror.
- A one-candle cross of both lines counts. A dip that never breaks the second line is not a signal.
- **Flat filter:** no signal when the EMAs are tangled (within 1% of each other) and flat (EMA 200 moved under 2% in 20 days).
- **Stop:** beyond the far line, buffer = 2% + the gap between the lines. Longs: lower EMA x (1 - buffer), hit on the daily low. Shorts: upper EMA x (1 + buffer), hit on the daily high. Fixed at entry; fills at the stop or the open if it gaps through.
- No exit rule. Results are the return after 1, 4, 8, 12, 16 and 20 weeks, or the stop loss if hit first.
- Skipped: `^IRX`, `^TNX`, `^VIX` (yields and volatility).

## Files

- `strategy.js`: the rule (used by the site and the build).
- `build.mjs`: fetches every symbol from this repo on GitHub, runs the rule, writes `summary.json`.
- `index.html`, `app.js`: the site. Per-symbol charts and trades load live from `public/data/daily/`.
- `backtest/ema_200_300_test.py`: the same rule in Python, with a text report.
- `tradingview/ema_200_300_ha_cross.pine`: the same rule as a TradingView indicator (paste into the Pine Editor, daily chart).

## Run

```bash
node build.mjs ../public/data
python -m http.server 8123
python backtest/ema_200_300_test.py ../public/data
```

Deployed on Vercel with this folder as the project root (`vercel.json`). Not investment advice.
