// GTA VI trophy-rarity forecaster (makefun/gta6-trophies-case/v1).
//
// The page's number for a trophy is earners / players-tracked, and two things
// move it in opposite directions:
//   (1) Exophase rescans a game on its own clock. A rescan adds a batch of
//       tracked players at once, so every trophy those players have not earned
//       yet steps DOWN the moment the denominator jumps. On launch night the
//       page sat unchanged at 638 players for four hours, then jumped to 3,868
//       with every rate cut several-fold.
//   (2) Between rescans the earners keep accumulating, so a trophy's rate
//       creeps up.
// A model of the rate against wall-clock time fits that sawtooth and then
// misses the next rescan, which is exactly what it has never seen.
//
// So the rate is regressed where its physics lives, on the denominator:
//     logit rate_i = a_i + b_i ln T + c ln(1 + hours since release)
// b_i is the dilution slope: -1 means the earner count did not move at all and
// the rate simply divides by T (a rare trophy, a fresh batch has none of it),
// 0 means the earners keep pace and the rate is flat, and a positive b means the
// players already tracked are still earning it faster than new ones dilute it.
// The logit link does the bounding for free: a trophy at 70% cannot be
// extrapolated to 130%, it saturates, which is why this parameterisation is
// used instead of the log-earner-count one - a count model with a fitted
// exponent above 1 runs away to 98% on a trophy that was going to 79%.
//
// c is one drift shared by all 55 trophies: inside a single rescan T does not
// move, so c is identified cleanly and b is what moves across rescans. One row
// per rescan (not one per read) keeps a hundred duplicate reads from faking a
// hundred observations. b is ridge-shrunk toward a prior from the trophy's own
// level (a 1% trophy dilutes, a 99% one does not) with the tier as a nudge.
//
// T at the target comes from its own fit on the recent rescans only, because
// tracked players grow fast at launch and saturate later: a slope fitted across
// the whole history extrapolates the launch burst into a week that will not
// repeat it.
//
// Five quantiles are logit(rate) + z_tau * s, with s from the fit residual, the
// extrapolation variance of b, T's own uncertainty scaled by b, and the
// sampling noise of the count, then widened: a quantile that misses costs ~19x
// one that is merely wide.
//
// The forecast anchors on the LAST read rather than on the fitted line: a fit
// through a climbing series sits under its own last point, and that bias used
// to cost more in simulation than every other term combined.
//
// Node 22 / standard library only. Reads every *.in in MAKEFUN_INPUT_DIR
// (default /input), writes <id>.out to MAKEFUN_OUTPUT_DIR (default /output).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449];

// ── tuning ───────────────────────────────────────────────────────────────────
const SLOPE_SD = 0.30;      // ridge width on b (dilution slope)
const SLOPE_DAMP = 0.80;    // fitted slope is extrapolated shortened
const C_PRIOR = 0.06;       // logit drift per ln hour, when little is observed
const C_PRIOR_W = 40;       // pseudo-information behind that prior
const TRACK_P_PRIOR = 1.00; // T ~ (1+h)^p when only one rescan is in hand
const TRACK_P_MAX = 1.60;
const TRACK_P_DAMP = 0.95;
const STALE_LAG_LN = 1.20;  // a page that never moved is behind, not current
const STALE_VAR = 0.80;
const SPREAD_SCALE = 1.05;
const SPREAD_FLOOR = 0.30;
const SPREAD_MAX = 2.60;
const MAX_WEIGHT = 120;     // cap on one rescan's leverage in the fit
const SHIFT_MAX = 2.20;     // no median moves further than this on the logit
const CV_VAR = 0.02;        // prior variance on the shared drift

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const clampPct = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => { const p = clampPct(pct) / 100; return Math.log(p / (1 - p)); };
const expit = (z: number): number => 100 / (1 + Math.exp(-z));
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

interface CaseFile {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels?: number[];
  game?: { release_date?: string };
  trophies: Array<{ id: number; tier?: string }>;
  history: Array<{ at: string; players_tracked: number; rates: Array<number | null>; slot?: string }>;
}

interface Read { h: number; v: number; T: number; u: number; ms: number; ep: number; rates: Array<number | null> }
interface Row { u: number; v: number; y: number; w: number }

