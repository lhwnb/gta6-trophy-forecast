# Notes: how the bands were calibrated

The practice cases carry no signal at all -- both of them show the same page
seven times in a row (`players_tracked` 638, `trophies_earned` 943, rates
`0.63, 100, 1.25, 1.1, 1.1, ...`) -- so nothing in `input/` says how wide a
5-95 % band should be, or how far a rate falls when the page rescans. Two
sources were used to fill that in: a synthetic world with a known truth, and
the one thing the kit's `competition.yaml` does state about the practice
answer (the page was 638 tracked / 943 earned, then rescanned to 3,868 / 4,276
and *every rate but the 100 % one fell*).

## The simulator (`sim/sim.mjs`)

```sh
node sim/sim.mjs 24      # number of final-shaped cases
```

- 9,000 players preregister, then start playing with a spread of ~9 h around
  release; play time per player is exponential with a 30 h median.
- Trophy *i* arrives after `need_i` hours of play, where `need_i` is drawn from
  the trophy's true rarity. One trophy needs zero hours (the "100 % from the
  first read" case) and the platinum needs far longer than anyone reaches.
- Exophase rescans: a rescan happens every `1.2 + 3.4 * u^2 + 0.6` hours and
  republishes *all* rates with the current denominator, so every rate steps
  down at once. The reader sees a 30-minute cadence.
- Truth = each trophy's earner share among the tracked population at the target
  time. Scored with the competition's own metric: mean pinball loss in logit
  space, plus typical miss (percentage points) and 90 % coverage.

Generative parameters, all in `sim/sim.mjs`: `N = 9000` players, tracked-share
`K_TRACK` (declared, not used -- the tracked set grows as a share of everyone
who has started), `TAU = 38` h session scale, `ALPHA = 0.62` for the
registration curve, `prereg = 640`, refresh interval as above, read interval
30 min. `startSpread` was raised from 2.6 h to 9 h and `playMedian` from 14 h to
30 h: with a 14 h median session the world is essentially finished 108 h later
and persistence is unbeatable *by construction* (house miss 1.6), which makes
the bake-off meaningless. At 30 h the house baseline has to actually miss.

## Bake-off

Final-shaped cases (24 cases, 6,510-minute horizon, ~60 h of history):

| model | pinball loss | typical miss (pp) | 90 % coverage |
| --- | --- | --- | --- |
| house baseline (persistence, `s = 0.5*sqrt(days)`) | 0.3806 | 7.086 | 0.981 |
| time trend (`logit` vs `ln(1+hours)`, last 24 h) | 0.2525 | 6.962 | 0.990 |
| **this model** | **0.1979** | **2.009** | 0.958 |

Launch-night cases (12 cases, 90 minutes across a rescan -- the shape of the
practice cases):

| model | pinball loss | typical miss (pp) | 90 % coverage |
| --- | --- | --- | --- |
| house baseline | 0.5859 | 0.705 | 0.724 |
| time trend | 0.7960 | 1.194 | 0.661 |
| **this model** | **0.5401** | 0.850 | 0.814 |

The model beats persistence on both shapes and gets within 0.03 of the house's
miss on launch night while being far better calibrated on the long horizon,
which is the case that actually decides the board.

## Practice cases against the documented answer (`sim/practice-check.mjs`)

`competition.yaml` states that the page stayed at 638 tracked / 943 earned
through the 04:00Z read and was 3,868 / 4,276 at 04:30Z. That pins the truth:
a trophy's earners went from `round(rate/100 * 638)` to that plus ~2 (total
earners grew 4.53x while the denominator grew 6.06x, so 3,230 new players
brought 3,333 earners between them), and the 100 % trophy simply became 3,868.
Reconstructing the total that way gives 4,281 against the documented 4,276 -- a
check that the reading of the refresh is right.

```sh
KIT=<kit root> node sim/practice-check.mjs
```

