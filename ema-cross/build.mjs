// Build step: fetch every symbol's daily data from the sector-terminal repo, run the strategy, write summary.json.
// Usage: node build.mjs [localDataDir]   (no arg = fetch from GitHub)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const { runStrategy, HORIZONS } = createRequire(import.meta.url)("./strategy.js");

const SRC = process.argv[2];
const RAW = "https://raw.githubusercontent.com/kaloyantosev/sector-terminal/main/public/data/";
const SKIP = new Set(["_IRX.json", "_TNX.json", "_VIX.json"]); // yields / volatility, not price trends
const load = async (p) => SRC ? JSON.parse(readFileSync(`${SRC}/${p}`, "utf8")) : (async () => {
  for (let t = 0; t < 3; t++) { const r = await fetch(RAW + p); if (r.ok) return r.json(); }
  throw new Error(`fetch failed: ${p}`);
})();

const r2 = (x, d) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
const median = (x) => { const s = [...x].sort((a, b) => a - b), n = s.length; return n ? (s[(n - 1) >> 1] + s[n >> 1]) / 2 : null; };
const mean = (x) => x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
function stats(ev) {
  const out = {};
  for (const [k, n] of Object.entries(HORIZONS)) {
    const v = ev.filter((e) => e[k] != null), x = v.map((e) => e[k]);
    out[k] = { n: v.length, avg: r2(mean(x) * 100, 2), median: r2(median(x) * 100, 2),
      win: v.length ? r2(x.filter((y) => y > 0).length / v.length * 100, 1) : null,
      stopped: v.length ? r2(v.filter((e) => e.stopDay !== null && e.stopDay <= n).length / v.length * 100, 1) : null };
  }
  return out;
}
const quantile = (s, q) => { const p = (s.length - 1) * q, lo = Math.floor(p); return s[lo] + (s[Math.ceil(p)] - s[lo]) * (p - lo); };

const uni = await load("universe.json");
const list = uni.sectors.filter((s) => !SKIP.has(s.file));
const results = await Promise.all(list.map(async (s) => ({ s, ev: runStrategy(await load("daily/" + s.file)).events })));
const a12 = (ev) => r2(mean(ev.filter((e) => e["12w"] != null).map((e) => e["12w"])) * 100, 2);
const symbols = [], all = [];
for (const { s, ev } of results) {
  const idx = symbols.length;
  ev.forEach((e) => { e.category = s.category; e.sym = idx; all.push(e); });
  const L = ev.filter((e) => e.dir === "long"), Sh = ev.filter((e) => e.dir === "short");
  symbols.push({ file: s.file, tv: s.tv_symbol, name: s.name, category: s.category, nL: L.length, aL: a12(L), nS: Sh.length, aS: a12(Sh) });
}
function block(ev) {
  const byCat = {};
  for (const e of ev) (byCat[e.category] ??= []).push(e);
  const gaps = ev.map((e) => e.gap).sort((a, b) => a - b), q1 = quantile(gaps, 1 / 3), q2 = quantile(gaps, 2 / 3);
  const terc = { tight: ev.filter((e) => e.gap <= q1), mid: ev.filter((e) => e.gap > q1 && e.gap <= q2), wide: ev.filter((e) => e.gap > q2) };
  return {
    total_signals: ev.length,
    stopped_ever: r2(ev.filter((e) => e.stopDay !== null).length / ev.length * 100, 1),
    median_days_to_stop: median(ev.filter((e) => e.stopDay !== null).map((e) => e.stopDay)),
    all: stats(ev),
    index_only: stats(ev.filter((e) => e.category === "Pure Sector Index")),
    categories: Object.fromEntries(Object.keys(byCat).sort().map((c) => [c, { signals: byCat[c].length, h: stats(byCat[c]) }])),
    gap: Object.fromEntries(Object.entries(terc).map(([k, g]) => [k, { signals: g.length,
      range: [r2(Math.min(...g.map((e) => e.gap)) * 100, 2), r2(Math.max(...g.map((e) => e.gap)) * 100, 2)], h: stats(g) }])),
  };
}
const dates = all.map((e) => e.date).sort();
const summary = { asOf: uni.asOf, first: dates[0], last: dates.at(-1), total_signals: all.length,
  long: block(all.filter((e) => e.dir === "long")), short: block(all.filter((e) => e.dir === "short")), symbols };
writeFileSync(new URL("./summary.json", import.meta.url), JSON.stringify(summary));
// every signal for the calendar: [date, symbol index, +1 long / -1 short, return % per horizon (null = not yet), days to stop]
const pctR = (x) => x == null ? null : Math.round(x * 1000) / 10;
const events = all.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.sym - b.sym)
  .map((e) => [e.date, e.sym, e.dir === "long" ? 1 : -1, ...Object.keys(HORIZONS).map((k) => pctR(e[k])), e.stopDay]);
writeFileSync(new URL("./events.json", import.meta.url), JSON.stringify(events));
// GitHub Pages serves the repo root: write the same page there, its scripts and data resolving to ema-cross/
if (SRC) {
  const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  if (!page.includes("<head>")) throw new Error("index.html has no <head>");
  writeFileSync(new URL("../index.html", import.meta.url), page.replace("<head>", '<head>\n<base href="ema-cross/">'));
}
console.log(`summary.json: ${symbols.length} symbols, ${summary.long.total_signals} long + ${summary.short.total_signals} short signals, data as of ${uni.asOf}`);
