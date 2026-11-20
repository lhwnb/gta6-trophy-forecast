// Times main.ts on realistic inputs (throwaway helper, not part of the model).
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWorld, makeCase } from './sim.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tf-time-'));
const out = mkdtempSync(join(tmpdir(), 'tf-time-out-'));
const cases = [];
for (let k = 0; k < 3; k++) {
  const w = makeWorld(900 + k, { prereg: 640 });
  cases.push(makeCase(w, 4000 + k, { atH: 60, targetH: 60 + 6510 / 60, id: `c${k}` }).caseObj);
}
for (const c of cases) writeFileSync(join(dir, `${c.id}.in`), JSON.stringify(c));

const runs = 5;
const t0 = process.hrtime.bigint();
for (let i = 0; i < runs; i++) {
  execFileSync(process.execPath, ['main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, MAKEFUN_INPUT_DIR: dir, MAKEFUN_OUTPUT_DIR: out },
    stdio: 'ignore',
  });
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
const size = readdirSync(out).map((f) => f.length);
console.log(`cases ${cases.length}  reads/case ${cases[0].history.length}  trophies ${cases[0].trophies.length}`);
console.log(`wall ${ms.toFixed(0)} ms per run of ${cases.length} cases => ${(ms / cases.length).toFixed(1)} ms/case`);
console.log(`output files ${size.length}`);
rmSync(dir, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
