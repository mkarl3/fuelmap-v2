// Lookup helpers for the PRE_RACE_FUELING preset catalog. Two facets per
// preset (glycogen scale and meal carbs per kg); two helpers expose each.
// Both fall back to the `light_meal` default on unknown ids — defensive
// guard for corrupt saves or future-version downgrades.

import { PRE_RACE_FUELING, PRE_RACE_FUELING_DEFAULT_ID } from '../constants/preRaceFueling.js';

function defaultPreset() {
  return PRE_RACE_FUELING.find(p => p.id === PRE_RACE_FUELING_DEFAULT_ID);
}

/**
 * Glycogen-scale multiplier for a pre-race fueling preset.
 *
 * Applied to `startingGlycogen(weightKg)` in `buildNutritionOverlay` to size
 * the rider's starting muscle/liver glycogen reserve. Range [0.70, 1.10] per
 * the calibration in `PRE_RACE_FUELING`.
 *
 * @param {string} id  Preset id (e.g. "fasted", "light_meal").
 * @returns {number}   Scale multiplier; falls back to the default preset's
 *                     scale on unknown id.
 */
export function fuelingScale(id) {
  const preset = PRE_RACE_FUELING.find(p => p.id === id);
  if (preset) return preset.glycogenScale;
  return defaultPreset().glycogenScale;
}

/**
 * Pre-race meal carbs in grams (weight-scaled) for a pre-race fueling preset.
 *
 * Used by the BurnRateChart's intake line to offset the cumulative-intake
 * line at race start (pre-race meal carbs are absorbed before the ride starts
 * and contribute to the rider's fuel buffer). Per ACSM/ISSN guidance, scales
 * with athlete body weight via `mealCarbsPerKg`.
 *
 * @param {string} id           Preset id.
 * @param {number} weightKg     Athlete weight in kilograms.
 * @returns {number}            Pre-race meal grams (integer); 0 if weight is
 *                              missing.
 */
export function fuelingMealCarbsG(id, weightKg) {
  const preset = PRE_RACE_FUELING.find(p => p.id === id) ?? defaultPreset();
  return Math.round((weightKg || 0) * preset.mealCarbsPerKg);
}
