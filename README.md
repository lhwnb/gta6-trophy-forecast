# trophy-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/lhwnb/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/lhwnb/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A submission for the make.fun bounty
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01):
forecast, for every trophy on the GTA VI PS5 trophy list, the share of tracked
players who hold it at the checkpoint's target time, as five quantiles
(5 / 25 / 50 / 75 / 95 %).

The interesting part of the problem is that an Exophase "rarity" number is
`earners / players_tracked`, and the second number moves in jumps whenever
Exophase rescans its player base. A trophy at 1.25 % can fall to 0.26 % between
two reads without a single player becoming worse -- the denominator was simply
multiplied by six. So the model has to separate **dilution** (the denominator
growing) from **progression** (players actually earning things), and it has to
survive the fact that the two are collinear inside any one history window.

## Running it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input directory (default `/input`), writes `<id>.out`
in the output directory (default `/output`). Node 22, standard library only, no
network, no randomness -- two runs on the same input are byte-identical.

Self-check (shape, ids, monotone, range, byte budget, determinism):

```sh
node tools/selfcheck.js input      # or: node tools/selfcheck.js /path/to/kit/input
```

## Model

For trophy *i* at a read with `T` tracked players and rate `p`:

- **logit response.** The fit and the forecast work on
  `y = logit(p) = ln(p / (1 - p))`, clamped to `0.01 .. 99.99`. On that scale a
  proportional dilution is a constant shift, the quantity can never leave
  `(0, 1)`, and a trophy that sits at exactly 100 % needs no special case.
- **Rescans, not reads.** A read only tells us something new when
  `players_tracked` changed; those are the *rescans*. Repeated identical reads
  are collapsed into the last one of each rescan (otherwise 40 duplicate reads
  would look like 40 observations of the same point). Each trophy's observation
  weight is `T * p * (1 - p)`, the Fisher information of a logit proportion.
- **Slope on `ln T` only.** For each trophy I regress `y` on `u = ln T` with a
  ridge prior `b0` (see below): the slope answers "when the tracked population
  grows by `x` e-folds, how far does this rate move?". Fitting a second
  regressor for elapsed time is tempting and it does not work -- over one
  window `ln T` and wall-clock are nearly collinear, so the pair is
  unidentified and the extrapolation flies off (in simulation it turned a 79 %
  truth into 98 %). Whatever is not explained by dilution is picked up as one
  **pooled** drift term instead: `cDrift` is estimated only from variation
  *within* a rescan (where `T` is constant), so time and denominator effects
  cannot be confused with each other.
- **Anchored forecast.** The median comes out as
  `logit(p_last) + b * (u_target - u_last) + cDrift * (target_time - last_time)`,
  i.e. it starts from the last reading rather than from the fitted line. A
  fitted line sits below the last point whenever a series is still climbing, and
  that bias alone used to cost more than everything else combined.
- **Tier priors.** With few rescans a trophy's own slope is noise, so `b` is
  shrunk towards `b0 = -0.88 + 0.88 * (p/100)^0.85` (pure dilution is `-1`,
  no dilution is `0`): rare trophies behave like a pure denominator effect,
  common ones like a saturated curve. The platinum/gold/silver/bronze tier
  nudges that prior by `-0.06 / 0 / +0.03 / +0.05`; bronze is where the
  denominator effect bites hardest.
- **Tracked-count projection.** `ln T` is projected to the target from a power
  law fitted on the recent rescans, with the exponent damped towards linear
  growth, and floored at the last observation (the tracked count is not going
  to fall). If the page has never rescanned, it is projected from the launch
  curve instead, with a deliberate lag -- a page that has been frozen for hours
  is behind, not current.
- **Spread.** The quantile band is Gaussian in logit space,
  `q_tau = 100 / (1 + exp(-(m + z_tau * s)))`. The variance adds up sampling
  noise (`1/earners` before and after the projection), slope uncertainty
  (`du^2 * var(b)`), tracked-count uncertainty (carried through `b`), and a
  flat floor so that no band is ever narrower than the data can support. It
  grows with the extrapolation distance. A miss on a tail costs roughly twenty
  times what a too-wide band costs, so `s` is deliberately generous.
- **Universal trophies.** A trophy that has been at 100 % from the start (the
  "you finished the prologue" kind) gets a narrow band pinned just under 100,
  never 100 itself -- a rate of exactly 100 is a claim that no tracked player
  lacks it, and that is not something a next rescan can be relied on to keep.

Quantiles are rounded to 4 decimals, which keeps an output file near 2.8 kB
against the 65,536-byte budget.

## Layout

| path | what it is |
| --- | --- |
| `main.ts` | the submission: input parsing, model, quantile output |
| `tools/selfcheck.js` | runs `main.ts` twice, validates shape/ids/monotone/range/bytes/determinism |
| `sim/sim.mjs` | synthetic world (players, play sessions, earn times, periodic rescans) + scorer + the house baseline, the time-trend model and this model scored side by side |
| `sim/practice-check.mjs` | scores this model on the real practice cases against the answer reconstructed from the kit's `competition.yaml` |
| `NOTES.md` | calibration notes: simulator parameters, comparison tables, what was tried and dropped |

The simulator and the practice check are development tools; only `main.ts` is
part of the submission.

This README is deliberately 7-bit ASCII: it survives being opened, piped or
round-tripped by any codepage without turning punctuation into mojibake.
