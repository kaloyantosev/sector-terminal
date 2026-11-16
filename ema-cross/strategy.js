// 200/300 EMA staggered cross. Same rules as ema_200_300_test.py.
// Long: the whole Heikin Ashi body (open and close) was below BOTH lines and is now above both (entry).
// Short: mirror, from above both to below both. A one-candle cross of both lines counts.
// A dip under one line and a reclaim of it (never below both) is not a signal.
const HORIZONS = { "1w": 5, "4w": 20, "8w": 40, "12w": 60, "16w": 80, "20w": 100 };
const WARMUP = 300;

function ema(x, n) {
  const a = 2 / (n + 1), out = new Array(x.length);
  out[0] = x[0];
  for (let i = 1; i < x.length; i++) out[i] = a * x[i] + (1 - a) * out[i - 1];
  return out;
}

// Heikin Ashi close = (o+h+l+c)/4; HA open = average of the previous HA open and close.
function haClose(d) {
  return d.close.map((c, i) => (d.open[i] + d.high[i] + d.low[i] + c) / 4);
}
function haOpen(d, hc) {
  const ho = new Array(hc.length);
  ho[0] = (d.open[0] + d.close[0]) / 2;
  for (let i = 1; i < hc.length; i++) ho[i] = (ho[i - 1] + hc[i - 1]) / 2;
  return ho;
}

// Decisions (EMAs and crosses) use Heikin Ashi closes. Entry fill, stop trigger and returns use real prices.
function runStrategy(d, baseBuf = 0.02, gapMult = 1.0) {
  const { open: o, high: h, low: l, close: c } = d;
  const hc = haClose(d), ho = haOpen(d, hc);
  const e200 = ema(hc, 200), e300 = ema(hc, 300);
  // +1 whole HA body above both lines, -1 whole body below both, 0 otherwise
  const side = (i) => {
    const lo = Math.min(ho[i], hc[i]), hi = Math.max(ho[i], hc[i]);
    return (lo > e200[i] && lo > e300[i]) ? 1 : (hi < e200[i] && hi < e300[i]) ? -1 : 0;
  };
  const events = [];
  let last = side(WARMUP) || 0; // last bar's "both" state (above both / below both)
  for (let i = WARMUP + 1; i < c.length; i++) {
    const s = side(i);
    if (s !== 0 && last === -s) {
      const long = s === 1, entry = c[i];
      const lower = Math.min(e200[i], e300[i]), upper = Math.max(e200[i], e300[i]);
      const gap = (upper - lower) / lower, buf = baseBuf + gapMult * gap;
      const stop = long ? lower * (1 - buf) : upper * (1 + buf);
      const ret = (exit) => long ? exit / entry - 1 : 1 - exit / entry;
      let stopDay = null, stopRet = null;
      for (let j = i + 1; j < c.length; j++) {
        if (long ? l[j] <= stop : h[j] >= stop) {
          stopDay = j - i; stopRet = ret(long ? Math.min(o[j], stop) : Math.max(o[j], stop)); break;
        }
      }
      const ev = { i, dir: long ? "long" : "short", date: d.dates[i], entry, stop, gap, risk: Math.abs(stop / entry - 1), stopDay, stopRet };
      for (const [k, n] of Object.entries(HORIZONS)) {
        ev[k] = stopDay !== null && stopDay <= n ? stopRet : i + n < c.length ? ret(c[i + n]) : null;
      }
      events.push(ev);
    }
    if (s !== 0) last = s;
  }
  return { e200, e300, hc, ho, events };
}

if (typeof module !== "undefined") module.exports = { runStrategy, HORIZONS, ema, haClose };
