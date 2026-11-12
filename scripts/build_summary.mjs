// Runs the default-parameter backtest for every symbol and stores the summary in
// public/data/universe.json (the screener columns). Uses the same strategy.js as the browser.
//   node scripts/build_summary.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const S = createRequire(import.meta.url)("../strategy.js");
const DATA = new URL("../public/data/", import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, DATA), "utf8"));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

const universe = read("universe.json");
const irx = read(`daily/${universe.risk_free_file}`);

for (const s of universe.sectors) {
  const d = read(`daily/${s.file}`);
  const st = S.run(d, {}, irx).stats;
  Object.assign(s, {
    days: d.dates.length,
    daily_close: r2(st.latest_close), daily_ema50: r2(st.latest_ema50), daily_ema300: r2(st.latest_ema300),
    daily_rsi_ema200: r1(st.latest_rsi_ema200),
    daily_state: st.current_state, daily_trades: st.total_trades, daily_win_rate: r1(st.win_rate_pct),
    daily_exposure: r1(st.exposure_pct),
    last_signal_date: st.last_signal_date, last_signal_type: st.last_signal_type,
    // null when the symbol has too little history to backtest
    daily_cagr: st.strategy && r2(st.strategy.cagr), daily_bh_cagr: st.benchmark && r2(st.benchmark.cagr),
    daily_sharpe: st.strategy && r2(st.strategy.sharpe), daily_bh_sharpe: st.benchmark && r2(st.benchmark.sharpe),
    daily_dd: st.strategy && r1(st.strategy.maxDrawdown), daily_bh_dd: st.benchmark && r1(st.benchmark.maxDrawdown),
  });
}

writeFileSync(new URL("universe.json", DATA), JSON.stringify(universe));
const t = universe.sectors.filter(s => s.daily_cagr != null);
const beat = k => t.filter(s => s[`daily_${k}`] > s[`daily_bh_${k}`]).length;
console.log(`Backtested ${t.length}/${universe.sectors.length}. Strategy beats buy & hold on CAGR in ${beat("cagr")}, ` +
  `on Sharpe in ${beat("sharpe")}, has the smaller drawdown in ${t.filter(s => s.daily_dd < s.daily_bh_dd).length}.`);
