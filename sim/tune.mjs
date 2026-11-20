// sim/tune.mjs -- constant search for main.ts over a frozen synthetic corpus.
//
// The world generator is expensive (9000 players x 55 trophies x ~30 rescans),
// so the corpus is generated once per run and kept in a temporary directory,
// together with a throwaway copy of main.ts per parameter vector. A parameter
// vector is applied by rewriting the `const NAME = ...;` lines, which keeps the
// thing being scored byte-for-byte the file that ships except for the constants.
//
//   node sim/tune.mjs baseline
//   node sim/tune.mjs scan SLOPE_SD 0.12,0.2,0.3,0.4,0.6
//   node sim/tune.mjs grid2 DRIFT_LOW 0.75,1.0 DRIFT_HIGH 2,2.8
//   node sim/tune.mjs cd              # coordinate descent on the tune corpus
//
// Scoring is the competition metric: mean pinball loss in logit space, plus
// typical miss (pp) and 90 % coverage. Two families of synthetic cases are
// scored (4.52 d horizon = the final's shape, 90 min across a rescan = the
// practice shape) plus the two real practice cases from the kit.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCase, makeWorld } from './sim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = join(tmpdir(), `trophy-tune-${process.pid}`);
mkdirSync(work, { recursive: true });

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449];
const clampPct = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (p) => { const q = clampPct(p) / 100; return Math.log(q / (1 - q)); };
const expit = (z) => 100 / (1 + Math.exp(-z));

const KIT = process.env.KIT
  ?? 'C:\\Users\\lhw\\Documents\\deepseek-harness\\default-workspace\\makefun-research\\kits\\gta6-trophy-rarity-forecast-01\\gta6-trophy-rarity-forecast-01-kit';

export const BASE = {
  SLOPE_SD: 0.30, SLOPE_DAMP: 0.80, SHIFT_MAX: 2.20,
  TRACK_P_PRIOR: 1.00, TRACK_P_MAX: 1.60, TRACK_P_DAMP: 0.95,
  SPREAD_SCALE: 0.50, SPREAD_FLOOR: 0.26, SPREAD_MAX: 2.60,
  C_PRIOR: 0.06, C_PRIOR_W: 40,
  STALE_LAG_LN: 1.20, STALE_VAR: 0.80,
  DRIFT_LOW: 1.00, DRIFT_HIGH: 2.80,
};

const GRID = {
  SLOPE_SD: [0.12, 0.18, 0.24, 0.30, 0.38, 0.48, 0.60],
  SLOPE_DAMP: [0.40, 0.55, 0.70, 0.80, 0.88, 0.95],
  SHIFT_MAX: [1.2, 1.6, 2.0, 2.2, 2.6, 3.0],
  TRACK_P_PRIOR: [0.70, 0.85, 1.00, 1.15, 1.30],
  TRACK_P_MAX: [1.20, 1.60, 2.00],
  TRACK_P_DAMP: [0.70, 0.80, 0.90, 0.95, 1.00],
  SPREAD_SCALE: [0.85, 0.95, 1.05, 1.15, 1.30],
  SPREAD_FLOOR: [0.20, 0.30, 0.40, 0.50],
  SPREAD_MAX: [2.00, 2.60, 3.20],
  C_PRIOR: [0.00, 0.03, 0.06, 0.09, 0.12],
  C_PRIOR_W: [10, 25, 40, 70],
  STALE_LAG_LN: [0.80, 1.00, 1.20, 1.40, 1.60],
  STALE_VAR: [0.40, 0.60, 0.80, 1.00, 1.30],
  DRIFT_LOW: [0.0, 0.8, 1.4, 2.2, 3.0, 4.0],
  DRIFT_HIGH: [0.0, 2.0, 3.5, 5.2, 7.0],
  MODEL_VAR: [0.0, 0.3, 0.6, 1.0, 1.5, 2.5],
};

// -- corpus -------------------------------------------------------------------
const FAMILIES = [
  { key: 'tuneFin', n: 24, atH: (k) => 48 + (k % 6) * 4, horizonH: () => 6510 / 60, wSeed: 2100, wStep: 11, rSeed: 6100, rStep: 13 },
  { key: 'tuneLaunch', n: 24, atH: (k) => 3 + 0.5 * (k % 2), horizonH: (k) => 1.5, wSeed: 2400, wStep: 17, rSeed: 6400, rStep: 19 },
  { key: 'validFin', n: 24, atH: (k) => 48 + (k % 6) * 4, horizonH: () => 6510 / 60, wSeed: 7100, wStep: 23, rSeed: 8100, rStep: 29 },
  { key: 'validLaunch', n: 24, atH: (k) => 3 + 0.5 * (k % 2), horizonH: (k) => 1.5, wSeed: 7400, wStep: 31, rSeed: 8400, rStep: 37 },
];

