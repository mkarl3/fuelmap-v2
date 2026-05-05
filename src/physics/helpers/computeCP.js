// Thin wrapper around `fitCPModel` adding R² threshold warnings and the
// 5000 J floor on W'.
//
// Per spec 3.4 / CC#2: this function no longer reimplements the regression
// math — `fitCPModel` is the single source. `computeCP` just dispatches and
// adds the user-facing concerns:
//  • R² threshold warnings (poor / moderate / good fit)
//  • 5000 J floor on W' (CC#4 user-fixable issue — return floored value
//    AND fire fitWarn so UI can surface re-test guidance)
//  • R² returned as PERCENT (0–100, 1 decimal) to preserve the existing UI
//    contract — current AthleteModal compares against 95/97/etc. thresholds
//
// `null` returned when input is insufficient — preserves CC#6 "legitimate
// no-answer" classification.

import { fitCPModel } from './fitCPModel.js';
import { fitWarn }    from './fitWarn.js';
import { DEFAULTS }   from '../constants/defaults.js';

const R2_GOOD_THRESHOLD     = 0.95;
const R2_MODERATE_THRESHOLD = 0.85;

/**
 * @param {Array<{secs: number, watts: number}>} cpTests
 *   Same input shape as legacy `computeCP`. Each entry is one max effort.
 * @returns {{cp: number, wPrime: number, r2: number} | null}
 *   On success: cp (W) and wPrime (J) rounded to int; r2 as PERCENT (0–100,
 *   1 decimal) for UI compat.
 *   On insufficient/degenerate input: null.
 *
 * Side effects (via fitWarn):
 *  - 'cp_test_poor_fit'      when R² < 0.85
 *  - 'cp_test_moderate_fit'  when 0.85 ≤ R² < 0.95
 *  - 'cp_test_low_wprime'    when fitted W' < DEFAULTS.wPrimeFloorJ (5000)
 */
export function computeCP(cpTests) {
  // Translate legacy {secs, watts} shape → fitCPModel's {durationSec, powerW}.
  const points = (cpTests || [])
    .filter(t => t && t.secs > 0 && t.watts > 0)
    .map(t => ({ durationSec: t.secs, powerW: t.watts }));

  const fit = fitCPModel(points);
  if (!fit) return null;

  const { cp, wPrime: wPrimeRaw, r2 } = fit;

  // R² threshold warnings (CC#4 user-fixable).
  if (r2 < R2_MODERATE_THRESHOLD) {
    fitWarn('cp_test_poor_fit',
      `CP fit R²=${r2.toFixed(3)} — test data may be unreliable, consider re-testing`,
      { r2 });
  } else if (r2 < R2_GOOD_THRESHOLD) {
    fitWarn('cp_test_moderate_fit',
      `CP fit R²=${r2.toFixed(3)} — moderate fit quality`,
      { r2 });
  }

  // W' floor (CC#4 user-fixable). The floor is policy applied here in the
  // wrapper, NOT in fitCPModel. Floored value is returned with warning.
  let wPrime = wPrimeRaw;
  if (wPrimeRaw < DEFAULTS.wPrimeFloorJ) {
    fitWarn('cp_test_low_wprime',
      `Fitted W' (${wPrimeRaw} J) below floor — CP test data may be unreliable. Capping at ${DEFAULTS.wPrimeFloorJ} J.`,
      { wPrimeRaw });
    wPrime = DEFAULTS.wPrimeFloorJ;
  }

  // Convert R² fraction → percent with 1-decimal rounding to preserve the
  // existing UI contract (AthleteModal compares against 95/97/etc.).
  const r2Pct = Math.round(r2 * 1000) / 10;

  return { cp: Math.round(cp), wPrime: Math.round(wPrime), r2: r2Pct };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Two-point clean fit (3 min @ 300W, 12 min @ 250W):
//   computeCP([{secs: 180, watts: 300}, {secs: 720, watts: 250}])
//   → { cp: 233, wPrime: 12000, r2: 100 }   (perfect 2-point line)
//
// Insufficient:
//   computeCP([{secs: 180, watts: 300}])  → null
//   computeCP([])                          → null
//
// Low-W' fit (would fire 'cp_test_low_wprime'):
//   computeCP([{secs: 180, watts: 200}, {secs: 720, watts: 199}])
//   → wPrime floored to 5000, fitWarn fires
//
// Poor R² (would fire 'cp_test_poor_fit'):
//   3+ point inconsistent data — depends on the specific values

export default computeCP;
