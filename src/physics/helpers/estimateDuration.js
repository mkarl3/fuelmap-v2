// Quick first-guess ride duration via flat-road speed at target IF.
//
// Computes the speed the rider could sustain on perfectly flat ground at
// `ifVal × FTP`, then divides total distance by that speed. **Ignores hills,
// wind, surface, and surges entirely** — intentionally too optimistic on
// hilly courses. `computeVI` corrects downstream.
//
// The chain: `estimateDuration` (flat answer) → `computeVI` (terrain
// correction) → realistic duration shown to user.
//
// Per spec 3.3 target state changes from legacy:
//  • Wind parameters removed from signature (legacy accepted them and
//    silently ignored; the function lied about its inputs).
//  • 9999 sentinel → structured error per CC#6 when the speed solver fails.
//  • Defaults via `DEFAULTS` per CC#5.
//
// CC#7 has no direct effect — this function doesn't iterate per-second.

import { speedAtPower }      from './speedAtPower.js';
import { PHYSICS_CONSTANTS } from '../constants/physicsConstants.js';
import { DEFAULTS }          from '../constants/defaults.js';

// Flat-road speed below this threshold (m/s) means the solver couldn't find
// a realistic answer for the requested IF — usually because IF was set
// extremely low or athlete data is missing. Returns structured error.
const MIN_VIABLE_FLAT_SPEED_MS = 0.1;

/**
 * @param {{ totalDistKm: number }} gpxStats
 * @param {{ ftp: number, weight: number }} athlete
 * @param {number} ifVal       target intensity factor (e.g. 0.76)
 * @param {number} [Crr]       rolling resistance coefficient
 * @param {number} [CdA]       aerodynamic drag area
 * @param {number} [eta]       drivetrain efficiency
 * @param {number} [bikeWeight] additional mass beyond athlete weight (kg)
 * @param {number} [rho]       air density
 * @returns {number | { ok: false, reason: string }}
 *   On success: duration in minutes.
 *   On failure: { ok: false, reason: 'speed_solver_failed' }.
 *
 * NOTE: legacy signature accepted `windSpeedMs` and `windDirDeg` after `rho`.
 * Both were silently ignored. Removed in this rewrite. If a caller still
 * passes them, JavaScript will silently drop them — but the call site should
 * be cleaned up in any case.
 */
export function estimateDuration(
  gpxStats,
  athlete,
  ifVal,
  Crr        = DEFAULTS.Crr,
  CdA        = DEFAULTS.bikePhysics.CdA,
  eta        = DEFAULTS.bikePhysics.eta,
  bikeWeight = 0,
  rho        = PHYSICS_CONSTANTS.rhoSeaLevelStandard,
) {
  const totalMass  = athlete.weight + bikeWeight;
  const totalDistM = gpxStats.totalDistKm * 1000;
  // Wind affects power demand, not pace target — fed in as 0 here.
  const flatSpeed  = speedAtPower(ifVal * athlete.ftp, 0, totalMass, Crr, CdA, eta, rho, 0);

  // speedAtPower returns either a number or a structured error. Pass
  // through if structured; otherwise check the numeric is viable.
  if (flatSpeed && typeof flatSpeed === 'object' && flatSpeed.ok === false) {
    return { ok: false, reason: 'speed_solver_failed', detail: flatSpeed };
  }
  if (flatSpeed <= MIN_VIABLE_FLAT_SPEED_MS) {
    return { ok: false, reason: 'speed_solver_failed' };
  }

  return (totalDistM / flatSpeed) / 60;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Normal estimate: 100 km, 75 kg athlete (FTP 250) at IF 0.76:
//   estimateDuration({ totalDistKm: 100 }, { ftp: 250, weight: 75 }, 0.76)
//   → ~190 min (3:10)  (varies with default Crr/CdA)
//
// Ridiculously low IF — solver likely fails:
//   estimateDuration({ totalDistKm: 100 }, { ftp: 250, weight: 75 }, 0.001)
//   → { ok: false, reason: 'speed_solver_failed' }

export default estimateDuration;
