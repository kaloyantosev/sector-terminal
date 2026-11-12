let UNIVERSE_DATA = null;
let FILTERED_SECTORS = [];
let SELECTED_SYMBOL = "XLK";
let STRATEGY_DATA = null;

let CHART_MODE = "lwc"; // 'lwc' (Lightweight Charts with markers) or 'tvw' (TradingView.com embed)
let TV_MODE = "primary";
let PRICE_SCALE_MODE = "log"; // 'log' or 'lin'

let sortKey = "composite_score";
let sortAsc = false;

let coverageChart = null;
let rrgChart = null;
let equityChart = null;
let pfChart = null;
let PORTFOLIO = null;     // public/data/portfolio.json, one backtest per mode
let PF_MODE = "cash";
let PF_YEAR = null;       // selected year card, or null for the whole run

function setPortfolioMode(mode) {
  PF_MODE = mode; PF_YEAR = null;
  document.getElementById("pf-mode-cash").classList.toggle("active", mode === "cash");
  document.getElementById("pf-mode-rebalance").classList.toggle("active", mode === "rebalance");
  renderPortfolio();
}

function selectPortfolioYear(y) {
  PF_YEAR = y;
  renderPortfolio();
}

function renderPortfolio() {
  if (!PORTFOLIO) return;
  const p = PORTFOLIO[PF_MODE];
  const yr = PF_YEAR === null ? null : p.years.find(y => y.year === PF_YEAR);
  const s = (yr || p.stats).strategy, b = (yr || p.stats).benchmark;
  const tone = v => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const sh = v => v.toFixed(2).replace("-", "−");
  const multi = s.years >= 1.5;
  const tile = (label, sv, bv, better, note) => `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${better === null ? "" : better ? "pos" : "neg"}">${sv}</div>
      <div class="stat-bench">SPY ${bv}</div>
      <div class="stat-note">${note}</div>
    </div>`;

  document.getElementById("pf-range").textContent =
    `${p.start} → ${p.end} · ${PORTFOLIO.members} US sector ETFs screened daily · data to ${PORTFOLIO.asOf}`;
  document.getElementById("pf-badge").textContent = PF_MODE === "cash" ? "CASH-ONLY BUYS" : "EQUAL-WEIGHT ON BUY";
  document.getElementById("pf-banner").innerHTML = yr
    ? `<b>${yr.year}${yr.partial ? " (year to date)" : ""}</b> · close to close, cut from the same run
       <button class="btn-ghost" onclick="selectPortfolioYear(null)">← All years</button>`
    : "";
  document.getElementById("pf-stats").innerHTML =
    tile("Return", fmtSigned(s.totalReturn), fmtSigned(b.totalReturn), s.totalReturn >= b.totalReturn,
      yr ? `Close to close, ${yr.year}` : `$10,000 → $${Math.round(10000 * (1 + s.totalReturn / 100)).toLocaleString("en-US")}`) +
    tile("CAGR", multi ? fmtSigned(s.cagr) : "–", multi ? fmtSigned(b.cagr) : "–", multi ? s.cagr >= b.cagr : null,
      multi ? `Over ${s.years.toFixed(1)} years` : "Shown for periods over 1.5 years") +
    tile("Max drawdown", fmtSigned(-s.maxDrawdown), fmtSigned(-b.maxDrawdown), s.maxDrawdown <= b.maxDrawdown, "Largest fall from a peak") +
    tile("Volatility", `${s.volatility.toFixed(1)}%`, `${b.volatility.toFixed(1)}%`, s.volatility <= b.volatility, "Annualised, daily returns") +
    tile("Sharpe ratio", sh(s.sharpe), sh(b.sharpe), s.sharpe >= b.sharpe, "Excess return over T-bills per unit of risk");

  const wins = p.trades.filter(t => t.ret_pct > 0).length;
  document.getElementById("pf-facts").innerHTML = [
    `${p.trades.length} closed positions, ${p.trades.length ? Math.round(wins / p.trades.length * 100) : 0}% winners`,
    `Invested ${p.exposure_pct.toFixed(0)}% of days, ${p.avg_holdings.toFixed(1)} sectors on average`,
    `Now ${p.holdings.length} holdings, ${p.cash_pct.toFixed(0)}% cash`,
    "0.10% cost per unit of turnover",
  ].map(t => `<span>${t}</span>`).join("");

  document.getElementById("pf-years").innerHTML = p.years.map(y => {
    const sr = y.strategy.totalReturn, br = y.benchmark.totalReturn;
    return `
      <button class="year-card ${PF_YEAR === y.year ? "active" : ""}" onclick="selectPortfolioYear(${y.year})">
        <span class="yc-year">${y.year}${y.partial ? "<small> YTD</small>" : ""}</span>
        <span class="yc-row"><small>Rot.</small><b class="${tone(sr)}">${fmtSigned(sr, 0)}</b></span>
        <span class="yc-row"><small>SPY</small><b>${fmtSigned(br, 0)}</b></span>
        <span class="yc-row yc-ex"><small>Excess</small><b class="${tone(sr - br)}">${fmtSigned(sr - br, 0)}</b></span>
      </button>`;
  }).join("");

  const pend = p.pending.filter(x => x.buy || x.held);
  document.getElementById("pf-pending-count").textContent = `${pend.length} SIGNALS`;
  document.querySelector("#pf-pending tbody").innerHTML = pend.length ? pend.map(x => `
    <tr onclick="selectSector('${x.sym}', true)">
      <td><span class="sym-pill">${x.sym}</span></td><td>${x.sector}</td><td>${x.kind}</td>
      <td>${!x.buy ? '<span class="sig-badge-EXIT">SELL</span>'
        : p.holdings.some(h => h.sector === x.sector) ? '<span style="color:var(--text-muted)">sector already held</span>'
        : PF_MODE === "cash" && p.cash_pct < 0.1 ? '<span style="color:var(--text-muted)">skipped, no cash</span>'
        : '<span class="sig-badge-A">BUY</span>'}</td>
    </tr>`).join("") : '<tr><td colspan="4" style="color:var(--text-muted); text-align:center;">No buy or sell signal at the last close.</td></tr>';

  document.getElementById("pf-hold-count").textContent = `${p.holdings.length} HELD`;
  document.querySelector("#pf-holdings tbody").innerHTML = p.holdings.length ? p.holdings.map(h => `
    <tr onclick="selectSector('${h.sym}', true)">
      <td><span class="sym-pill">${h.sym}</span></td><td>${h.sector}</td>
      <td style="font-family:var(--font-mono);">${h.entry_date}</td>
      <td class="num">${h.weight.toFixed(1)}%</td><td class="num">${fmtPct(h.ret_pct)}</td>
    </tr>`).join("") : '<tr><td colspan="5" style="color:var(--text-muted); text-align:center;">All in T-bills.</td></tr>';

  const log = p.log.filter(l => !yr || l.date.startsWith(String(yr.year))).slice().reverse().slice(0, 400);
  document.getElementById("pf-log-count").textContent = `${p.log.length} FILLS`;
  document.querySelector("#pf-log tbody").innerHTML = log.map(l => `
    <tr onclick="selectSector('${l.sym}', true)">
      <td style="font-family:var(--font-mono);">${l.date}</td>
      <td>${l.side === "BUY" ? '<span class="sig-badge-A">BUY</span>' : '<span class="sig-badge-EXIT">SELL</span>'}</td>
      <td><span class="sym-pill">${l.sym}</span></td><td>${l.sector}</td><td class="num">${l.weight.toFixed(1)}%</td>
    </tr>`).join("");

  const ctx = document.getElementById("pfChart").getContext("2d");
  if (pfChart) pfChart.destroy();
  pfChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: p.dates,
      datasets: [
        { label: "Rotation portfolio (after costs)", data: p.equity, borderColor: "#10b981", backgroundColor: "rgba(16,185,129,0.08)", fill: true, borderWidth: 1.8, pointRadius: 0 },
        { label: "SPY (total return)", data: p.benchmark, borderColor: "#627d98", borderWidth: 1.2, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#9fb3c8", font: { size: 10.5 } } },
                 tooltip: { backgroundColor: "#0d1421", borderColor: "#2d466e", borderWidth: 1 } },
      scales: { x: { grid: { display: false }, ticks: { color: "#627d98", maxTicksLimit: 8 } },
                y: { type: "logarithmic", grid: { color: "rgba(30,45,71,0.4)" }, ticks: { color: "#9fb3c8" } } },
    },
  });
}

