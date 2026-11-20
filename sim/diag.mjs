// sim/diag.mjs -- where the loss comes from: movement of the median vs truth,
// bucketed by the trophy's last read. Run: node sim/diag.mjs [family]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastCase } from '../main.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, '.tune', 'corpus.json'), 'utf8'));
const clampPct = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (p) => { const q = clampPct(p) / 100; return Math.log(q / (1 - q)); };

const EDGES = [0, 0.5, 1, 2, 5, 10, 25, 50, 80, 101];
const fam = process.argv[2] ?? 'tuneFin';
for (const key of [fam]) {
  const buckets = EDGES.slice(0, -1).map(() => ({ n: 0, dTrue: 0, dModel: 0, lo: 0, hi: 0, cov: 0 }));
  for (const { caseObj, truth } of corpus[key]) {
    const rows = forecastCase(caseObj);
    const last = caseObj.history[caseObj.history.length - 1];
    for (let i = 0; i < rows.length; i++) {
      const lr = last.rates[i];
      if (lr == null) continue;
      const b = EDGES.findIndex((e, j) => lr >= e && lr < EDGES[j + 1]);
      if (b < 0) continue;
      const y0 = logit(lr);
      const y = logit(truth[i]);
      const q = rows[i].q;
      buckets[b].n++;
      buckets[b].dTrue += y - y0;
      buckets[b].dModel += logit(q[2]) - y0;
      buckets[b].lo += logit(q[2]) - logit(q[0]);
      buckets[b].hi += logit(q[4]) - logit(q[2]);
      if (q[0] <= truth[i] && truth[i] <= q[4]) buckets[b].cov++;
    }
  }
  console.log(`${key}: last-rate bucket  n   dTrue  dModel   q50-q05  q95-q50  cov`);
  buckets.forEach((v, j) => {
    if (!v.n) return;
    const f = (x) => (x / v.n).toFixed(2).padStart(6);
    console.log(`${String(EDGES[j]).padStart(4)}-${String(EDGES[j + 1]).padStart(4)}%  ${String(v.n).padStart(5)}  ${f(v.dTrue)} ${f(v.dModel)}  ${f(v.lo)}  ${f(v.hi)}  ${(v.cov / v.n).toFixed(2)}`);
  });
}
