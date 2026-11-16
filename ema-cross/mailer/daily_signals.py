"""Daily signal mail.

1. Fetches fresh daily prices for every index in public/data/universe.json (same Yahoo fetch as the weekly refresh).
2. Runs the EMA 200/300 Heikin Ashi rule (ema-cross/backtest/ema_200_300_test.py, same rules as the site).
3. Keeps the signals from each index's latest completed session (LOOKBACK_SESSIONS to widen).
4. For each signalling index, maps it to a GICS sector / sub-industry and lists the 5 large (S&P 500), mid (S&P 400)
   and small (S&P 600) cap stocks with the highest relative volume: average volume of the last 10 sessions
   divided by the average of the 50 sessions before that.
5. Mails the result (SMTP settings from environment variables), or writes it to a file with --dry-run.

Environment:
    SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASS, MAIL_TO (comma separated), MAIL_FROM (optional)
    MAIL_TZ (default Europe/Sofia), MAIL_HOUR (default 10), LOOKBACK_SESSIONS (default 1)
    SCHEDULE_CRON: set by GitHub Actions to the cron line that fired. The workflow fires at two UTC hours so the
    mail goes out at MAIL_HOUR local time in both summer and winter; the run whose hour does not match exits.

Usage:
    python ema-cross/mailer/daily_signals.py --dry-run [out.html]
"""
import html
import io
import json
import os
import smtplib
import ssl
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "ema-cross" / "backtest")]
from update_data import fetch  # noqa: E402  same Yahoo fetch as the weekly data refresh
import ema_200_300_test as strat  # noqa: E402  same rules as the site

SITE = "https://ema-cross.vercel.app"
UA = {"User-Agent": "Mozilla/5.0 (compatible; signal-mailer)"}
TIERS = [("Large cap (S&P 500)", "500"), ("Mid cap (S&P 400)", "400"), ("Small cap (S&P 600)", "600")]
MIN_DOLLAR_VOL = 2e6  # skip stocks trading under $2M a day: relative volume on thin stocks is noise

# universe "sector" -> (GICS sector or None for the whole market, GICS sub-industry keywords or None)
# Missing from this map (foreign benchmarks, rates, crypto, volatility): signal is listed, no stocks.
ALL = (None, None)
SECTOR_MAP = {
    "Broad Market": ALL, "Blue Chip": ALL, "Small Cap": ALL, "Large-Cap Growth": ALL,
    "Information Technology": ("Information Technology", None), "Technology": ("Information Technology", None),
    "Semiconductors": ("Information Technology", ["Semiconductor"]),
    "Software": ("Information Technology", ["Software"]), "Cloud Computing": ("Information Technology", ["Software"]),
    "Cybersecurity": ("Information Technology", ["Software"]),
    "Networking": ("Information Technology", ["Communications Equipment"]),
    "Communication Services": ("Communication Services", None), "Media": ("Communication Services", None),
    "Telecom": ("Communication Services", ["Telecom"]),
    "Internet": ("Communication Services", ["Interactive Media"]), "China Internet": ("Communication Services", ["Interactive Media"]),
    "Consumer Discretionary": ("Consumer Discretionary", None),
    "Automobiles": ("Consumer Discretionary", ["Automobile", "Automotive"]),
    "Retail": ("Consumer Discretionary", ["Retail"]),
    "Travel & Leisure": ("Consumer Discretionary", ["Hotels", "Casinos", "Leisure"]),
    "Leisure & Entertainment": ("Consumer Discretionary", ["Hotels", "Casinos", "Leisure", "Restaurants"]),
    "Homebuilders": ("Consumer Discretionary", ["Homebuilding"]), "Housing / Real Estate": ("Consumer Discretionary", ["Homebuilding"]),
    "Consumer Staples": ("Consumer Staples", None),
    "Food & Beverage": ("Consumer Staples", ["Food", "Beverage", "Brewers", "Soft Drinks", "Distillers"]),
    "Personal & Household": ("Consumer Staples", ["Personal Care", "Household"]),
    "Agribusiness": ("Consumer Staples", ["Agricultural"]), "Agriculture": ("Consumer Staples", ["Agricultural"]),
    "Energy": ("Energy", None), "Energy / Oil & Gas": ("Energy", None),
    "Oil & Gas E&P": ("Energy", ["Exploration"]), "Natural Gas": ("Energy", ["Exploration"]),
    "Oil Services": ("Energy", ["Equipment & Services", "Drilling"]),
    "Energy Pipelines / MLP": ("Energy", ["Storage & Transportation"]),
    "Financials": ("Financials", None), "Europe Financials": ("Financials", None), "Financial Services": ("Financials", None),
    "Banks": ("Financials", ["Banks"]), "Regional Banks": ("Financials", ["Regional Banks"]),
    "Capital Markets": ("Financials", ["Investment Banking", "Asset Management", "Exchanges"]),
    "Broker/Dealers": ("Financials", ["Investment Banking"]),
    "Insurance": ("Financials", ["Insurance"]), "Mortgage REITs": ("Financials", ["Mortgage REIT"]),
    "Health Care": ("Health Care", None), "Pharmaceuticals": ("Health Care", ["Pharmaceuticals"]),
    "Biotechnology": ("Health Care", ["Biotechnology"]),
    "Medical Devices": ("Health Care", ["Health Care Equipment", "Health Care Supplies"]),
    "Healthcare Providers": ("Health Care", ["Health Care Facilities", "Health Care Services", "Managed Health Care"]),
    "Industrials": ("Industrials", None), "Aerospace & Defense": ("Industrials", ["Aerospace"]),
    "Airlines": ("Industrials", ["Airlines"]),
    "Transportation": ("Industrials", ["Trucking", "Rail Transportation", "Air Freight", "Cargo", "Ground Transportation", "Marine"]),
    "Shipping / Maritime": ("Industrials", ["Marine"]),
    "Infrastructure": ("Industrials", ["Construction & Engineering", "Building Products"]),
    "US Infrastructure": ("Industrials", ["Construction & Engineering", "Building Products"]),
    "Construction & Materials": ("Industrials", ["Construction & Engineering", "Building Products", "Construction Materials"]),
    "Materials": ("Materials", None), "Basic Resources": ("Materials", None), "Metals & Mining": ("Materials", None),
    "Chemicals": ("Materials", ["Chemicals"]), "Steel": ("Materials", ["Steel"]),
    "Copper Miners": ("Materials", ["Copper", "Diversified Metals"]), "Industrial Metals": ("Materials", ["Copper", "Diversified Metals", "Aluminum"]),
    "Gold Miners": ("Materials", ["Gold", "Precious Metals"]), "Junior Gold Miners": ("Materials", ["Gold", "Precious Metals"]),
    "Silver Miners": ("Materials", ["Silver", "Precious Metals", "Gold"]), "Precious Metals": ("Materials", ["Gold", "Precious Metals", "Silver"]),
    "Timber & Forestry": ("Materials", ["Forest Products", "Paper"]),
    "Real Estate": ("Real Estate", None), "Real Estate ex-US": ("Real Estate", None), "REITs": ("Real Estate", None),
    "Data Center REITs": ("Real Estate", ["Data Center"]),
    "Utilities": ("Utilities", None),
}


