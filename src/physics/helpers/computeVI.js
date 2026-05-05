// Two-component Variability Index (VI) correction for flat-road duration
// estimates. Combines a grade-based component (vert per km from GPX) with a
// terrain-based component (weighted surface roughness) to produce an
// adjusted duration plus a ±5% uncertainty band.
//
// Validated against Barry-Roubaix 2026 FIT data — see Decision Log.
//
// **Status (per spec 3.9):** function is slated for CONDITIONAL DELETION
// after CC#7 lands and Step 6 validation completes (Prompt 4 scope). The
// grade component becomes mathematically redundant once `buildPowerStream`
// natively integrates per-second grade-aware physics. Until validation
// confirms this is safe, the function stays.
//
// Per spec 3.9 for this prompt: magic numbers lifted to named constants,
// behavior otherwise unchanged. Function never returned `null` historically;
// the spec's "null returns preserved" instruction is moot for this function
// (always returns an object).

import { SURFACES } from '../constants/referenceData.js';

// ── Tuning constants per CC#5 ────────────────────────────────────────────
// Calibrated against Barry-Roubaix 2026 FIT data; see Decision Log.
//   VI_grade   = VI_GRADE_BASE + VI_GRADE_PER_VERT_PER_KM_HUNDRED × (vertPerKm / 100)
//                Slope: 28.1 m/km vert → +0.030 above base, matching literature
//   VI_terrain = weighted SURFACES.viOffset × pct/100, summed
//   VI_total   = VI_grade + VI_terrain  (additive — see CC#3 of spec)
const VI_GRADE_BASE                       = 1.020;
const VI_GRADE_PER_VERT_PER_KM_HUNDRED    = 0.107;
const VI_UNCERTAINTY_BAND                 = 0.05; // ±5%

/**
 * @param {{ totalDistKm: number, elevGainM?: number, elevLossM?: number }} gpxStats
 * @param {Array<{ id: string, pct: number }>} surfaceMix
 * @param {number} physicsEstimateDurationMin   flat-road estimate to correct
 * @returns {{
 *   viGrade: number, viTerrain: number, viTotal: number,
 *   correctedDurationMin: number, durationLoMin: number, durationHiMin: number
 * }}
 *
 * Edge cases:
 *  - Missing elevGain/elevLoss → treated as 0 (rolling-flat assumption)
 *  - Empty surfaceMix → viTerrain = 0 (no terrain contribution)
 *  - Unknown surface id in mix → contributes 0 (silent — matches legacy
 *    behavior; spec's tighter-error variant of `blendedCrr` doesn't apply
 *    here because computeVI is being deleted in Prompt 4 anyway)
 */
export function computeVI(gpxStats, surfaceMix, physicsEstimateDurationMin) {
  const totalVertM  = (gpxStats.elevGainM ?? 0) + (gpxStats.elevLossM ?? 0);
  const totalDistKm = gpxStats.totalDistKm ?? 1;
  const vertPerKm   = totalVertM / totalDistKm;

  const viGrade = VI_GRADE_BASE + VI_GRADE_PER_VERT_PER_KM_HUNDRED * (vertPerKm / 100);

  const viTerrain = (surfaceMix ?? []).reduce((sum, s) => {
    const surf = SURFACES.find(x => x.id === s.id);
    return sum + (surf?.viOffset ?? 0) * (s.pct / 100);
  }, 0);

  const viTotal = viGrade + viTerrain;
  const correctedDurationMin = physicsEstimateDurationMin * viTotal;
  const durationLoMin = physicsEstimateDurationMin * viTotal * (1 - VI_UNCERTAINTY_BAND);
  const durationHiMin = physicsEstimateDurationMin * viTotal * (1 + VI_UNCERTAINTY_BAND);

  return {
    viGrade:               Math.round(viGrade   * 1000) / 1000,
    viTerrain:             Math.round(viTerrain * 1000) / 1000,
    viTotal:               Math.round(viTotal   * 1000) / 1000,
    correctedDurationMin:  Math.round(correctedDurationMin),
    durationLoMin:         Math.round(durationLoMin),
    durationHiMin:         Math.round(durationHiMin),
  };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Flat course, all tarmac, 240 min flat estimate:
//   computeVI({ totalDistKm: 100, elevGainM: 0, elevLossM: 0 },
//             [{ id: 'tarmac', pct: 100 }], 240)
//   → viGrade = 1.020, viTerrain = 0, viTotal = 1.020
//   → correctedDurationMin ≈ 245
//
// Hilly gravel (Barry-Roubaix-ish): 100 km, 1500 m gain/loss, 50/50 tarmac+L2 gravel:
//   computeVI({ totalDistKm: 100, elevGainM: 1500, elevLossM: 1500 },
//             [{ id: 'tarmac', pct: 50 }, { id: 'gravel_2', pct: 50 }], 240)
//   → viGrade ≈ 1.052, viTerrain = 0.028, viTotal ≈ 1.080
//   → correctedDurationMin ≈ 259

export default computeVI;