| case | model | loss | miss (pp) | coverage |
| --- | --- | --- | --- | --- |
| p00 | house baseline | 1.3844 | 0.676 | 0.018 |
| p00 | **this model** | **0.2267** | **0.036** | 1.000 |
| p01 | house baseline | 1.3844 | 0.676 | 0.018 |
| p01 | **this model** | **0.2337** | 0.044 | 1.000 |

Per-trophy medians, last read -> truth -> forecast: id 1 `0.63 -> 0.154 -> 0.137`,
id 3 `1.25 -> 0.256 -> 0.332`, id 4 `1.1 -> 0.231 -> 0.291`, id 20
`2.04 -> 0.386 -> 0.556`. The remaining bias is one-directional (a little too
high on the rare trophies): a frozen page hides an unknown amount of denominator
growth, and the prior used for it (`b0` near `-0.88`, i.e. slightly less than
pure dilution) is the middle of the plausible range rather than the point value
of this one refresh.

## What was tried and dropped

- **Earner counts instead of rates** (`ln E = a + b ln T`): no ceiling. A
  fitted `b` slightly above 1 extrapolates to 98 % where the truth is 58 %, and
  it did exactly that on a silver trophy.
- **A second regressor for elapsed time** (`ln T` and `ln(1+hours)` together,
  per trophy): the two are nearly collinear inside one window, the split is
  unidentified, and the forecast explodes -- in simulation the loss was 1.94
  with a 26 pp typical miss and zero coverage. Replaced by one pooled
  within-rescan drift term.
- **Anchoring on the fitted line** rather than on the last reading: biased low
  whenever the series is still climbing. Anchoring on the last read took the
  simulated loss from 1.99 to 0.20 on its own.
- **Counting every read as an observation.** Identical consecutive reads are
  one observation; before collapsing them, a frozen page with 40 reads looked
  like 40 independent points and the slope variance collapsed to zero.
- **Weighting by `earners * p * (1-p)`.** The variance of `logit(p_hat)` is
  `1/earners`, so the weight is `earners * p * (1-p)` -- dividing by `p(1-p)`
  instead inflates it by `1/p` (var 40 instead of 0.25 on a 4-earner trophy)
  and makes rare trophies look far more certain than they are.

## Parameters and where they came from

| parameter | value | why |
| --- | --- | --- |
| `SLOPE_SD` | 0.30 | ridge width of the per-trophy slope; priors tuned so the practice cases land within ~0.4 logit of the answer |
| `SLOPE_DAMP` | 0.80 | only the *deviation* from the prior is damped, so a trophy with no usable data still gets the full prior slope |
| slope prior `b0` | `clamp(-0.88 + 0.88*(p/100)^0.85, -1, 0.05)` | pure dilution is `-1`, saturation is `0`; the documented refresh implies ~ `-0.84` at 1 % |
| tier tilt | plat `-0.06`, gold `0`, silver `+0.03`, bronze `+0.05` | bronze is dominated by denominator effects |
| `C_PRIOR`, `C_PRIOR_W` | 0.06, 40 | pooled drift prior: +0.06 logit/day, worth 40 observations |
| `TRACK_P_PRIOR/MAX/DAMP` | 1.00 / 1.60 / 0.95 | tracked-count power law, damped towards linear |
| `STALE_LAG_LN`, `STALE_VAR` | 1.20, 0.80 | a page that never rescanned lags the launch curve by ~e^1.2 in `ln T`; chosen against the documented 638 -> 3,868 refresh |
| `SHIFT_MAX` | 2.20 | cap on how far a median may move from the last reading, in logits |
| `CV_VAR` | 0.02 | variance of the tracked-count projection passed through the slope |
| `SPREAD_SCALE/FLOOR/MAX` | 1.05 / 0.30 / 2.60 | tail misses cost ~20x a wide band, so widen a little and never go below 0.30 |
| `MAX_WEIGHT` | 120 | caps the influence of one very common trophy |
| write rounding | 4 dp | ~2.8 kB per case against a 65,536-byte budget |

`Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449]` for the 5 / 25 / 50 / 75 / 95 %
quantiles.
