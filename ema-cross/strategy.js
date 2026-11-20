// 200/300 EMA staggered cross. Same rules as ema_200_300_test.py.
// Long: the HA candle broke below BOTH lines (any part of the HA body under both counts), and later the whole
// HA body (open and close) is above both (entry). Short: the mirror. A one-candle cross of both lines counts.
// A dip that never breaks the second line is not a signal.
// Flat filter: no signal when the EMAs are within flatGap of each other today and on all of the previous flatDays,
// AND the EMA 200 moved under flatSlope in 20 days. Lines that only meet briefly (V-recovery) do not block.
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
function runStrategy(d, baseBuf = 0.02, gapMult = 1.0, flatGap = 0.002, flatSlope = 0.02, flatDays = 40) {
  const { open: o, high: h, low: l, close: c } = d;
  const hc = haClose(d), ho = haOpen(d, hc);
  const e200 = ema(hc, 200), e300 = ema(hc, 300);
  // +1 whole HA body above both lines, -1 whole body below both, 0 otherwise
  const lo = (i) => Math.min(ho[i], hc[i]), hi = (i) => Math.max(ho[i], hc[i]);
  const side = (i) => (lo(i) > e200[i] && lo(i) > e300[i]) ? 1 : (hi(i) < e200[i] && hi(i) < e300[i]) ? -1 : 0;
  // part of the HA body past both lines = a break; it arms the entry the other way
  const brokeDn = (i) => lo(i) < e200[i] && lo(i) < e300[i], brokeUp = (i) => hi(i) > e200[i] && hi(i) > e300[i];
  const events = [];
  let armLong = brokeDn(WARMUP), armShort = brokeUp(WARMUP), tangled = false;
  for (let i = WARMUP + 1; i < c.length; i++) {
    const s = side(i);
    const fire = (s === 1 && armLong) || (s === -1 && armShort);
    if (fire && s === 1) armLong = false;
    if (fire && s === -1) armShort = false;
    armLong = armLong || brokeDn(i); armShort = armShort || brokeUp(i);
    tangled = Math.abs(e200[i] / e200[i - 20] - 1) < flatSlope;
    for (let k = i - flatDays; tangled && k <= i; k++) tangled = Math.abs(e200[k] - e300[k]) / Math.min(e200[k], e300[k]) < flatGap;
    if (fire && !tangled) {
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
  }
  // armLong/armShort/tangled: state after the last candle (a long or short is armed and waiting; flat filter on)
  return { e200, e300, hc, ho, events, armLong, armShort, tangled };
}

// Weekly ("W": Monday to Friday) or monthly ("M") candles built from daily ones, each dated by its last day.
// The last candle can still be forming (current week or month).
function resample(d, tf) {
  if (tf !== "W" && tf !== "M") return d;
  const key = tf === "M" ? (ds) => ds.slice(0, 7) : (ds) => Math.floor((Date.parse(ds + "T00:00:00Z") / 864e5 + 3) / 7);
  const x = { dates: [], open: [], high: [], low: [], close: [] };
  let prev = null;
  for (let i = 0; i < d.close.length; i++) {
    const k = key(d.dates[i]), n = x.close.length - 1;
    if (k !== prev) {
      x.dates.push(d.dates[i]); x.open.push(d.open[i]); x.high.push(d.high[i]); x.low.push(d.low[i]); x.close.push(d.close[i]);
      prev = k;
    } else {
      x.dates[n] = d.dates[i]; x.close[n] = d.close[i];
      x.high[n] = Math.max(x.high[n], d.high[i]); x.low[n] = Math.min(x.low[n], d.low[i]);
    }
  }
  return x;
}

if (typeof module !== "undefined") module.exports = { runStrategy, resample, HORIZONS, WARMUP, ema, haClose };
