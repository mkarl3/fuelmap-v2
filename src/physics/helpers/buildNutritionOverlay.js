// PLAN-side and ANALYZE-side glycogen / intake overlay.
//
// For each block in the input stream, computes:
//   • Carb burn rate (from `carbOxidationRate` against block power)
//   • Per-block scheduled intake from intake events (windowed per liquid/solid)
//   • Gut-pool carry-over and absorption (B-27)
//   • Updated glycogen reserve and reserve %
//
// **Block resolution principle (4C):** function is parameterized on
// `blockMinutes`; all time-dependent internal constants scale with it.
// Both PLAN and ANALYZE callers pass `blockMinutes=1` post-rebuild.
//
// **B-27 gut-pool model:** carbs scheduled above the per-block absorption
// cap accumulate in a running gut pool and absorb on subsequent blocks until
// the pool empties. Excess above GUT_POOL_CAPACITY_G is rejected (body
// physiologically rejected — GI distress / regurgitation) rather than carried
// forward. Replaces the pre-B-27 silent-drop model. Conservation invariant:
//   sum(intake events) ≈ sum(actualAbsorbed) + final gutPool + sum(overLimit)
//
// **B-28 liquid vs solid windows:** each intake event picks its absorption
// window based on its `isLiquid` flag — solids deliver into the gut over
// ~20 min (gels, chews, bars consumed in seconds); liquids over ~60 min
// (bottles, drink mixes sipped over time). Legacy events without the field
// default to solid for backward compatibility.

import { carbOxidationRate } from './carbOxidationRate.js';
import { startingGlycogen }  from './startingGlycogen.js';

/**
 * @param {Array<{ power: number, time: number }>} stream
 *   Per-block plan or actual power data. Time is in minutes (block boundary).
 * @param {Array<{ time: number, carbs: number, isLiquid?: boolean }>} intakeEvents
 *   In-ride fuel events. Snapshotted from product picks (B-28 snapshots
 *   isLiquid alongside name/carbs/sodium).
 * @param {{ weight: number, ftp: number }} athlete
 * @param {number} glycogenScale
 *   Multiplier on weight-based starting glycogen. Caller derives from
 *   `fuelingScale(preRaceFuelingId)`.
 * @param {number} [blockMinutes=1]
 *   Minutes per block in `stream`. PLAN and ANALYZE both pass 1 post-rebuild.
 * @returns {Array<object>}
 *   Each block, augmented with nutrition fields:
 *     burnRate (g/hr), glycogenReserve (g), reservePct (% of maxGlycogen),
 *     gutPool (g), intakeRate (g/hr absorbed), intake (g ingested in this
 *     block), actualAbsorbed (g absorbed in this block), overLimit (g rejected
 *     this block due to gut capacity overflow).
 */