function buildCorpus() {
  const cache = join(work, 'corpus.json');
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  console.error('building corpus...');
  const corpus = {};
  for (const f of FAMILIES) {
    const cases = [];
    for (let k = 0; k < f.n; k++) {
      const world = makeWorld(f.wSeed + k * f.wStep, { prereg: 640 });
      const atH = f.atH(k);
      const { caseObj, truth } = makeCase(world, f.rSeed + k * f.rStep, { atH, targetH: atH + f.horizonH(k), id: `${f.key}${k}` });
      cases.push({ caseObj, truth });
    }
    corpus[f.key] = cases;
  }
  writeFileSync(cache, JSON.stringify(corpus));
  return corpus;
}

function practiceCases() {
  const out = [];
  for (const name of ['p00', 'p01']) {
    const caseObj = JSON.parse(readFileSync(join(KIT, 'input', `${name}.in`), 'utf8'));
    const last = caseObj.history[caseObj.history.length - 1];
    const truth = caseObj.trophies.map((t, i) => {
      const r = last.rates[i];
      if (r >= 99) return 99.99;
      const before = (r / 100) * 638;
      return clampPct(((before + 1.93) / 3868) * 100);
    });
    out.push({ name, caseObj, truth });
  }
  return out;
}

function score(caseObj, rows, truth) {
  const idx = new Map(caseObj.trophies.map((t, i) => [t.id, i]));
  let sum = 0, n = 0, miss = 0, cov = 0, bias = 0, width = 0;
  const lossTau = [0, 0, 0, 0, 0];
  for (const row of rows) {
    const y = logit(truth[idx.get(row.id)]);
    for (let k = 0; k < 5; k++) {
      const d = y - logit(row.q[k]);
      const l = 2 * Math.max(LEVELS[k] * d, (LEVELS[k] - 1) * d);
      sum += l;
      lossTau[k] += l;
      n++;
    }
    const yp = truth[idx.get(row.id)];
    miss += Math.abs(yp - row.q[2]);
    bias += y - logit(row.q[2]);
    width += logit(row.q[4]) - logit(row.q[0]);
    if (row.q[0] <= yp && yp <= row.q[4]) cov++;
  }
  const m = rows.length;
  return {
    loss: sum / n, miss: miss / m, cov: cov / m, bias: bias / m, width: width / m,
    lossTau: lossTau.map((x) => x / m),
  };
}

// -- variant module -----------------------------------------------------------
let seq = 0;
const src = readFileSync(join(root, 'main.ts'), 'utf8');
const NAMES = Object.keys(BASE).map((k) => ({ k, re: new RegExp(`const ${k} = [^;]+;`) }));
for (const { k, re } of NAMES) if (!re.test(src)) throw new Error(`main.ts has no 'const ${k} = ...;'`);

