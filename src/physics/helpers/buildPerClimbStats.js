// Per-climb actual ride statistics — NP, avg power, % FTP, W'bal at exit —
// for every climb detected by `detectClimbs`.
//
// Per spec 3.7 target state changes from legacy:
//  • NP routes through canonical `computeNP` (CC#1) — eliminates one of the
//    duplicated NP sites from the cross-cutting audit.
//  • 20-second filter lifted to named constant `MIN_CLIMB_SECONDS_FOR_STATS`.
//  • Climbs with 0 FIT data → null (filtered out by caller) + fitWarn.
//  • Field rename: `peakGrade` → `peakGradePct` (spec 2.6 split).
//
// **Climb attribution model:** legacy `gpxOffsetM` single-point offset
// preserved. CC#8 (per-second GPS alignment via `alignFitToGpx`) lands in
// Prompt 4 — for now the constant-offset assumption holds. `alignFitToGpx`
// is exported from the physics module but not yet consumed here.
//
// **Performance:** linear scan retained per spec. Profile in Step 6 if
// measured slow before adding binary search / spatial index.

import { computeNP } from './computeNP.js';
import { fitWarn }   from './fitWarn.js';

// Must exceed `computeNP`'s 30-second rolling window — below that, NP is
// mathematically meaningless. Not user-configurable; this is a math
// constraint, not a tuning choice.
const MIN_CLIMB_SECONDS_FOR_STATS = 20;

/**
 * @param {Array<{
 *   id: number, category: string,
 *   startDistKm: number, lengthKm: number,
 *   avgGrade: number, peakGradePct: number
 * }>} climbs
 *   `detectClimbs` output. Per spec 2.6 split, the field is `peakGradePct`
 *   (% grade). Legacy `peakGrade` is read as a fallback for backward-compat
 *   with any in-flight migration; once detectClimbs is fully migrated, the
 *   fallback can be removed.
 * @param {number[]} movingPowerSeries
 * @param {number[]} movingDistSeries  per-second distance delta (m)
 * @param {object | null} actualWbalRaw output of buildWbalFromRawSeries
 * @param {number} ftp
 * @param {number} [gpxOffsetM=0]      legacy single-point offset model
 * @returns {Array<{
 *   climbId, category, startDistKm, lengthKm, avgGrade, peakGradePct,
 *   np, avgP, pctFTP, wbalPctAtExit, secondsInClimb,
 * }>}
 *   Climbs with < MIN_CLIMB_SECONDS_FOR_STATS seconds of FIT data are
 *   filtered out. fitWarn fires for each filtered climb so missing-data
 *   issues are visible during debugging.
 */
export function buildPerClimbStats(climbs, movingPowerSeries, movingDistSeries,
                                    actualWbalRaw, ftp, gpxOffsetM = 0) {
  if (!climbs?.length || !movingPowerSeries?.length || !movingDistSeries?.length) return [];

  // Build cumulative-distance array from per-second deltas, offset-adjusted
  // so it starts at gpxOffsetM (matching terrain stream coordinate frame).
  const cumDist = new Float32Array(movingDistSeries.length);
  let acc = gpxOffsetM;
  for (let i = 0; i < movingDistSeries.length; i++) {
    acc += movingDistSeries[i];
    cumDist[i] = acc;
  }

  // Per-second W'bal interpolated from 1-min chartData.
  const wbalChart = actualWbalRaw?.chartData ?? [];
  const wbalAtSec = (secIdx) => {
    if (!wbalChart.length) return null;
    const minuteIdx = secIdx / 60;
    const lo = Math.floor(minuteIdx);
    const hi = Math.ceil(minuteIdx);
    if (lo >= wbalChart.length) return wbalChart[wbalChart.length - 1].wbalPct;
    if (hi >= wbalChart.length) return wbalChart[lo].wbalPct;
    const t = minuteIdx - lo;
    return Math.round(wbalChart[lo].wbalPct * (1 - t) + wbalChart[hi].wbalPct * t);
  };

  return climbs.map(climb => {
    const startM = climb.startDistKm * 1000;
    const endM   = startM + climb.lengthKm * 1000;

    // Collect power seconds within this climb's distance window.
    // For computeNP we need the FULL contiguous slice (zeros included) so
    // the 30-second rolling window operates on real time. The legacy
    // implementation filtered zeros before computing NP, which is wrong
    // for the rolling-window method per CC#1 — we don't replicate that.
    const powersForNP = [];
    const powersForAvg = []; // exclude zeros to match user expectation of "avg"
    let lastSecInClimb = -1;
    for (let i = 0; i < cumDist.length; i++) {
      if (cumDist[i] >= startM && cumDist[i] <= endM) {
        const p = movingPowerSeries[i];
        powersForNP.push(p);
        if (p > 0) powersForAvg.push(p);
        lastSecInClimb = i;
      }
    }

    const secondsInClimb = powersForAvg.length;
    if (powersForNP.length === 0) {
      fitWarn('climb_no_fit_data',
        `Climb #${climb.id} at ${climb.startDistKm}km has no FIT data`,
        { climbId: climb.id });
      return null;
    }

    const np     = computeNP(powersForNP);
    const avgP   = secondsInClimb ? Math.round(powersForAvg.reduce((s, p) => s + p, 0) / secondsInClimb) : 0;
    const pctFTP = ftp > 0 && np > 0 ? Math.round(np / ftp * 100) : 0;
    const wbalPctAtExit = lastSecInClimb >= 0 ? wbalAtSec(lastSecInClimb) : null;

    return {
      climbId:      climb.id,
      category:     climb.category,
      startDistKm:  climb.startDistKm,
      lengthKm:     climb.lengthKm,
      avgGrade:     climb.avgGrade,
      peakGradePct: climb.peakGradePct ?? climb.peakGrade ?? 0, // accept either field during migration
      np, avgP, pctFTP,
      wbalPctAtExit,
      secondsInClimb,
    };
  }).filter(c => c !== null && c.secondsInClimb >= MIN_CLIMB_SECONDS_FOR_STATS);
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Two synthetic climbs, one with valid FIT data, one with none:
//   const climbs = [
//     { id: 1, category: 'moderate', startDistKm: 0, lengthKm: 1, avgGrade: 5, peakGradePct: 7 },
//     { id: 2, category: 'steep',    startDistKm: 100, lengthKm: 1, avgGrade: 8, peakGradePct: 12 },
//   ];
//   60 seconds × 1m/s = 60m, can't reach the second climb at 100km.
//   buildPerClimbStats(climbs, Array(60).fill(250), Array(60).fill(1), null, 250)
//   → [ { climbId: 1, np: 250, avgP: 250, pctFTP: 100, secondsInClimb: 60, ... } ]
//   → climb 2 filtered out (no FIT data — fires climb_no_fit_data warning)

export default buildPerClimbStats;
