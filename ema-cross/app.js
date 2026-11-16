const DATA = "https://raw.githubusercontent.com/kaloyantosev/sector-terminal/main/public/data/daily/";
const H = Object.keys(HORIZONS);
const $ = (id) => document.getElementById(id);
const pct = (v, d = 2) => v == null || isNaN(v) ? "–" : `<span class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v > 0 ? "+" : ""}${v.toFixed(d)}%</span>`;
let S, chart, current, tab = "chart", dir = "long", EV = [], byWeek = new Map(), calYear, calWeek;

function horizonTable(rows) { // rows: [label, statsByHorizon]
  const head = `<tr><th></th>${H.map((h) => `<th colspan="1">${h}</th>`).join("")}</tr>`;
  const line = (label, f, h) => `<tr><td>${label}</td>${H.map((k) => `<td>${f(h[k])}</td>`).join("")}</tr>`;
  return rows.map(([label, h]) => head.replace("<th></th>", `<th>${label}</th>`) +
    line("Avg return", (s) => pct(s.avg), h) + line("Median", (s) => pct(s.median), h) +
    line("% positive", (s) => s.win == null ? "–" : s.win.toFixed(1) + "%", h) +
    line("% stopped by then", (s) => s.stopped == null ? "–" : s.stopped.toFixed(1) + "%", h) +
    line("Trades", (s) => s.n, h)).join("");
}

function summaryTable(groups, label) {
  return `<tr><th>${label}</th><th>Signals</th>${H.map((h) => `<th>avg ${h}</th>`).join("")}<th>% pos 12w</th></tr>` +
    Object.entries(groups).map(([k, g]) => `<tr><td>${k}</td><td>${g.signals}</td>${H.map((h) => `<td>${pct(g.h[h].avg)}</td>`).join("")}<td>${g.h["12w"].win ?? "–"}%</td></tr>`).join("");
}

function renderList(filter = "") {
  const f = filter.toLowerCase(), byCat = {};
  for (const s of S.symbols) if (!f || (s.tv + s.name).toLowerCase().includes(f)) (byCat[s.category] ??= []).push(s);
  $("list").innerHTML = Object.entries(byCat).map(([c, list]) => `<div class="cat">${c}</div>` + list.map((s) =>
    `<div class="sym${current === s ? " on" : ""}" data-f="${s.file}" title="${s.name}"><span>${s.tv || s.file}<br><span class="muted" style="font-size:11px">${s.name}</span></span>` +
    `<span class="n">${dir === "long" ? s.nL : s.nS} sig<br>12w ${pct(dir === "long" ? s.aL : s.aS, 1)}</span></div>`).join("")).join("");
}

