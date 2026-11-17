# Sector Daily Terminal: 300/50 EMA + smoothed RSI backtest

> The site's main page is now the EMA 200/300 Heikin Ashi cross study in [`ema-cross/`](ema-cross/). The terminal described below lives at `classic.html`.

## The strategy: sector rotation

Every close, all US-listed sector ETFs in the universe (about 140) are screened with the signal rules below.

- A **buy** signal enters the sector at the next close. Buys on the same day split the money equally.
- A position is held until **that sector's own sell** signal, then sold at the next close.
- **One fund per sector**, so XLK, VGT and IYW buying together are one tech position. The fund with the longer history wins.
- **Cash only** (default): new buys use idle cash only; when fully invested, new signals are skipped. **Equal-weight on new buy**: a new buy resizes all holdings to an equal share, so no signal is skipped.
- Idle cash earns T-bills. The benchmark is SPY with dividends.

Not in the rotation: price indexes and futures (not investable), EUR-listed STOXX funds (currency mismatch), and macro sleeves (bonds, VIX, dollar, crypto). The fund list is today's, so newer thematic ETFs carry survivorship bias.

## The signal rules

Each symbol is also backtested alone against buy & hold of the same symbol:

- **Buy A:** price reclaims the 300-day EMA after a dip in which the smoothed RSI (200-day EMA of RSI 14) held above 50.
- **Buy B:** price reclaims the 300-day and 50-day EMA after a dip in which the smoothed RSI broke 50.
- **Bounce:** after a momentum exit, an ATR-filtered reclaim of the 50-day EMA with a 10-day breakout.
- **Sell 50:** a clean break of the 50-day EMA while the smoothed RSI rolls over.
- **Sell both:** a close below both the 300-day and 50-day EMA.

The site shows the signal chart, the stats against buy & hold (return, CAGR, max drawdown, volatility, Sharpe vs T-bills), a card for every year, the trade log, a sector rotation map, and a screener of every symbol. Click a year and the stats and chart switch to that year. Change a parameter and the backtest reruns in the browser.

## How it is tested

- **Total-return prices** (dividends reinvested) for ETFs. Symbols tagged IDX are price indexes or continuous futures: no dividends, and not investable as shown.
- **Next-day execution:** signals use the day's close and fill at the next close, with 0.10% cost per fill.
- **Cash earns T-bills** (^IRX) while flat. Sharpe is measured against T-bills.
- **Warm-up:** the first 600 bars only build the indicators. Buy & hold starts on the same bar as the strategy. Symbols with under 852 bars are not backtested.
- **One continuous run:** each year is a slice of the same equity curve, measured close to close.

The default parameters were chosen on this same history. Treat the backtest as in-sample. With the defaults, the strategy beats buy & hold on CAGR in about 1 symbol in 10, and has the smaller max drawdown in about 9 in 10.

## Data

`public/data/daily/<SYMBOL>.json` holds dividend- and split-adjusted daily OHLC from Yahoo Finance (via `yfinance`). `public/data/universe.json` holds the screener metrics and every symbol's backtest summary. A GitHub Action refreshes both every week; to refresh by hand:

```bash
pip install yfinance pandas
python scripts/update_data.py
node scripts/build_summary.mjs
```

## Develop

It is a static site: serve the folder and open it.

```bash
python -m http.server 8095
node scripts/test_strategy.mjs
```

Not investment advice.
