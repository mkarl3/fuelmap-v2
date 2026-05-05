// Core Skiba W'bal simulation. Pure math — no input transformation, no
// output formatting.
//
// Wrappers in `buildWbal` (PLAN side) and `buildWbalFromRawSeries` (ANALYZE
// side) handle their own input/output shaping per spec 3.5 / 3.6 / CC#3.
// This is the single source of truth for the depletion/recovery math.
//
// Skiba dynamic tau (instantaneous form, matching legacy code):
//   tau = 546 × exp(-0.01 × (CP - power)) + 316   when power < CP
//
// Per Mike's confirmation: dCP is the instantaneous deficit (CP - power),
// not a recent-history average. This matches the existing buildWbal /
// buildWbalFromRawSeries implementations exactly.

/**
 * Simulate W' balance over a power time series.
 *
 * @param {number[]} powerSeries - power values in watts at the given dt resolution
 * @param {number} dt - timestep in seconds (typically 1 under CC#7)
 * @param {number} cp - critical power in watts
 * @param {number} wPrime - W' in joules (the rider's anaerobic capacity)
 * @param {number} [tauOverride] - optional fixed tau in seconds. If omitted,
 *   uses Skiba dynamic tau (instantaneous (CP - power) form). Useful for
 *   testing / sensitivity analysis.
 * @returns {number[]} W' remaining in joules at each timestep, length matches
 *   input. Each value is clamped to [0, wPrime].
 *
 * Edge cases:
 *  - Empty / null input → []
 *  - wPrime ≤ 0 → returns zeros (no anaerobic capacity to deplete)
 *  - dt ≤ 0 → treated as 1 (defensive)
 *  - Above CP (`power > cp`): deplete by (power - cp) × dt joules
 *  - At or below CP (`power ≤ cp`): recover via exponential toward wPrime
 *    using tau (Skiba dynamic or override)
 */
export function simulateWbal(powerSeries, dt, cp, wPrime, tauOverride) {
  if (!powerSeries || powerSeries.length === 0) return [];
  if (!(wPrime > 0)) return powerSeries.map(() => 0);

  const safeDt = dt > 0 ? dt : 1;
  const out = new Array(powerSeries.length);
  let wbal = wPrime;

  for (let i = 0; i < powerSeries.length; i++) {
    const power = powerSeries[i];
    if (power > cp) {
      // Above CP: linear depletion proportional to deficit and dt.
      const cost = (power - cp) * safeDt;
      wbal = Math.max(0, wbal - cost);
    } else {
      // At or below CP: exponential recovery toward wPrime.
      // Skiba dynamic tau uses instantaneous deficit; tauOverride forces a
      // fixed value (e.g., for sensitivity testing).
      const tau = (typeof tauOverride === 'number' && tauOverride > 0)
        ? tauOverride
        : 546 * Math.exp(-0.01 * (cp - power)) + 316;
      wbal = wPrime - (wPrime - wbal) * Math.exp(-safeDt / tau);
    }
    // Clamp upper bound (math should never exceed wPrime, but be defensive).
    if (wbal > wPrime) wbal = wPrime;
    out[i] = wbal;
  }
  return out;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Above CP — depletion. Power 300, CP 250 → deficit 50 J/s.
//   const dep = simulateWbal([300, 300, 300], 1, 250, 20000);
//   // → [19950, 19900, 19850]  (linear depletion at 50 J/s)
//
// Below CP — recovery (clamped at wPrime when starting full):
//   const rec = simulateWbal([200, 200, 200], 1, 250, 20000);
//   // → [20000, 20000, 20000]  (already full, can't recover further)
//
// Recovery from depleted state:
//   const recDepleted = simulateWbal([200, 200, 200], 1, 250, 20000);
//   // Without depletion first, can't see recovery — needs setup.
//   // Manual: at power=200, CP=250, dCP=50; tau ≈ 546*e^(-0.5)+316 ≈ 647
//   // From wbal=10000, after 1s: 20000 - (20000-10000)*e^(-1/647)
//   //                          ≈ 20000 - 9984.5 ≈ 10015.5  (recovers ~15 J/s)
//
// Empty / null:
//   simulateWbal([], 1, 250, 20000)        → []
//   simulateWbal(null, 1, 250, 20000)      → []
//
// Zero W' (degenerate athlete):
//   simulateWbal([300, 200], 1, 250, 0)    → [0, 0]
//
// At CP exactly (boundary — recovery branch, no change when full):
//   simulateWbal([250, 250], 1, 250, 20000)  → [20000, 20000]

export default simulateWbal;
