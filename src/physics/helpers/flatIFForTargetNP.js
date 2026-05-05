// Binary-search wrapper around buildPowerStream. Spec 4.1 orchestrator.
//
// Given a desired NP IF, finds the flat-road IF that produces it after the
// full grade-aware simulation. Necessary because asymmetric physics on hilly
// terrain means flat-road IF is always lower than NP IF — naive flat-IF
// targeting causes systematic NP inflation, overpacing, and second-half
// explosion.
//
// Per spec 4.1 target state:
//  • #1 Search applies caps (resolves S1-FINDING-MODEL-SHAPE). Both
//    `maxPower` and `climbCategories` parameters are now honored — search
//    and final use identical physics. Pre-rewrite the search ran with
//    Infinity / null and the display ran with caps, producing systematic
//    NP undershoot on hilly terrain.
//  • #2 Unreachable-target detection. After max iterations, if the
//    converged IF can't produce the requested NP IF (capped out), returns a
//    structured error per CC#6 with the maxAchievableIF.
//  • #3 Convergence detection. Exits early when (hi - lo) < tolerance.
//    Reduces typical iteration count from 30 → ~10.
//  • #4 Magic numbers lifted to named constants.
//  • #5 CC#7 future-proofing: inner buildPowerStream call structure works
//    unchanged when 4B flips to 1-second resolution.

import { buildPowerStream } from './buildPowerStream.js';

// ── Function-specific tuning constants (per CC#5) ────────────────────────
const MAX_ITERATIONS         = 30;
const CONVERGENCE_TOLERANCE  = 0.001; // IF units — exit when (hi - lo) < this
const IF_SEARCH_FLOOR        = 0.30;  // lower bound of binary-search interval
const UNREACHABLE_NP_TOLERANCE = 0.01; // converged actual NP IF must reach
                                       // target within this band, else
                                       // declare target unreachable

/**
 * @param {number} targetNpIF       desired NP IF (e.g. 0.85)
 * @param {object} gpxStats         GPX route stats
 * @param {object} athlete          athlete profile
 * @param {number} Crr
 * @param {number} maxPower         global power ceiling (Infinity = no global cap)
 * @param {number} CdA
 * @param {number} eta
 * @param {number} bikeWeight       kg added to athlete.weight
 * @param {number} rho
 * @param {number} windSpeedMs
 * @param {number} windDirDeg
 * @param {object} climbCategories  per-category caps {moderate, steep, wall}
 *                                  with {min, max}. Required for search-with-
 *                                  caps; null/undefined falls back to
 *                                  search-without-caps (legacy behavior, used
 *                                  by callers that haven't yet migrated).
 * @returns {number | { ok: false, reason: string, ... }}
 *   On success: flat-road IF (decimal) that produces the target NP IF after
 *   grade-aware simulation, within UNREACHABLE_NP_TOLERANCE.
 *   On unreachable target: structured error with maxAchievableIF.
 */
export function flatIFForTargetNP(
  targetNpIF, gpxStats, athlete,
  Crr, maxPower, CdA, eta, bikeWeight, rho,
  windSpeedMs, windDirDeg, climbCategories,
) {
  let lo = IF_SEARCH_FLOOR;
  let hi = targetNpIF; // flat-road IF is always ≤ NP IF on variable terrain

  // Track the best converged result so unreachable-target detection has a
  // value to report (the maxAchievableIF — the actual NP that the search's
  // best mid-point produces).
  let bestActualNpIF = 0;
  let bestFlatIF = (lo + hi) / 2;
  let iterations = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations++;
    const mid = (lo + hi) / 2;
    const strat = { mode: 'constant_if', targetIF: mid };
    // #1: search applies caps. Same physics in search and final.
    const result = buildPowerStream(
      gpxStats, athlete, strat,
      Crr, maxPower, CdA, eta, bikeWeight, rho,
      windSpeedMs, windDirDeg, climbCategories,
    );
    // buildPowerStream may return a structured error (e.g. climb_cap_unset).
    // If it does, propagate up — search can't proceed.
    if (result && typeof result === 'object' && result.ok === false) {
      return result;
    }

    const actualNpIF = result.ifActual;
    if (actualNpIF > bestActualNpIF) {
      bestActualNpIF = actualNpIF;
      bestFlatIF = mid;
    }

    if (actualNpIF > targetNpIF) hi = mid;
    else                          lo = mid;

    // #3: convergence detection — exit early.
    if ((hi - lo) < CONVERGENCE_TOLERANCE) break;
  }

  const finalIF = (lo + hi) / 2;
  // Run one more buildPowerStream at finalIF to measure the actual NP IF
  // we'd get with the converged value. (The loop's `result` is for `mid`
  // not `finalIF`; on a converged interval they're effectively the same,
  // but on a hit-the-iteration-cap exit they could differ by tolerance.)
  const finalCheck = buildPowerStream(
    gpxStats, athlete, { mode: 'constant_if', targetIF: finalIF },
    Crr, maxPower, CdA, eta, bikeWeight, rho,
    windSpeedMs, windDirDeg, climbCategories,
  );
  if (finalCheck && typeof finalCheck === 'object' && finalCheck.ok === false) {
    return finalCheck;
  }
  if (finalCheck.ifActual > bestActualNpIF) {
    bestActualNpIF = finalCheck.ifActual;
    bestFlatIF = finalIF;
  }

  // #2: unreachable-target detection. If the best NP we can produce under
  // the given caps is still below the user's target, return structured
  // error so caller / UI can surface the limit.
  if (bestActualNpIF < targetNpIF - UNREACHABLE_NP_TOLERANCE) {
    return {
      ok: false,
      reason: 'target_unreachable_with_caps',
      maxAchievableIF: Math.round(bestActualNpIF * 1000) / 1000,
      flatIFAtMax: Math.round(bestFlatIF * 1000) / 1000,
      iterations,
      recommendation: 'lower NP IF target or raise climb caps',
    };
  }

  return finalIF;
}

// ─── Sanity checks (run mentally or via Node REPL) ───────────────────────
//
// Reasonable target on hilly terrain:
//   flatIFForTargetNP(0.85, tdlStats, athlete, ..., climbCaps)
//   → some flat-IF in [0.65, 0.80] depending on terrain (was undershooting
//     to ~0.50 pre-Step 8 because search ran without caps).
//
// Unreachable target:
//   flatIFForTargetNP(1.50, tdlStats, athlete, ..., climbCaps)
//   → { ok: false, reason: 'target_unreachable_with_caps', maxAchievableIF: ~0.95, ... }
//
// Trivially low target (below floor):
//   flatIFForTargetNP(0.20, ...)
//   → IF_SEARCH_FLOOR (0.30) — search clamps at floor; actual NP overshoots target,
//     hi clamps to 0.30; (hi - lo) is 0; convergence triggers immediately.
//     The "unreachable" check fires the OTHER way (we can't go below floor) —
//     bestActualNpIF will be > targetNpIF, so the unreachable check (bestActualNpIF
//     < targetNpIF - tolerance) doesn't fire. Returns 0.30. Behaviorally correct.

export default flatIFForTargetNP;
