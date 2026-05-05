// Air density from temperature, with optional altitude correction.
//
// Sea-level term: ρ₀(tempC) = ρ_ref × (T_ref / T(tempC))
//   ρ_ref = 1.225 kg/m³ at T_ref = 288.15 K (15 °C standard atmosphere)
//
// Altitude correction (standard troposphere model):
//   ρ(h) = ρ₀(tempC) × (1 - L·h/T_ref)^n
//   L = 0.0065 K/m, n = 4.255
//
// At h = 0 the multiplier evaluates to 1.0 — function is backward-compatible
// with callers that don't pass elevation. At ~1500 m (Denver-ish) the
// multiplier is ~0.86 → ~13% lower density than sea level. At 7,000 ft
// (~2134 m), ~22% lower.
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.5.

import { PHYSICS_CONSTANTS } from '../constants/physicsConstants.js';

/**
 * @param {number | null | undefined} tempC  air temperature in °C
 * @param {number} [elevationM=0]            elevation above sea level in meters
 * @returns {number}                         air density (kg/m³)
 *
 * Edge cases:
 *  - tempC null/undefined → returns sea-level standard 1.225 (matches legacy)
 *    AT THE ELEVATION GIVEN. If both are missing, returns 1.225.
 *  - Negative elevation (below sea level): formula still works mathematically;
 *    multiplier > 1.0. Realistic for Death Valley (-86 m) etc.
 *  - Extreme altitude: formula valid through troposphere (~11 km / 36k ft).
 *    Beyond that the model breaks down — not relevant for cycling.
 */
export function rhoFromTemp(tempC, elevationM = 0) {
  const {
    rhoSeaLevelStandard,
    tempStandardKelvin,
    troposphereLapseRate,
    troposphereExponent,
  } = PHYSICS_CONSTANTS;

  // Sea-level density at the given (or default) temperature.
  const rho0 = (tempC === null || tempC === undefined)
    ? rhoSeaLevelStandard
    : rhoSeaLevelStandard * (tempStandardKelvin / (273.15 + tempC));

  // Altitude correction multiplier. Defaults to 1.0 when elevationM = 0.
  const h = (typeof elevationM === 'number' && isFinite(elevationM)) ? elevationM : 0;
  const altMult = Math.pow(
    1 - (troposphereLapseRate * h) / tempStandardKelvin,
    troposphereExponent
  );

  return rho0 * altMult;
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Sea level standard:
//   rhoFromTemp(15, 0)        → 1.225
//   rhoFromTemp(15)           → 1.225 (default elevation = 0)
//
// Hot day at sea level (lower density):
//   rhoFromTemp(35, 0)        → 1.225 * (288.15 / 308.15) ≈ 1.146
//
// 1500 m at standard temp:
//   rhoFromTemp(15, 1500)     → 1.225 * (1 - 0.0065*1500/288.15)^4.255
//                              ≈ 1.225 * 0.864 ≈ 1.058
//
// Backward compat — no elevation:
//   rhoFromTemp(20)           → 1.225 * (288.15 / 293.15) ≈ 1.204
//
// Null temp:
//   rhoFromTemp(null, 0)      → 1.225
//   rhoFromTemp(null, 1000)   → 1.225 * 0.907 ≈ 1.111
//                               (sea-level fallback temp, altitude correction applied)

export default rhoFromTemp;
