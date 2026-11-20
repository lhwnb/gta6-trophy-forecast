// Self-check for the submission: run main.ts twice on the same inputs and
// verify the output shape, the ids, the ordering, the ranges, the byte budget
// and that the two runs agree byte for byte.
//
//   node tools/selfcheck.js [inputDir]
//
// Defaults to ../input relative to the repo root, so a checkout with an input/
// folder next to main.ts needs no arguments. Prints one line per case and
// exits non-zero on the first violation.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const inputDir = resolve(process.argv[2] ?? process.env.MAKEFUN_INPUT_DIR ?? join(root, 'input'));
const MAX_BYTES = 65536;
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

const runOnce = (outDir) => {
  const r = spawnSync(process.execPath, [join(root, 'main.ts')], {
    cwd: root,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outDir },
    stdio: 'ignore',
  });
  if (r.status !== 0) fail(`main.ts exited ${r.status} writing to ${outDir}`);
};

const a = mkdtempSync(join(tmpdir(), 'trophy-a-'));
const b = mkdtempSync(join(tmpdir(), 'trophy-b-'));
try {
  runOnce(a);
  runOnce(b);

  const inputs = readdirSync(inputDir).filter((f) => f.endsWith('.in')).sort();
  if (inputs.length === 0) fail(`no *.in files in ${inputDir}`);
  if (readdirSync(a).sort().join(',') !== inputs.map((f) => f.replace(/\.in$/, '.out')).join(',')) {
    fail(`output file set ${readdirSync(a).sort().join(',')} does not match the input set`);
  }

  for (const file of inputs) {
    const name = `${file.slice(0, -3)}.out`;
    const caseObj = JSON.parse(readFileSync(join(inputDir, file), 'utf8'));
    const raw = readFileSync(join(a, name));
    const rawB = readFileSync(join(b, name));

    if (!raw.equals(rawB)) fail(`${name}: two runs differ byte for byte`);
    if (raw.length > MAX_BYTES) fail(`${name}: ${raw.length} bytes > ${MAX_BYTES}`);
    if (raw.length === 0) fail(`${name}: empty`);

    let doc;
    try {
      doc = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      fail(`${name}: not JSON (${err.message})`);
    }
    const keys = Object.keys(doc);
    if (keys.length !== 1 || keys[0] !== 'trophies') fail(`${name}: top-level keys ${keys.join(',')}`);
    if (!Array.isArray(doc.trophies)) fail(`${name}: trophies is not an array`);

    const want = caseObj.trophies.map((t) => t.id);
    const got = doc.trophies.map((t) => t.id);
    if (got.length !== want.length) fail(`${name}: ${got.length} trophies, case has ${want.length}`);
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) fail(`${name}: trophy #${i} id ${got[i]}, case has ${want[i]}`);
      const row = doc.trophies[i];
      const rk = Object.keys(row).sort().join(',');
      if (rk !== 'id,q') fail(`${name}: id ${row.id} keys ${rk}`);
      if (!Array.isArray(row.q) || row.q.length !== LEVELS.length) fail(`${name}: id ${row.id} q is not length 5`);
      for (let k = 0; k < row.q.length; k++) {
        const x = row.q[k];
        if (typeof x !== 'number' || !Number.isFinite(x)) fail(`${name}: id ${row.id} q[${k}] = ${x}`);
        if (x < 0 || x > 100) fail(`${name}: id ${row.id} q[${k}] = ${x} out of 0..100`);
        if (k > 0 && x < row.q[k - 1]) fail(`${name}: id ${row.id} q is not non-decreasing: ${JSON.stringify(row.q)}`);
      }
    }
    console.log(`ok    ${name}  ${String(raw.length).padStart(5)} B  ${doc.trophies.length} trophies  identical=true`);
  }
  console.log(`\nall ${inputs.length} case(s) pass: shape, ids, monotone, range, <=${MAX_BYTES} B, deterministic`);
} finally {
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
}
