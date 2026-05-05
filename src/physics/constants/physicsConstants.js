// Universal physics constants — values that don't change for a given
// environment (gravity, sea-level air density, troposphere parameters).
//
// This file is for universal physics constants only.
//   • Tuning parameters and athlete/bike fallback values → defaults.js
//   • Reference data tables (POSITIONS, etc.) → referenceData.js
//
// See FuelMAP_Physics_Spec_v0_3 CC#5 for the tier framework.

export const PHYSICS_CONSTANTS = Object.freeze({
  /** Gravitational acceleration, m/s². */
  g: 9.81,

  /** Standard sea-level air density at 15 °C (kg/m³). Used as the reference
   *  point for `rhoFromTemp` and altitude correction. */
  rhoSeaLevelStandard: 1.225,

  /** Standard sea-level temperature, °C. Pairs with `rhoSeaLevelStandard`. */
  tempStandard: 15,

  /** Troposphere lapse rate (K/m). Used in altitude correction:
   *    ρ(h) = ρ₀(T) × (1 - L·h/T₀)^n
   *  where L = 0.0065, T₀ = 288.15 K (= 15 °C in kelvin). */
  troposphereLapseRate: 0.0065,

  /** Troposphere exponent. Pairs with `troposphereLapseRate` in the
   *  altitude-correction formula above. */
  troposphereExponent: 4.255,

  /** Temperature in kelvin at sea level under standard atmosphere.
   *  T₀ = 288.15 K (= 15 °C). Used as the divisor in the lapse-rate term. */
  tempStandardKelvin: 288.15,
});