export function buildNutritionOverlay(stream, intakeEvents, athlete, glycogenScale, blockMinutes = 1) {
  if (!stream || stream.length === 0) return [];
  let glycogenReserve = Math.round(startingGlycogen(athlete.weight) * glycogenScale);
  const maxGlycogen = startingGlycogen(athlete.weight) * 1.15;
  const MAX_ABSORPTION = 90; // g/hr max intestinal absorption
  // B-28: per-product absorption windows. Solids (gels/chews/bars/food) are
  // consumed in seconds and fully delivered into the gut over ~20 min. Liquids
  // (bottles/drink mixes) are sipped over time and deliver carbs over ~60 min.
  const ABSORB_WINDOW_SOLID_MIN  = 20;
  const ABSORB_WINDOW_LIQUID_MIN = 60;
  // B-27: typical upper-bound gut tolerance. Carbs beyond this are physiologically
  // rejected (GI distress / nausea / regurgitation) rather than absorbed later.
  const GUT_POOL_CAPACITY_G = 150;

  // Build absQueue: per-block scheduled intake into the gut pool. Each event's
  // carbs are spread uniformly over `windowMin` of ride time, where windowMin
  // depends on the event's `isLiquid` flag. Events missing the flag (legacy
  // saves) default to solid (20 min) for backward compatibility.
  const absQueue = new Array(stream.length).fill(0);
  for (const e of intakeEvents) {
    const startBlock = stream.findIndex(pt => pt.time >= e.time);
    if (startBlock === -1) continue;
    const windowMin = e.isLiquid ? ABSORB_WINDOW_LIQUID_MIN : ABSORB_WINDOW_SOLID_MIN;
    const absorbBlocks = Math.max(1, Math.round(windowMin / blockMinutes));
    const gPerBlock = (e.carbs || 0) / absorbBlocks;
    for (let b = startBlock; b < Math.min(startBlock + absorbBlocks, stream.length); b++) {
      absQueue[b] += gPerBlock;
    }
  }

  // B-27: gut-pool model with carry-over. Per block:
  //   1. New scheduled intake adds to the gut pool.
  //   2. If the pool now exceeds GUT_POOL_CAPACITY_G, excess is rejected
  //      (recorded as `overLimit`, NOT carried forward).
  //   3. Absorb up to MAX_ABSORPTION × dt from what's in the pool; the rest
  //      stays in the pool and carries to the next block.
  //
  // `overLimit` semantic changed: previously "exceeded per-block absorption
  // cap" (silently dropped the per-block excess). Now: "exceeded gut pool
  // capacity" (body genuinely rejected the carbs because the gut was full).
  // Excess carbs that previously dropped silently now carry forward and
  // absorb on subsequent blocks. Conservation invariant:
  //   sum(intake events) ≈ sum(actualAbsorbed) + final gutPool + sum(overLimit)
  // (≈ because intake events landing within the absorption window of stream
  // end are partially un-scheduled — separate concern, deferred.)
  let gutPool = 0;

  return stream.map((pt, idx) => {
    const burnRate = carbOxidationRate(pt.power, athlete.ftp); // g/hr
    const burned = burnRate * (blockMinutes / 60); // g burned this block

    gutPool += absQueue[idx];

    // Cap-then-absorb order: if intake would overflow gut capacity, the excess
    // is rejected up front rather than absorbed and then expelled. Slightly
    // more conservative than absorb-then-cap; matches GI-tolerance intuition.
    const overLimit = Math.max(0, gutPool - GUT_POOL_CAPACITY_G);
    gutPool = Math.min(gutPool, GUT_POOL_CAPACITY_G);

    const maxAbsorbThisBlock = MAX_ABSORPTION * (blockMinutes / 60);
    const actualAbsorbed = Math.min(gutPool, maxAbsorbThisBlock);
    gutPool -= actualAbsorbed;

    // Point-in-time intake for reference markers (one block's window).
    const pointIntake = intakeEvents
      .filter(e => e.time >= pt.time && e.time < pt.time + blockMinutes)
      .reduce((s, e) => s + (e.carbs || 0), 0);

    glycogenReserve = Math.min(maxGlycogen, Math.max(0, glycogenReserve - burned + actualAbsorbed));

    return {
      ...pt,
      burnRate: Math.round(burnRate),
      glycogenReserve: Math.round(glycogenReserve),
      reservePct: Math.round((glycogenReserve / maxGlycogen) * 100),
      gutPool: Math.round(gutPool),
      intakeRate: Math.round(actualAbsorbed * (60 / blockMinutes)), // g/block → g/hr
      intake: Math.round(pointIntake),
      actualAbsorbed: Math.round(actualAbsorbed),
      overLimit: Math.round(overLimit),
    };
  });
}

export default buildNutritionOverlay;

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Single 60g intake (solid) at minute 30 in a 90-min stream at constant 200W
// (burn ~4 g/min), athlete weight 80kg, FTP 250, glycogenScale 0.92:
//   absQueue spreads 60g across blocks 30-49 (3 g/min for 20 min).
//   Pool builds at +1.5 g/min (3 in, 1.5 out) during blocks 30-49 → peak ~30g.
//   Blocks 50-69: pool drains at 1.5 g/min until empty.
//   Total absorbed: 60g ✓ (conservation holds).
//   No overLimit fires (peak pool 30g << 150g capacity).
//
// 80g liquid intake at minute 30: window = 60 min (vs 20 for solid).
//   gPerBlock = 80/60 = 1.33 g/min, BELOW the 1.5 g/min absorption cap.
//   Pool stays low (<2g) throughout; everything absorbs within the window.
//   No overLimit. Demonstrates the value of B-28's per-product windows.
//
// 4× 80g intakes at minutes 0, 15, 30, 45 (aggressive over-fueling):
//   Steady-state pool grows ~3.83 g/min after minute 30.
//   Pool crosses 50g around minute 38 → gut-backlog-sustained alert.
//   Pool eventually hits 150g cap → overLimit accumulates from that point on.
//
// Empty inputs:
//   buildNutritionOverlay([], [], { weight: 80, ftp: 250 }, 1.0)        → []
//   buildNutritionOverlay(stream, [], athlete, 1.0)                     → stream rows
//     with burned glycogen but zero intake (passive depletion baseline).
