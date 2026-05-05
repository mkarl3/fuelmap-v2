// Fits a 2-parameter Critical Power model to MMP test data.
//
// Uses linear regression on (t, e) = (duration, energy = power × duration),
// fitting `e = CP × t + W'`. This is the standard work-balance linearization
// of the hyperbolic CP model `P = CP + W'/t`.
//
// Per spec 3.4 / CC#2 — single helper consumed by both `computeCP` (returns
// the full {cp, wPrime, r2}) and `deriveWPrime` Tier 1 (uses just wPrime).
// The 5000 J floor is policy applied by `deriveWPrime`, not by this fit.
//
// Why (t, e) and not (1/t, P): both forms are mathematically equivalent
// solutions of the hyperbolic model, but they minimize different residuals.
// (t, e) minimizes joule-residuals; (1/t, P) minimizes watt-residuals. The
// app has historically used (t, e) — preserve that for numerical continuity
// against existing saved athlete profiles.

/**
 * Fit Critical Power model to MMP points.
 *
 * @param {Array<{durationSec: number, powerW: number}>} mmpPoints
 *   At least 2 valid points (positive duration AND positive power) required.
 *   Points should span the aerobic-anaerobic range — e.g., 3-min and 12-min,
 *   or 5-min and 20-min — for meaningful CP separation.
 * @returns {{cp: number, wPrime: number, r2: number} | null}
 *   Returns null when fewer than 2 valid points OR the fit is degenerate
 *   (all points at the same duration → division by zero).
 *
 *   - `cp`: critical power in watts (rounded to int).
 *   - `wPrime`: W' in joules (rounded to int) — RAW; no floor applied here.
 *   - `r2`: coefficient of determination, 0–1.0 (1.0 = perfect linear fit,
 *           0 = no correlation). Returns 1 when ssTot is exactly 0 (all
 *           energy values equal — only possible with identical inputs).
 *
 * Edge cases:
 *  - Fewer than 2 valid points → null.
 *  - Points with durationSec ≤ 0 or powerW ≤ 0 are filtered before fitting.
 *  - All remaining points at the same duration → null (degenerate).
 *  - Negative wPrime (very poor fit) is returned as-is — caller decides
 *    whether to surface as a warning. `deriveWPrime` floors at DEFAULTS.wPrimeFloorJ.
 */
export function fitCPModel(mmpPoints) {
  if (!mmpPoints || !Array.isArray(mmpPoints)) return null;

  const filled = mmpPoints.filter(p =>
    p && typeof p.durationSec === 'number' && typeof p.powerW === 'number'
    && p.durationSec > 0 && p.powerW > 0
  );
  if (filled.length < 2) return null;

  // (t, e) regression: e = CP × t + W'.
  // Using `t = durationSec` and `e = powerW × durationSec` (joules).
  const n = filled.length;
  const pts = filled.map(p => ({ t: p.durationSec, e: p.powerW * p.durationSec }));

  const sumT  = pts.reduce((s, p) => s + p.t,         0);
  const sumE  = pts.reduce((s, p) => s + p.e,         0);
  const sumTT = pts.reduce((s, p) => s + p.t * p.t,   0);
  const sumTE = pts.reduce((s, p) => s + p.t * p.e,   0);

  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null; // all points at same duration

  const cp     = (n * sumTE - sumT * sumE) / denom;
  const wPrime = (sumE - cp * sumT) / n;

  // R² (coefficient of determination) on the energy regression.
  const meanE = sumE / n;
  const ssTot = pts.reduce((s, p) => s + Math.pow(p.e - meanE, 2),         0);
  const ssRes = pts.reduce((s, p) => s + Math.pow(p.e - (cp * p.t + wPrime), 2), 0);
  const r2    = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return {
    cp:     Math.round(cp),
    wPrime: Math.round(wPrime),
    r2:     Math.round(r2 * 10000) / 10000, // 4 decimal places, fraction 0–1
  };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Two clean points (3-min @ 300W, 12-min @ 250W):
//   const a = fitCPModel([
//     { durationSec: 180, powerW: 300 },
//     { durationSec: 720, powerW: 250 },
//   ]);
//   // Math: e3=54000 J, e12=180000 J. Slope (t→e): (180000-54000)/(720-180) = 233.3 W
//   // Intercept: 54000 - 233.3*180 = 12000 J. r²=1 (only 2 points).
//   // → a = { cp: 233, wPrime: 12000, r2: 1 }
//
// Three points clustered along a line — clean fit:
//   fitCPModel([
//     { durationSec: 180, powerW: 320 },
//     { durationSec: 300, powerW: 290 },
//     { durationSec: 720, powerW: 250 },
//   ])
//   // → r² close to 1, cp ~230-240, wPrime in 14-18k range
//
// Insufficient data:
//   fitCPModel([{ durationSec: 180, powerW: 300 }])    → null
//   fitCPModel([])                                       → null
//   fitCPModel(null)                                     → null
//
// All same duration (degenerate):
//   fitCPModel([
//     { durationSec: 300, powerW: 300 },
//     { durationSec: 300, powerW: 250 },
//   ])
//   → null
//
// Filtering of bad points:
//   fitCPModel([
//     { durationSec: 180, powerW: 300 },
//     { durationSec:   0, powerW: 999 },     // filtered (zero duration)
//     { durationSec: 720, powerW: 250 },
//   ])
//   → uses 2 points, returns valid fit

export default fitCPModel;
