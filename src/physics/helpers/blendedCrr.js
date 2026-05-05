// Compute single Crr from surface mix weighted by route fraction.
//
// Per spec 2.3 target state:
//  • Empty mix → bug indicator (zero rolling resistance is unphysical and
//    would corrupt all downstream physics). Returns structured error per CC#6.
//  • Pct not summing to 100 → defensible default with auto-normalization.
//    Math gracefully handles non-normalized input by computing pct/sum*100;
//    `fitWarn('surface_pct_not_normalized')` fires if delta > 2% so users
//    notice mid-edit states without blocking.
//  • Unknown surface id → bug indicator. Silent fallback to 0.004 was
//    masking real bugs (typos, corrupted plans).
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.3.

import { SURFACES } from '../constants/referenceData.js';
import { DEFAULTS } from '../constants/defaults.js';
import { fitWarn }  from './fitWarn.js';

const NORMALIZATION_TOLERANCE_PCT = 2;

/**
 * @param {Array<{id: string, pct: number}>} mix
 * @param {number} [tireMult=1.0]
 * @returns {number | {ok: false, reason: string, detail?: any}}
 *   Success: blended Crr value.
 *   Failure modes:
 *    - Empty / null mix → { ok: false, reason: 'empty_surface_mix' }
 *    - Any unknown surface id → { ok: false, reason: 'unknown_surface_id', detail: <id> }
 *
 * Edge cases:
 *  - pct values are renormalized to sum to 100 — `[50, 25, 25]` and
 *    `[2, 1, 1]` produce identical Crr. Warning fires if input was
 *    materially non-normalized (> 2% off from 100%).
 *  - tireMult applies uniformly across all surfaces.
 */
export function blendedCrr(mix, tireMult = 1.0) {
  if (!mix || !Array.isArray(mix) || mix.length === 0) {
    return { ok: false, reason: 'empty_surface_mix' };
  }

  // Pre-flight: validate every id and capture sum for normalization.
  let pctSum = 0;
  for (const s of mix) {
    if (!s) continue;
    const surf = SURFACES.find(x => x.id === s.id);
    if (surf === undefined) {
      fitWarn('unknown_surface_id',
        `blendedCrr: id "${s?.id}" not in SURFACES table`,
        { id: s?.id });
      return { ok: false, reason: 'unknown_surface_id', detail: s?.id };
    }
    if (typeof s.pct === 'number' && s.pct > 0) pctSum += s.pct;
  }

  if (pctSum <= 0) {
    // All-zero pcts — degenerate. Treat as empty.
    return { ok: false, reason: 'empty_surface_mix' };
  }
  if (Math.abs(pctSum - 100) > NORMALIZATION_TOLERANCE_PCT) {
    fitWarn('surface_pct_not_normalized',
      `blendedCrr: pct sum is ${pctSum} (not 100); auto-normalizing`,
      { pctSum, mix });
  }

  // Auto-normalize. Each surface contributes (Crr × tireMult × pct/sum).
  let crr = 0;
  for (const s of mix) {
    if (!s || typeof s.pct !== 'number' || s.pct <= 0) continue;
    const surf = SURFACES.find(x => x.id === s.id); // already validated above
    crr += surf.Crr * tireMult * (s.pct / pctSum);
  }
  return crr;
}

/** Default Crr — exported for callers wanting a fallback value when blendedCrr
 *  returns an error (UI display, transient mid-edit states, etc.). */
export const DEFAULT_CRR = DEFAULTS.Crr;

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Pure tarmac:
//   blendedCrr([{ id: 'tarmac', pct: 100 }])  → 0.0040
//
// 50/50 tarmac + L2 gravel:
//   blendedCrr([{ id: 'tarmac', pct: 50 }, { id: 'gravel_2', pct: 50 }])
//   → (0.0040 + 0.0090) / 2 = 0.0065
//
// Auto-normalize (pcts sum to 90, treated as 100% of total):
//   blendedCrr([{ id: 'tarmac', pct: 45 }, { id: 'gravel_2', pct: 45 }])
//   → 0.0065  + fitWarn('surface_pct_not_normalized')
//
// Tire multiplier 1.15 (gravel tire):
//   blendedCrr([{ id: 'gravel_2', pct: 100 }], 1.15)  → 0.0090 * 1.15 = 0.01035
//
// Empty mix:
//   blendedCrr([])      → { ok: false, reason: 'empty_surface_mix' }
//   blendedCrr(null)    → { ok: false, reason: 'empty_surface_mix' }
//
// Unknown id:
//   blendedCrr([{ id: 'gravvel', pct: 50 }, { id: 'tarmac', pct: 50 }])
//   → { ok: false, reason: 'unknown_surface_id', detail: 'gravvel' } + fitWarn

export default blendedCrr;
