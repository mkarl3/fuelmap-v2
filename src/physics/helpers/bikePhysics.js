// Resolve a bike configuration object into the physics parameters needed
// by powerAtSpeed / speedAtPower: { CdA, eta, tireMult }.
//
// Per spec 2.4 target state:
//  • Unknown id (caller specified a bike-param id that's not in the table)
//    → bug indicator. Returns structured error per CC#6. A pacing plan
//    computed against the wrong CdA is materially misleading; better to
//    fail visibly than silently fall back.
//  • Missing id (positionId/drivetrainId/tireId is null/undefined)
//    → defensible default. Returns DEFAULTS.bikePhysics with fitWarn.
//    Covers the case where athlete hasn't configured a bike profile yet.
//  • Lookup uses `entry.default === true` flag from referenceData.js, NOT
//    array position [1]. Reorder-safe.
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.4.

import { POSITIONS, DRIVETRAINS, TIRE_MULTIPLIERS } from '../constants/referenceData.js';
import { DEFAULTS } from '../constants/defaults.js';
import { fitWarn }  from './fitWarn.js';

function findById(table, id) {
  if (!id) return null;                  // null/undefined/'' → caller didn't specify
  return table.find(e => e.id === id) ?? undefined; // undefined → unknown id
}

/**
 * @param {{positionId?: string, drivetrainId?: string, tireId?: string} | null | undefined} bike
 * @returns {{CdA: number, eta: number, tireMult: number} | {ok: false, reason: string, detail: object}}
 *   Success: physics parameter object.
 *   Failure modes:
 *    - bike object missing entirely → DEFAULTS.bikePhysics + fitWarn (defensible)
 *    - any id missing → DEFAULTS.bikePhysics + fitWarn (defensible)
 *    - any id present but unknown → structured error (bug indicator)
 */
export function bikePhysics(bike) {
  if (!bike) {
    fitWarn('bike_param_missing',
      'bikePhysics called with no bike object — falling back to defaults', { bike });
    return { ...DEFAULTS.bikePhysics };
  }

  const { positionId, drivetrainId, tireId } = bike;

  // Missing ids → defensible default. fitWarn for upstream visibility.
  if (!positionId || !drivetrainId || !tireId) {
    fitWarn('bike_param_missing',
      'bikePhysics: one or more bike-param ids missing — falling back to defaults',
      { positionId, drivetrainId, tireId });
    return { ...DEFAULTS.bikePhysics };
  }

  const pos  = findById(POSITIONS,         positionId);
  const dt   = findById(DRIVETRAINS,       drivetrainId);
  const tire = findById(TIRE_MULTIPLIERS,  tireId);

  // Any id present but unknown → bug indicator.
  if (pos === undefined || dt === undefined || tire === undefined) {
    return {
      ok: false,
      reason: 'unknown_bike_param',
      detail: {
        positionId:    pos  === undefined ? positionId    : null,
        drivetrainId:  dt   === undefined ? drivetrainId  : null,
        tireId:        tire === undefined ? tireId        : null,
      },
    };
  }

  return { CdA: pos.CdA, eta: dt.eta, tireMult: tire.mult };
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// All ids valid:
//   bikePhysics({ positionId: 'road_race', drivetrainId: 'road_wax', tireId: 'road_28_32' })
//   → { CdA: 0.28, eta: 0.984, tireMult: 1.00 }
//
// Missing bike entirely:
//   bikePhysics(null)
//   → { CdA: 0.32, eta: 0.975, tireMult: 1.00 }  (DEFAULTS) + fitWarn
//
// Missing one id:
//   bikePhysics({ positionId: 'road_race' })
//   → DEFAULTS.bikePhysics + fitWarn('bike_param_missing')
//
// Unknown id:
//   bikePhysics({ positionId: 'bogus', drivetrainId: 'road_std', tireId: 'road_28_32' })
//   → { ok: false, reason: 'unknown_bike_param',
//       detail: { positionId: 'bogus', drivetrainId: null, tireId: null } }

export default bikePhysics;
