"""
Builds public/data/: daily *total-return* OHLC (dividends and splits adjusted) for every
symbol in scripts/universe.py, from Yahoo Finance via yfinance, plus the weekly screener metrics.

    pip install yfinance pandas
    python scripts/update_data.py
    node scripts/build_summary.mjs      # adds the backtest summary of every symbol

Format (compact, column-oriented, one file per symbol because 210 symbols of OHLC do not fit one file):
    public/data/daily/<SYMBOL>.json
        {"asOf": "YYYY-MM-DD", "adjusted": true, "source": "...", "dates": [...],
         "open": [...], "high": [...], "low": [...], "close": [...]}
    public/data/universe.json
        {"asOf": ..., "coverage": {...}, "sectors": [{yf_symbol, file, name, ..., weekly metrics}]}
"""
import json
import math
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

from universe import SECTOR_UNIVERSE

OUT = Path(__file__).resolve().parent.parent / "public" / "data"
SOURCE = "Yahoo Finance via yfinance, auto_adjust=True (total return: dividends and splits)"
RISK_FREE = "^IRX"  # 13-week T-bill yield: cash return while flat, and the Sharpe hurdle
MAX_FAILED = 10     # a few delisted symbols are tolerated; a Yahoo outage is not


def sig(x: float, digits: int = 6):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    if x == 0:
        return 0
    return round(x, max(0, digits - 1 - int(math.floor(math.log10(abs(x))))))


