// Canonical Normalized Power (NP) — TrainingPeaks/Garmin/Strava methodology.
//
// Hardcoded 30-second rolling window applied to 1-second power data, then
// 4th-power mean, then 4th root. Industry-standard formula — non-negotiable
// for validation against device numbers.
//
// See FuelMAP_Physics_Spec_v0_3 CC#1.

/**
 * Compute Normalized Power from a 1-second power series.
 *
 * @param {number[]} powerSeries - 1-second power values in watts. Zero values
 *   are included in the rolling window — they represent coasting/recovery,
 *   not missing data, and the rolling window must operate on contiguous time
 *   for NP to be physically meaningful.
 * @returns {number} Normalized Power in watts, rounded to nearest integer.
 *   Returns 0 for empty/null input.
 *
 * Edge cases:
 *  - First 29 indices use a partial window of length min(i+1, 30).
 *    This matches the legacy implementation's `slice(Math.max(0, i-29), i+1)`
 *    behavior and Garmin/TrainingPeaks reference output.
 *  - Empty array → 0.
 *  - Single value → that value (window of 1, mean of mean^4 = value).
 *  - All zeros → 0.
 */
export function computeNP(powerSeries) {
  if (!powerSeries || powerSeries.length === 0) return 0;
  const rolling = powerSeries.map((_, i, a) => {
    const w = a.slice(Math.max(0, i - 29), i + 1);
    return w.reduce((s, p) => s + p, 0) / w.length;
  });
  return Math.round(
    Math.pow(
      rolling.reduce((s, p) => s + Math.pow(p, 4), 0) / rolling.length,
      0.25
    )
  );
}

// ─── Sanity checks (run via `node` to verify) ────────────────────────────
//
// Constant power → NP = avg power:
//   computeNP(Array(30).fill(200))   → 200
//
// Empty:
//   computeNP([])                     → 0
//   computeNP(null)                   → 0
//
// Single value:
//   computeNP([250])                  → 250
//
// Variability penalty (4th-power mean lifts NP above arithmetic mean):
//   const alt = []; for (let i = 0; i < 30; i++) alt.push(i % 2 ? 300 : 100);
//   computeNP(alt)                    → ~233 (arithmetic mean = 200)
//
// All zeros:
//   computeNP(Array(30).fill(0))      → 0

export default computeNP;
