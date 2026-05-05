// Recommended carb intake rate (g/hr), gut-limited.
//
// Intake rate is bounded by gut absorption capacity — typically 90 g/hr for
// untrained gut, up to 120+ g/hr for trained endurance athletes. Power
// output drives BURN rate (`carbOxidationRate`), but consumption is capped
// by what the gut can absorb.
//
// When burn exceeds intake cap, the rider is in glycogen deficit even with
// perfect fueling. Surfacing both numbers in the UI lets riders see that
// gap rather than thinking they're keeping up when they aren't.
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.8.

import { fitWarn } from './fitWarn.js';

const DEFAULT_MAX_INTAKE_G_PER_HR = 90;

/**
 * @param {number} burnRateGPerHr   carb burn rate from `carbOxidationRate`
 * @param {number} athleteMaxIntake athlete's gut-absorption ceiling (g/hr)
 * @returns {number}                recommended intake rate (g/hr)
 *
 * Edge cases:
 *  - burnRateGPerHr ≤ 0 → 0
 *  - athleteMaxIntake missing/invalid → defaults to 90 g/hr + fitWarn
 *    (matches legacy implicit assumption when athlete profile lacks the field)
 */
export function recommendIntakeRate(burnRateGPerHr, athleteMaxIntake) {
  let cap = athleteMaxIntake;
  if (typeof cap !== 'number' || !(cap > 0)) {
    fitWarn('athlete_max_intake_missing',
      `recommendIntakeRate: athleteMaxIntake invalid — defaulting to ${DEFAULT_MAX_INTAKE_G_PER_HR} g/hr`,
      { athleteMaxIntake });
    cap = DEFAULT_MAX_INTAKE_G_PER_HR;
  }
  if (!(burnRateGPerHr > 0)) return 0;
  return Math.min(burnRateGPerHr, cap);
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Under cap:
//   recommendIntakeRate(70, 90)            → 70
//
// Over cap:
//   recommendIntakeRate(110, 90)           → 90
//
// At cap:
//   recommendIntakeRate(90, 90)            → 90
//
// Trained gut:
//   recommendIntakeRate(115, 120)          → 115
//
// Missing/invalid cap → defaults to 90 + fitWarn:
//   recommendIntakeRate(70, undefined)     → 70  (under default 90)
//   recommendIntakeRate(110, undefined)    → 90  (capped at default 90)
//   recommendIntakeRate(110, 0)            → 90  (zero treated as missing)
//   recommendIntakeRate(110, -5)           → 90  (negative treated as missing)
//
// No burn:
//   recommendIntakeRate(0, 90)             → 0

export default recommendIntakeRate;
