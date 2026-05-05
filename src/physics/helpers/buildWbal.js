// PLAN-side W'bal time series. Thin wrapper around `simulateWbal`.
//
// Per spec 3.5 target state changes from legacy:
//  • Skiba math extracted to `simulateWbal` (CC#3) — single source of truth.
//  • dt parameterized (`options.blockSeconds`, defaults to 60). Under CC#7
//    (Prompt 4B Step 2), PLAN side passes dt=1 alongside `powerStreamPerSec`,
//    matching ANALYZE side. Caller selects:
//      • `buildWbal(plan.powerStreamPerSec, athlete, { blockSeconds: 1 })`
//        — preferred path; CC#7 canonical (1-sec, matches device numbers).
//      • `buildWbal(plan.powerStream, athlete)` — fallback for legacy plans
//        saved before CC#7 landed (no `powerStreamPerSec` field on disk).
//        Uses dt=60 over 1-min blocks; sub-1% drift vs canonical, acceptable
//        for older saves until they're recomputed on next plan edit.
//  • CP source dispatch: when athlete has CP test data, both CP and W' come
//    from `fitCPModel`. Otherwise both fall back to FTP-based defaults.
//    Mixing fitted CP with FTP-derived W' (or vice versa) is forbidden by
//    the data-integrity constraint (spec 3.5 #4).
//
// **Behavior shift (microscopic):** legacy code branched on `power >= CP`
// (depletion) while `simulateWbal` branches on `power > CP`. At exactly
// power == CP, the legacy depletes by 0 (no-op); the new code recovers
// by tau toward wPrime. Numerical drift is sub-1% in real-world data.

import { simulateWbal } from './simulateWbal.js';
import { fitCPModel }   from './fitCPModel.js';
import { deriveWPrime } from './deriveWPrime.js';

/**
 * @param {Array<{ power: number }>} powerStream
 *   Plan blocks. Each block contributes one timestep of `simulateWbal` math.
 *   Other fields (time, grade, distKm, etc.) are spread through to the output
 *   to preserve legacy chart consumer expectations.
 * @param {{ ftp: number, cpTests?: Array, phenotype?: string }} athlete
 * @param {{ blockSeconds?: number }} [options]
 *   blockSeconds: dt for `simulateWbal`. Default 60 (legacy 1-min blocks).
 *   Under CC#7 (Prompt 4), PLAN side flips to 1.
 * @returns {Array<object>}
 *   Each block, augmented with `wbal` (J, rounded) and `wbalPct` (% of W',
 *   rounded). Empty input → empty array.
 */
export function buildWbal(powerStream, athlete, options) {
  if (!powerStream || powerStream.length === 0) return [];

  const blockSeconds = options?.blockSeconds ?? 60;

  // CP/W' source dispatch — data integrity per spec 3.5 #4.
  // Both come from the same source: fitted (when CP tests available) OR
  // FTP-based defaults (otherwise). No mixing.
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

  if (!(cp > 0) || !(wPrime > 0)) return powerStream.map(pt => ({ ...pt, wbal: 0, wbalPct: 0 }));

  const powers = powerStream.map(pt => pt.power);
  const wbalSeries = simulateWbal(powers, blockSeconds, cp, wPrime);

  return powerStream.map((pt, i) => ({
    ...pt,
    wbal:    Math.round(wbalSeries[i]),
    // 4B.5: float, not rounded. Per-second W' changes are often <1%/sec; integer
    // rounding here aliased ~5–20 consecutive samples to the same y-value and
    // produced a Y-axis staircase on the PLAN-side chart once CC#7 routed
    // per-second data through. Display sites round; comparison sites (`<= 20`,
    // `<= 40`) work identically on float.
    wbalPct: (wbalSeries[i] / wPrime) * 100,
  }));
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Constant 200W, CP=250 → W' holds steady (start full, stays full):
//   buildWbal([{power:200},{power:200},{power:200}],
//             { ftp: 250 })
//   → 3 entries; wbal stays at wPrime, wbalPct = 100
//
// Constant 300W, CP=250, dt=60 → depletes 50 J/s × 60 = 3000 J/block:
//   buildWbal([{power:300},{power:300},{power:300}],
//             { ftp: 250 })
//   → wbal: 18750-3000 = 15750, then 12750, then 9750 (assuming wPrime=18750)
//   → wbalPct: 84, 68, 52 (approx)
//
// Empty:
//   buildWbal([], { ftp: 250 })  → []
//
// Athlete with CP test data — CP comes from fit, not FTP:
//   buildWbal(stream,
//             { ftp: 250, cpTests: [{secs:180, watts:300}, {secs:720, watts:250}] })
//   → uses cp=233 (fitted) and wPrime=12000 (fitted), not FTP/derived

export default buildWbal;