def should_send_now():
    """In Actions, two cron lines fire (summer and winter UTC offsets); only the one that is MAIL_HOUR local sends."""
    cron = os.environ.get("SCHEDULE_CRON", "").strip()
    if not cron:
        return True  # manual run or local run
    utc_hour = int(cron.split()[1])
    tz = ZoneInfo(os.environ.get("MAIL_TZ", "Europe/Sofia"))
    now = datetime.now(timezone.utc)
    local = now.replace(hour=utc_hour, minute=0, second=0, microsecond=0).astimezone(tz)
    return local.hour == int(os.environ.get("MAIL_HOUR", "10"))


def index_signals(lookback):
    uni = json.load(open(ROOT / "public" / "data" / "universe.json", encoding="utf8"))["sectors"]
    items = [s for s in uni if s["file"] not in strat.SKIP]

    def run(s):
        df = fetch(s["yf_symbol"])
        if df is None or len(df) < strat.WARMUP + 25:
            return s, None, []
        d = {"dates": [t.strftime("%Y-%m-%d") for t in df.index], "open": df["Open"].tolist(),
             "high": df["High"].tolist(), "low": df["Low"].tolist(), "close": df["Close"].tolist()}
        recent = set(d["dates"][-lookback:])
        return s, d["dates"][-1], [e for e in strat.events(d) if e["date"] in recent]

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(run, items))
    lasts = [last for _, last, _ in results if last]
    newest = Counter(lasts).most_common(1)[0][0] if lasts else None  # most common last session (crypto trades weekends)
    sigs, failed = [], [s["yf_symbol"] for s, last, _ in results if last is None]
    for s, last, evs in results:
        for e in evs:
            sigs.append({**e, "symbol": s.get("tv_symbol") or s["yf_symbol"], "yf": s["yf_symbol"], "name": s["name"],
                         "category": s["category"], "sector": s["sector"], "last": last})
    return sigs, newest, failed


