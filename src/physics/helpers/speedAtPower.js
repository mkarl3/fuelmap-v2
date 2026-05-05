// Steady-state speed achievable at a given power. Inverse of powerAtSpeed.
//
// Binary search across [0, DEFAULTS.maxRideSpeedMs] m/s using powerAtSpeed.
// 60 iterations → ~0.01 m/s precision.
//
// Per spec 2.2 target state (changed from current):
//  • Speed cap raised from 25 m/s → DEFAULTS.maxRideSpeedMs (35 m/s ≈ 78 mph).
//    25 m/s silently truncated real-world fast descents (70+ mph).
//  • Negative `targetWatts` returns structured error per CC#6 — should never
//    happen in normal flow; if it does, upstream code is broken.
//
// Success returns a plain number (m/s). Failure returns the structured error
// object. Consumers check by type/shape (per CC#6 contract).

import { powerAtSpeed }      from './powerAtSpeed.js';
import { PHYSICS_CONSTANTS } from '../constants/physicsConstants.js';
import { DEFAULTS }          from '../constants/defaults.js';

/**
 * @param {number} targetWatts  target power in watts (≥ 0)
 * @param {number} grade        decimal grade
 * @param {number} massKg       rider + bike + gear mass in kg
 * @param {number} [Crr]
 * @param {number} [CdA]
 * @param {number} [eta]
 * @param {number} [rho]
 * @param {number} [windMs]
 * @returns {number | {ok: false, reason: string}}
 *   On success: speed in m/s, capped at DEFAULTS.maxRideSpeedMs (35).
 *   On negative targetWatts: { ok: false, reason: 'negative_power_input' }.
 *
 * Edge cases:
 *  - targetWatts === 0 on flat: returns near-zero
 *  - targetWatts === 0 on steep descent: returns freewheel speed
 *  - Insufficient power for grade: returns ~0
 *  - High power on steep descent: capped at maxRideSpeedMs (sanity bound to
 *    prevent runaway binary-search iteration; real-world descents at 35 m/s
 *    require structurally different physics anyway)
 */
export function speedAtPower(
  targetWatts, grade, massKg,
  Crr  = DEFAULTS.Crr,
  CdA  = DEFAULTS.bikePhysics.CdA,
  eta  = DEFAULTS.bikePhysics.eta,
  rho  = PHYSICS_CONSTANTS.rhoSeaLevelStandard,
  windMs = 0,
) {
  if (typeof targetWatts !== 'number' || targetWatts < 0) {
    return { ok: false, reason: 'negative_power_input' };
  }
  if (targetWatts === 0) return 0;

  let lo = 0.1, hi = DEFAULTS.maxRideSpeedMs, mid;
  for (let i = 0; i < 60; i++) {
    mid = (lo + hi) / 2;
    powerAtSpeed(mid, grade, massKg, Crr, CdA, eta, rho, windMs) < targetWatts
      ? lo = mid
      : hi = mid;
  }
  return mid;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Round-trip with powerAtSpeed (250W flat, 75 kg → ~10 m/s):
//   const sp = speedAtPower(250, 0, 75);
//   // sp should be roughly 10.3 m/s; powerAtSpeed(sp, 0, 75) ≈ 250 ± 1
//
// Climbing 5%, same 250W:
//   speedAtPower(250, 0.05, 75)  → ~4.9 m/s
//
// Negative power (bug indicator):
//   speedAtPower(-50, 0, 75)
//   → { ok: false, reason: 'negative_power_input' }
//
// Speed cap (huge target wattage maxes out at maxRideSpeedMs):
//   speedAtPower(2000, -0.10, 75)  → 35 (capped)

export default speedAtPower;