function releaseMs(c: CaseFile): number {
  const d = c.game?.release_date;
  if (typeof d === 'string') {
    const t = Date.parse(`${d}T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  const t = c.history[0]?.at ? Date.parse(c.history[0].at) : NaN;
  return Number.isFinite(t) ? t - 3600_000 : Date.parse(c.at) - 3600_000;
}

/** Dilution prior: how much a rescan should move this trophy's rate. */
function slopePrior(ratePct: number): number {
  // A rare trophy's earners barely move when a fresh batch arrives, so its rate
  // divides by the denominator (slope -1). One nearly everyone has does not
  // move at all (slope 0).
  const r = clamp(ratePct, 0, 100) / 100;
  return clamp(-0.88 + 0.88 * r ** 0.85, -1.0, 0.05);
}

function tierTilt(tier: string | undefined): number {
  if (tier === 'platinum') return -0.06;
  if (tier === 'gold') return 0.0;
  if (tier === 'silver') return 0.03;
  return 0.05;
}

/** How many tracked players a trophy's rate implies. */
function earners(ratePct: number, T: number): number {
  return Math.max((clampPct(ratePct) / 100) * T, 0.4);
}

/** Fit T(h) = T_last * ((1+h)/(1+h_last))^p on recent rescans; Var(ln T). */
function fitTracked(epochs: Array<{ h: number; u: number }>, targetV: number): { u: number; varU: number; p: number } {
  const m = epochs.length;
  if (m === 0) return { u: Math.log(1000), varU: 1.2, p: 0 };
  const last = epochs[m - 1];
  const xLast = Math.log1p(Math.max(last.h, 0));
  const dxT = Math.max(0, targetV - xLast);
  if (m === 1) {
    // The page never moved, so its count predates the growth rather than
    // measuring it: put the page behind by a lag and pay for it in variance.
    return { u: last.u + TRACK_P_PRIOR * dxT + STALE_LAG_LN, varU: STALE_VAR, p: TRACK_P_PRIOR };
  }
  // Recent rescans only: the growth rate now is not the launch-week rate.
  const from = Math.max(0, m - Math.max(3, Math.ceil(m / 2)));
  let sxx = 0;
  let sxu = 0;
  for (let j = from; j < m; j++) {
    const w = 1 + 2 * ((j - from) / Math.max(1, m - 1 - from)) ** 2;
    const dx = Math.log1p(Math.max(epochs[j].h, 0)) - xLast;
    sxx += w * dx * dx;
    sxu += w * dx * (epochs[j].u - last.u);
  }
  const pRaw = sxx > 1e-9 ? sxu / sxx : TRACK_P_PRIOR;
  const p = clamp(pRaw, 0.0, TRACK_P_MAX) * TRACK_P_DAMP;
  const varP = sxx > 1e-9 ? 0.10 / sxx : 0.6;
  return { u: last.u + p * dxT, varU: varP * dxT * dxT + 0.10, p };
}

/** Weighted ridge of y on u, shrunk toward a slope prior. */
function slopeFit(rows: Row[], b0: number): { a: number; b: number; residVar: number; varB: number; mu: number } {
  const n = rows.length;
  if (n === 0) return { a: 0, b: b0, residVar: 1.0, varB: SLOPE_SD ** 2, mu: 0 };
  let sw = 0, su = 0, sy = 0;
  for (const r of rows) { sw += r.w; su += r.w * r.u; sy += r.w * r.y; }
  const mu = su / sw;
  const my = sy / sw;
  let Suu = 0, Suy = 0;
  for (const r of rows) {
    const du = r.u - mu;
    Suu += r.w * du * du;
    Suy += r.w * du * (r.y - my);
  }
  const lb = 1 / (SLOPE_SD ** 2);
  const den = Suu + lb;
  const b = (Suy + lb * b0) / den;
  const a = my - b * mu;
  let ss = 0;
  for (const r of rows) { const e = r.y - (a + b * r.u); ss += r.w * e * e; }
  const residVar = Math.max(1e-3, (ss / Math.max(sw, 1e-9)) * (n / Math.max(1, n - 2)));
  return { a, b, residVar, varB: residVar / den, mu };
}

export function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  const rel = releaseMs(c);
  const reads: Read[] = [];
  let prevT = -1;
  let ep = -1;
  for (const h of c.history) {
    if (!h || typeof h.at !== 'string') continue;
    const ms = Date.parse(h.at);
    if (!Number.isFinite(ms)) continue;
    const T = typeof h.players_tracked === 'number' && h.players_tracked > 0 ? h.players_tracked : 1;
    const prev = reads[reads.length - 1];
    // A rescan is exactly what moves players_tracked; reads in between repeat it.
    if (!prev || T !== prevT || ms - prev.ms > 24 * 3600_000) { ep += 1; prevT = T; }
    const hours = Math.max(0, (ms - rel) / 3600_000);
    reads.push({ h: hours, v: Math.log1p(hours), T, u: Math.log(T), ms, ep, rates: Array.isArray(h.rates) ? h.rates : [] });
  }
  if (reads.length === 0) throw new Error(`${c.id}: no usable history`);
  const lastRead = reads[reads.length - 1];

  // One anchor per rescan: the LAST read it stayed current. Anchoring on a
  // rescan's first read would put the page hours behind where it actually is.
  const epochs: Array<{ h: number; u: number }> = [];
  for (const r of reads) epochs[r.ep] = { h: r.h, u: r.u };

  const targetMs = Date.parse(c.target);
  const targetH = Math.max(0, ((Number.isFinite(targetMs) ? targetMs : lastRead.ms) - rel) / 3600_000);
  const targetV = Math.log1p(targetH);
  const tracked = fitTracked(epochs, targetV);
  const uTarget = Math.max(tracked.u, lastRead.u);
  const TTarget = Math.exp(uTarget);

  const p = (rate: number): number => clampPct(rate) / 100;
  const toRow = (rate: number, r: Read): Row => ({
    u: r.u,
    v: r.v,
    y: logit(rate),
    // Var(logit rate-hat) ~ 1/(T p (1-p)); weight by its inverse, capped so one
    // enormous count cannot outvote the other 54 trophies.
    w: Math.min(Math.max(r.T * p(rate) * (1 - p(rate)), 0.05), MAX_WEIGHT),
  });

  const nT = c.trophies.length;
  const fitRows: Row[][] = [];
  const lastRate = new Float64Array(nT).fill(-1);
  const lastEp = new Int32Array(nT).fill(-1);
  for (let i = 0; i < nT; i++) fitRows.push([]);
  for (const r of reads) {
    for (let i = 0; i < nT; i++) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      const row = toRow(rate, r);
      const rows = fitRows[i];
      if (lastEp[i] === r.ep) rows[rows.length - 1] = row; // same rescan: replace
      else rows.push(row);
      lastEp[i] = r.ep;
      lastRate[i] = rate;
    }
  }

  // Shared drift c, from variation inside rescans only (T is constant there).
  let svv = 0, svy = 0;
  for (let i = 0; i < nT; i++) {
    let cell: Row[] = [];
    let cellEp = -1;
    const flush = (): void => {
      if (cell.length < 2) return;
      let sw = 0, mv = 0, my = 0;
      for (const r of cell) { sw += r.w; mv += r.w * r.v; my += r.w * r.y; }
      mv /= sw; my /= sw;
      for (const r of cell) { svv += r.w * (r.v - mv) ** 2; svy += r.w * (r.v - mv) * (r.y - my); }
    };
    for (const r of reads) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      if (r.ep !== cellEp) { flush(); cell = []; cellEp = r.ep; }
      cell.push(toRow(rate, r));
    }
    flush();
  }
  const cDrift = clamp((svy + C_PRIOR_W * C_PRIOR) / (svv + C_PRIOR_W), -0.4, 1.0);

  const out: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < nT; i++) {
    const rows = fitRows[i];
    const known = lastRate[i] >= 0;
    const baseRate = known ? lastRate[i] : 50;
    // A trophy every tracked player holds cannot be diluted by more tracking.
    if (known && baseRate >= 99) {
      out.push({ id: c.trophies[i].id, q: [99.96, 99.98, 99.99, 99.99, 99.99] });
      continue;
    }
    const b0 = clamp(slopePrior(baseRate) + tierTilt(c.trophies[i].tier), -1.0, 0.35);
    for (const r of rows) r.y -= cDrift * r.v; // strip the drift, then fit b
    const fit = slopeFit(rows, b0);
    const b = b0 + SLOPE_DAMP * (clamp(fit.b, -1.4, 1.6) - b0);
    // Anchor on the LAST reading, not on the fitted line's mean: the last read
    // is a measurement, while the line's level is an average over a window the
    // rate was still climbing out of. Carry only the fitted increments forward.
    const du = uTarget - lastRead.u;
    const dv = targetV - lastRead.v;
    const mRaw = logit(baseRate) + b * du + cDrift * dv;
    const m = logit(baseRate) + clamp(mRaw - logit(baseRate), -SHIFT_MAX, SHIFT_MAX);
    const rateAt = clampPct(expit(m));

    // Sampling noise of the counts behind both ends: Var(logit p-hat) ~ 1/E.
    const sampling = 1 / Math.max(earners(baseRate, lastRead.T), 1) + 1 / Math.max(earners(rateAt, TTarget), 1);
    const tail = b * b * tracked.varU;
    const varRaw = sampling + du * du * fit.varB + dv * dv * CV_VAR + tail + 0.02;
    const s = clamp(Math.sqrt(Math.max(varRaw, 0)) * SPREAD_SCALE, SPREAD_FLOOR, SPREAD_MAX);
    out.push({ id: c.trophies[i].id, q: Z.map((z) => round4(expit(m + z * s))) });
  }

  for (const row of out) {
    for (let j = 0; j < row.q.length; j++) row.q[j] = clamp(row.q[j], 0, 100);
    for (let j = 1; j < row.q.length; j++) if (row.q[j] < row.q[j - 1]) row.q[j] = row.q[j - 1];
  }
  return out;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir).filter((f) => f.endsWith('.in')).sort();
  for (const file of files) {
    const c = JSON.parse(readFileSync(join(inputDir, file), 'utf8')) as CaseFile;
    if (!Array.isArray(c.trophies) || !Array.isArray(c.history) || c.history.length === 0) {
      throw new Error(`${file}: missing trophies or history`);
    }
    if (Array.isArray(c.levels) && (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j]))) {
      throw new Error(`${file}: unexpected levels ${JSON.stringify(c.levels)}`);
    }
    const id = file.slice(0, -3);
    writeFileSync(join(outputDir, `${id}.out`), `${JSON.stringify({ trophies: forecastCase(c) })}\n`);
  }
}

const direct = (() => {
  try {
    const a = process.argv[1];
    return !!a && pathToFileURL(a).href === import.meta.url;
  } catch { return false; }
})();
if (direct) main();
