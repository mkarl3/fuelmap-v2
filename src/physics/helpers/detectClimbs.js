// Walk a GPX route's segment grades and group consecutive ≥3% segments into
// named climbs. Returns each climb with avg grade, peak grade, length, gain,
// and category — the shared definition of "where the climbs are" that every
// downstream system (power capping, W'bal projection, per-climb stats,
// climb narrative) operates on.
//
// Per spec 3.8 target state changes from legacy:
//  • Categorization via the new `climbCategory(climbStats)` from physics
//    module (spec 2.6 split). Considers BOTH avg and peak grade — fixes the
//    S3 climb-count display bug where 5%-avg climbs with 11% pinches were
//    labeled "moderate."
//  • `peakGrade` → `peakGradePct` field rename (spec 2.6 split canonical name).
//  • Magic numbers lifted to named constants (CC#5).
//  • New: `MIN_CLIMB_LENGTH_M = 200` filter — discards micro-bumps that
//    don't deserve a "climb" label or per-climb pacing entry.
//  • Climb merging logic preserved — gap tolerance handles long climbs with
//    brief flat sections in the middle.
//  • CC#7 boundary documented: this function operates on **GPX segments**
//    (~50–100m each, native route geometry), NOT the 1-second resampled
//    stream. Climb detection is route topology, not metric calculation.
//    Running it on 1-sec data would produce noise.

import { climbCategory } from './climbCategory.js';

// ── Tuning constants per CC#5 ────────────────────────────────────────────
const CLIMB_GRADE_THRESHOLD       = 0.03; // 3% — below this is rolling, not climbing
const CLIMB_GAP_TOLERANCE_BLOCKS  = 2;    // empirical — long climbs with brief rollers stay one climb
const MIN_CLIMB_LENGTH_M          = 200;  // micro-bump filter; <200m sections won't be labeled climbs

/**
 * @param {{
 *   totalDistKm: number,
 *   segmentGrades: Array<{ distM: number, gradeDecimal: number }>
 * }} gpxStats
 * @returns {Array<{
 *   id: number,
 *   startDistKm: number,
 *   lengthKm: number,
 *   avgGrade: number,        // % grade (0–25)
 *   peakGradePct: number,    // % grade (0–25) — NEW canonical name
 *   gainM: number,
 *   category: 'moderate' | 'steep' | 'wall',
 *   startDistFrac: number,
 *   endDistFrac: number,
 * }>}
 */
export function detectClimbs(gpxStats) {
  if (!gpxStats?.segmentGrades || gpxStats.segmentGrades.length === 0) return [];
  const segs = gpxStats.segmentGrades;
  const totalDistM = gpxStats.totalDistKm * 1000;

  const climbs = [];
  let inClimb = false;
  let gapCount = 0;
  let climbBlocks = []; // { gradeDecimal, distM, startM }
  let cumM = 0;

  const flush = () => {
    if (climbBlocks.length === 0) return;
    // Trim trailing gap (sub-threshold) blocks.
    while (climbBlocks.length > 0
        && climbBlocks[climbBlocks.length - 1].gradeDecimal < CLIMB_GRADE_THRESHOLD) {
      climbBlocks.pop();
    }
    if (climbBlocks.length === 0) return;

    const startM  = climbBlocks[0].startM;
    const lengthM = climbBlocks.reduce((s, b) => s + b.distM, 0);

    // Apply minimum-length filter — skip micro-bumps entirely.
    if (lengthM < MIN_CLIMB_LENGTH_M) return;

    const avgGrade  = climbBlocks.reduce((s, b) => s + b.gradeDecimal * b.distM, 0) / lengthM;
    const peakGrade = Math.max(...climbBlocks.map(b => b.gradeDecimal));
    const gainM     = climbBlocks.reduce((s, b) => s + Math.max(0, b.gradeDecimal * b.distM), 0);

    const avgGradePct  = Math.round(avgGrade  * 1000) / 10;
    const peakGradePct = Math.round(peakGrade * 1000) / 10;

    // New climbCategory(climbStats) considers BOTH avg and peak.
    const category = climbCategory({ avgGradePct, peakGradePct, lengthM });

    climbs.push({
      id:           climbs.length + 1,
      startDistKm:  Math.round(startM / 100) / 10,
      lengthKm:     Math.round(lengthM / 100) / 10,
      avgGrade:     avgGradePct,
      peakGradePct,
      gainM:        Math.round(gainM),
      category,
      startDistFrac: startM / totalDistM,
      endDistFrac:   Math.min(1, (startM + lengthM) / totalDistM),
    });
  };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isClimbing = seg.gradeDecimal >= CLIMB_GRADE_THRESHOLD;
    if (isClimbing) {
      if (!inClimb) { inClimb = true; gapCount = 0; climbBlocks = []; }
      gapCount = 0;
      climbBlocks.push({ gradeDecimal: seg.gradeDecimal, distM: seg.distM, startM: cumM });
    } else if (inClimb) {
      gapCount++;
      climbBlocks.push({ gradeDecimal: seg.gradeDecimal, distM: seg.distM, startM: cumM });
      if (gapCount > CLIMB_GAP_TOLERANCE_BLOCKS) {
        flush();
        inClimb = false; gapCount = 0; climbBlocks = [];
      }
    }
    cumM += seg.distM;
  }
  if (inClimb) flush();
  return climbs;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Single 1-km, 5% climb (200m segments × 5):
//   const segs = Array(5).fill({ distM: 200, gradeDecimal: 0.05 });
//   detectClimbs({ totalDistKm: 1, segmentGrades: segs })
//   → 1 climb, avgGrade ≈ 5, peakGradePct ≈ 5, lengthKm = 1, category 'moderate'
//
// Climb with a sharp pinch (4% avg, 11% peak):
//   const segs = [
//     { distM: 200, gradeDecimal: 0.04 }, { distM: 200, gradeDecimal: 0.04 },
//     { distM: 200, gradeDecimal: 0.11 },                          // pinch
//     { distM: 200, gradeDecimal: 0.04 }, { distM: 200, gradeDecimal: 0.04 },
//   ];
//   detectClimbs({ totalDistKm: 1, segmentGrades: segs })
//   → 1 climb, avgGradePct ≈ 5.4, peakGradePct ≈ 11, category 'wall' (peak ≥ 10)
//   This is the S3 bug fix: legacy categorized as 'moderate' on avg alone.
//
// Micro-bump below MIN_CLIMB_LENGTH_M:
//   detectClimbs({ totalDistKm: 0.1, segmentGrades: [{ distM: 100, gradeDecimal: 0.05 }] })
//   → []  (filtered — single 100m segment is below 200m threshold)
//
// Empty:
//   detectClimbs({ totalDistKm: 1, segmentGrades: [] })  → []
//   detectClimbs(null)                                    → []
//   detectClimbs({})                                      → []

export default detectClimbs;
