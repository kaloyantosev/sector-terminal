"""Swing test: EMA 200/300 trend (Heikin Ashi, as on the site) + TD Sequential (DeMark) pullback entries,
daily entries with weekly and monthly confirmation. Same TD rules as tradingview/ema_200_300_ha_cross.pine.
Usage: python swing_td_test.py <data dir with universe.json and daily/>
"""
import json, sys
from pathlib import Path
import numpy as np
import pandas as pd
from ema_200_300_test import representatives, ema

HZ = {"4w": 20, "8w": 40, "12w": 60}


def td(o, h, l, c):
    """TD Sequential arrays: bs/ss setup counts, buy/sell 9 perfected flags, buy/sell countdown 13 flags,
    and the setup's DeMark risk level (lowest true low minus that candle's true range; mirror for sells)."""
    n = len(c)
    pc = np.r_[c[0], c[:-1]]
    tH, tL = np.maximum(h, pc), np.minimum(l, pc)
    bs, ss = np.zeros(n, int), np.zeros(n, int)
    for i in range(4, n):
        bs[i] = bs[i - 1] + 1 if c[i] < c[i - 4] else 0
        ss[i] = ss[i - 1] + 1 if c[i] > c[i - 4] else 0
    bPerf, sPerf = np.zeros(n, bool), np.zeros(n, bool)
    b13, s13 = np.zeros(n, bool), np.zeros(n, bool)
    bcN, scN = np.zeros(n, int), np.zeros(n, int)  # countdown number shown on each candle (0 = none)
    bRisk, sRisk = np.full(n, np.nan), np.full(n, np.nan)
    bAct = sAct = False
    bc = sc = 0
    b8 = s8 = bSize = sSize = bHi = sLo = np.nan
    for i in range(9, n):
        w = slice(i - 8, i + 1)
        hi9, lo9 = tH[w].max(), tL[w].min()
        if bs[i] == 9:
            bPerf[i] = min(l[i], l[i - 1]) <= min(l[i - 2], l[i - 3])
            k = i - 8 + int(np.argmin(tL[w])); bRisk[i] = tL[k] - (tH[k] - tL[k])
        if ss[i] == 9:
            sPerf[i] = max(h[i], h[i - 1]) >= max(h[i - 2], h[i - 3])
            k = i - 8 + int(np.argmax(tH[w])); sRisk[i] = tH[k] + (tH[k] - tL[k])
        if ss[i] == 9: bAct = False
        if bs[i] == 9: sAct = False
        if bs[i] in (9, 18):
            sz = hi9 - lo9
            if not bAct or (sz >= bSize and sz < 1.618 * bSize):
                bAct, bc, b8, bSize, bHi = True, 0, np.nan, sz, hi9
            elif sz >= 1.618 * bSize:
                bAct = False
        if ss[i] in (9, 18):
            sz = hi9 - lo9
            if not sAct or (sz >= sSize and sz < 1.618 * sSize):
                sAct, sc, s8, sSize, sLo = True, 0, np.nan, sz, lo9
            elif sz >= 1.618 * sSize:
                sAct = False
        if bAct and tL[i] > bHi: bAct = False
        if sAct and tH[i] < sLo: sAct = False
        if bAct and c[i] <= l[i - 2] and (bc < 12 or l[i] <= b8):
            bc += 1
            bcN[i] = bc
            if bc == 8: b8 = c[i]
            if bc == 13: b13[i], bAct = True, False
        if sAct and c[i] >= h[i - 2] and (sc < 12 or h[i] >= s8):
            sc += 1
            scN[i] = sc
            if sc == 8: s8 = c[i]
            if sc == 13: s13[i], sAct = True, False
    return dict(bs=bs, ss=ss, bPerf=bPerf, sPerf=sPerf, b13=b13, s13=s13, bcN=bcN, scN=scN, bRisk=bRisk, sRisk=sRisk)


def frame(df):
    o, h, l, c = (df[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    hc = (o + h + l + c) / 4
    e2, e3 = ema(hc, 200), ema(hc, 300)
    t = td(o, h, l, c)
    out = pd.DataFrame({"up": (hc > e2) & (hc > e3) & (e2 > e3), "dn": (hc < e2) & (hc < e3) & (e2 < e3),
                        "b9": t["bs"] == 9, "s9": t["ss"] == 9, "bP": t["bPerf"], "sP": t["sPerf"],
                        "b13": t["b13"], "s13": t["s13"], "bRisk": t["bRisk"], "sRisk": t["sRisk"]}, index=df.index)
    out.iloc[:300, :2] = False  # EMA warm-up
    return out


def higher(df, rule):
    """Weekly/monthly candles and their state, shifted so a day only sees the last COMPLETED higher-timeframe candle."""
    g = df.groupby(df.index.to_period(rule))
    x = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(), "close": g["close"].last()})
    f = frame(x)
    recent = lambda s, k: s.rolling(k, min_periods=1).max().astype(bool)  # fired within the last k candles
    st = pd.DataFrame({"up": f["up"], "dn": f["dn"],
                       "sellEx": recent(f["s9"] | f["s13"], 3), "buyEx": recent(f["b9"] | f["b13"], 3),
                       "ok": pd.Series(np.arange(len(f)) >= 300, index=f.index)}).shift(1)
    return st.reindex(df.index.to_period(rule)).set_axis(df.index).astype("boolean").fillna(False).astype(bool)