function loadVariant(params) {
  let out = src;
  for (const { k, re } of NAMES) out = out.replace(re, `const ${k} = ${params[k]};`);
  const file = join(work, `v${seq++}.ts`);
  writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const corpus = buildCorpus();
const practice = practiceCases();

async function evaluate(params) {
  const mod = await loadVariant({ ...BASE, ...params });
  const res = { params: { ...BASE, ...params }, fam: {}, practice: [] };
  for (const f of FAMILIES) {
    let loss = 0, miss = 0, cov = 0, bias = 0, width = 0;
    const lt = [0, 0, 0, 0, 0];
    for (const { caseObj, truth } of corpus[f.key]) {
      const s = score(caseObj, mod.forecastCase(caseObj), truth);
      loss += s.loss; miss += s.miss; cov += s.cov; bias += s.bias; width += s.width;
      for (let k = 0; k < 5; k++) lt[k] += s.lossTau[k];
    }
    const n = corpus[f.key].length;
    res.fam[f.key] = {
      loss: loss / n, miss: miss / n, cov: cov / n, bias: bias / n, width: width / n,
      lossTau: lt.map((x) => x / n),
    };
  }
  for (const p of practice) res.practice.push(score(p.caseObj, mod.forecastCase(p.caseObj), p.truth));
  res.pLoss = (res.practice[0].loss + res.practice[1].loss) / 2;
  res.obj = res.fam.tuneFin.loss;
  return res;
}

function fmt(res, tag = '') {
  const f = res.fam;
  return `${tag.padEnd(26)} fin ${f.tuneFin.loss.toFixed(4)}  launch ${f.tuneLaunch.loss.toFixed(4)}  ` +
    `prac ${res.pLoss.toFixed(4)}  |  vfin ${f.validFin.loss.toFixed(4)}  vlaunch ${f.validLaunch.loss.toFixed(4)}  ` +
    `obj ${res.obj.toFixed(4)}  cov ${f.tuneFin.cov.toFixed(3)}`;
}

// -- driver -------------------------------------------------------------------
const mode = process.argv[2] ?? 'baseline';

if (mode === 'baseline') {
  const res = await evaluate({});
  console.log(fmt(res, 'baseline'));
  for (const [k, v] of Object.entries(res.fam)) console.log(`  ${k.padEnd(12)} loss ${v.loss.toFixed(4)} miss ${v.miss.toFixed(3)} cov ${v.cov.toFixed(3)} bias ${v.bias.toFixed(2)} width ${v.width.toFixed(2)} tau ${v.lossTau.map((x) => x.toFixed(3)).join("/")}`);
  console.log(`  practice p00 ${res.practice[0].loss.toFixed(4)}  p01 ${res.practice[1].loss.toFixed(4)}`);
} else if (mode === 'scan') {
  const name = process.argv[3];
  const values = process.argv[4].split(',').map(Number);
  console.log(`# scan ${name}`);
  for (const v of values) {
    const res = await evaluate({ [name]: v });
    console.log(fmt(res, `${name}=${v}`));
  }
} else if (mode === 'cd') {
  const passes = Number(process.argv[3] ?? 3);
  let cur = {};
  let best = await evaluate(cur);
  console.log(fmt(best, 'start'));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const name of Object.keys(GRID)) {
      let localBest = null;
      const table = [];
      for (const v of GRID[name]) {
        const res = await evaluate({ ...cur, [name]: v });
        table.push([v, res.obj, res.fam.tuneFin.loss, res.pLoss]);
        if (!localBest || res.obj < localBest.res.obj) localBest = { v, res };
      }
      const line = table.map(([v, o, l, p]) => `${v}:${o.toFixed(4)}/${l.toFixed(4)}/${p.toFixed(4)}`).join('  ');
      console.log(`  ${name.padEnd(14)} ${line}`);
      if (localBest.res.obj < best.obj - 1e-5 && localBest.v !== (cur[name] ?? BASE[name])) {
        cur = { ...cur, [name]: localBest.v };
        best = localBest.res;
        moved = true;
        console.log(fmt(best, `  -> ${name}=${localBest.v}`));
      }
    }
    if (!moved) break;
  }
  console.log('\nfinal params', JSON.stringify({ ...BASE, ...cur }));
  console.log(fmt(best, 'best'));
  for (const [k, v] of Object.entries(best.fam)) console.log(`  ${k.padEnd(12)} loss ${v.loss.toFixed(4)} miss ${v.miss.toFixed(3)} cov ${v.cov.toFixed(3)}`);
} else if (mode === 'grid2') {
  // node sim/tune.mjs grid2 NAME v1,v2 NAME2 v1,v2,v3 [base '{json}']
  const [n1, l1, n2, l2] = process.argv.slice(3, 7);
  const extra = process.argv[7] ? JSON.parse(process.argv[7]) : {};
  const vals1 = l1.split(',').map(Number);
  const vals2 = l2.split(',').map(Number);
  console.log(`# grid2 ${n1} x ${n2}  base ${JSON.stringify(extra)}`);
  for (const a of vals1) {
    const row = [];
    for (const b of vals2) {
      const res = await evaluate({ ...extra, [n1]: a, [n2]: b });
      row.push(`${b}:${res.fam.tuneFin.loss.toFixed(4)}/${res.fam.validFin.loss.toFixed(4)}/${res.pLoss.toFixed(4)}`);
    }
    console.log(`  ${n1}=${String(a).padEnd(5)} ${row.join('  ')}`);
  }
} else if (mode === 'eval') {
  // node sim/tune.mjs eval '{"SLOPE_SD":0.24}'   (or TUNE_PARAMS=... when the
  // shell eats the quotes -- PowerShell strips them from native argv)
  const res = await evaluate(JSON.parse(process.argv[3] ?? process.env.TUNE_PARAMS ?? '{}'));
  console.log(fmt(res, 'eval'));
  for (const [k, v] of Object.entries(res.fam)) console.log(`  ${k.padEnd(12)} loss ${v.loss.toFixed(4)} miss ${v.miss.toFixed(3)} cov ${v.cov.toFixed(3)} bias ${v.bias.toFixed(2)} width ${v.width.toFixed(2)} tau ${v.lossTau.map((x) => x.toFixed(3)).join("/")}`);
  console.log(`  practice p00 ${res.practice[0].loss.toFixed(4)}  p01 ${res.practice[1].loss.toFixed(4)}`);
  console.log(`  params ${JSON.stringify(res.params)}`);
}

// Throwaway variant modules are only needed while the process runs.
process.on('exit', () => {
  rmSync(work, { recursive: true, force: true });
});
