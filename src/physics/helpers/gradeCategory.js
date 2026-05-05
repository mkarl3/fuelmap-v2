// Point-in-time grade classifier.
//
// Replaces the old single-purpose `climbCategory(avgGradePct)` for per-block
// / per-second classification use cases (e.g., inside `buildPowerStream` for
// climb-cap selection). Climb-level categorization (which considers the full
// climb's avg AND peak grade) is `climbCategory(climbStats)` — see spec 2.6
// split rationale.
//
// New: 'descent' category for negative grades (the legacy function silently
// returned 'moderate' for any sub-6% grade including negatives — semantically
// meaningless for caller decisions about climb caps vs descent floors).
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.6.

/**
 * @param {number} gradePct  signed grade in percent (e.g., -3.5 = 3.5% descent)
 * @returns {'descent' | 'moderate' | 'steep' | 'wall'}
 *
 * Bin edges (left-closed):
 *   gradePct < 0       → 'descent'
 *   0 ≤ gradePct < 6   → 'moderate'
 *   6 ≤ gradePct < 10  → 'steep'
 *   gradePct ≥ 10      → 'wall'
 *
 * Edge cases:
 *  - Non-finite input (NaN/null/undefined) → 'moderate' (defensive default;
 *    flat-ish behavior is the safest fallback for unknown grades)
 */
export function gradeCategory(gradePct) {
  if (typeof gradePct !== 'number' || !isFinite(gradePct)) return 'moderate';
  if (gradePct < 0)  return 'descent';
  if (gradePct >= 10) return 'wall';
  if (gradePct >= 6)  return 'steep';
  return 'moderate';
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// gradeCategory(-2)   → 'descent'
// gradeCategory(0)    → 'moderate'
// gradeCategory(3)    → 'moderate'
// gradeCategory(5.99) → 'moderate'
// gradeCategory(6)    → 'steep'
// gradeCategory(7)    → 'steep'
// gradeCategory(9.99) → 'steep'
// gradeCategory(10)   → 'wall'
// gradeCategory(12)   → 'wall'
// gradeCategory(NaN)  → 'moderate'
// gradeCategory(null) → 'moderate'

export default gradeCategory;
