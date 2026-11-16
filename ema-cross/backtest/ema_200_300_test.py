"""200/300 EMA staggered-cross event study on every symbol in sector-terminal's data. Longs and shorts.

Decisions use Heikin Ashi closes (EMAs on HA close, crosses of HA close). Entry fills at the real close.
Long entry (daily close): HA close was below BOTH EMA200 and EMA300, then closed above one of them, and on a
later day closed above the other. A dip under one line followed by a reclaim of it (price never below both)
is NOT a signal. A same-day cross of both lines is skipped.
Short entry: the mirror. Price was above both, closed below one, later closed below the other.
Stop: beyond the far line at entry (lower EMA for longs, upper EMA for shorts), with a buffer that widens with the gap:
    buffer = BASE_BUF + GAP_MULT * gap,   gap = (upper - lower) / lower
Stop is fixed at entry and checked on each day's low (longs) / high (shorts); fill at stop, or at the open if it gaps through.
No exit rule: for each horizon we report the return if held that long, or the stop return if hit first.
Short return = 1 - exit / entry. Each signal is an independent event.

Usage: python ema_200_300_test.py repo/public/data
"""
import json, sys, os
import numpy as np
import pandas as pd

BASE_BUF, GAP_MULT = 0.02, 1.0           # 2% base slippage + 1x the EMA gap
HORIZONS = {"1w": 5, "4w": 20, "8w": 40, "12w": 60, "16w": 80, "20w": 100}
SKIP = {"_IRX.json", "_TNX.json", "_VIX.json"}   # yields / volatility, not price trends
WARMUP = 300


def ema(x, n):
    return pd.Series(x).ewm(span=n, adjust=False).mean().to_numpy()


def events(d):
    o, h, l, c = (np.asarray(d[k], float) for k in ("open", "high", "low", "close"))
    hc = (o + h + l + c) / 4  # Heikin Ashi close: decisions use it; fills, stops and returns use real prices
    e200, e300 = ema(hc, 200), ema(hc, 300)
    side = np.where((hc > e200) & (hc > e300), 1, np.where((hc < e200) & (hc < e300), -1, 0))  # +1 above both, -1 below both
    out = []
    last = side[WARMUP]
    for i in range(WARMUP + 1, len(c)):
        s = side[i]
        if s != 0 and last == -s and side[i - 1] == 0:
            long = s == 1
            entry = c[i]
            lower, upper = min(e200[i], e300[i]), max(e200[i], e300[i])
            gap = (upper - lower) / lower
            buf = BASE_BUF + GAP_MULT * gap
            stop = lower * (1 - buf) if long else upper * (1 + buf)
            ret = (lambda x: x / entry - 1) if long else (lambda x: 1 - x / entry)
            stop_day, stop_ret = None, None
            for j in range(i + 1, len(c)):
                if (l[j] <= stop) if long else (h[j] >= stop):
                    stop_day, stop_ret = j - i, ret(min(o[j], stop) if long else max(o[j], stop))
                    break
            row = {"dir": "long" if long else "short", "date": d["dates"][i], "gap": gap, "risk": abs(stop / entry - 1),
                   "stop_day": stop_day, "stop_ret": stop_ret}
            for name, n in HORIZONS.items():
                if stop_day is not None and stop_day <= n:
                    row[name] = stop_ret
                elif i + n < len(c):
                    row[name] = ret(c[i + n])
                else:
                    row[name] = np.nan  # not enough future data yet
            out.append(row)
        if s != 0:
            last = s
    return out


def main(data_dir):
    uni = {s["file"]: s for s in json.load(open(os.path.join(data_dir, "universe.json")))["sectors"]}
    rows = []
    for f in sorted(os.listdir(os.path.join(data_dir, "daily"))):
        if f in SKIP:
            continue
        d = json.load(open(os.path.join(data_dir, "daily", f)))
        meta = uni.get(f, {})
        for r in events(d):
            r.update(symbol=f[:-5], tv=meta.get("tv_symbol"), category=meta.get("category", "?"))
            rows.append(r)
    df = pd.DataFrame(rows)
    df.to_csv("ema_200_300_events.csv", index=False)
    return df


def summary(df):
    lines = []
    for name, n in HORIZONS.items():
        s = df[name].dropna()
        sub = df.loc[s.index]
        stopped = (sub["stop_day"].notna() & (sub["stop_day"] <= n)).mean()
        lines.append({"hold": name, "trades": len(s), "avg_%": s.mean() * 100, "median_%": s.median() * 100,
                      "win_%": (s > 0).mean() * 100, "stopped_%": stopped * 100})
    return pd.DataFrame(lines).round(2)


def report(df, label):
    print(f"=============== {label}: {len(df)} signals on {df['symbol'].nunique()} symbols, {df['date'].min()} .. {df['date'].max()}\n")
    print(summary(df).to_string(index=False), "\n")
    print("Pure price indexes only (^GSPC, ^NDX, ^SOX ...)\n", summary(df[df["category"] == "Pure Sector Index"]).to_string(index=False), "\n")
    g = df.groupby("category")
    print(pd.DataFrame({"n": g.size(), "avg4w": g["4w"].mean() * 100, "avg12w": g["12w"].mean() * 100,
                        "win12w": g["12w"].apply(lambda s: (s.dropna() > 0).mean() * 100), "avg20w": g["20w"].mean() * 100,
                        "stopped_ever_%": g["stop_day"].apply(lambda s: s.notna().mean() * 100)}).round(1).to_string(), "\n")
    sd = df["stop_day"].dropna()
    print(f"Ever stopped: {df['stop_day'].notna().mean()*100:.1f}%   median days to stop: {sd.median():.0f}   "
          f"avg risk to stop at entry: {df['risk'].mean()*100:.1f}%")
    q = pd.qcut(df["gap"], 3, labels=["tight gap", "mid gap", "wide gap"])
    print(df.groupby(q, observed=True).agg(n=("12w", "size"), avg4w=("4w", "mean"), avg12w=("12w", "mean"), avg20w=("20w", "mean"),
          win12w=("12w", lambda s: (s.dropna() > 0).mean()), stopped_ever=("stop_day", lambda s: s.notna().mean())).mul(
          [1, 100, 100, 100, 100, 100]).round(1).to_string(), "\n")


if __name__ == "__main__":
    df = main(sys.argv[1] if len(sys.argv) > 1 else "public/data")
    # self-check: risk positive, and a stop-out never returns better than the stop distance allows
    assert (df["risk"] > 0).all() and (df["stop_ret"].dropna() <= -df.loc[df["stop_ret"].notna(), "risk"] + 1e-9).all()
    pd.set_option("display.width", 200)
    for side in ("long", "short"):
        report(df[df["dir"] == side], side.upper())
