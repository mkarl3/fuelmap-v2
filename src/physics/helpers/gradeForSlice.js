// Distance-weighted average grade across a route slice [startM, endM).
//
// Translates GPX route data into the grade input for the physics engine.
// Walks segments in route order, computes overlap with the slice, weights
// each segment's grade by overlap length, returns weighted mean.
//
// Hot path: under CC#7 this is called once per second of plan generation
// (~10,800 calls per typical plan). Returns a plain number — structured
// result would force unwrap at every call site, which we can't afford here.
// Per CC#6 / CC#4, defensible-default behavior (no-coverage → 0) is paired
// with `fitWarn` for upstream debugging visibility.
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.7.

import { fitWarn } from './fitWarn.js';

// Module-level cache: track which segs arrays have already been validated
// for monotonic ordering. Avoids re-firing the warning per call.
// Stored as a WeakSet so GC reclaims when the plan changes.
const _validatedSegs = new WeakSet();

/**
 * @param {Array<{distM: number, gradeDecimal: number}>} segs
 *   Segments in route order. `distM` is segment length (not cumulative).
 * @param {number} startM   slice start in meters from route start
 * @param {number} endM     slice end in meters from route start
 * @returns {number}        distance-weighted average grade (decimal).
 *   Returns 0 when no segments overlap the slice.
 *
 * Edge cases:
 *  - Empty / null segs → 0 (defensible default)
 *  - Slice entirely outside route coverage → 0 + fitWarn('grade_coverage_gap')
 *  - startM > endM → 0 (no positive-length slice)
 *  - Bad segment ordering (negative distM) → fitWarn('grade_bad_segment_order')
 *    on first call per segs array; subsequent calls suppressed
 */
export function gradeForSlice(segs, startM, endM) {
  if (!segs || segs.length === 0) return 0;

  // One-time validation per segs array — bail-cheap if we've seen it.
  if (segs && typeof segs === 'object' && !_validatedSegs.has(segs)) {
    let bad = false;
    for (const s of segs) {
      if (!s || typeof s.distM !== 'number' || s.distM < 0) { bad = true; break; }
    }
    if (bad) {
      fitWarn('grade_bad_segment_order',
        'gradeForSlice received segments with non-monotonic / negative distM',
        { firstFew: segs.slice(0, 3) });
    }
    _validatedSegs.add(segs);
  }

  let cumM = 0, weightedGrade = 0, totalCovered = 0;
  let routeLen = 0;
  for (const seg of segs) {
    const segStart = cumM, segEnd = cumM + seg.distM;
    cumM += seg.distM;
    routeLen = cumM;
    if (segEnd <= startM) continue;
    if (segStart >= endM) break;
    const overlapStart = Math.max(segStart, startM);
    const overlapEnd   = Math.min(segEnd,   endM);
    const overlap = overlapEnd - overlapStart;
    weightedGrade += seg.gradeDecimal * overlap;
    totalCovered  += overlap;
  }

  if (totalCovered <= 0) {
    // Slice exceeds route coverage. 0 here means "outside route, treated as
    // flat" — physics behaves correctly; the warning surfaces upstream issues
    // for debugging.
    fitWarn('grade_coverage_gap',
      'gradeForSlice slice has no segment overlap',
      { startM, endM, routeLen });
    return 0;
  }
  return weightedGrade / totalCovered;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Single segment, full overlap:
//   gradeForSlice(
//     [{ distM: 1000, gradeDecimal: 0.05 }],
//     0, 500
//   )
//   → 0.05  (5% throughout the slice)
//
// Two segments, slice spans both:
//   gradeForSlice(
//     [{ distM: 500, gradeDecimal: 0.05 }, { distM: 500, gradeDecimal: 0.10 }],
//     0, 1000
//   )
//   // weighted: (0.05 * 500 + 0.10 * 500) / 1000 = 0.075
//   → 0.075
//
// Slice entirely within one segment:
//   gradeForSlice(
//     [{ distM: 1000, gradeDecimal: 0.03 }, { distM: 1000, gradeDecimal: 0.08 }],
//     1200, 1800
//   )
//   → 0.08  (slice falls inside segment 2)
//
// No coverage (slice past route end):
//   gradeForSlice([{ distM: 100, gradeDecimal: 0.04 }], 200, 300)
//   → 0  + fitWarn('grade_coverage_gap', ...)
//
// Empty / null:
//   gradeForSlice([], 0, 100)     → 0
//   gradeForSlice(null, 0, 100)   → 0

export default gradeForSlice;
