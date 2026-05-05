// ANALYZE-side W'bal time series. Thin wrapper around `simulateWbal`.
//
// Produces the W'bal series for an actual completed ride from raw 1-Hz FIT
// data. Drives the W'bal chart, per-climb W'bal-at-exit, and post-race
// narrative. The most sensitive analysis metric in the app — small changes
// here cascade into fade analysis, climb pacing, and alerts.
//
// Per spec 3.6 target state changes from legacy:
//  • Skiba math extracted to `simulateWbal` (CC#3) — single source of truth.
//  • dt=1 retained (ANALYZE was already at 1-second resolution).
//  • CP source dispatch: matches `buildWbal` — same data integrity rule.
//    Fitted CP/W' from `fitCPModel` when test data exists, FTP fallback
//    otherwise.
//  • Min/peak tracking preserved as a post-processing pass over
//    `simulateWbal` output (not interleaved with the math).
//  • Altitude downsampling: arithmetic mean → per-minute MAX. Preserves
//    climb peaks on the W'bal chart instead of smoothing them away.

import { simulateWbal } from './simulateWbal.js';
import { fitCPModel }   from './fitCPModel.js';
import { deriveWPrime } from './deriveWPrime.js';

const EMPTY_RESULT = { chartData: [], minWbal: null, minWbalTime: 0, peakBurnJ: 0, peakBurnTime: 0 };

/**
 * @param {number[]} movingPowerSeries  1-Hz power values, moving seconds only
 * @param {{ ftp: number, cpTests?: Array, phenotype?: string }} athlete
 * @param {(number|null|undefined)[]} [movingAltSeries]
 * @returns {{
 *   chartData: Array<{time, wbal, wbalPct, burnJ, burnKj, minPct, altM}>,
 *   minWbal: number, minWbalPct: number, minWbalTime: number,
 *   peakBurnJ: number, peakBurnTime: number,
 *   wPrime: number, hasAltitude: boolean,
 * }}
 *   Chart data is downsampled to 1-min resolution. Min/peak are per-second.
 */
export function buildWbalFromRawSeries(movingPowerSeries, athlete, movingAltSeries) {
  if (!movingPowerSeries || movingPowerSeries.length === 0) return EMPTY_RESULT;

  // CP/W' source dispatch — data integrity per spec 3.6 #3 (mirrors buildWbal).
  let cp, wPrime;
  const points = (athlete?.cpTests ?? [])
    .filter(t => t && t.secs > 0 && t.watts > 0)
    .map(t => ({ durationSec: t.secs, powerW: t.watts }));
  const fit = points.length >= 2 ? fitCPModel(points) : null;
  if (fit) {
    cp     = fit.cp;
    wPrime = fit.wPrime;
  } else {
    cp = athlete?.ftp ?? 0;
    const wFromFallback = deriveWPrime(athlete);
    wPrime = (wFromFallback && typeof wFromFallback === 'object' && wFromFallback.ok === false)
      ? 0
      : wFromFallback;
  }

  if (!(cp > 0) || !(wPrime > 0)) return { ...EMPTY_RESULT, wPrime: 0, hasAltitude: false };

  // ── Run core math ──────────────────────────────────────────────────
  const wbalSeries = simulateWbal(movingPowerSeries, 1, cp, wPrime);

  // ── Min / peak post-processing ─────────────────────────────────────
  let minWbal = wPrime, minWbalTime = 0;
  let peakBurnJ = 0, peakBurnTime = 0;
  let prevWbal = wPrime;
  for (let i = 0; i < wbalSeries.length; i++) {
    const w = wbalSeries[i];
    const burn = Math.max(0, prevWbal - w);
    if (w < minWbal)   { minWbal = w;   minWbalTime = i; }
    if (burn > peakBurnJ) { peakBurnJ = burn; peakBurnTime = i; }
    prevWbal = w;
  }

  // ── 1-min downsampled chartData ────────────────────────────────────
  // Altitude: per-minute MAX (per spec 3.6 #6 — preserves climb peaks).
  const minuteData = [];
  let minuteBurnJ = 0;
  let minuteMinWbal = wPrime;
  let minuteAltMax = -Infinity;
  let minuteAltSeen = false;
  let prevForBurn = wPrime;

  const altAt = (i) => {
    const a = movingAltSeries?.[i];
    return (a !== null && a !== undefined && isFinite(a)) ? a : null;
  };

  for (let i = 0; i < wbalSeries.length; i++) {
    const w = wbalSeries[i];
    const burn = Math.max(0, prevForBurn - w);
    minuteBurnJ += burn;
    if (w < minuteMinWbal) minuteMinWbal = w;
    const a = altAt(i);
    if (a !== null) { minuteAltSeen = true; if (a > minuteAltMax) minuteAltMax = a; }
    prevForBurn = w;

    const isMinuteBoundary = (i + 1) % 60 === 0 || i === wbalSeries.length - 1;
    if (isMinuteBoundary) {
      const timeMin = Math.round((i + 1) / 60);
      minuteData.push({
        time:    timeMin,
        wbal:    Math.round(w),
        wbalPct: Math.round(w / wPrime * 100),
        burnJ:   Math.round(minuteBurnJ),
        burnKj:  Math.round(minuteBurnJ / 100) / 10,
        minPct:  Math.round(minuteMinWbal / wPrime * 100),
        altM:    minuteAltSeen ? Math.round(minuteAltMax * 10) / 10 : null,
      });
      minuteBurnJ = 0;
      minuteMinWbal = w;
      minuteAltMax = -Infinity;
      minuteAltSeen = false;
    }
  }

  return {
    chartData:    minuteData,
    minWbal:      Math.round(minWbal),
    minWbalPct:   Math.round(minWbal / wPrime * 100),
    minWbalTime,
    peakBurnJ:    Math.round(peakBurnJ),
    peakBurnTime,
    wPrime,
    hasAltitude:  (movingAltSeries?.some(a => a !== null && a !== undefined)) ?? false,
  };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Constant 200W (below CP=250) → W' holds steady at wPrime:
//   buildWbalFromRawSeries([200,200,200], { ftp: 250 })
//   → minWbalPct = 100, peakBurnJ = 0, chartData has 1 entry at minute 0
//
// Constant 300W (50 J/s deficit) for 60 s:
//   buildWbalFromRawSeries(Array(60).fill(300), { ftp: 250 })
//   → minWbalPct ≈ 84% (3000 J burned from ~18750 J), chartData length 1
//
// Empty:
//   buildWbalFromRawSeries([], { ftp: 250 })   → EMPTY_RESULT shape
//
// Altitude per-minute max (key behavior change from legacy mean):
//   const alts = [];
//   for (let i = 0; i < 60; i++) alts.push(i < 30 ? 100 : 200);
//   const r = buildWbalFromRawSeries(Array(60).fill(200), {ftp:250}, alts);
//   → r.chartData[0].altM === 200  (NOT 150 mean)

export default buildWbalFromRawSeries;
