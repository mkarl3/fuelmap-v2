// Starting glycogen reserve (g) for a trained athlete.
//
// Empirical estimate: ~300g base + small weight component. Per gram of body
// weight ≈ 5.5g muscle/liver glycogen for a trained endurance athlete.
// Used by `buildNutritionOverlay` to size the rider's starting fuel store
// (then scaled by a pre-race fueling preset's `glycogenScale`).
//
// Also used by the GlycogenChart UI to set the chart's Y-axis maxGlycogen
// reference, so consumers can import it directly from the physics module
// rather than duplicating the formula.

export function startingGlycogen(weightKg) {
  return Math.round(weightKg * 5.5);
}

export default startingGlycogen;

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// 80kg trained athlete:
//   startingGlycogen(80) → 440g
// 60kg lighter rider:
//   startingGlycogen(60) → 330g
// Edge case (no weight):
//   startingGlycogen(0)  → 0g (caller should guard against this)
