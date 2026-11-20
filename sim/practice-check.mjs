// Score the practice cases against the answer the kit's competition.yaml
// documents: the page was 638 tracked / 943 earned, then rescanned to 3,868 /
// 4,276, so every non-universal count moved by ~+2 earners while the
// denominator went x6.06.
import { readFileSync } from 'node:fs';
import { forecastCase } from '../main.ts';

const KIT = process.env.KIT;
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449];
const clampPct = (x) => Math.min(99.99, Math.max(0.01, x));
const logit = (p) => { const q = clampPct(p) / 100; return Math.log(q / (1 - q)); };
const expit = (z) => 100 / (1 + Math.exp(-z));

const T_BEFORE = 638;
const T_AFTER = 3868;
const EARned_AFTER = 4276;

for (const name of ['p00', 'p01']) {
  const c = JSON.parse(readFileSync(`${KIT}/input/${name}.in`, 'utf8'));
  const last = c.history[c.history.length - 1];
  const truth = c.trophies.map((t, i) => {
    const r = last.rates[i];
    if (r >= 99) return 99.99;
    const before = (r / 100) * T_BEFORE;
    return clampPct(((before + 1.93) / T_AFTER) * 100);
  });
  const mine = forecastCase(c);
  const house = c.trophies.map((t, i) => ({
    id: t.id,
    q: Z.map((z) => Math.round(expit(logit(last.rates[i]) + z * 0.5 * Math.sqrt(c.horizon_minutes / 1440)) * 1e4) / 1e4),
  }));
  const sc = (rows) => {
    let sum = 0, n = 0, typ = 0, cov = 0;
    for (const row of rows) {
      const i = c.trophies.findIndex((t) => t.id === row.id);
      const y = logit(truth[i]);
      for (let k = 0; k < 5; k++) {
        const d = y - logit(row.q[k]);
        sum += 2 * Math.max(LEVELS[k] * d, (LEVELS[k] - 1) * d);
        n++;
      }
      typ += Math.abs(truth[i] - row.q[2]);
      if (row.q[0] <= truth[i] && truth[i] <= row.q[4]) cov++;
    }
    return { loss: sum / n, miss: typ / rows.length, cov: cov / rows.length };
  };
  const a = sc(mine), b = sc(house);
  console.log(`${name}  mine  loss ${a.loss.toFixed(4)}  miss ${a.miss.toFixed(3)}  cov ${a.cov.toFixed(3)}`);
  console.log(`${name}  house loss ${b.loss.toFixed(4)}  miss ${b.miss.toFixed(3)}  cov ${b.cov.toFixed(3)}`);
  console.log(`  earned-after check: ${c.trophies.reduce((s, t, i) => s + (last.rates[i] >= 99 ? T_AFTER : Math.round((last.rates[i] / 100) * T_BEFORE) + 2), 0)} (want ${EARned_AFTER})`);
  for (const i of [0, 2, 3, 19]) {
    console.log(`   id${c.trophies[i].id} last ${last.rates[i]} -> truth ${truth[i].toFixed(3)}  mine ${mine[i].q[2]}`);
  }
}
