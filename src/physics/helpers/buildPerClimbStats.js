// Per-climb actual ride statistics — NP, avg power, % FTP, W'bal at exit —
// for every climb detected by `detectClimbs`.
//
// **CC#8 (Prompt 4B Step 5):** climb attribution model migrated from the
// legacy single-point `gpxOffsetM` constant offset to per-second
// `alignFitToGpx` alignment. Each FIT moving second is mapped onto the GPX
// route by nearest-neighbor GPS; off-route seconds are excluded from climb
// membership rather than smeared across the planned route. The legacy
// constant-offset model broke whenever the rider deviated from the route
// (closed roads, course changes, off-course detours).
//
// Per spec 3.7 target state changes from legacy:
//  • NP routes through canonical `computeNP` (CC#1) — eliminates one of the
//    duplicated NP sites from the cross-cutting audit.
//  • 20-second filter lifted to named constant `MIN_CLIMB_SECONDS_FOR_STATS`.
//  • Climbs with 0 FIT data → null (filtered out by caller) + fitWarn.
//  • Field rename: `peakGrade` → `peakGradePct` (spec 2.6 split).
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
 * @param {number[]} movingDistSeries  per-second distance delta (m) — used
 *   only as a legacy fallback when `alignment` is unavailable
 * @param {object | null} actualWbalRaw output of buildWbalFromRawSeries
 * @param {number} ftp
 * @param {Array<{onRoute: boolean, gpxDistM: number | null, fitDistM: number}> | null} alignment
 *   Per-moving-second alignment from `alignFitToGpx` (CC#8). Length must
 *   match `movingPowerSeries` length. When provided, climb membership is
 *   determined by `alignment[i].gpxDistM` (with on-route filter); off-route
 *   seconds are excluded.
 *   When null/missing (legacy save without movingGPSPath, or no _gpxPts on
 *   the GPX route), falls back to cumulative-FIT-distance attribution with
 *   zero offset — same shape as the constant-offset model with offset=0,
 *   which is incorrect on most real rides but the only thing we can do
 *   without GPS data. fitWarn fires so the caller can surface the issue.
 * @returns {Array<{
 *   climbId, category, startDistKm, lengthKm, avgGrade, peakGradePct,
 *   np, avgP, pctFTP, wbalPctAtExit, secondsInClimb,
 * }>}
 *   Climbs with < MIN_CLIMB_SECONDS_FOR_STATS seconds of FIT data are
 *   filtered out. fitWarn fires for each filtered climb so missing-data
 *   issues are visible during debugging.
 */
export function buildPerClimbStats(climbs, movingPowerSeries, movingDistSeries,
                                    actualWbalRaw, ftp, alignment = null) {
  if (!climbs?.length || !movingPowerSeries?.length || !movingDistSeries?.length) return [];

  const n = movingPowerSeries.length;
  const hasAlignment = Array.isArray(alignment) && alignment.length === n;

  // Per-second GPX distance lookup. Two paths:
  //   (1) CC#8 alignment available → on-route seconds map via alignment[i].gpxDistM,
  //       off-route seconds get NaN (excluded from climb membership).
  //   (2) Legacy fallback → cumulative-FIT-distance with zero offset. Imperfect
  //       (rider's FIT 0m may not be route 0m) but matches the prior behavior
  //       when neither alignment nor _gpxPts were available.
  const gpxDistAtSec = new Float64Array(n);
  if (hasAlignment) {
    for (let i = 0; i < n; i++) {
      const a = alignment[i];
      gpxDistAtSec[i] = (a && a.onRoute && a.gpxDistM != null) ? a.gpxDistM : NaN;
    }
  } else {
    fitWarn('per_climb_no_alignment',
      'buildPerClimbStats called without alignment — using zero-offset cumulative FIT distance fallback',
      { climbCount: climbs.length });
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += movingDistSeries[i] || 0;
      gpxDistAtSec[i] = acc;
    }
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

    // Collect power seconds within this climb's distance window. Off-route
    // seconds (gpxDistAtSec[i] === NaN) are excluded — NaN comparisons are
    // false on both sides of the window, so they fall through naturally.
    //
    // B-20: avg and NP both consume the same series (zeros included =
    // Convention C). Pre-fix, `powersForAvg` filtered `p > 0` while
    // `powersForNP` did not — produced avg > NP scenarios on FIT data with
    // coasting (observed on PP climb 1: act avg 379 > act NP 271). The
    // variance-penalty inequality avg ≤ NP must hold per Decision_Log.md.
    const powersInClimb = [];
    let lastSecInClimb = -1;
    for (let i = 0; i < n; i++) {
      const d = gpxDistAtSec[i];
      if (d >= startM && d <= endM) {
        powersInClimb.push(movingPowerSeries[i]);
        lastSecInClimb = i;
      }
    }

    const secondsInClimb = powersInClimb.length;
    if (secondsInClimb === 0) {
      fitWarn('climb_no_fit_data',
        `Climb #${climb.id} at ${climb.startDistKm}km has no FIT data`,
        { climbId: climb.id });
      return null;
    }

    const np     = computeNP(powersInClimb);
    // avg must be ≤ NP per Convention C (Decision_Log.md).
    const avgP   = Math.round(powersInClimb.reduce((s, p) => s + p, 0) / secondsInClimb);
    const pctFTP = ftp > 0 && np > 0 ? Math.round(np / ftp * 100) : 0;
    const wbalPctAtExit = lastSecInClimb >= 0 ? wbalAtSec(lastSecInClimb) : null;

    return {
      climbId:      climb.id,
      category:     climb.category,
      startDistKm:  climb.startDistKm,
      lengthKm:     climb.lengthKm,
      avgGrade:     climb.avgGrade,
      peakGradePct: climb.peakGradePct ?? climb.peakGrade ?? 0,
      np, avgP, pctFTP,
      wbalPctAtExit,
      secondsInClimb,
    };
  }).filter(c => c !== null && c.secondsInClimb >= MIN_CLIMB_SECONDS_FOR_STATS);
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// CC#8 — alignment-driven attribution. Two synthetic climbs at distinct route
// distances; FIT has 60s of valid GPS, all on-route around climb #1's window:
//   const climbs = [
//     { id: 1, category: 'moderate', startDistKm: 0.5, lengthKm: 1, avgGrade: 5, peakGradePct: 7 },
//     { id: 2, category: 'steep',    startDistKm: 100, lengthKm: 1, avgGrade: 8, peakGradePct: 12 },
//   ];
//   const power = Array(60).fill(250);
//   const dist  = Array(60).fill(1);
//   const alignment = power.map((_, i) => ({
//     onRoute: true, gpxDistM: 500 + i * 16, fitDistM: i * 1,   // sweeps 500–1444 m
//   }));
//   buildPerClimbStats(climbs, power, dist, null, 250, alignment)
//   → [ { climbId: 1, np: 250, avgP: 250, pctFTP: 100, secondsInClimb: ~31, ... } ]
//   → climb 2 filtered out (no FIT seconds at 100 km)
//
// Off-route filtering: half of FIT seconds are off-route — those should be
// excluded from climb membership:
//   const alignment2 = power.map((_, i) => ({
//     onRoute: i % 2 === 0, gpxDistM: i % 2 === 0 ? 500 + i * 16 : null, fitDistM: i,
//   }));
//   → climb 1 secondsInClimb halves vs the all-on-route case.
//
// Legacy fallback (no alignment): falls back to cumulative-FIT-distance
// attribution with offset 0. Fires per_climb_no_alignment warn:
//   buildPerClimbStats(climbs, power, dist, null, 250)
//   → climb 1 found at 0.5–1.5 km; climb 2 still missing.

export default buildPerClimbStats;
