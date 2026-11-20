// sim/sim.mjs -- synthetic GTA-VI-shaped cases, a scorer, and a model bake-off.
//
// The generative story is the page's own physics: players get tracked when
// Exophase registers them, they start playing some hours later, and a trophy is
// earned d_i/speed hours into a session. A read only moves when Exophase
// rescans, so every refresh drops the rate of anything the new batch has not
// earned yet. That reproduces the launch-night step (638 -> 3,868 tracked,
// every rare rate cut several-fold) without hand-fitting it.
//
// Run: node sim/sim.mjs [cases]

import { forecastCase } from '../main.ts';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449];
const clampPct = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (p) => { const q = clampPct(p) / 100; return Math.log(q / (1 - q)); };
const expit = (z) => 100 / (1 + Math.exp(-z));
const round2 = (x) => Math.round(x * 100) / 100;

// -- deterministic RNG --------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// -- the world ----------------------------------------------------------------
const N = 9000;          // simulated players
const LAUNCH = 0;        // hours
const K_TRACK = 110000;  // Exophase users who ever register the game
const TAU = 38;          // registration time scale, hours
const ALPHA = 0.62;      // registration curve shape (sub-linear: front-loaded)

function makeWorld(seed, opts = {}) {
  const r = rng(seed);
  const startSpread = opts.startSpread ?? 9.0;  // hours between register and play
  const speedSd = opts.speedSd ?? 0.85;
  const playMedian = opts.playMedian ?? 30;    // hours played in week one
  const prereg = opts.prereg ?? 640;           // tracked before launch

  // register time: Weibull-ish, plus the pre-launch cohort
  const reg = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    if (j < prereg) reg[j] = -24 + 24 * r();
    else reg[j] = TAU * Math.pow(-Math.log(1 - r() * 0.985), 1 / ALPHA);
  }
  // start playing: at launch at the earliest, plus a delay
  const start = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const delay = -Math.log(1 - r()) * startSpread;
    start[j] = Math.max(reg[j], LAUNCH) + delay * (0.3 + 1.4 * r());
  }
  const speed = new Float64Array(N);
  for (let j = 0; j < N; j++) speed[j] = Math.exp(gauss(r) * speedSd);
  const horizon = new Float64Array(N);
  for (let j = 0; j < N; j++) horizon[j] = Math.max(0.2, playMedian * Math.exp(gauss(r) * 0.9 - 0.4));

  // trophy thresholds: hours of play needed
  const D = new Float64Array(55);
  D[0] = 150;                      // platinum: finish everything
  D[1] = 0;                        // intro trophy: instant
  const storyIds = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  storyIds.forEach((_, k) => { D[2 + k] = 6 + 7.5 * k + 2 * r(); });
  for (let i = 2 + storyIds.length; i < 55; i++) D[i] = 1 + 90 * Math.pow(r(), 1.6);
  // tier shape: gold/silver are mid-late, bronze covers everything
  const tier = new Array(55).fill('bronze');
  tier[0] = 'platinum';
  tier[1] = 'gold'; tier[2] = 'gold';
  for (let i = 3; i < 9; i++) tier[i] = 'silver';
  const points = tier.map((t) => (t === 'platinum' ? 300 : t === 'gold' ? 90 : t === 'silver' ? 30 : 15));

  // earn times, N x 55 (Infinity = never)
  const earn = new Float64Array(N * 55);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < 55; i++) {
      const need = D[i] / speed[j];
      earn[j * 55 + i] = need <= horizon[j] ? start[j] + need : Infinity;
    }
  }

  // sorted registration times for the tracked count
  const regSorted = Array.from(reg).sort((a, b) => a - b);
  const trackedAt = (t) => {
    let lo = 0, hi = regSorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (regSorted[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  };
  const ratesAt = (t) => {
    const n = trackedAt(t);
    const cnt = new Float64Array(55);
    for (let j = 0; j < N; j++) {
      if (reg[j] > t) continue;
      const base = j * 55;
      for (let i = 0; i < 55; i++) if (earn[base + i] <= t) cnt[i]++;
    }
    const out = new Array(55);
    let total = 0;
    for (let i = 0; i < 55; i++) { out[i] = n ? round2((cnt[i] / n) * 100) : 0.01; total += cnt[i]; }
    return { n, rates: out, earned: total };
  };
  return { trackedAt, ratesAt, tier, points };
}

// refresh schedule: Exophase rescans on its own clock, hours apart
function refreshTimes(seed, untilH) {
  const r = rng(seed ^ 0x9e3779b9);
  const out = [];
  let t = -0.5;
  while (t < untilH) {
    out.push(t);
    t += 1.2 + 3.4 * r() * r() + 0.6; // mostly 1.5-4h
  }
  return out;
}

/** Build one case: reads every 30 min carrying the last refresh's snapshot. */
function makeCase(world, seed, { atH, targetH, id, startH = -0.2 }) {
  const snaps = refreshTimes(seed, targetH + 24);
  const snapInfo = snaps.map((t) => ({ t, ...world.ratesAt(t) }));
  const history = [];
  for (let h = startH; h < atH - 1e-9; h += 0.5) {
    let cur = snapInfo[0];
    for (const s of snapInfo) { if (s.t <= h) cur = s; else break; }
    history.push({
      slot: new Date(Date.UTC(2026, 10, 18, 23, 50) + h * 3600e3).toISOString().replace('.000', ''),
      at: new Date(Date.UTC(2026, 10, 18, 23, 50) + h * 3600e3).toISOString(),
      players_tracked: cur.n,
      trophies_earned: cur.earned,
      rates: cur.rates.slice(),
    });
  }
  let truth = snapInfo[0];
  for (const s of snapInfo) { if (s.t <= targetH) truth = s; else break; }
  const trophies = [];
  for (let i = 0; i < 55; i++) {
    trophies.push({
      id: i + 1, name: `T${i + 1}`, description: '', tier: world.tier[i], points: world.points[i], secret: i > 0,
    });
  }
  return {
    caseObj: {
      schema: 'makefun/gta6-trophies-case/v1',
      id,
      at: new Date(Date.UTC(2026, 10, 18, 23, 50) + atH * 3600e3).toISOString(),
      horizon_minutes: Math.round((targetH - atH) * 60),
      target: new Date(Date.UTC(2026, 10, 18, 23, 50) + targetH * 3600e3).toISOString(),
      levels: LEVELS,
      game: { name: 'Grand Theft Auto VI', platform: 'PS5', release_date: '2026-11-19', source: 'x' },
      trophies,
      history,
      notes: 'synthetic',
    },
    truth: truth.rates.map((x) => clampPct(x)),
    lastRates: history[history.length - 1].rates,
  };
}

// -- scoring ------------------------------------------------------------------
function score(caseObj, rows, truth) {
  const idx = new Map(caseObj.trophies.map((t, i) => [t.id, i]));
  let sum = 0, n = 0, typ = 0, cov = 0;
  for (const row of rows) {
    const y = logit(truth[idx.get(row.id)]);
    for (let k = 0; k < 5; k++) {
      const d = y - logit(row.q[k]);
      sum += 2 * Math.max(LEVELS[k] * d, (LEVELS[k] - 1) * d);
      n++;
    }
    const yp = truth[idx.get(row.id)];
    typ += Math.abs(yp - row.q[2]);
    if (row.q[0] <= yp && yp <= row.q[4]) cov++;
  }
  return { loss: sum / n, miss: typ / rows.length, coverage: cov / rows.length };
}

// -- baselines ----------------------------------------------------------------
function houseBaseline(c) {
  const last = c.history[c.history.length - 1];
  const spread = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return c.trophies.map((t, i) => ({
    id: t.id,
    q: Z.map((z) => Math.round(expit(logit(last.rates[i] ?? 0) + z * spread) * 1e4) / 1e4),
  }));
}

/** logit(rate) linear in ln(1+hours), least squares over the last 24 h. */
function timeTrend(c, cap = 1.0) {
  const rel = Date.parse('2026-11-19T00:00:00Z');
  const reads = c.history.map((r) => ({ x: Math.log1p(Math.max(0, (Date.parse(r.at) - rel) / 3600e3)), r: r.rates }));
  const tgt = Math.log1p(Math.max(0, (Date.parse(c.target) - rel) / 3600e3));
  return c.trophies.map((t, i) => {
    const pts = reads.filter((p) => p.r[i] != null);
    const use = pts.slice(-48);
    let b = 0, a = pts.length ? logit(pts[pts.length - 1].r[i]) : 0;
    if (use.length >= 3) {
      const mx = use.reduce((s, p) => s + p.x, 0) / use.length;
      const my = use.reduce((s, p) => s + logit(p.r[i]), 0) / use.length;
      let sxx = 0, sxy = 0;
      for (const p of use) { const dx = p.x - mx; sxx += dx * dx; sxy += dx * (logit(p.r[i]) - my); }
      if (sxx > 1e-9) { b = Math.max(-cap, Math.min(cap, sxy / sxx)); a = my + b * (tgt - mx); }
    }
    const s = 0.75;
    return { id: t.id, q: Z.map((z) => Math.round(expit(a + z * s) * 1e4) / 1e4) };
  });
}

export { makeWorld, makeCase, score, houseBaseline, timeTrend, logit };

// -- bake-off -----------------------------------------------------------------
const nCases = Number(process.argv[2] ?? 24);
const rows = [];
for (let k = 0; k < nCases; k++) {
  const world = makeWorld(1000 + k * 7);
  const atH = 48 + (k % 6) * 4;          // 48-68 h history
  const targetH = atH + 6510 / 60;        // the final's 4.52 day horizon
  const { caseObj, truth } = makeCase(world, 500 + k, { atH, targetH, id: `f${k}` });
  const models = {
    house: houseBaseline(caseObj),
    trend: timeTrend(caseObj),
    mine: forecastCase(caseObj),
  };
  for (const [name, r] of Object.entries(models)) {
    const s = score(caseObj, r, truth);
    rows.push({ name, ...s });
  }
}
const by = {};
for (const r of rows) {
  by[r.name] ??= { loss: 0, miss: 0, cov: 0, n: 0 };
  by[r.name].loss += r.loss; by[r.name].miss += r.miss; by[r.name].cov += r.coverage; by[r.name].n++;
}
console.log(`\n=== final-shaped cases (${nCases}, horizon ${(6510 / 60).toFixed(2)} d) ===`);
console.log('model    loss     miss    cov90');
for (const [name, v] of Object.entries(by)) {
  console.log(`${name.padEnd(8)} ${(v.loss / v.n).toFixed(4)}  ${(v.miss / v.n).toFixed(3)}  ${(v.cov / v.n).toFixed(3)}`);
}

// practice-shaped: 90 minute horizon across a refresh the history cannot see
const prows = [];
for (let k = 0; k < 12; k++) {
  const world = makeWorld(3000 + k * 13, { prereg: 640 });
  const { caseObj, truth } = makeCase(world, 700 + k, { atH: 3 + 0.5 * (k % 2), targetH: 4.5 + 0.5 * (k % 2), id: `p${k}` });
  for (const [name, r] of Object.entries({ house: houseBaseline(caseObj), trend: timeTrend(caseObj), mine: forecastCase(caseObj) })) {
    prows.push({ name, ...score(caseObj, r, truth) });
  }
}
const pby = {};
for (const r of prows) {
  pby[r.name] ??= { loss: 0, miss: 0, cov: 0, n: 0 };
  pby[r.name].loss += r.loss; pby[r.name].miss += r.miss; pby[r.name].cov += r.coverage; pby[r.name].n++;
}
console.log('\n=== launch-night practice-shaped cases (90 min, across a refresh) ===');
console.log('model    loss     miss    cov90');
for (const [name, v] of Object.entries(pby)) {
  console.log(`${name.padEnd(8)} ${(v.loss / v.n).toFixed(4)}  ${(v.miss / v.n).toFixed(3)}  ${(v.cov / v.n).toFixed(3)}`);
}