// TradingView Lightweight Charts instances
let lwcPriceChart = null;
let lwcRsiChart = null;
let lwcCandleSeries = null;
let lwcSyncing = false;
let lwcResizeObserver = null;

window.addEventListener("DOMContentLoaded", () => {
  loadUniverse();
});

const DATA = "public/data/";
const DAILY_CACHE = new Map(); // file -> parsed daily OHLC
let RISK_FREE = null;          // ^IRX daily file
let PERIOD = null;             // year card selected in the stats panel, or null for the whole run

async function fetchJson(path) {
  const resp = await fetch(DATA + path, { cache: "no-cache" }); // revalidate: data changes weekly
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

async function loadDaily(file) {
  if (!DAILY_CACHE.has(file)) DAILY_CACHE.set(file, await fetchJson(`daily/${file}`));
  return DAILY_CACHE.get(file);
}

async function loadUniverse() {
  try {
    const params = new URLSearchParams(window.location.search);
    const reqSym = params.get("symbol") || "XLK";
    if (params.get("view") === "chart") document.body.classList.add("chart-only");

    UNIVERSE_DATA = await fetchJson("universe.json");
    RISK_FREE = await loadDaily(UNIVERSE_DATA.risk_free_file);
    renderHeaderAndCoverage();
    populateCategoryFilter();
    renderScoreboard();
    fetchJson("portfolio.json").then(p => { PORTFOLIO = p; renderPortfolio(); })
      .catch(err => console.error("Failed to load portfolio:", err));
    applyFilters();

    const defaultSym = UNIVERSE_DATA.sectors.find(s => s.yf_symbol === reqSym)
      ? reqSym
      : UNIVERSE_DATA.sectors[0]?.yf_symbol;
    if (defaultSym) {
      await selectSector(defaultSym, false);
    }
  } catch (err) {
    console.error("Failed to load universe:", err);
    document.getElementById("last-sync-label").textContent = "Error loading data";
  }
}

const fmtSigned = (v, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;

function fmtPct(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return '<span style="color:var(--text-muted)">—</span>';
  const cls = val > 0 ? "pos" : val < 0 ? "neg" : "";
  const sign = val > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${Number(val).toFixed(2)}%</span>`;
}

function fmtNum(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// =========================================================================
// DAILY 300/50 EMA + SMOOTHED RSI BUY/SELL STRATEGY & TRADINGVIEW CHARTS
// =========================================================================

async function selectSector(symbol, scrollToTop = false) {
  SELECTED_SYMBOL = symbol;
  document.getElementById("hdr-active-sector").textContent = symbol;

  document.querySelectorAll(".tech-quick-bar button[data-sym]").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-sym") === symbol);
  });

  if (UNIVERSE_DATA) renderScreenerTable();
  await refreshStrategy();

  if (CHART_MODE === "tvw") {
    initTradingViewWidget();
  }
  if (scrollToTop) {
    document.getElementById("sec-strategy").scrollIntoView({ behavior: "smooth" });
  }
}

async function refreshStrategy() {
  if (!SELECTED_SYMBOL || !UNIVERSE_DATA) return;
  const sec = UNIVERSE_DATA.sectors.find(s => s.yf_symbol === SELECTED_SYMBOL);
  if (!sec) return;
  const val = id => parseFloat(document.getElementById(id).value);
  const params = {
    dev_pct: val("param-dev"), confirm_days: val("param-conf"), slope_win: val("param-slope"),
    atr_mult: val("param-atr"), rsi_drop: val("param-rsidrop"), cooldown_days: val("param-cooldown"),
    require_rising: val("param-rising") === 1, cost_bps: val("param-cost"),
  };
  try {
    const d = await loadDaily(sec.file);
    if (sec.yf_symbol !== SELECTED_SYMBOL) return; // a later click won the race
    const res = Strategy.run(d, params, RISK_FREE);
    STRATEGY_DATA = {
      sector: sec, params, res,
      chart: { dates: d.dates, opens: d.open, highs: d.high, lows: d.low, closes: d.close,
               ema50: res.ind.ema50, ema300: res.ind.ema300, rsi_ema200: res.ind.rsi_ema200 },
      signals: res.signals, trades: res.trades,
      equity_curve: res.equity_curve, bh_curve: res.bh_curve, stats: res.stats,
      years: Strategy.yearly(res, d.dates),
    };
    PERIOD = null;
    renderStrategyTelemetry();
    renderLightweightCharts();
    if (!document.body.classList.contains("chart-only")) {
      renderStrategyEquityChart();
      renderTradeLog();
    }
  } catch (err) {
    console.error("Failed to load daily strategy:", err);
  }
}

function setChartMode(mode) {
  CHART_MODE = mode;
  document.getElementById("btn-chart-lwc").classList.toggle("active", mode === "lwc");
  document.getElementById("btn-chart-tvw").classList.toggle("active", mode === "tvw");
  document.getElementById("lwc-wrapper").style.display = mode === "lwc" ? "flex" : "none";
  document.getElementById("tvw-wrapper").style.display = mode === "tvw" ? "block" : "none";

  if (mode === "tvw") {
    initTradingViewWidget();
  } else if (STRATEGY_DATA) {
    renderLightweightCharts();
  }
}

function setTvMode(mode) {
  TV_MODE = mode;
  document.getElementById("btn-tv-primary").classList.toggle("active", mode === "primary");
  document.getElementById("btn-tv-index").classList.toggle("active", mode === "index");
  initTradingViewWidget();
}

function setPriceScale(mode) {
  PRICE_SCALE_MODE = mode;
  document.getElementById("btn-scale-log").classList.toggle("active", mode === "log");
  document.getElementById("btn-scale-lin").classList.toggle("active", mode === "lin");
  if (lwcPriceChart) {
    lwcPriceChart.priceScale("right").applyOptions({
      mode: mode === "log" ? LightweightCharts.PriceScaleMode.Logarithmic : LightweightCharts.PriceScaleMode.Normal
    });
  }
}

function resetChartZoom() {
  if (lwcPriceChart) lwcPriceChart.timeScale().fitContent();
  if (lwcRsiChart) lwcRsiChart.timeScale().fitContent();
}

function zoomRecentYears(years) {
  if (!lwcPriceChart || !STRATEGY_DATA) return;
  if (CHART_MODE !== "lwc") setChartMode("lwc");
  const n = STRATEGY_DATA.chart.dates.length;
  const bars = Math.round(years * 252);
  const fromIdx = Math.max(0, n - bars);
  lwcPriceChart.timeScale().setVisibleLogicalRange({ from: fromIdx, to: n - 1 });
}

function zoomToDate(dateStr) {
  if (!lwcPriceChart || !STRATEGY_DATA) return;
  if (CHART_MODE !== "lwc") setChartMode("lwc");
  const dates = STRATEGY_DATA.chart.dates;
  const idx = dates.indexOf(dateStr);
  if (idx < 0) return;
  const fromIdx = Math.max(0, idx - 160);
  const toIdx = Math.min(dates.length - 1, idx + 220);
  lwcPriceChart.timeScale().setVisibleLogicalRange({ from: fromIdx, to: toIdx });
}

function renderStrategyTelemetry() {
  const sec = STRATEGY_DATA.sector;
  const st = STRATEGY_DATA.stats;
  const nDays = STRATEGY_DATA.chart.dates.length;

  document.getElementById("strat-title").textContent =
    `${sec.yf_symbol} — ${sec.name} (Daily · ${sec.years}Y / ${nDays.toLocaleString()} trading days)` +
    (sec.tradable ? "" : " · price index, not investable");
  document.getElementById("strat-rule-status").textContent = st.waiting_rule;

  const stateBadge = document.getElementById("strat-state-badge");
  stateBadge.textContent = st.current_state;
  if (st.current_state.startsWith("LONG")) {
    stateBadge.className = "card-badge badge-emerald";
  } else if (st.current_state.startsWith("DIP")) {
    stateBadge.className = "card-badge badge-amber";
  } else {
    stateBadge.className = "card-badge badge-rose";
  }

  document.getElementById("leg-sym").textContent = sec.yf_symbol;
  document.getElementById("leg-ema300").textContent = fmtNum(st.latest_ema300);
  document.getElementById("leg-ema50").textContent = fmtNum(st.latest_ema50);
  document.getElementById("leg-rsi-ema").textContent = st.latest_rsi_ema200.toFixed(1);

  // Whole run, or the selected year cut from the same run.
  const dates = STRATEGY_DATA.chart.dates;
  const per = PERIOD || { strategy: st.strategy, benchmark: st.benchmark };
  const s = per.strategy, b = per.benchmark;
  const tile = (label, sv, bv, better, note) => `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${better === null ? "" : better ? "pos" : "neg"}">${sv}</div>
      <div class="stat-bench">Buy &amp; hold ${bv}</div>
      <div class="stat-note">${note}</div>
    </div>`;
  const grid = document.getElementById("stats-grid");
  if (!s) {
    grid.innerHTML = `<div class="stat-note">${st.waiting_rule}. Not backtested.</div>`;
  } else {
    const multi = s.years >= 1.5, sh = v => v.toFixed(2).replace("-", "−");
    grid.innerHTML =
      tile("Return", fmtSigned(s.totalReturn), fmtSigned(b.totalReturn), s.totalReturn >= b.totalReturn,
        PERIOD ? `Close to close, ${PERIOD.year}` : `Since ${dates[STRATEGY_DATA.res.warmup]}, both start at 100`) +
      tile("CAGR", multi ? fmtSigned(s.cagr) : "–", multi ? fmtSigned(b.cagr) : "–", multi ? s.cagr >= b.cagr : null,
        multi ? `Compound annual growth over ${s.years.toFixed(1)} years` : "Shown for periods over 1.5 years") +
      tile("Max drawdown", fmtSigned(-s.maxDrawdown), fmtSigned(-b.maxDrawdown), s.maxDrawdown <= b.maxDrawdown, "Largest fall from a peak") +
      tile("Volatility", `${s.volatility.toFixed(1)}%`, `${b.volatility.toFixed(1)}%`, s.volatility <= b.volatility, "Annualised, daily returns") +
      tile("Sharpe ratio", sh(s.sharpe), sh(b.sharpe), s.sharpe >= b.sharpe, "Excess return over T-bills per unit of risk");
  }

  document.getElementById("period-banner").innerHTML = PERIOD
    ? `<b>${PERIOD.year}${PERIOD.partial ? " (year to date)" : ""}</b> · ${dates[PERIOD.from]} → ${dates[PERIOD.to]} · cut from the same continuous run
       <button class="btn-ghost" onclick="selectPeriod(null)">← All years</button>`
    : "";

  const tone = v => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  document.getElementById("years-strip").innerHTML = STRATEGY_DATA.years.map(y => {
    const sr = y.strategy.totalReturn, br = y.benchmark.totalReturn;
    return `
      <button class="year-card ${PERIOD && PERIOD.year === y.year ? "active" : ""}" onclick="selectPeriod(${y.year})">
        <span class="yc-year">${y.year}${y.partial ? "<small> YTD</small>" : ""}</span>
        <span class="yc-row"><small>Strat</small><b class="${tone(sr)}">${fmtSigned(sr, 0)}</b></span>
        <span class="yc-row"><small>B&amp;H</small><b>${fmtSigned(br, 0)}</b></span>
        <span class="yc-row yc-ex"><small>Excess</small><b class="${tone(sr - br)}">${fmtSigned(sr - br, 0)}</b></span>
      </button>`;
  }).join("");

  document.getElementById("period-facts").innerHTML = [
    `${st.total_trades} trades (${st.buy_a_count} A / ${st.buy_b_count} B / ${st.buy_bounce_count} bounce)`,
    `Win rate ${st.win_rate_pct.toFixed(0)}%`,
    `In the market ${st.exposure_pct.toFixed(0)}% of days, T-bills otherwise`,
    `Sells: ${st.sell_50_count} (<50) / ${st.sell_both_count} (both)`,
    `Costs ${st.costs_pct.toFixed(1)}% (${st.fills} fills × ${(STRATEGY_DATA.params.cost_bps / 100).toFixed(2)}%)`,
  ].map(t => `<span>${t}</span>`).join("");
}

// Year card click: the tiles and the chart switch to that year; null goes back to the whole run.
function selectPeriod(year) {
  PERIOD = year === null ? null : STRATEGY_DATA.years.find(y => y.year === year) || null;
  renderStrategyTelemetry();
  if (PERIOD && lwcPriceChart) lwcPriceChart.timeScale().setVisibleLogicalRange({ from: PERIOD.from, to: PERIOD.to });
  else resetChartZoom();
}

function renderLightweightCharts() {
  if (typeof LightweightCharts === "undefined" || !STRATEGY_DATA) return;
  const priceBox = document.getElementById("lwc_price_container");
  const rsiBox = document.getElementById("lwc_rsi_container");

  if (lwcResizeObserver) { lwcResizeObserver.disconnect(); lwcResizeObserver = null; }
  if (lwcPriceChart) { lwcPriceChart.remove(); lwcPriceChart = null; }
  if (lwcRsiChart) { lwcRsiChart.remove(); lwcRsiChart = null; }

  const commonOpts = {
    layout: {
      background: { color: "#090d16" },
      textColor: "#9fb3c8",
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(30, 45, 71, 0.35)" },
      horzLines: { color: "rgba(30, 45, 71, 0.35)" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: "#1e2d47",
    },
    timeScale: {
      borderColor: "#1e2d47",
      timeVisible: false,
    },
  };

  const priceW = priceBox.clientWidth || window.innerWidth - 28;
  const priceH = priceBox.clientHeight || Math.max(380, Math.floor(window.innerHeight * 0.68));
  const rsiW = rsiBox.clientWidth || window.innerWidth - 28;
  const rsiH = rsiBox.clientHeight || Math.max(150, Math.floor(window.innerHeight * 0.24));

  lwcPriceChart = LightweightCharts.createChart(priceBox, {
    ...commonOpts,
    width: priceW,
    height: priceH,
    rightPriceScale: {
      borderColor: "#1e2d47",
      mode: PRICE_SCALE_MODE === "log"
        ? LightweightCharts.PriceScaleMode.Logarithmic
        : LightweightCharts.PriceScaleMode.Normal,
    },
  });

  lwcRsiChart = LightweightCharts.createChart(rsiBox, {
    ...commonOpts,
    width: rsiW,
    height: rsiH,
  });

  const ch = STRATEGY_DATA.chart;
  const dev = parseFloat(STRATEGY_DATA.params.dev_pct || 0) / 100.0;

  const candleData = [];
  const ema300Data = [];
  const ema300UpData = [];
  const ema300DnData = [];
  const ema50Data = [];
  const rsiEmaData = [];

  for (let i = 0; i < ch.dates.length; i++) {
    const t = ch.dates[i];
    candleData.push({
      time: t,
      open: ch.opens[i],
      high: ch.highs[i],
      low: ch.lows[i],
      close: ch.closes[i],
    });
    ema300Data.push({ time: t, value: ch.ema300[i] });
    ema300UpData.push({ time: t, value: +(ch.ema300[i] * (1 + dev)).toFixed(4) });
    ema300DnData.push({ time: t, value: +(ch.ema300[i] * (1 - dev)).toFixed(4) });
    ema50Data.push({ time: t, value: ch.ema50[i] });
    rsiEmaData.push({ time: t, value: ch.rsi_ema200[i] });
  }

  lwcCandleSeries = lwcPriceChart.addCandlestickSeries({
    upColor: "#10b981",
    downColor: "#f43f5e",
    borderVisible: false,
    wickUpColor: "#10b981",
    wickDownColor: "#f43f5e",
  });
  lwcCandleSeries.setData(candleData);

  if (dev > 0) {
    const bandUp = lwcPriceChart.addLineSeries({
      color: "rgba(6, 182, 212, 0.30)",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    bandUp.setData(ema300UpData);

    const bandDn = lwcPriceChart.addLineSeries({
      color: "rgba(6, 182, 212, 0.30)",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    bandDn.setData(ema300DnData);
  }

  const s300 = lwcPriceChart.addLineSeries({
    color: "#06b6d4",
    lineWidth: 2.2,
    title: "300D EMA",
    priceLineVisible: false,
  });
  s300.setData(ema300Data);

  const s50 = lwcPriceChart.addLineSeries({
    color: "#f59e0b",
    lineWidth: 1.8,
    title: "50D EMA",
    priceLineVisible: false,
  });
  s50.setData(ema50Data);

  // Print BUY A, BUY B, BUY BOUNCE, SELL <50+RSI↓, and SELL <BOTH markers on Daily Candles
  const markers = STRATEGY_DATA.signals.map(sig => {
    if (sig.kind === "BUY_A") {
      return { time: sig.time, position: "belowBar", color: "#10b981", shape: "arrowUp", text: "BUY A (>300)", size: 2 };
    }
    if (sig.kind === "BUY_B") {
      return { time: sig.time, position: "belowBar", color: "#06b6d4", shape: "arrowUp", text: "BUY B (>300&50)", size: 2 };
    }
    if (sig.kind === "BUY_BOUNCE") {
      return { time: sig.time, position: "belowBar", color: "#34d399", shape: "arrowUp", text: "BOUNCE (>50)", size: 1 };
    }
    if (sig.kind === "SELL_50") {
      return { time: sig.time, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", text: "SELL <50+RSI↓", size: 1 };
    }
    return { time: sig.time, position: "aboveBar", color: "#f43f5e", shape: "arrowDown", text: "SELL <BOTH", size: 2 };
  });
  lwcCandleSeries.setMarkers(markers);

  // RSI Sub-pane: ONLY Smoothed RSI (200D EMA) and Neutral 50.0 line (purple raw line removed!)
  const rsiEmaSeries = lwcRsiChart.addLineSeries({
    color: "#facc15",
    lineWidth: 2.2,
    title: "Smoothed RSI (200D EMA)",
    priceLineVisible: false,
  });
  rsiEmaSeries.setData(rsiEmaData);

  rsiEmaSeries.createPriceLine({
    price: 50,
    color: "#94a3b8",
    lineWidth: 1.2,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: "NEUTRAL 50",
  });

  lwcPriceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (lwcSyncing || !range) return;
    lwcSyncing = true;
    lwcRsiChart.timeScale().setVisibleLogicalRange(range);
    lwcSyncing = false;
  });
  lwcRsiChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (lwcSyncing || !range) return;
    lwcSyncing = true;
    lwcPriceChart.timeScale().setVisibleLogicalRange(range);
    lwcSyncing = false;
  });

  lwcPriceChart.timeScale().fitContent();
  lwcRsiChart.timeScale().fitContent();

  lwcResizeObserver = new ResizeObserver(() => {
    if (lwcPriceChart && priceBox.clientWidth > 0 && priceBox.clientHeight > 0) {
      lwcPriceChart.applyOptions({ width: priceBox.clientWidth, height: priceBox.clientHeight });
    }
    if (lwcRsiChart && rsiBox.clientWidth > 0 && rsiBox.clientHeight > 0) {
      lwcRsiChart.applyOptions({ width: rsiBox.clientWidth, height: rsiBox.clientHeight });
    }
  });
  lwcResizeObserver.observe(priceBox);
  lwcResizeObserver.observe(rsiBox);
}

function renderStrategyEquityChart() {
  if (!STRATEGY_DATA) return;
  const ctx = document.getElementById("strategyEquityChart").getContext("2d");
  if (equityChart) equityChart.destroy();

  const dates = STRATEGY_DATA.chart.dates;
  const eq = STRATEGY_DATA.equity_curve;
  const bh = STRATEGY_DATA.bh_curve;

  // Downsample long daily series (~10,000 points) for snappy Chart.js rendering
  const step = Math.max(1, Math.floor(dates.length / 400));
  const labels = [];
  const eqPts = [];
  const bhPts = [];
  for (let i = Math.min(STRATEGY_DATA.res.warmup, dates.length - 1); i < dates.length; i += step) {
    labels.push(dates[i]);
    eqPts.push(eq[i]);
    bhPts.push(bh[i]);
  }
  if (labels[labels.length - 1] !== dates[dates.length - 1]) {
    labels.push(dates[dates.length - 1]);
    eqPts.push(eq[eq.length - 1]);
    bhPts.push(bh[bh.length - 1]);
  }

  equityChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Strategy (next-close fills, after costs, T-bills when flat)",
          data: eqPts,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.08)",
          fill: true,
          borderWidth: 1.8,
          pointRadius: 0,
        },
        {
          label: "Buy & Hold",
          data: bhPts,
          borderColor: "#627d98",
          borderWidth: 1.2,
          borderDash: [4, 4],
          pointRadius: 0,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#9fb3c8", font: { size: 10.5 } } },
        tooltip: { backgroundColor: "#0d1421", borderColor: "#2d466e", borderWidth: 1 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#627d98", maxTicksLimit: 6 } },
        y: { type: "logarithmic", grid: { color: "rgba(30,45,71,0.4)" }, ticks: { color: "#9fb3c8" } }
      }
    }
  });
}

function renderTradeLog() {
  const tbody = document.querySelector("#trade-log-table tbody");
  const trades = [...STRATEGY_DATA.trades].reverse();
  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted); text-align:center;">No trades triggered under current parameters.</td></tr>';
    return;
  }

  tbody.innerHTML = trades.map(t => {
    let buyBadge = '<span class="sig-badge-B">BUY B</span>';
    if (t.entry_type === "BUY_A") buyBadge = '<span class="sig-badge-A">BUY A</span>';
    else if (t.entry_type === "BUY_BOUNCE") buyBadge = '<span class="sig-badge-A">BOUNCE</span>';

    let sellBadge = '<span class="pos">OPEN</span>';
    if (t.exit_type === "SELL_50") sellBadge = '<span class="sig-badge-EXIT">&lt;50+RSI↓</span>';
    else if (t.exit_type === "SELL_BOTH") sellBadge = '<span class="sig-badge-EXIT">&lt;BOTH</span>';

    return `
      <tr onclick="zoomToDate('${t.entry_date}')">
        <td style="font-family:var(--font-mono);">${t.entry_date}</td>
        <td>${buyBadge}</td>
        <td class="num">${fmtNum(t.entry_price)}</td>
        <td style="font-family:var(--font-mono);">${t.exit_date ?? "—"}</td>
        <td>${sellBadge}</td>
        <td class="num">${fmtNum(t.exit_price)}</td>
        <td class="num">${fmtPct(t.ret_pct)}</td>
      </tr>
    `;
  }).join("");
}

function initTradingViewWidget() {
  if (!STRATEGY_DATA) return;
  const sec = STRATEGY_DATA.sector;
  const tvSym = TV_MODE === "index"
    ? (sec.tv_index || sec.tv_symbol)
    : sec.tv_symbol;

  document.getElementById("tv-active-sym").textContent = tvSym;
  const container = document.getElementById("tv_sector_container");
  container.innerHTML = "";
  if (typeof TradingView === "undefined") return;

  new TradingView.widget({
    autosize: true,
    symbol: tvSym,
    interval: "D",
    timezone: "America/New_York",
    theme: "dark",
    style: "1",
    locale: "en",
    toolbar_bg: "#0b0e14",
    enable_publishing: false,
    hide_top_toolbar: false,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    studies: [
      { id: "MAExp@tv-basicstudies", inputs: { length: 50 } },
      { id: "MAExp@tv-basicstudies", inputs: { length: 300 } }
    ],
    container_id: "tv_sector_container"
  });
}

// =========================================================================
// COVERAGE, RRG ROTATION & MASTER SCREENER
// =========================================================================

function renderHeaderAndCoverage() {
  const d = UNIVERSE_DATA;
  const cov = d.coverage;

  document.getElementById("hdr-total-count").textContent = d.total_verified;
  document.getElementById("hdr-20y-count").textContent = `${cov.count_20y_plus} (${Math.round(cov.count_20y_plus / d.total_verified * 100)}%)`;
  document.getElementById("last-sync-label").textContent = `Daily closes to ${d.asOf} · refreshed weekly`;

  const spx = d.sectors.find(s => s.yf_symbol === "^GSPC");
  if (spx) {
    document.getElementById("hdr-spx-close").textContent = fmtNum(spx.last_close);
    document.getElementById("hdr-spx-1w").innerHTML = fmtPct(spx.ret_1w);
  }

  document.getElementById("cov-total").textContent = d.total_verified;
  document.getElementById("cov-failed").textContent = `${d.failed_count} failed / ${d.total_candidates} tested`;
  document.getElementById("cov-30y").textContent = cov.count_30y_plus;
  document.getElementById("cov-max-yrs").textContent = `Max: ${cov.max_years}Y`;
  document.getElementById("cov-25y").textContent = cov.count_25y_plus;
  document.getElementById("cov-20y").textContent = cov.count_20y_plus;
  document.getElementById("cov-median").textContent = `Median: ${cov.median_years}Y`;
  document.getElementById("cov-10y").textContent = cov.count_10y_plus;
  document.getElementById("cov-15y").textContent = `15Y+: ${cov.count_15y_plus}`;

  const cats = Object.entries(cov.by_category).sort((a, b) => b[1].max_years - a[1].max_years);
  const tbody = document.querySelector("#category-summary-table tbody");
  tbody.innerHTML = cats.map(([cat, info]) => `
    <tr onclick="filterByCategory('${cat.replace(/'/g, "\\'")}')">
      <td><strong>${cat}</strong></td>
      <td class="num"><span class="sym-pill">${info.count}</span></td>
      <td style="font-family:var(--font-mono); color:var(--text-secondary);">${info.earliest_start}</td>
      <td class="num">${info.min_years.toFixed(1)}y</td>
      <td class="num pos"><strong>${info.max_years.toFixed(1)}y</strong></td>
    </tr>
  `).join("");

  const ctx = document.getElementById("coverageChart").getContext("2d");
  if (coverageChart) coverageChart.destroy();
  coverageChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: cats.map(([c]) => c),
      datasets: [
        {
          label: "Max History (Years)",
          data: cats.map(([, info]) => info.max_years),
          backgroundColor: "rgba(6, 182, 212, 0.72)",
          borderColor: "#06b6d4",
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: "Symbols Count",
          data: cats.map(([, info]) => info.count),
          backgroundColor: "rgba(59, 130, 246, 0.65)",
          borderColor: "#3b82f6",
          borderWidth: 1,
          borderRadius: 4,
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#9fb3c8", font: { size: 11 } } },
        tooltip: { backgroundColor: "#0d1421", borderColor: "#2d466e", borderWidth: 1 }
      },
      scales: {
        x: { grid: { color: "rgba(30,45,71,0.5)" }, ticks: { color: "#9fb3c8" } },
        y: { grid: { display: false }, ticks: { color: "#f0f4f8", font: { size: 11 } } }
      }
    }
  });
}

function populateCategoryFilter() {
  const sel = document.getElementById("filter-category");
  const cats = Object.keys(UNIVERSE_DATA.coverage.by_category).sort();
  sel.innerHTML = `<option value="ALL">All Categories (${UNIVERSE_DATA.total_verified})</option>` +
    cats.map(c => `<option value="${c}">${c} (${UNIVERSE_DATA.coverage.by_category[c].count})</option>`).join("");
}

function filterByCategory(cat) {
  document.getElementById("filter-category").value = cat;
  applyFilters();
  document.getElementById("sec-screener").scrollIntoView({ behavior: "smooth" });
}

function resetFilters() {
  document.getElementById("filter-search").value = "";
  document.getElementById("filter-category").value = "ALL";
  document.getElementById("filter-region").value = "ALL";
  document.getElementById("filter-years").value = "0";
  document.getElementById("filter-quadrant").value = "ALL";
  applyFilters();
}

function applyFilters() {
  if (!UNIVERSE_DATA) return;
  const q = document.getElementById("filter-search").value.trim().toLowerCase();
  const cat = document.getElementById("filter-category").value;
  const reg = document.getElementById("filter-region").value;
  const minYrs = parseFloat(document.getElementById("filter-years").value) || 0;
  const quad = document.getElementById("filter-quadrant").value;

  FILTERED_SECTORS = UNIVERSE_DATA.sectors.filter(s => {
    if (cat !== "ALL" && s.category !== cat) return false;
    if (reg !== "ALL" && !s.region.toLowerCase().includes(reg.toLowerCase())) return false;
    if (s.years < minYrs) return false;
    if (quad !== "ALL" && s.quadrant !== quad) return false;
    if (q) {
      const hay = `${s.yf_symbol} ${s.tv_symbol} ${s.tv_index} ${s.name} ${s.sector} ${s.category}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  sortFiltered();
  renderScreenerTable();
  renderRotationSection();
}

function sortBy(key) {
  if (sortKey === key) {
    sortAsc = !sortAsc;
  } else {
    sortKey = key;
    sortAsc = ["yf_symbol", "name", "sector", "daily_state", "last_signal_date", "quadrant"].includes(key);
  }
  sortFiltered();
  renderScreenerTable();
}

function sortFiltered() {
  FILTERED_SECTORS.sort((a, b) => {
    let va = a[sortKey];
    let vb = b[sortKey];
    if (va === null || va === undefined) va = sortAsc ? 999999 : -999999;
    if (vb === null || vb === undefined) vb = sortAsc ? 999999 : -999999;
    if (typeof va === "string" && typeof vb === "string") {
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortAsc ? va - vb : vb - va;
  });
}

// "strategy / buy & hold" cell, green when the strategy is the better of the two
function vsCell(sv, bv, higherIsBetter, unit) {
  if (sv == null) return '<td class="num" style="color:var(--text-muted)">n/a</td>';
  const better = higherIsBetter ? sv > bv : sv < bv;
  return `<td class="num"><strong class="${better ? "pos" : "neg"}">${sv}${unit}</strong> <span style="color:var(--text-muted)">/ ${bv}${unit}</span></td>`;
}

// The honest headline: how often the default strategy beats simply holding the same symbol.
function renderScoreboard() {
  const t = UNIVERSE_DATA.sectors.filter(s => s.daily_cagr != null);
  const n = f => t.filter(f).length;
  document.getElementById("scoreboard").innerHTML =
    `Default parameters, ${t.length} symbols with enough history: the strategy beats buy &amp; hold on ` +
    `<b>CAGR in ${n(s => s.daily_cagr > s.daily_bh_cagr)}</b>, on <b>Sharpe in ${n(s => s.daily_sharpe > s.daily_bh_sharpe)}</b>, ` +
    `and has the <b>smaller max drawdown in ${n(s => s.daily_dd < s.daily_bh_dd)}</b>. ` +
    `It trades return for drawdown control.`;
}

function renderScreenerTable() {
  document.getElementById("screener-showing-count").textContent = `Showing ${FILTERED_SECTORS.length} / ${UNIVERSE_DATA.total_verified}`;
  const tbody = document.querySelector("#master-screener-table tbody");

  tbody.innerHTML = FILTERED_SECTORS.map(s => {
    const pctBar = Math.min(100, Math.round((s.years / 45) * 100));
    const selCls = s.yf_symbol === SELECTED_SYMBOL ? "selected-row" : "";
    const dState = s.daily_state || "";
    const stateShort = dState.startsWith("LONG")
      ? '<span class="sig-badge-A">LONG</span>'
      : dState.startsWith("DIP")
      ? '<span class="sig-badge-B">DIP ARMED</span>'
      : dState.startsWith("INSUFF")
      ? '<span style="color:var(--text-muted)">n/a</span>'
      : '<span class="sig-badge-EXIT">FLAT</span>';

    return `
      <tr class="${selCls}" onclick="selectSector('${s.yf_symbol}', true)">
        <td><span class="sym-pill">${s.yf_symbol}</span></td>
        <td>${s.name}${s.tradable ? "" : ' <span class="idx-tag" title="Price index or continuous future: no dividends, not investable as such">IDX</span>'}</td>
        <td>${s.sector}</td>
        <td class="num">
          <div class="depth-bar-bg"><div class="depth-bar-fill" style="width:${pctBar}%"></div></div>
          <strong>${s.years.toFixed(1)}y</strong>
        </td>
        <td class="num"><strong>${fmtNum(s.daily_close ?? s.last_close)}</strong></td>
        <td class="num">${fmtPct(s.ret_1w)}</td>
        <td class="num">${fmtPct(s.ret_13w)}</td>
        <td class="num" style="color:var(--accent-amber);">${fmtNum(s.daily_ema50)}</td>
        <td class="num" style="color:var(--accent-cyan);">${fmtNum(s.daily_ema300)}</td>
        <td class="num">${s.daily_rsi_ema200?.toFixed(1) ?? "—"}</td>
        <td>${stateShort}</td>
        <td class="num"><strong>${s.daily_trades ?? 0}</strong></td>
        ${vsCell(s.daily_cagr, s.daily_bh_cagr, true, "%")}
        ${vsCell(s.daily_sharpe, s.daily_bh_sharpe, true, "")}
        ${vsCell(s.daily_dd, s.daily_bh_dd, false, "%")}
        <td style="font-family:var(--font-mono); color:var(--text-secondary);">${s.last_signal_date ?? "—"}</td>
        <td><span class="quad-pill quad-${s.quadrant}">${s.quadrant}</span></td>
      </tr>
    `;
  }).join("");
}

function renderRotationSection() {
  const pool = FILTERED_SECTORS.filter(s => !s.category.startsWith("Macro & Benchmark") && s.yf_symbol !== "^VIX");
  const byScoreDesc = [...pool].sort((a, b) => b.composite_score - a.composite_score);
  const leaders = byScoreDesc.slice(0, 8);
  const laggards = [...byScoreDesc].reverse().slice(0, 8);

  const renderMini = (rows, tbodySel) => {
    document.querySelector(tbodySel).innerHTML = rows.map(s => `
      <tr onclick="selectSector('${s.yf_symbol}', true)">
        <td><span class="sym-pill">${s.yf_symbol}</span></td>
        <td>${s.sector} <span style="color:var(--text-muted); font-size:10.5px;">(${s.years.toFixed(0)}y)</span></td>
        <td class="num">${fmtPct(s.ret_1w)}</td>
        <td class="num">${fmtPct(s.ret_13w)}</td>
        <td class="num"><strong>${s.composite_score.toFixed(1)}</strong></td>
      </tr>
    `).join("");
  };
  renderMini(leaders, "#leaders-table tbody");
  renderMini(laggards, "#laggards-table tbody");

  const quadColors = {
    Leading: "rgba(16, 185, 129, 0.85)",
    Improving: "rgba(6, 182, 212, 0.85)",
    Weakening: "rgba(245, 158, 11, 0.85)",
    Lagging: "rgba(244, 63, 94, 0.85)",
    Neutral: "rgba(148, 163, 184, 0.7)"
  };

  const points = pool.slice(0, 90).map(s => ({
    x: s.rs_ratio,
    y: s.rs_momentum,
    symbol: s.yf_symbol,
    name: s.name,
    quad: s.quadrant,
    score: s.composite_score,
    r: s.yf_symbol === SELECTED_SYMBOL ? 9 : 5.5
  }));

  const crosshairPlugin = {
    id: "rrgCrosshair",
    beforeDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;
      const cx = x.getPixelForValue(100);
      const cy = y.getPixelForValue(100);
      ctx.save();
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        ctx.fillStyle = "rgba(16, 185, 129, 0.05)";
        ctx.fillRect(cx, top, right - cx, cy - top);
        ctx.fillStyle = "rgba(6, 182, 212, 0.04)";
        ctx.fillRect(left, top, cx - left, cy - top);
        ctx.fillStyle = "rgba(245, 158, 11, 0.04)";
        ctx.fillRect(cx, cy, right - cx, bottom - cy);
        ctx.fillStyle = "rgba(244, 63, 94, 0.05)";
        ctx.fillRect(left, cy, cx - left, bottom - cy);
      }
      ctx.strokeStyle = "rgba(159, 179, 200, 0.35)";
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1;
      if (cx >= left && cx <= right) {
        ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, bottom); ctx.stroke();
      }
      if (cy >= top && cy <= bottom) {
        ctx.beginPath(); ctx.moveTo(left, cy); ctx.lineTo(right, cy); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.font = "700 11px JetBrains Mono, monospace";
      ctx.fillStyle = "rgba(16,185,129,0.7)";
      ctx.fillText("LEADING", right - 64, top + 16);
      ctx.fillStyle = "rgba(6,182,212,0.7)";
      ctx.fillText("IMPROVING", left + 10, top + 16);
      ctx.fillStyle = "rgba(245,158,11,0.7)";
      ctx.fillText("WEAKENING", right - 78, bottom - 10);
      ctx.fillStyle = "rgba(244,63,94,0.7)";
      ctx.fillText("LAGGING", left + 10, bottom - 10);
      ctx.restore();
    }
  };

  const ctx = document.getElementById("rrgChart").getContext("2d");
  if (rrgChart) rrgChart.destroy();
  rrgChart = new Chart(ctx, {
    type: "bubble",
    data: {
      datasets: [{
        label: "Sectors vs S&P 500",
        data: points,
        backgroundColor: points.map(p => quadColors[p.quad] || quadColors.Neutral),
        borderColor: points.map(p => p.symbol === SELECTED_SYMBOL ? "#ffffff" : "rgba(255,255,255,0.25)"),
        borderWidth: points.map(p => p.symbol === SELECTED_SYMBOL ? 2 : 1)
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_, elements) => {
        if (elements.length > 0) {
          const pt = points[elements[0].index];
          if (pt) selectSector(pt.symbol, true);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0d1421",
          borderColor: "#2d466e",
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return `${p.symbol} (${p.name}) | RS-Ratio: ${p.x} | RS-Mom: ${p.y} | Score: ${p.score}`;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: "Mansfield RS-Ratio vs S&P 500 (100 = Neutral)", color: "#9fb3c8" },
          grid: { color: "rgba(30,45,71,0.4)" },
          ticks: { color: "#9fb3c8" }
        },
        y: {
          title: { display: true, text: "13W RS-Momentum (100 = Flat)", color: "#9fb3c8" },
          grid: { color: "rgba(30,45,71,0.4)" },
          ticks: { color: "#9fb3c8" }
        }
      }
    },
    plugins: [crosshairPlugin]
  });
}