def constituents():
    rows = []
    for _, idx in TIERS:
        r = requests.get(f"https://en.wikipedia.org/wiki/List_of_S%26P_{idx}_companies", headers=UA, timeout=30)
        r.raise_for_status()
        t = pd.read_html(io.StringIO(r.text))[0][["Symbol", "Security", "GICS Sector", "GICS Sub-Industry"]]
        t["tier"] = idx
        rows.append(t)
    df = pd.concat(rows, ignore_index=True)
    df["yf"] = df["Symbol"].astype(str).str.replace(".", "-", regex=False)  # BRK.B -> BRK-B on Yahoo
    return df


def pool_for(cons, key):
    gics, subs = SECTOR_MAP[key]
    base = cons if gics is None else cons[cons["GICS Sector"] == gics]
    if subs:
        m = cons["GICS Sub-Industry"].str.contains("|".join(subs), case=False, regex=True)
        return cons[m], base  # sub-industry match first, sector as fallback
    return base, base


def volume_metrics(tickers):
    data = yf.download(sorted(tickers), period="6mo", auto_adjust=True, progress=False, threads=True)
    out = {}
    for t in tickers:
        try:
            v, c = data["Volume"][t].dropna(), data["Close"][t].dropna()
        except KeyError:
            continue
        if len(v) < 60 or len(c) < 11:
            continue
        v10, v50 = v.iloc[-10:].mean(), v.iloc[-60:-10].mean()
        dollar10 = float((c.iloc[-10:] * v.iloc[-10:]).mean())
        if v50 <= 0 or dollar10 < MIN_DOLLAR_VOL:
            continue
        out[t] = {"relvol": float(v10 / v50), "dollar10": dollar10, "ret10": float(c.iloc[-1] / c.iloc[-11] - 1)}
    return out


def pick(pool, fallback, metrics, tier, n=5):
    def top(df):
        df = df[(df["tier"] == tier) & df["yf"].isin(metrics.keys())].copy()
        df["relvol"] = df["yf"].map(lambda t: metrics[t]["relvol"])
        return df.sort_values("relvol", ascending=False).head(n)
    best = top(pool)
    if len(best) < n:  # too few in the sub-industry for this cap tier: fill from the whole sector
        extra = top(fallback[~fallback["yf"].isin(best["yf"])]).head(n - len(best))
        best = extra if best.empty else pd.concat([best, extra])
    return best


def fmt_money(x):
    return f"${x / 1e9:.1f}B" if x >= 1e9 else f"${x / 1e6:.0f}M"


