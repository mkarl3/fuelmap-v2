// Estimate dietary carbohydrate burn rate (g/hr) at a given power output.
//
// Two-step model:
//  1) Look up carb fraction by % FTP (intensity tiers)
//  2) Convert: (watts × 3.6 × carbPct) / divisor
//
// The "÷ divisor" compresses three conversions:
//   - mechanical→metabolic efficiency (~25%)
//   - W → kJ/hr (× 3.6)
//   - kJ → g via carb energy density (~17 kJ/g)
//
// **Accuracy fix from spec 2.8:** legacy code used `÷ 4`, but the physically
// correct divisor is `17 × 0.25 = 4.25`. New numbers are ~6% lower than
// before. Behavior change documented; downstream nutrition recommendations
// shift down by that amount.
//
// **Continuous interpolation** between intensity tiers replaces the legacy
// 5-tier step function. Linear interpolation between tier midpoints. Smoother,
// more physiologically honest, no change to broad shape.
//
// This function returns the BODY's actual carb consumption rate.
// For the recommended INTAKE rate (which is gut-limited, not power-limited),
// use `recommendIntakeRate(burnRate, athleteMaxIntake)`.
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.8.

const WATTS_TO_KJ_PER_HOUR        = 3.6;
const MECHANICAL_EFFICIENCY        = 0.25;
const CARB_ENERGY_DENSITY_KJ_PER_G = 17;
const DIVISOR = CARB_ENERGY_DENSITY_KJ_PER_G * MECHANICAL_EFFICIENCY; // = 4.25

// Intensity tier centers + carb fractions. The legacy step function was:
//   pct < 0.55          → 0.38   (Z1 / low Z2)
//   0.55 ≤ pct < 0.65   → 0.52   (mid Z2)
//   0.65 ≤ pct < 0.75   → 0.65   (high Z2 / low Z3)
//   0.75 ≤ pct < 0.85   → 0.78   (Z3 / threshold)
//   pct ≥ 0.85          → 0.90   (Z4+)
//
// We anchor each fraction at the MIDPOINT of its tier and interpolate
// linearly between adjacent midpoints. Below the first midpoint or above the
// last, value is held flat (no extrapolation).
const TIER_ANCHORS = Object.freeze([
  { pct: 0.40,  carbPct: 0.38 }, // midpoint of (-∞, 0.55) — anchor at typical Z1 ~0.40
  { pct: 0.60,  carbPct: 0.52 }, // midpoint of [0.55, 0.65)
  { pct: 0.70,  carbPct: 0.65 }, // midpoint of [0.65, 0.75)
  { pct: 0.80,  carbPct: 0.78 }, // midpoint of [0.75, 0.85)
  { pct: 0.95,  carbPct: 0.90 }, // typical Z4+ effort, anchor at 0.95
]);

function interpolateCarbPct(pct) {
  if (pct <= TIER_ANCHORS[0].pct) return TIER_ANCHORS[0].carbPct;
  if (pct >= TIER_ANCHORS[TIER_ANCHORS.length - 1].pct) {
    return TIER_ANCHORS[TIER_ANCHORS.length - 1].carbPct;
  }
  for (let i = 0; i < TIER_ANCHORS.length - 1; i++) {
    const lo = TIER_ANCHORS[i], hi = TIER_ANCHORS[i + 1];
    if (pct >= lo.pct && pct <= hi.pct) {
      const t = (pct - lo.pct) / (hi.pct - lo.pct);
      return lo.carbPct + t * (hi.carbPct - lo.carbPct);
    }
  }
  return TIER_ANCHORS[TIER_ANCHORS.length - 1].carbPct; // unreachable
}

/**
 * @param {number} watts  current power output
 * @param {number} ftp    athlete's FTP
 * @returns {number}      estimated carb burn rate in g/hr (≥ 0)
 *
 * Edge cases:
 *  - watts ≤ 0 → 0 g/hr
 *  - ftp ≤ 0  → 0 g/hr (defensive — would otherwise divide by zero)
 */
export function carbOxidationRate(watts, ftp) {
  if (!(watts > 0) || !(ftp > 0)) return 0;
  const pct = watts / ftp;
  const carbPct = interpolateCarbPct(pct);
  return (watts * WATTS_TO_KJ_PER_HOUR * carbPct) / DIVISOR;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Legacy behavior comparison (FTP=250):
//   At 200W → 80% FTP → carbPct ~0.78 → (200 × 3.6 × 0.78) / 4.25 ≈ 132 g/hr
//   Legacy ÷4 form would give ~140 g/hr (~6% higher).
//
// Low intensity (200W, FTP 350 → 57%, near tier-2 anchor):
//   carbOxidationRate(200, 350) ≈ 200 × 3.6 × ~0.49 / 4.25 ≈ 83 g/hr
//
// Edge cases:
//   carbOxidationRate(0, 250)   → 0
//   carbOxidationRate(200, 0)   → 0
//   carbOxidationRate(-50, 250) → 0
//
// Continuous (no step discontinuity):
//   carbOxidationRate(187, 250) ≈ carbOxidationRate(188, 250) within < 0.5 g/hr
//   (legacy step function jumped ~13 g/hr at 75% FTP boundary)

export default carbOxidationRate;
