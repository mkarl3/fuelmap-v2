// Block-level approximation of NP for downsampled (non-1-second) data.
//
// NOT equivalent to true `computeNP`. This function exists for legacy
// block-resolution code paths and for UI display when working with
// coarser-than-1-second data. Under CC#7, the canonical metric of record is
// `computeNP` operating on 1-second data on both PLAN and ANALYZE sides.
// This function will be retired as the metric of record once CC#7 is fully
// implemented (spec CC#1).
//
// Adapts the rolling window to block resolution: at 1-min blocks, window
// collapses to 1 block (no rolling), so it computes a 4th-power mean on
// raw block averages. Diverges materially from canonical NP at larger block
// sizes — block averaging suppresses variance before the 4th-power step
// (the same bug `parseFIT.rawNP` was historically guilty of, fixed by
// always running 30-sec rolling on 1-sec data).
//
// See FuelMAP_Physics_Spec_v0_3 CC#1.

/**
 * Approximate NP from block-level (downsampled) power values.
 *
 * @param {number[]} blockSeries - power values per block in watts
 * @param {number} blockSeconds - duration of each block in seconds
 * @returns {number} Approximated NP in watts (rounded). Returns 0 on empty/null.
 *
 * Edge cases:
 *  - Empty or null input → 0
 *  - Single block → that value
 *  - blockSeconds ≤ 0 → treated as 1 (defensive — caller bug)
 */
export function computeBlockNP(blockSeries, blockSeconds) {
  if (!blockSeries || blockSeries.length === 0) return 0;
  const safeBlockSecs = blockSeconds > 0 ? blockSeconds : 1;
  const windowBlocks = Math.max(1, Math.ceil(30 / safeBlockSecs));
  const rolling = blockSeries.map((_, i, a) => {
    const w = a.slice(Math.max(0, i - windowBlocks + 1), i + 1);
    return w.reduce((s, p) => s + p, 0) / w.length;
  });
  return Math.round(
    Math.pow(
      rolling.reduce((s, p) => s + Math.pow(p, 4), 0) / rolling.length,
      0.25
    )
  );
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Constant power, 1-min blocks → returns the value:
//   computeBlockNP([200, 200, 200], 60)   → 200
//
// Empty:
//   computeBlockNP([], 60)                 → 0
//
// At 1-sec blocks, behaves identically to computeNP (window = 30):
//   computeBlockNP(Array(30).fill(200), 1) → 200

export default computeBlockNP;