function ensureChart() {
  if (chart) return chart;
  const css = getComputedStyle(document.documentElement), v = (n) => css.getPropertyValue(n).trim();
  chart = LightweightCharts.createChart($("chart"), { autoSize: true, layout: { background: { color: v("--bg") }, textColor: v("--muted") },
    grid: { vertLines: { color: v("--line") }, horzLines: { color: v("--line") } }, rightPriceScale: { mode: 1 }, timeScale: { borderColor: v("--line") } });
  chart.price = chart.addCandlestickSeries({ upColor: v("--pos"), downColor: v("--neg"), wickUpColor: v("--pos"), wickDownColor: v("--neg"), borderVisible: false });
  chart.e200 = chart.addLineSeries({ color: v("--e200"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  chart.e300 = chart.addLineSeries({ color: v("--e300"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  chart.colors = { pos: v("--pos"), neg: v("--neg"), muted: v("--muted") };
  return chart;
}

function showTV(s) {
  $("tv").innerHTML = "";
  if (tab !== "tv" || !s.tv || typeof TradingView === "undefined") return;
  new TradingView.widget({ container_id: "tv", autosize: true, symbol: s.tv, interval: "D", style: "8", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    studies: [{ id: "MAExp@tv-basicstudies", inputs: { length: 200 } }, { id: "MAExp@tv-basicstudies", inputs: { length: 300 } }] });
}

async function select(s) {
  current = s; renderList($("q").value);
  $("symTitle").textContent = `${s.tv || s.file} · ${s.name}`;
  $("tvlink").href = s.tv ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(s.tv)}` : "#";
  $("symTbl").innerHTML = "";
  $("trades").innerHTML = "<tr><td>Loading prices…</td></tr>";
  showTV(s);
  let d;
  try { d = await (await fetch(DATA + s.file)).json(); } catch (e) { $("trades").innerHTML = `<tr><td>Could not load ${s.file}: ${e.message}</td></tr>`; return; }
  if (current !== s) return;
  const r = runStrategy(d), c = ensureChart();
  const symStats = (ev) => { const h = {};
  for (const [k, n] of Object.entries(HORIZONS)) {
    const v = ev.filter((e) => e[k] != null), x = v.map((e) => e[k] * 100).sort((a, b) => a - b);
    h[k] = { n: v.length, avg: x.length ? x.reduce((a, b) => a + b, 0) / x.length : null, median: x.length ? (x[(x.length - 1) >> 1] + x[x.length >> 1]) / 2 : null,
      win: x.length ? x.filter((y) => y > 0).length / x.length * 100 : null, stopped: v.length ? v.filter((e) => e.stopDay !== null && e.stopDay <= n).length / v.length * 100 : null };
  }
  return [`${ev[0]?.dir === "short" ? "Shorts" : "Longs"}: ${ev.length} signals, ${(ev.filter((e) => e.stopDay !== null).length / (ev.length || 1) * 100).toFixed(1)}% ever stopped`, h]; };
  const L = r.events.filter((e) => e.dir === "long"), Sh = r.events.filter((e) => e.dir === "short");
  $("symTbl").innerHTML = horizonTable([symStats(L), symStats(Sh)]).replace("Longs: undefined", "Longs").replace("Shorts: undefined", "Shorts");
  const pts = (arr) => d.dates.map((t, i) => ({ time: t, value: arr[i] }));
  c.price.setData(d.dates.map((t, i) => ({ time: t, open: r.ho[i], close: r.hc[i], // Heikin Ashi candles: what the decisions use
    high: Math.max(d.high[i], r.ho[i], r.hc[i]), low: Math.min(d.low[i], r.ho[i], r.hc[i]) })));
  c.e200.setData(pts(r.e200).slice(200));
  c.e300.setData(pts(r.e300).slice(300));
  const marks = [];
  for (const e of r.events) {
    const lg = e.dir === "long";
    marks.push({ time: e.date, position: lg ? "belowBar" : "aboveBar", color: lg ? c.colors.pos : c.colors.neg, shape: lg ? "arrowUp" : "arrowDown" });
    if (e.stopDay !== null && e.i + e.stopDay < d.dates.length) marks.push({ time: d.dates[e.i + e.stopDay], position: lg ? "belowBar" : "aboveBar", color: c.colors.muted, shape: "circle" });
  }
  const seen = new Set();
  c.price.setMarkers(marks.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0).filter((m) => { const k = m.time + m.shape + m.position; return !seen.has(k) && seen.add(k); }));
  c.timeScale().fitContent();
  $("trades").innerHTML = `<tr><th>Entry date</th><th>Side</th><th>Entry</th><th>Stop</th><th>Risk</th><th>EMA gap</th><th>Stopped after</th>${H.map((h) => `<th>${h}</th>`).join("")}</tr>` +
    r.events.slice().reverse().map((e) => `<tr><td>${e.date}</td><td class="${e.dir === "long" ? "pos" : "neg"}">${e.dir}</td><td>${e.entry.toFixed(2)}</td><td>${e.stop.toFixed(2)}</td><td>${(e.risk * 100).toFixed(1)}%</td><td>${(e.gap * 100).toFixed(2)}%</td>` +
      `<td>${e.stopDay === null ? "open" : e.stopDay + " d"}</td>${H.map((h) => `<td>${e[h] == null ? "–" : pct(e[h] * 100, 1)}</td>`).join("")}</tr>`).join("");
}

// ---- signal calendar: one button per ISO week, click shows every signal that week
const DAY = 864e5;
function isoWeek(ds) { // "YYYY-MM-DD" -> [ISO year, ISO week]
  const d = new Date(ds + "T00:00:00Z"), thu = new Date(d.getTime() + (3 - (d.getUTCDay() + 6) % 7) * DAY);
  const y = thu.getUTCFullYear();
  return [y, Math.floor((thu - Date.UTC(y, 0, 1)) / DAY / 7) + 1];
}
function weekMonday(y, w) {
  const jan4 = Date.UTC(y, 0, 4);
  return new Date(jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (w - 1) * 7 * DAY);
}
const md = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function renderCal() {
  const years = [...new Set(EV.map((e) => isoWeek(e[0])[0]))].sort((a, b) => b - a);
  $("calYear").innerHTML = years.map((y) => `<option${y === calYear ? " selected" : ""}>${y}</option>`).join("");
  const nW = isoWeek(`${calYear}-12-28`)[1];
  let html = "", nL = 0, nS = 0;
  for (let w = 1; w <= nW; w++) {
    const list = byWeek.get(`${calYear}-${w}`) || [], L = list.filter((e) => e[2] === 1).length, Sh = list.length - L;
    nL += L; nS += Sh;
    html += `<button class="wk${w === calWeek ? " on" : ""}${list.length ? "" : " empty"}" data-w="${w}" aria-label="Week ${w}: ${L} long, ${Sh} short">` +
      `<b>W${w}</b><span>${md(weekMonday(calYear, w))}</span><span><i class="pos">${L ? "▲" + L : ""}</i> <i class="neg">${Sh ? "▼" + Sh : ""}</i>${list.length ? "" : "–"}</span></button>`;
  }
  $("calGrid").innerHTML = html;
  $("calInfo").textContent = `${calYear}: ${nL} long, ${nS} short signals`;
  renderWeek();
}

function renderWeek() {
  const list = byWeek.get(`${calYear}-${calWeek}`) || [], mon = weekMonday(calYear, calWeek);
  $("weekTitle").textContent = `Week ${calWeek}, ${calYear} (${md(mon)} – ${md(new Date(mon.getTime() + 4 * DAY))}): ${list.length} signal${list.length === 1 ? "" : "s"}`;
  $("weekTbl").innerHTML = list.length ? `<tr><th>Date</th><th>Symbol</th><th>Name</th><th>Category</th><th>Side</th>${H.map((h) => `<th>${h}</th>`).join("")}<th>Stopped after</th></tr>` +
    list.map((e) => { const s = S.symbols[e[1]];
      return `<tr data-f="${s.file}" title="Open chart"><td>${e[0]}</td><td>${s.tv || s.file}</td><td>${s.name}</td><td>${s.category}</td>` +
        `<td class="${e[2] === 1 ? "pos" : "neg"}">${e[2] === 1 ? "long" : "short"}</td>${H.map((h, k) => `<td>${e[3 + k] == null ? "–" : pct(e[3 + k], 1)}</td>`).join("")}` +
        `<td>${e[3 + H.length] == null ? "not stopped" : e[3 + H.length] + " d"}</td></tr>`; }).join("")
    : `<tr><td class="muted">No signals this week.</td></tr>`;
}

function renderSummary() {
  const B = S[dir], name = dir === "long" ? "Longs" : "Shorts";
  $("kpis").innerHTML = [[`${name}: signals`, B.total_signals.toLocaleString()], ["Ever stopped", B.stopped_ever + "%"], ["Median days to stop", B.median_days_to_stop],
    ["Avg 4w / 20w", `${B.all["4w"].avg}% / ${B.all["20w"].avg}%`]].map(([k, v]) => `<div class="box"><span class="muted">${k}</span><b>${v}</b></div>`).join("");
  $("allTbl").innerHTML = horizonTable([[`${name}, all symbols`, B.all], [`${name}, pure price indexes only`, B.index_only]]);
  $("catTbl").innerHTML = summaryTable(B.categories, `Category (${name.toLowerCase()})`);
  $("gapTbl").innerHTML = summaryTable(Object.fromEntries(Object.entries(B.gap).map(([k, g]) => [`${k} (${g.range[0]}–${g.range[1]}%)`, g])), `Gap tercile (${name.toLowerCase()})`);
  renderList($("q").value);
}

(async () => {
  [S, EV] = await Promise.all([fetch("summary.json").then((r) => r.json()), fetch("events.json").then((r) => r.json())]);
  for (const e of EV) { const k = isoWeek(e[0]).join("-"); if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(e); }
  [calYear, calWeek] = isoWeek(EV.at(-1)[0]);
  renderCal();
  $("calYear").addEventListener("change", (e) => { calYear = +e.target.value; calWeek = 1; renderCal(); });
  const stepYear = (d) => { const ys = [...$("calYear").options].map((o) => +o.value); const i = ys.indexOf(calYear) - d;
    if (i >= 0 && i < ys.length) { calYear = ys[i]; calWeek = 1; renderCal(); } };
  $("calPrev").addEventListener("click", () => stepYear(-1));
  $("calNext").addEventListener("click", () => stepYear(1));
  $("calGrid").addEventListener("click", (e) => { const b = e.target.closest(".wk"); if (!b) return; calWeek = +b.dataset.w;
    document.querySelectorAll(".wk").forEach((x) => x.classList.toggle("on", x === b)); renderWeek(); });
  $("weekTbl").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-f]"); if (!tr) return;
    select(S.symbols.find((s) => s.file === tr.dataset.f)); $("symTitle").scrollIntoView({ behavior: "smooth" }); });
  $("sub").textContent = `${S.symbols.length} symbols · ${S.long.total_signals.toLocaleString()} long + ${S.short.total_signals.toLocaleString()} short signals · ${S.first} to ${S.last} · data as of ${S.asOf}`;
  renderSummary();
  document.querySelectorAll("#dirTabs button").forEach((b) => b.addEventListener("click", () => {
    dir = b.dataset.d;
    document.querySelectorAll("#dirTabs button").forEach((x) => x.classList.toggle("on", x === b));
    renderSummary();
  }));
  $("q").addEventListener("input", (e) => renderList(e.target.value));
  $("list").addEventListener("click", (e) => { const el = e.target.closest(".sym"); if (el) select(S.symbols.find((s) => s.file === el.dataset.f)); });
  document.querySelectorAll(".tabs button[data-t]").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.t;
    document.querySelectorAll(".tabs button[data-t]").forEach((x) => x.classList.toggle("on", x === b));
    $("chart").hidden = tab !== "chart"; $("tv").hidden = tab !== "tv";
    if (tab === "tv") {
      if (typeof TradingView === "undefined") { const sc = document.createElement("script"); sc.src = "https://s3.tradingview.com/tv.js"; sc.onload = () => showTV(current); document.head.appendChild(sc); }
      else showTV(current);
    }
  }));
  select(S.symbols.find((s) => s.file === "_GSPC.json") || S.symbols[0]);
})();
