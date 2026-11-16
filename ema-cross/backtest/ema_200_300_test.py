"""200/300 EMA staggered-cross event study on every symbol in sector-terminal's data. Longs and shorts.

Decisions use Heikin Ashi closes (EMAs on HA close, crosses of HA close). Entry fills at the real close.
Long entry (daily close): the whole HA body (open and close) closes above BOTH EMA200 and EMA300, after the HA
candle broke below both lines (any part of the HA body under both counts as a break, pierce="body"; with
pierce="wick" the HA low is enough). A one-candle cross of both lines counts. A dip that never breaks the second
line is NOT a signal. Short entry: the mirror.
Flat filter: no signal when the EMAs are tangled (gap under 1%) AND flat (EMA 200 moved under 2% in 20 days).
(pierce=None needs the whole body past both lines on the way in too; pierce=None, same_day=False, body=False
gives the oldest close-only, skip-same-day rule.)
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
FLAT_GAP, FLAT_SLOPE = 0.01, 0.02  # no signal if EMAs are within 1% AND EMA 200 moved under 2% in 20 days


def ema(x, n):
    return pd.Series(x).ewm(span=n, adjust=False).mean().to_numpy()


def events(d, same_day=True, body=True, pierce="body", flat_gap=FLAT_GAP, flat_slope=FLAT_SLOPE):
    """same_day: count a one-candle cross of both lines. body: the whole HA body (open and close) must be past both lines."""
    o, h, l, c = (np.asarray(d[k], float) for k in ("open", "high", "low", "close"))
    hc = (o + h + l + c) / 4  # Heikin Ashi close: decisions use it; fills, stops and returns use real prices
    e200, e300 = ema(hc, 200), ema(hc, 300)
    ho = np.empty_like(hc); ho[0] = (o[0] + c[0]) / 2
    for k in range(1, len(c)):
        ho[k] = (ho[k - 1] + hc[k - 1]) / 2  # Heikin Ashi open
    if body:
        lo_b, hi_b = np.minimum(ho, hc), np.maximum(ho, hc)
    else:
        lo_b = hi_b = hc
    # "broke below / above both lines": part of the HA body (or the HA wick) is past both
    lo_p, hi_p = (np.minimum(l, lo_b), np.maximum(h, hi_b)) if pierce == "wick" else (lo_b, hi_b)
    broke_dn = (lo_p < e200) & (lo_p < e300)
    broke_up = (hi_p > e200) & (hi_p > e300)
    side = np.where((lo_b > e200) & (lo_b > e300), 1, np.where((hi_b < e200) & (hi_b < e300), -1, 0))  # +1 above both, -1 below both
    out = []
    last = side[WARMUP]
    arm_long, arm_short = broke_dn[WARMUP], broke_up[WARMUP]  # pierce mode: a break of both lines arms the opposite entry
    for i in range(WARMUP + 1, len(c)):
        s = side[i]
        if pierce:
            fire = (s == 1 and arm_long) or (s == -1 and arm_short)
            if s == 1 and fire:
                arm_long = False
            if s == -1 and fire:
                arm_short = False
            arm_long, arm_short = arm_long or broke_dn[i], arm_short or broke_up[i]
        else:
            fire = s != 0 and last == -s and (same_day or side[i - 1] == 0)
        if fire and flat_gap is not None:
            # skip when the EMAs are tangled (gap under flat_gap) AND flat (EMA 200 moved under flat_slope in 20 days)
            g = abs(e200[i] - e300[i]) / min(e200[i], e300[i])
            sl = abs(e200[i] / e200[i - 20] - 1)
            if g < flat_gap and sl < flat_slope:
                fire = False
        if fire:
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


def main(data_dir, **kw):
    uni = {s["file"]: s for s in json.load(open(os.path.join(data_dir, "universe.json")))["sectors"]}
    rows = []
    for f in sorted(os.listdir(os.path.join(data_dir, "daily"))):
        if f in SKIP:
            continue
        d = json.load(open(os.path.join(data_dir, "daily", f)))
        meta = uni.get(f, {})
        for r in events(d, **kw):
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