def file_name(sym: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", sym) + ".json"


def fetch(sym: str):
    try:
        df = yf.Ticker(sym).history(period="max", interval="1d", auto_adjust=True)
    except Exception:
        return None
    if df is None or df.empty:
        return None
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    df = df.dropna(subset=["Close"])
    df = df[df["Close"] > 0]
    # Completed sessions only: today's bar may still be trading (crypto always is).
    df = df[df.index < pd.Timestamp(datetime.now(timezone.utc).date())]
    for col in ("Open", "High", "Low"):
        df[col] = df[col].where(df[col] > 0, df["Close"])
    return df if len(df) else None


def pct(cur: float, prev: float):
    if not prev or math.isnan(prev) or math.isnan(cur):
        return None
    return round((cur / prev - 1.0) * 100.0, 2)


def rsi(series: pd.Series, period: int = 14) -> float:
    if len(series) < period + 2:
        return 50.0
    delta = series.diff()
    gain = delta.clip(lower=0.0).ewm(alpha=1.0 / period, adjust=False).mean().iloc[-1]
    loss = (-delta.clip(upper=0.0)).ewm(alpha=1.0 / period, adjust=False).mean().iloc[-1]
    if loss == 0:
        return 100.0 if gain > 0 else 50.0
    return round(100.0 - 100.0 / (1.0 + gain / loss), 1)


def weekly_metrics(item: dict, daily: pd.DataFrame, spx_weekly: pd.Series | None) -> dict:
    """Screener row: weekly returns, trend, relative strength vs the S&P 500 and a composite score."""
    wk = daily.resample("W-FRI").agg({"High": "max", "Low": "min", "Close": "last"}).dropna()
    closes = wk["Close"]
    n = len(closes)
    last = float(closes.iloc[-1])
    start, end = daily.index[0], daily.index[-1]
    years = round((end - start).days / 365.25, 1)

    def back(k):
        return pct(last, float(closes.iloc[-k - 1])) if n >= k + 1 else None

    ret_1w, ret_4w, ret_13w, ret_26w, ret_52w = back(1), back(4), back(13), back(26), back(52)
    prior = daily["Close"][daily.index.year < end.year]
    ret_ytd = pct(float(daily["Close"].iloc[-1]), float(prior.iloc[-1])) if len(prior) else None

    def ema(span):
        return float(closes.ewm(span=span, adjust=False).mean().iloc[-1])

    ema10, ema20, ema50, ema200 = ema(10), ema(20), ema(50), ema(200)
    rsi_14w = rsi(closes)
    rets = closes.pct_change().dropna().iloc[-52:]
    vol_52w = round(float(rets.std() * math.sqrt(52.0) * 100.0), 1) if len(rets) >= 8 else None

    rs_13w = rs_52w = None
    rs_ratio = rs_momentum = 100.0
    quadrant = "Neutral"
    if spx_weekly is not None:
        al = pd.concat([closes.rename("sec"), spx_weekly.rename("spx")], axis=1).sort_index().ffill().dropna()
        if len(al) >= 20:
            ratio = al["sec"] / al["spx"]
            mansfield = (ratio / ratio.rolling(min(52, len(ratio))).mean() * 100.0).dropna()
            if len(mansfield) >= 2:
                rs_ratio = round(float(mansfield.iloc[-1]), 2)
                ref = mansfield.iloc[-14] if len(mansfield) >= 14 else mansfield.iloc[0]
                rs_momentum = round(100.0 + float(mansfield.iloc[-1]) - float(ref), 2)
            quadrant = (("Leading" if rs_momentum >= 100 else "Weakening") if rs_ratio >= 100
                        else ("Lagging" if rs_momentum < 100 else "Improving"))
            spx = al["spx"]
            if len(al) >= 14 and ret_13w is not None:
                rs_13w = round(ret_13w - pct(float(spx.iloc[-1]), float(spx.iloc[-14])), 2)
            if len(al) >= 53 and ret_52w is not None:
                rs_52w = round(ret_52w - pct(float(spx.iloc[-1]), float(spx.iloc[-53])), 2)

    score = 50.0
    score += 6 * (last > ema10) + 8 * (last > ema20) + 10 * (last > ema50) + 6 * (last > ema200) + 5 * (ema20 > ema50)
    if ret_13w is not None:
        score += max(-12.0, min(12.0, ret_13w * 0.5))
    if rs_13w is not None:
        score += max(-10.0, min(10.0, rs_13w * 0.6))
    score += max(-8.0, min(8.0, (rsi_14w - 50.0) * 0.3))

    sym = item["yf"]
    return {
        "yf_symbol": sym, "file": file_name(sym), "tv_symbol": item["tv"], "tv_index": item["tv_index"],
        "name": item["name"], "sector": item["sector"], "category": item["category"], "region": item["region"],
        # Indexes and continuous futures are price-only (no dividends, roll gaps) and cannot be bought as such.
        "tradable": not (sym.startswith("^") or sym.endswith("=F") or sym.endswith(".NYB")),
        "start_date": start.strftime("%Y-%m-%d"), "end_date": end.strftime("%Y-%m-%d"), "years": years,
        "last_close": round(last, 2),
        "ret_1w": ret_1w, "ret_4w": ret_4w, "ret_13w": ret_13w, "ret_26w": ret_26w, "ret_52w": ret_52w, "ret_ytd": ret_ytd,
        "rsi_14w": rsi_14w, "vol_52w": vol_52w,
        "rs_13w": rs_13w, "rs_52w": rs_52w, "rs_ratio": rs_ratio, "rs_momentum": rs_momentum, "quadrant": quadrant,
        "composite_score": round(max(0.0, min(100.0, score)), 1),
    }


def write_daily(sym: str, df: pd.DataFrame):
    out = {
        "asOf": df.index[-1].strftime("%Y-%m-%d"), "adjusted": True, "source": SOURCE,
        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
        "open": [sig(v) for v in df["Open"].tolist()], "high": [sig(v) for v in df["High"].tolist()],
        "low": [sig(v) for v in df["Low"].tolist()], "close": [sig(v) for v in df["Close"].tolist()],
    }
    (OUT / "daily" / file_name(sym)).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")


def main():
    (OUT / "daily").mkdir(parents=True, exist_ok=True)
    symbols = [x["yf"] for x in SECTOR_UNIVERSE] + [RISK_FREE]
    with ThreadPoolExecutor(max_workers=8) as ex:
        frames = dict(zip(symbols, ex.map(fetch, symbols)))
    failed = [s for s in symbols if frames[s] is None]
    if len(failed) > MAX_FAILED or frames.get("^GSPC") is None or frames[RISK_FREE] is None:
        sys.exit(f"No data for {len(failed)} symbols, nothing written: {', '.join(failed)}")

    write_daily(RISK_FREE, frames[RISK_FREE])
    spx_weekly = frames["^GSPC"]["Close"].resample("W-FRI").last().dropna()
    rows = []
    for item in SECTOR_UNIVERSE:
        df = frames[item["yf"]]
        if df is None:
            continue  # keep last week's file
        write_daily(item["yf"], df)
        rows.append(weekly_metrics(item, df, spx_weekly))
    rows.sort(key=lambda r: (-r["composite_score"], -r["years"]))

    years = [r["years"] for r in rows]
    cats: dict = {}
    for r in rows:
        c = cats.setdefault(r["category"], {"count": 0, "max_years": 0.0, "min_years": 999.0, "earliest_start": "9999"})
        c["count"] += 1
        c["max_years"] = max(c["max_years"], r["years"])
        c["min_years"] = min(c["min_years"], r["years"])
        c["earliest_start"] = min(c["earliest_start"], r["start_date"])

    as_of = frames["^GSPC"].index[-1].strftime("%Y-%m-%d")
    universe = {
        "asOf": as_of, "adjusted": True, "source": SOURCE, "risk_free_file": file_name(RISK_FREE),
        "total_candidates": len(SECTOR_UNIVERSE), "total_verified": len(rows),
        "failed_count": len(failed), "failed_symbols": failed,
        "coverage": {
            "max_years": max(years), "median_years": round(float(np.median(years)), 1), "min_years": min(years),
            **{f"count_{k}y_plus": sum(y >= k for y in years) for k in (30, 25, 20, 15, 10)},
            "by_category": cats,
        },
        "sectors": rows,
    }
    (OUT / "universe.json").write_text(json.dumps(universe, separators=(",", ":")), encoding="utf-8")
    size = sum(f.stat().st_size for f in (OUT / "daily").glob("*.json")) / 1e6
    print(f"Wrote {len(rows)} symbols ({size:.0f} MB) as of {as_of}; failed: {failed or 'none'}")


if __name__ == "__main__":
    main()