def trades(df):
    """Longs only. Trend: daily AND last completed weekly HA close above both EMAs with EMA 200 above 300.
    D = daily buy 9 or 13 in that trend; W = a weekly buy 9/13 just completed (first day of the next week).
    base = every 5th day of the same daily trend (what buying at a random time would give).
    Stop = lower daily EMA x (1 - 2% - gap), as in the main strategy. Exit = first daily sell 9/13 or weekly
    sell 9/13, the stop, or 60 trading days."""
    o, h, l, c = (df[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    hc = (o + h + l + c) / 4
    e2, e3 = ema(hc, 200), ema(hc, 300)
    f, w, m = frame(df), higher(df, "W"), higher(df, "M")
    wk = w["up"].to_numpy() & w["ok"].to_numpy()
    moEx = m["sellEx"].to_numpy()
    per = df.index.to_period("W")
    g = df.groupby(per)
    fw = frame(pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(), "close": g["close"].last()}))
    last_wk = lambda s: s.shift(1).reindex(per).astype("boolean").fillna(False).to_numpy(bool)  # last COMPLETED week
    wb, ws = last_wk(fw["b9"] | fw["b13"]), last_wk(fw["s9"] | fw["s13"])
    newweek = np.r_[True, per[1:] != per[:-1]]
    up, trig, sell = f["up"].to_numpy(), (f["b9"] | f["b13"]).to_numpy(), (f["s9"] | f["s13"]).to_numpy()
    rows = []
    for i in range(300, len(c) - 60):
        kinds = [k for k, ok in (("base", up[i] and i % 5 == 0), ("D", up[i] and wk[i] and trig[i]),
                                 ("W", up[i] and wk[i] and wb[i] and newweek[i])) if ok]
        if not kinds:
            continue
        lo = min(e2[i], e3[i]); stop = lo * (1 - 0.02 - abs(e2[i] - e3[i]) / lo); en = c[i]
        sd = sr = None
        for j in range(i + 1, i + 61):
            if l[j] <= stop:
                sd, sr = j - i, min(o[j], stop) / en - 1
                break
        r = {k: sr if sd is not None and sd <= v else c[i + v] / en - 1 for k, v in HZ.items()}
        ex, days = c[i + 60] / en - 1, 60
        for j in range(i + 1, i + 61):
            if sd == j - i:
                ex, days = sr, j - i; break
            if sell[j] or (ws[j] and newweek[j]):
                ex, days = c[j] / en - 1, j - i; break
        for k in kinds:
            rows.append(dict(kind=k, moEx=moEx[i], risk=en / stop - 1, exit=ex, days=days, **r))
    return rows


def main(data_dir):
    root = Path(data_dir)
    uni = json.loads((root / "universe.json").read_text())
    rows = []
    for s in representatives(uni["sectors"]):
        d = json.loads((root / "daily" / s["file"]).read_text())
        df = pd.DataFrame({k: d[k] for k in ("open", "high", "low", "close")}, index=pd.to_datetime(d["dates"])).astype(float)
        if len(df) >= 400:
            rows += [dict(r, sym=s["file"]) for r in trades(df)]
    t = pd.DataFrame(rows)
    t.to_csv(Path(__file__).with_name("swing_td_trades.csv"), index=False)
    names = {"base": "random day in daily uptrend", "D": "daily buy 9/13, daily+weekly up", "W": "weekly buy 9/13, daily+weekly up"}
    for k, x in t.groupby("kind"):
        for nm, y in (("", x), (" | no monthly sell 9/13", x[~x.moEx])):
            print(f"{names[k] + nm:58s} n={len(y):6d} risk {y.risk.median()*100:4.1f}% | "
                  + "  ".join(f"{h} {y[h].mean()*100:5.2f}%/{(y[h]>0).mean()*100:3.0f}" for h in HZ)
                  + f" | exit at sell 9/13: {y.exit.mean()*100:5.2f}% avg, {(y.exit>0).mean()*100:3.0f}% win, {y.days.mean():4.1f} days")


if __name__ == "__main__":
    main(sys.argv[1])
