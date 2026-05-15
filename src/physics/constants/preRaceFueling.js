// Pre-race fueling preset catalog. Drives two facets of the nutrition model:
//   • `glycogenScale` — multiplier on weight-based starting glycogen reserve
//     (long-duration: stored muscle/liver fuel at race start).
//   • `mealCarbsPerKg` — grams/kg of race-morning meal carbs absorbed into
//     circulation by race start (short-duration buffer; used by the
//     "Cumulative Burn vs Intake" chart to offset the intake line).
//
// Replaced the legacy 0–300g `preRaceMeal` slider that conflated single-meal
// size with multi-day carb-loading state. Four user-friendly behavioral
// presets map to scaling factors anchored on:
//
//   • Glycogen: 0.70–1.10 range. `carb_loaded` sits at 1.10 (below the model's
//     1.15 hard cap) so it's never literally saturating.
//   • Meal carbs: ACSM/ISSN guidance of 1–4 g/kg in the 4 hours pre-exercise.
//     Carb-loaded picks 1.8 g/kg (slightly above Full meal) — the multi-day
//     loading effect is in `glycogenScale`, but the race-morning meal is
//     typically a touch larger on a properly-loaded day. At 80kg these give
//     0 / 40 / 120 / 144 g — within the descriptive ranges in `helper`.
//     Scales naturally for lighter/heavier riders.

export const PRE_RACE_FUELING = Object.freeze([
  { id: "fasted",      label: "Fasted",      helper: "No meal in 4+ hours",                 glycogenScale: 0.70, mealCarbsPerKg: 0.0 },
  { id: "light_meal",  label: "Light meal",  helper: "~30–60g carbs (banana, half bagel)",  glycogenScale: 0.82, mealCarbsPerKg: 0.5 },
  { id: "full_meal",   label: "Full meal",   helper: "~80–150g carbs (full breakfast)",     glycogenScale: 0.92, mealCarbsPerKg: 1.5 },
  { id: "carb_loaded", label: "Carb-loaded", helper: "Multi-day loading + race-day meal",   glycogenScale: 1.10, mealCarbsPerKg: 1.8 },
]);

export const PRE_RACE_FUELING_DEFAULT_ID = "light_meal";
