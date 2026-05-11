// B-23 surge factor — per-climb cap adjustment for short, steep climbs.
//
// Real riders punch short steep climbs much harder than long ones at the
// same grade. The plan-side flat-IF + uniform climb-cap model produces
// too-smooth power profiles on short efforts. This helper computes a
// per-climb cap multiplier from climb duration and peak grade.
//
// Structure: surge = durationScore × gradeScore, each linear-clamped to
// [0,1]. Surge maps linearly to a cap multiplier in [SURGE_CAP_MIN,
// SURGE_CAP_MAX]. Below SURGE_FACTOR_THRESHOLD, fall through to the
// static gradeCategory cap. FLOOR_AT_BASE_CAP enforces that the formula
// can never reduce a category below its existing static cap (a wall
// climb at low surge could otherwise compute below 1.30).
//
// Constants calibrated against TDL/CC/PP fixtures (see
// `B23_Calibration_Report.md`). The "sharp" formula at MAE 0.052 cap-mult
// units, max constraining error 0.047, max permissive error 0.147.
//
// **Predicted vs actual duration:** in production the formula consumes
// PREDICTED climb duration (computed from a static-cap pass-1 run of
// buildPowerStream). The calibration used actual FIT-side duration for
// validation; predicted/actual delta on the calibration set was small and
// did not cross any formula breakpoint.

export const SURGE_FACTOR_DEFAULTS = Object.freeze({
  SURGE_DURATION_FLOOR_SEC: 60,    // ≤60s: durationScore = 1.0 (full surge weight)
  SURGE_DURATION_CEIL_SEC:  240,   // ≥240s: durationScore = 0.0 (no surge)
  SURGE_GRADE_FLOOR_PCT:    4.0,   // ≤4%: gradeScore = 0.0
  SURGE_GRADE_CEIL_PCT:     6.0,   // ≥6%: gradeScore = 1.0
  SURGE_CAP_MIN:            1.05,  // surge ≥ threshold → cap mult starts here
  SURGE_CAP_MAX:            1.55,  // surge = 1.0 → cap mult ends here
  SURGE_FACTOR_THRESHOLD:   0.10,  // below this, fall through to baseCapMult
  FLOOR_AT_BASE_CAP:        true,  // formula never reduces below the static cap
});

function durationScore(sec, F) {
  if (sec <= F.SURGE_DURATION_FLOOR_SEC) return 1.0;
  if (sec >= F.SURGE_DURATION_CEIL_SEC) return 0.0;
  return 1.0 - (sec - F.SURGE_DURATION_FLOOR_SEC)
             / (F.SURGE_DURATION_CEIL_SEC - F.SURGE_DURATION_FLOOR_SEC);
}

function gradeScore(pct, F) {
  if (pct <= F.SURGE_GRADE_FLOOR_PCT) return 0.0;
  if (pct >= F.SURGE_GRADE_CEIL_PCT) return 1.0;
  return (pct - F.SURGE_GRADE_FLOOR_PCT)
       / (F.SURGE_GRADE_CEIL_PCT - F.SURGE_GRADE_FLOOR_PCT);
}

/**
 * @param {object} climb
 * @param {number} climb.durationSec   Predicted climb duration (sec).
 * @param {number} climb.peakGradePct  Peak grade within climb (% as 0–25).
 * @param {number} climb.baseCapMult   Static category cap as multiplier of FTP.
 *                                      e.g. moderate cap 231W on FTP 215 → 1.074
 * @param {object} [F=SURGE_FACTOR_DEFAULTS] Tuning constants.
 * @returns {{ capMult: number, surge: number }}
 *          `capMult` is the surge-adjusted cap as a multiplier of FTP.
 *          `surge` is the raw surge factor (0–1) for diagnostics.
 */
export function surgeAdjustedCapMult({ durationSec, peakGradePct, baseCapMult }, F = SURGE_FACTOR_DEFAULTS) {
  const surge = durationScore(durationSec, F) * gradeScore(peakGradePct, F);
  let capMult;
  if (surge < F.SURGE_FACTOR_THRESHOLD) {
    capMult = baseCapMult;
  } else {
    capMult = F.SURGE_CAP_MIN + surge * (F.SURGE_CAP_MAX - F.SURGE_CAP_MIN);
  }
  if (F.FLOOR_AT_BASE_CAP && capMult < baseCapMult) capMult = baseCapMult;
  return { capMult, surge };
}

export default surgeAdjustedCapMult;

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// PP #2 (67s, 6.1% peak, base cap 1.15): full surge expected.
//   surgeAdjustedCapMult({ durationSec: 67, peakGradePct: 6.1, baseCapMult: 1.15 })
//   → { capMult ≈ 1.531, surge ≈ 0.96 }
//
// PP #1 (60s, 5.1% peak, base cap 1.05): partial surge.
//   surgeAdjustedCapMult({ durationSec: 60, peakGradePct: 5.1, baseCapMult: 1.05 })
//   → { capMult ≈ 1.325, surge ≈ 0.55 }
//
// TDL short shallow (90s, 4.2% peak, base 1.074): grade below floor; falls through.
//   surgeAdjustedCapMult({ durationSec: 90, peakGradePct: 4.2, baseCapMult: 1.074 })
//   → { capMult: 1.074, surge: 0.083 }  (gradeScore × durScore = 0.10 × 0.83 ≈ 0.083 < threshold)
//
// TDL long climb (374s, 6.8% peak, base 1.074): duration above ceil; falls through.
//   surgeAdjustedCapMult({ durationSec: 374, peakGradePct: 6.8, baseCapMult: 1.074 })
//   → { capMult: 1.074, surge: 0 }
//
// Wall climb at low surge (180s, 5% peak, base cap 1.30):
// surge = 0.25 × 0.5 = 0.125 > threshold → 1.05 + 0.125 × 0.50 = 1.1125
// FLOOR_AT_BASE_CAP forces output up to 1.30 (don't reduce below static).
//   surgeAdjustedCapMult({ durationSec: 180, peakGradePct: 5, baseCapMult: 1.30 })
//   → { capMult: 1.30, surge: 0.125 }
