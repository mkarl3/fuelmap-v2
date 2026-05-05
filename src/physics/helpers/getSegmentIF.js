// For "by_segment" pacing strategy, return the target IF for the rider's
// current progress along the route.
//
// Per spec 3.1 target state changes from legacy:
//  • Empty segments → bug indicator (CC#6) — caller responsible for falling
//    back to constant-IF strategy when no segments are provided.
//  • Field renamed: `lengthKm` (or implicit `endKm - startKm`) → `weight`.
//    Segments are relative weights, not absolute kilometers — the legacy
//    field names misled.
//  • Auto-normalize weights to proportions: `[10, 20, 10]` and `[1, 2, 1]`
//    produce identical fractions.
//
// **Backward-compat:** legacy segments persist with `{startKm, endKm}` shape
// in IndexedDB. The helper reads either:
//  • If `seg.weight` is a positive number, use it directly.
//  • Else if `seg.startKm` and `seg.endKm` are numbers, derive
//    `weight = endKm - startKm`.
//  • Else weight = 0 (after fitWarn).
//
// New saves should use `{ id, weight, targetIF }`. UI display still
// references `startKm/endKm` for now — segment-editor cleanup is a future
// prompt's scope.

import { fitWarn } from './fitWarn.js';

function resolveWeight(seg) {
  if (typeof seg.weight === 'number' && isFinite(seg.weight)) return seg.weight;
  // Legacy schema fallback.
  if (typeof seg.startKm === 'number' && typeof seg.endKm === 'number'
      && isFinite(seg.startKm) && isFinite(seg.endKm)) {
    return seg.endKm - seg.startKm;
  }
  return NaN;
}

/**
 * @param {Array<{ weight?: number, startKm?: number, endKm?: number, targetIF: number }>} segments
 * @param {number} progress    fractional progress along route (0.0 – 1.0)
 * @returns {number | { ok: false, reason: string }}
 *   On success: target IF for the segment containing `progress` (decimal).
 *   On empty input: { ok: false, reason: 'empty_segments' }.
 *
 * Edge cases:
 *  - segment with negative or NaN weight → fitWarn + treated as 0
 *  - all weights zero → returns the LAST segment's targetIF (defensible —
 *    progress can't fall in any of them)
 *  - progress > 1.0 → returns last segment's targetIF
 */
export function getSegmentIF(segments, progress) {
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return { ok: false, reason: 'empty_segments' };
  }

  // Resolve weights, validate, sum.
  const weights = segments.map(seg => {
    const w = resolveWeight(seg);
    if (!isFinite(w) || w < 0) {
      fitWarn('malformed_segment_weight',
        `getSegmentIF: segment weight invalid — treating as 0`,
        { seg });
      return 0;
    }
    return w;
  });
  const total = weights.reduce((s, w) => s + w, 0);

  if (total <= 0) {
    // No usable weights — return the last segment's targetIF as a defensible
    // default rather than blowing up. Caller is mid-edit or schema is corrupt.
    return segments[segments.length - 1].targetIF;
  }

  let cumPct = 0;
  for (let i = 0; i < segments.length; i++) {
    cumPct += weights[i] / total;
    if (progress <= cumPct) return segments[i].targetIF;
  }
  return segments[segments.length - 1].targetIF;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Two-segment, 30/70 weight split (new schema):
//   getSegmentIF([{weight:30, targetIF:0.72}, {weight:70, targetIF:0.85}], 0.2)
//   → 0.72  (in first segment, 0–30%)
//   getSegmentIF([{weight:30, targetIF:0.72}, {weight:70, targetIF:0.85}], 0.5)
//   → 0.85  (in second segment, 30–100%)
//
// Auto-normalize (relative weights):
//   getSegmentIF([{weight:1, targetIF:0.72},{weight:2, targetIF:0.85},{weight:1, targetIF:0.74}], 0.5)
//   → 0.85  (sum=4, fractions 25/50/25; 0.5 falls in middle)
//
// Legacy schema (startKm/endKm) — backward-compat:
//   getSegmentIF([{startKm:0,endKm:30,targetIF:0.72},{startKm:30,endKm:100,targetIF:0.85}], 0.5)
//   → 0.85  (derives weight=30, weight=70 from km diffs, same answer as above)
//
// Empty:
//   getSegmentIF([], 0.5)         → { ok: false, reason: 'empty_segments' }
//   getSegmentIF(null, 0.5)       → { ok: false, reason: 'empty_segments' }
//
// Negative weight (fires fitWarn, treated as 0):
//   getSegmentIF([{weight:-5, targetIF:0.50}, {weight:10, targetIF:0.85}], 0.5)
//   → 0.85

export default getSegmentIF;
