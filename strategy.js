// Daily 300/50 EMA + smoothed-RSI long-only strategy. One engine, used by the browser (app.js)
// and by Node (scripts/build_summary.mjs), so the screener and the chart can never disagree.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Strategy = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Bars before the first signal. The 300D EMA is seeded with the first close; after 600 bars
  // that seed carries under 2% of the weight. The old min(250, n/8) traded on a half-formed EMA.
  const WARMUP = 600;
  const MIN_BARS = WARMUP + 252;
  const DEFAULTS = {
    dev_pct: 1.5, confirm_days: 3, slope_win: 15, atr_mult: 1.5, rsi_drop: 1.5,
    cooldown_days: 12, req_ema50_flat: true, require_rising: true,
    cost_bps: 10, // per fill, i.e. 0.1% of turnover
  };

  // pandas ewm(adjust=False): seeded with the first value
  function ewm(x, alpha, start = 0) {
    const out = new Array(x.length).fill(x[start]);
    let p = x[start];
    for (let i = start + 1; i < x.length; i++) { p = alpha * x[i] + (1 - alpha) * p; out[i] = p; }
    return out;
  }

  function indicators(d) {
    const c = d.close, h = d.high, l = d.low, n = c.length;
    const tr = new Array(n), gain = new Array(n).fill(0), loss = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const pc = i ? c[i - 1] : c[i];
      tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - pc), Math.abs(l[i] - pc));
      if (i) { const dl = c[i] - c[i - 1]; gain[i] = Math.max(dl, 0); loss[i] = Math.max(-dl, 0); }
    }
    const ag = ewm(gain, 1 / 14, Math.min(1, n - 1)), al = ewm(loss, 1 / 14, Math.min(1, n - 1));
    const rsi = ag.map((g, i) => (al[i] > 0 ? 100 - 100 / (1 + g / al[i]) : g > 0 ? 100 : 50));
    for (let i = 0; i < Math.min(14, n - 1); i++) rsi[i] = rsi[Math.min(14, n - 1)];
    return {
      ema50: ewm(c, 2 / 51), ema300: ewm(c, 2 / 301),
      atr14: ewm(tr, 1 / 14), rsi_ema200: ewm(rsi, 2 / 201),
    };
  }

  // Daily T-bill return for each date, from ^IRX (13-week bill yield, % a year). 0 before it exists.
  function rfDaily(dates, irx) {
    const out = new Array(dates.length).fill(0);
    if (!irx) return out;
    let j = -1;
    for (let i = 0; i < dates.length; i++) {
      while (j + 1 < irx.dates.length && irx.dates[j + 1] <= dates[i]) j++;
      const y = j >= 0 ? irx.close[j] : 0;
      out[i] = y > 0 ? y / 100 / 252 : 0;
    }
    return out;
  }

  // Return, CAGR, volatility, Sharpe (vs T-bills) and max drawdown of curve[from..to]; curve[from] is the base.
  // shortcut: annualises with 252 days, which understates crypto (365 days); switch per asset class if that matters.
  function ratios(curve, rf, dates, from, to) {
    const rets = [], ex = [];
    let peak = curve[from], mdd = 0;
    for (let i = from + 1; i <= to; i++) {
      const r = curve[i] / curve[i - 1] - 1;
      rets.push(r); ex.push(r - rf[i]);
      if (curve[i] > peak) peak = curve[i];
      mdd = Math.max(mdd, 1 - curve[i] / peak);
    }
    const mean = x => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
    const sd = x => {
      if (x.length < 2) return 0;
      const m = mean(x);
      return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1));
    };
    const years = Math.max(1 / 365, (Date.parse(dates[to]) - Date.parse(dates[from])) / (365.25 * 864e5));
    const total = curve[to] / curve[from] - 1, exSd = sd(ex);
    return {
      totalReturn: total * 100,
      cagr: years >= 1 ? (Math.pow(1 + total, 1 / years) - 1) * 100 : total * 100,
      volatility: sd(rets) * Math.sqrt(252) * 100,
      sharpe: exSd > 0 ? (mean(ex) / exSd) * Math.sqrt(252) : 0,
      maxDrawdown: mdd * 100,
      years,
    };
  }

  function periodStats(res, dates, from, to) {
    return {
      from: dates[from], to: dates[to],
      strategy: ratios(res.equity_curve, res.rf, dates, from, to),
      benchmark: ratios(res.bh_curve, res.rf, dates, from, to),
    };
  }

  // One entry per calendar year, each cut from the same continuous run, measured close to close.
  function yearly(res, dates) {
    const out = [], n = dates.length;
    if (res.warmup >= n - 1) return out;
    let from = res.warmup;
    for (let i = res.warmup + 1; i <= n; i++) {
      if (i === n || dates[i].slice(0, 4) !== dates[i - 1].slice(0, 4)) {
        const to = i - 1;
        if (to > from) out.push({ year: +dates[to].slice(0, 4), from, to, partial: i === n && dates[to].slice(5) < "12-28", ...periodStats(res, dates, from, to) });
        from = to;
      }
    }
    return out;
  }

  // d = {dates, open, high, low, close}. Signals use the close of day i and fill at the close of day i+1.
  // Flat capital earns T-bills. Buy & hold starts at the same bar the strategy is first allowed to trade.
  function run(d, params, irx) {
    const P = Object.assign({}, DEFAULTS, params);
    const dates = d.dates, closes = d.close, n = dates.length;
    const ind = indicators(d);
    const { ema50, ema300, atr14, rsi_ema200: rsiSm } = ind;
    const rf = rfDaily(dates, irx);
    const eq = new Array(n).fill(100), bh = new Array(n).fill(100);
    const latest = {
      latest_close: closes[n - 1], latest_ema50: ema50[n - 1],
      latest_ema300: ema300[n - 1], latest_rsi_ema200: rsiSm[n - 1],
    };
    if (n < MIN_BARS) {
      return {
        ind, rf, signals: [], trades: [], equity_curve: eq, bh_curve: bh, warmup: n - 1,
        stats: {
          insufficient: true, total_trades: 0, buy_a_count: 0, buy_b_count: 0, buy_bounce_count: 0,
          sell_50_count: 0, sell_both_count: 0, win_rate_pct: 0, exposure_pct: 0, fills: 0, costs_pct: 0,
          strategy: null, benchmark: null, last_signal_date: null, last_signal_type: null,
          current_state: "INSUFFICIENT DATA", waiting_rule: `Needs ${MIN_BARS} daily bars, has ${n}`, ...latest,
        },
      };
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const dev = clamp(+P.dev_pct, 0, 10) / 100, conf = clamp(Math.trunc(P.confirm_days), 1, 10);
    const swin = clamp(Math.trunc(P.slope_win), 3, 60), amult = clamp(+P.atr_mult, 0, 5);
    const rdrop = clamp(+P.rsi_drop, 0, 10), cdown = clamp(Math.trunc(P.cooldown_days), 0, 60);
    const cost = clamp(+P.cost_bps, 0, 500) / 1e4, warmup = WARMUP;

    let sig = false;      // position the signal logic wants (flips on the signal bar)
    let pos = false;      // position actually held (flips one bar later, at the fill)
    let pending = null;   // "BUY" | "SELL" waiting for the next close
    let wasAbove50 = false, in300Dip = false, brokeMid = false, soldOn50 = false, lastSellIdx = -999;
    let buyStreak = 0, sellBothStreak = 0, sell50Streak = 0, daysIn = 0, fills = 0;
    const signals = [], trades = [];
    let cur = null;

    const openTrade = (i, type, label) => {
      sig = true; pending = "BUY";
      cur = { signal_date: dates[i], entry_date: null, entry_price: null, entry_type: type, entry_label: label,
              exit_date: null, exit_price: null, exit_type: null, exit_label: null, ret_pct: null, status: "OPEN" };
      signals.push({ time: dates[i], kind: type, price: closes[i], rsi_ema200: rsiSm[i] });
    };
    const closeTrade = (i, type, label) => {
      sig = false; pending = "SELL";
      cur.exit_type = type; cur.exit_label = label;
      signals.push({ time: dates[i], kind: type, price: closes[i], rsi_ema200: rsiSm[i] });
    };

    for (let i = 0; i < n; i++) {
      if (i > warmup) {
        eq[i] = eq[i - 1] * (pos ? closes[i] / closes[i - 1] : 1 + rf[i]);
        bh[i] = (closes[i] / closes[warmup]) * 100;
        if (pos) daysIn++;
      }
      if (pending) { // yesterday's signal fills at today's close
        eq[i] *= 1 - cost; fills++;
        if (pending === "BUY") {
          pos = true; cur.entry_date = dates[i]; cur.entry_price = closes[i];
        } else {
          pos = false;
          cur.exit_date = dates[i]; cur.exit_price = closes[i]; cur.status = "CLOSED";
          cur.ret_pct = ((closes[i] / cur.entry_price) * (1 - cost) * (1 - cost) - 1) * 100;
          trades.push(cur); cur = null;
        }
        pending = null;
      }
      if (i < warmup) continue;

      const p = closes[i], pp = closes[i - 1], e50 = ema50[i], e300 = ema300[i], a = atr14[i];
      const r = rsiSm[i], lb = Math.max(0, i - swin);
      let rPeak40 = -Infinity;
      for (let k = Math.max(0, i - 40); k <= i; k++) if (rsiSm[k] > rPeak40) rPeak40 = rsiSm[k];

      // Smoothed RSI falling, down >= rsi_drop from its 40D peak, and not bullishly diverging
      const rsiFalling = r < rsiSm[i - 1] && r < rsiSm[lb] && rPeak40 - r >= rdrop;
      const noBullDiv = !(p < closes[lb] && r >= rsiSm[lb]);
      const ema50Weak = !P.req_ema50_flat || e50 <= ema50[Math.max(0, i - 10)] * 1.001;
      const rsiConfirmDown = rsiFalling && noBullDiv && ema50Weak;

      const below300 = p < e300 * (1 - dev), below50 = p < e50 * (1 - dev);
      const below50Atr = p < Math.min(e50 * (1 - dev), e50 - amult * a);
      const above300 = p > e300 * (1 + dev), above50 = p > e50 * (1 + dev);
      const above50Atr = p > Math.max(e50 * (1 + dev), e50 + 0.5 * amult * a);
      const climbing = !P.require_rising || p > pp;

      if (sig) {
        if (above50) wasAbove50 = true;
        // SELL 1: close below both the 300 and 50 EMA
        sellBothStreak = below300 && below50 ? sellBothStreak + 1 : 0;
        // SELL 2: clean break of the 50 EMA (ATR-filtered) with smoothed RSI rolling over
        sell50Streak = wasAbove50 && below50Atr && !below300 && rsiConfirmDown ? sell50Streak + 1 : 0;

        if (sellBothStreak >= conf) {
          wasAbove50 = false; in300Dip = true; brokeMid = r < 50; soldOn50 = false;
          sellBothStreak = sell50Streak = buyStreak = 0;
          closeTrade(i, "SELL_BOTH", "SELL (<300&50)");
        } else if (sell50Streak >= conf) {
          wasAbove50 = false; soldOn50 = true; lastSellIdx = i; in300Dip = false; brokeMid = false;
          sellBothStreak = sell50Streak = buyStreak = 0;
          closeTrade(i, "SELL_50", "SELL (<50+RSI↓)");
        }
      } else if (below300) {
        if (!in300Dip) { in300Dip = true; brokeMid = r < 50; }
        else if (r < 50) brokeMid = true;
        soldOn50 = false; buyStreak = 0;
      } else if (in300Dip) {
        if (r < 50) brokeMid = true;
        const cond = brokeMid ? above300 && above50 : above300;
        if (cond && climbing) buyStreak++;
        else if (!cond) buyStreak = 0;
        if (buyStreak >= conf) {
          wasAbove50 = p > e50;
          openTrade(i, brokeMid ? "BUY_B" : "BUY_A", brokeMid ? "BUY B (>300&50)" : "BUY A (>300)");
          in300Dip = false; brokeMid = false; buyStreak = 0;
        }
      } else if (soldOn50) {
        // Bounce buy: cooldown + ATR reclaim of the 50 EMA + 10D breakout + smoothed RSI no longer falling
        let hi10 = -Infinity;
        for (let k = Math.max(0, i - 10); k < i; k++) if (closes[k] > hi10) hi10 = closes[k];
        const rsiStable = r >= rsiSm[Math.max(0, i - 5)] - 0.1;
        if (i - lastSellIdx >= cdown && above50Atr && above300 && p >= hi10 * 0.995 && climbing && rsiStable) buyStreak++;
        else if (!above50Atr) buyStreak = 0;
        if (buyStreak >= conf) {
          wasAbove50 = true;
          openTrade(i, "BUY_BOUNCE", "BUY BOUNCE (>50)");
          soldOn50 = false; buyStreak = 0;
        }
      } else if (above300 && above50) {
        wasAbove50 = true;
        openTrade(i, "BUY_B", "BUY INIT (>300&50)");
      }
    }

    if (cur && cur.entry_date) { // still long (or a sell waiting to fill): mark to the last close
      const last = closes[n - 1];
      Object.assign(cur, { exit_date: dates[n - 1], exit_price: last, exit_type: "OPEN", exit_label: "OPEN",
                           ret_pct: ((last / cur.entry_price) * (1 - cost) - 1) * 100 });
      trades.push(cur);
    }

    const e50 = ema50[n - 1], e300 = ema300[n - 1], a = atr14[n - 1];
    const f = v => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let state, rule;
    if (sig) {
      state = "LONG (IN POSITION)";
      rule = `Holding long · sell <50D (${f(Math.min(e50 * (1 - dev), e50 - amult * a))}) if smoothed RSI↓≥${rdrop}, or <both (${f(Math.min(e50, e300) * (1 - dev))})`;
    } else if (soldOn50) {
      state = "FLAT (50D MOMENTUM EXIT)";
      rule = `Bounce buy if >${f(Math.max(e50 * (1 + dev), e50 + 0.5 * amult * a))} (10D reclaim + RSI turn), or <300D EMA (${f(e300 * (1 - dev))}) arms dip`;
    } else if (in300Dip) {
      state = "DIP ARMED (WAITING BUY)";
      const tgt = (brokeMid ? Math.max(e300, e50) : e300) * (1 + dev);
      rule = `${brokeMid ? "RSI broke 50 → BUY B (>300&50)" : "RSI held >50 → BUY A (>300)"} @ >${f(tgt)}`;
    } else {
      state = "FLAT / WAITING"; rule = "Waiting for buy trigger";
    }
    if (pending) rule += ` · ${pending} signal on the last bar fills at the next close`;

    const res = { ind, rf, signals, trades, equity_curve: eq, bh_curve: bh, warmup };
    const all = periodStats(res, dates, warmup, n - 1);
    const count = (k, v) => trades.filter(t => t[k] === v).length;
    res.stats = {
      insufficient: false,
      total_trades: trades.length,
      buy_a_count: count("entry_type", "BUY_A"), buy_b_count: count("entry_type", "BUY_B"),
      buy_bounce_count: count("entry_type", "BUY_BOUNCE"),
      sell_50_count: count("exit_type", "SELL_50"), sell_both_count: count("exit_type", "SELL_BOTH"),
      win_rate_pct: trades.length ? (trades.filter(t => t.ret_pct > 0).length / trades.length) * 100 : 0,
      exposure_pct: (daysIn / (n - 1 - warmup)) * 100,
      fills, costs_pct: fills * cost * 100,
      strategy: all.strategy, benchmark: all.benchmark,
      last_signal_date: signals.length ? signals[signals.length - 1].time : null,
      last_signal_type: signals.length ? signals[signals.length - 1].kind : null,
      current_state: state, waiting_rule: rule, ...latest,
    };
    return res;
  }

  // Sector rotation portfolio. Every close, each symbol's own signal engine (run) is checked:
  //  - a BUY signal opens a position at the next close; buys on the same day share the money equally
  //  - a position is held until that symbol's own SELL signal, then sold at the next close
  //  - one position per sector label, so XLK, VGT and IYW buying together do not triple the tech bet
  //  - mode "cash": new buys only use idle cash (sell proceeds, start capital); fully invested = no new buys
  //  - mode "rebalance": a new buy resizes every holding to an equal share, so a new wave is never missed
  // Idle cash earns T-bills. Costs are charged on every unit of turnover.
  // members = [{sym, sector, d}], calendar = benchmark daily file {dates, close}.
  function portfolio(members, calendar, irx, params, opts) {
    const o = Object.assign({ mode: "cash", minMembers: 5 }, opts);
    const P = Object.assign({}, DEFAULTS, params);
    const cost = P.cost_bps / 1e4, cal = calendar.dates, n = cal.length;
    const rf = rfDaily(cal, irx);

    // Each member: its close as of every calendar day (forward-filled, null before it trades),
    // the calendar day its first signal is allowed, and its signals keyed by fill day.
    const fillsAt = Array.from({ length: n }, () => []);
    const ready = new Array(n).fill(0);
    const px = members.map((m, k) => {
      const d = m.d, a = new Array(n).fill(null);
      let j = -1;
      for (let i = 0; i < n; i++) {
        while (j + 1 < d.dates.length && d.dates[j + 1] <= cal[i]) j++;
        if (j >= 0) a[i] = d.close[j];
      }
      if (d.dates.length < MIN_BARS) return a;
      const firstOk = cal.findIndex(t => t >= d.dates[WARMUP]);
      if (firstOk >= 0) for (let i = firstOk; i < n; i++) ready[i]++;
      for (const s of run(d, P, irx).signals) {
        let f = cal.findIndex(t => t > s.time); // next calendar close after the signal
        if (f < 0) f = n; // signal on the last bar: fills tomorrow, reported as pending
        if (f < n) fillsAt[f].push({ k, buy: s.kind.startsWith("BUY"), signal: s.time, kind: s.kind });
        else fillsAt.pending = (fillsAt.pending || []).concat({ k, buy: s.kind.startsWith("BUY"), signal: s.time, kind: s.kind });
      }
      return a;
    });

    const start = ready.findIndex(c => c >= o.minMembers);
    if (start < 0) return null;
    let cash = 100;
    const units = new Map(); // member index -> units held
    const entry = new Map(); // member index -> {date, price, signal, kind}
    const bySector = new Map(); // sector -> member index held
    const eq = [], bh = [], rfs = [], held = [], trades = [], log = [];
    const value = i => { let v = cash; for (const [k, u] of units) v += u * px[k][i]; return v; };

    for (let i = start; i < n; i++) {
      if (i > start) cash *= 1 + rf[i];
      // sells first, so their cash can fund the same day's buys
      for (const f of fillsAt[i]) {
        if (f.buy || !units.has(f.k)) continue;
        const p = px[f.k][i], e = entry.get(f.k), proceeds = units.get(f.k) * p * (1 - cost);
        cash += proceeds;
        trades.push({ sym: members[f.k].sym, sector: members[f.k].sector, entry_date: e.date, entry_kind: e.kind,
                      exit_signal: f.signal, exit_date: cal[i], exit_kind: f.kind,
                      ret_pct: ((p / e.price) * (1 - cost) * (1 - cost) - 1) * 100 });
        log.push({ date: cal[i], side: "SELL", sym: members[f.k].sym, sector: members[f.k].sector, kind: f.kind, weight: proceeds / value(i) * 100 });
        units.delete(f.k); entry.delete(f.k); bySector.delete(members[f.k].sector);
      }
      const buys = [];
      for (const f of fillsAt[i]) {
        const m = members[f.k];
        if (!f.buy || units.has(f.k) || bySector.has(m.sector) || px[f.k][i] == null) continue;
        if (buys.some(b => members[b.k].sector === m.sector)) continue; // first in universe order wins
        buys.push(f);
      }
      if (buys.length) {
        const total = value(i);
        let budget = cash;
        if (o.mode === "rebalance") {
          const target = total / (units.size + buys.length);
          for (const [k, u] of units) { // trim every holding down to the new equal share
            const v = u * px[k][i], cut = Math.max(0, v - target);
            units.set(k, u - cut / px[k][i]); cash += cut * (1 - cost);
          }
          budget = cash;
        }
        if (budget > total * 0.001) {
          const each = budget / buys.length;
          for (const f of buys) {
            const p = px[f.k][i];
            units.set(f.k, (each * (1 - cost)) / p); cash -= each;
            entry.set(f.k, { date: cal[i], price: p, kind: f.kind });
            bySector.set(members[f.k].sector, f.k);
            log.push({ date: cal[i], side: "BUY", sym: members[f.k].sym, sector: members[f.k].sector, kind: f.kind, weight: each / total * 100 });
          }
        }
      }
      const v = value(i);
      eq.push(v); bh.push((calendar.close[i] / calendar.close[start]) * 100); rfs.push(rf[i]);
      held.push({ n: units.size, cash: (cash / v) * 100 });
    }

    const last = n - 1, vEnd = value(last);
    const holdings = [...units].map(([k, u]) => {
      const e = entry.get(k), p = px[k][last];
      return { sym: members[k].sym, sector: members[k].sector, entry_date: e.date, entry_kind: e.kind,
               weight: (u * p / vEnd) * 100, ret_pct: (p / e.price - 1) * 100 };
    }).sort((a, b) => b.weight - a.weight);
    const dates = cal.slice(start);
    const res = { equity_curve: eq, bh_curve: bh, rf: rfs, warmup: 0 };
    const pending = (fillsAt.pending || []).map(f => ({ sym: members[f.k].sym, sector: members[f.k].sector, kind: f.kind, buy: f.buy,
                                                        held: units.has(f.k), signal: f.signal }));
    return {
      mode: o.mode, members: members.length, start: dates[0], end: dates[dates.length - 1],
      dates, equity: eq, benchmark: bh, rf: rfs, held,
      stats: periodStats(res, dates, 0, dates.length - 1), years: yearly(res, dates),
      trades, log, holdings, pending, cash_pct: (cash / vEnd) * 100,
      exposure_pct: (held.filter(h => h.n > 0).length / held.length) * 100,
      avg_holdings: held.reduce((a, h) => a + h.n, 0) / held.length,
    };
  }

  return { WARMUP, MIN_BARS, DEFAULTS, indicators, rfDaily, periodStats, yearly, run, portfolio };
});