def build_mail(sigs, newest, failed, groups, metrics):
    e = html.escape
    longs = [s for s in sigs if s["dir"] == "long"]
    shorts = [s for s in sigs if s["dir"] == "short"]
    subject = f"EMA 200/300 signals {newest}: {len(longs)} long, {len(shorts)} short"
    th = 'style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc;font-size:12px;color:#555"'
    td = 'style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px"'
    tdr = 'style="padding:4px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right"'
    parts = [f'<div style="font-family:Segoe UI,Arial,sans-serif;color:#16181d;max-width:900px">',
             f"<h2 style='margin:0 0 4px'>EMA 200/300 Heikin Ashi signals</h2>",
             f"<p style='margin:0 0 12px;color:#555'>Session of {e(str(newest))}: {len(longs)} long, {len(shorts)} short. "
             f"Entry would be at that close; the stop is fixed at entry. <a href='{SITE}'>Open the site</a>.</p>"]
    if not sigs:
        parts.append("<p>No index gave a signal on the latest session.</p>")
    else:
        parts.append(f"<table style='border-collapse:collapse'><tr><th {th}>Date</th><th {th}>Side</th><th {th}>Index</th><th {th}>Name</th>"
                     f"<th {th}>Category</th><th {th}>Close</th><th {th}>Stop</th><th {th}>Risk</th><th {th}>EMA gap</th></tr>")
        for s in sorted(sigs, key=lambda s: (s["date"], s["dir"], s["category"], s["symbol"]), reverse=True):
            col = "#0a7f4f" if s["dir"] == "long" else "#c0352b"
            parts.append(f"<tr><td {td}>{s['date']}</td><td {td}><b style='color:{col}'>{s['dir'].upper()}</b></td><td {td}>{e(s['symbol'])}</td>"
                         f"<td {td}>{e(s['name'])}</td><td {td}>{e(s['category'])}</td><td {tdr}>{s['entry']:.2f}</td>"
                         f"<td {tdr}>{s['stop']:.2f}</td><td {tdr}>{s['risk'] * 100:.1f}%</td><td {tdr}>{s['gap'] * 100:.2f}%</td></tr>")
        parts.append("</table>")
    for key, g in groups.items():
        names = ", ".join(f"{s['symbol']} ({s['dir']})" for s in g["sigs"])
        gics, subs = SECTOR_MAP[key]
        scope = "whole US market" if gics is None else gics + (f" / {', '.join(subs)}" if subs else "")
        parts.append(f"<h3 style='margin:22px 0 4px'>{e(key)}</h3><p style='margin:0 0 6px;color:#555;font-size:13px'>"
                     f"Signals: {e(names)}. Stocks from: {e(scope)}. Ranked by relative volume (last 10 sessions vs the 50 before).</p>")
        for label, tier in TIERS:
            best = g["picks"][tier]
            parts.append(f"<p style='margin:10px 0 2px;font-weight:600;font-size:13px'>{label}</p>")
            if best.empty:
                parts.append("<p style='margin:0;color:#777;font-size:13px'>No liquid stocks in this group.</p>")
                continue
            parts.append(f"<table style='border-collapse:collapse'><tr><th {th}>Ticker</th><th {th}>Company</th><th {th}>Sub-industry</th>"
                         f"<th {th}>Rel. volume</th><th {th}>Avg $ vol 10d</th><th {th}>Return 10d</th></tr>")
            for _, r in best.iterrows():
                m = metrics[r["yf"]]
                rc = "#0a7f4f" if m["ret10"] >= 0 else "#c0352b"
                parts.append(f"<tr><td {td}><b>{e(str(r['Symbol']))}</b></td><td {td}>{e(str(r['Security']))}</td>"
                             f"<td {td}>{e(str(r['GICS Sub-Industry']))}</td><td {tdr}>{m['relvol']:.2f}x</td>"
                             f"<td {tdr}>{fmt_money(m['dollar10'])}</td><td {tdr} ><span style='color:{rc}'>{m['ret10'] * 100:+.1f}%</span></td></tr>")
            parts.append("</table>")
    unmapped = sorted({s["symbol"] for s in sigs if s["sector"] not in SECTOR_MAP})
    if unmapped:
        parts.append(f"<p style='color:#777;font-size:12px;margin-top:18px'>No US stock list for: {e(', '.join(unmapped))} "
                     "(foreign benchmark, rates, crypto or volatility).</p>")
    if failed:
        parts.append(f"<p style='color:#777;font-size:12px'>Could not load prices for: {e(', '.join(failed))}.</p>")
    parts.append("<p style='color:#777;font-size:12px;margin-top:18px'>Rules: daily Heikin Ashi, EMA 200/300 on the HA close; "
                 "long after a break below both lines once the whole HA body is above both (shorts mirrored); "
                 "no signal when the EMAs have been tangled within 1% for 40 days and are flat. "
                 "Stocks: S&P 500 / 400 / 600 members by GICS, $2M+ daily dollar volume. Not investment advice.</p></div>")
    return subject, "".join(parts)


def send(subject, body_html):
    host, user, pw, to = (os.environ.get(k, "") for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_TO"))
    if not (host and user and pw and to):
        sys.exit("SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_TO must be set (GitHub repository secrets).")
    port = int(os.environ.get("SMTP_PORT") or 465)
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, os.environ.get("MAIL_FROM") or user, to
    msg.set_content("This mail is HTML. Open it in a mail client that shows HTML, or visit " + SITE)
    msg.add_alternative(body_html, subtype="html")
    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=60) as s:
            s.login(user, pw)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=60) as s:
            s.starttls(context=ctx)
            s.login(user, pw)
            s.send_message(msg)


def main():
    dry = "--dry-run" in sys.argv
    if not dry and not should_send_now():
        print("Not the mail hour in", os.environ.get("MAIL_TZ", "Europe/Sofia"), "for this cron line; exiting.")
        return
    lookback = int(os.environ.get("LOOKBACK_SESSIONS", "1"))
    sigs, newest, failed = index_signals(lookback)
    if newest is None:
        sys.exit("No price data could be loaded.")
    print(f"{len(sigs)} signals on the session of {newest}; {len(failed)} symbols failed to load.")

    groups, metrics = {}, {}
    mapped = [s for s in sigs if s["sector"] in SECTOR_MAP]
    if mapped:
        cons = constituents()
        for s in mapped:
            groups.setdefault(s["sector"], {"sigs": []})["sigs"].append(s)
        pools = {k: pool_for(cons, k) for k in groups}
        tickers = set()
        for pool, fallback in pools.values():
            tickers |= set(pool["yf"]) | set(fallback["yf"])
        metrics = volume_metrics(tickers)
        for k, g in groups.items():
            g["picks"] = {tier: pick(*pools[k], metrics, tier) for _, tier in TIERS}

    subject, body = build_mail(sigs, newest, failed, groups, metrics)
    if dry:
        out = Path(next((a for a in sys.argv[1:] if a.endswith(".html")), "signal_mail_preview.html"))
        out.write_text(body, encoding="utf8")
        print("Subject:", subject, "\nWrote", out.resolve())
    else:
        send(subject, body)
        print("Sent:", subject)


if __name__ == "__main__":
    main()
