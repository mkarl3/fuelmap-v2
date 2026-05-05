// Climb-level classifier — takes the FULL climb object (avg + peak + length)
// rather than a single grade value.
//
// Replaces the legacy `climbCategory(avgGradePct)` for callers that have a
// detected-climb object in hand (`detectClimbs` output). Avoids the bug where
// a 5%-avg climb with an 11% pinch was labeled "moderate" — the pinch
// section will trigger Steep/Wall caps in `buildPowerStream`, but the climb
// list display said "moderate". Both pieces of information should be in
// agreement.
//
// Point-in-time grade classification (single grade value, e.g. inside
// `buildPowerStream`) uses `gradeCategory(gradePct)` instead.
//
// Returns one of 'moderate' / 'steep' / 'wall'. (Climbs by definition are
// uphill — no 'descent' category here; that's for `gradeCategory`.)
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.6.

/**
 * @param {{avgGradePct: number, peakGradePct: number, lengthM?: number}} climbStats
 *   Climb summary as produced by `detectClimbs`. `lengthM` accepted but not
 *   currently consumed — reserved for future logic that may treat short
 *   pinches differently from long climbs.
 * @returns {'moderate' | 'steep' | 'wall'}
 *
 * Logic:
 *  - peakGradePct ≥ 10                     → 'wall'
 *  - avgGradePct ≥ 6 OR peakGradePct ≥ 8   → 'steep'
 *  - else                                  → 'moderate'
 *
 * Edge cases:
 *  - Missing peakGradePct (legacy data without the new field) — falls back
 *    to using only avgGradePct. Result: anything < 6% avg → 'moderate',
 *    6–10% avg → 'steep', ≥10% avg → 'wall' (legacy semantics).
 *  - Non-object input → 'moderate' (defensive).
 */
export function climbCategory(climbStats) {
  if (!climbStats || typeof climbStats !== 'object') return 'moderate';
  const avg  = typeof climbStats.avgGradePct  === 'number' ? climbStats.avgGradePct  : 0;
  const peak = typeof climbStats.peakGradePct === 'number' ? climbStats.peakGradePct : avg;
  if (peak >= 10) return 'wall';
  if (avg  >= 6 || peak >= 8) return 'steep';
  return 'moderate';
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Wall — peak ≥ 10:
//   climbCategory({ avgGradePct: 4, peakGradePct: 12, lengthM: 800 })  → 'wall'
//   climbCategory({ avgGradePct: 11, peakGradePct: 13 })               → 'wall'
//
// Steep — avg ≥ 6:
//   climbCategory({ avgGradePct: 7, peakGradePct: 9 })                 → 'steep'
//
// Steep — peak ≥ 8 (even with low avg):
//   climbCategory({ avgGradePct: 4, peakGradePct: 9 })                 → 'steep'
//
// Moderate — neither threshold:
//   climbCategory({ avgGradePct: 4, peakGradePct: 7 })                 → 'moderate'
//   climbCategory({ avgGradePct: 5.5, peakGradePct: 7 })               → 'moderate'
//
// Legacy data (no peakGradePct):
//   climbCategory({ avgGradePct: 7 })                                  → 'steep'
//   climbCategory({ avgGradePct: 4 })                                  → 'moderate'
//   climbCategory({ avgGradePct: 11 })                                 → 'wall' (peak defaults to avg)
//
// Defensive:
//   climbCategory(null)  → 'moderate'
//   climbCategory({})    → 'moderate'

export default climbCategory;
