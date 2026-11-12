// Self-check of the backtest accounting.  node scripts/test_strategy.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const S = createRequire(import.meta.url)("../strategy.js");

// 2,000 business days: +0.1% a day, with a 40% slide over bars 1,200-1,400.
const dates = [], close = [];
let p = 100;
for (let i = 0, t = Date.UTC(2000, 0, 3); dates.length < 2000; i++, t += 864e5) {
  if ([0, 6].includes(new Date(t).getUTCDay())) continue;
  const k = dates.length;
  p *= k < 1200 || k >= 1400 ? 1.001 : 0.9975;
  dates.push(new Date(t).toISOString().slice(0, 10));
  close.push(p);
}
const d = { dates, open: close, high: close.map(c => c * 1.005), low: close.map(c => c * 0.995), close };
const irx = { dates: [dates[0]], close: [2.52] }; // 2.52% a year = 0.01% a day

const res = S.run(d, {}, irx), free = S.run(d, { cost_bps: 0 }, irx);
const ix = t => dates.indexOf(t);

assert.ok(res.trades.length >= 2, "buys the uptrend, sells the slide, buys the recovery");
for (const t of res.trades) {
  assert.equal(ix(t.entry_date), ix(t.signal_date) + 1, "fills one bar after the signal, never on it");
  assert.equal(t.entry_price, close[ix(t.entry_date)]);
}
// Nothing happens before the warm-up, and buy & hold starts on the same bar as the strategy.
assert.ok(res.signals.every(s => ix(s.time) >= S.WARMUP));
assert.equal(res.bh_curve[S.WARMUP], 100);
assert.equal(res.equity_curve[S.WARMUP], 100);
// Equity = product of held returns, T-bills while flat, and one cost per fill.
const [t0, t1] = res.trades;
const a = ix(t0.entry_date), b = ix(t0.exit_date), c2 = ix(t1.entry_date);
assert.ok(Math.abs(res.equity_curve[b] / res.equity_curve[a] - (close[b] / close[a]) * 0.999) < 1e-9, "long leg + exit cost");
assert.ok(Math.abs(res.equity_curve[c2 - 1] / res.equity_curve[b] - 1.0001 ** (c2 - 1 - b)) < 1e-9, "flat leg earns T-bills");
assert.ok(Math.abs(res.equity_curve.at(-1) / free.equity_curve.at(-1) - 0.999 ** res.stats.fills) < 1e-9, "costs");
// Years chain back to the full-period return.
const chained = S.yearly(res, dates).reduce((m, y) => m * (1 + y.strategy.totalReturn / 100), 1);
assert.ok(Math.abs(chained - (1 + res.stats.strategy.totalReturn / 100)) < 1e-9);
// Too little history is reported, not backtested.
const short = S.run({ dates: dates.slice(0, 500), open: close, high: close, low: close, close: close.slice(0, 500) }, {}, irx);
assert.equal(short.stats.insufficient, true);

console.log(`ok: ${res.trades.length} trades, ${res.stats.fills} fills`);
