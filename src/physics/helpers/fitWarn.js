// Shared warning logging utility per CC#4.
//
// Single console-logging path that can later route to a UI warnings queue
// without refactoring callers. Today: just `console.warn` with a consistent
// prefix. Future: also push to an in-memory warnings buffer that the UI
// surfaces (e.g., a "physics warnings" panel in the ANALYZE tab).
//
// Categories used today (alphabetical, snake_case):
//   bike_param_missing        — DEFAULTS.bikePhysics fallback (spec 2.4)
//   climb_cap_unset           — race created without populated climb caps
//   climb_no_fit_data         — climb has 0 FIT data after alignment (spec 3.7)
//   cp_test_moderate_fit      — R² 0.85–0.95 (spec 3.4)
//   cp_test_poor_fit          — R² < 0.85 (spec 3.4)
//   cp_test_unreliable        — fitted W' below DEFAULTS.wPrimeFloorJ (spec 3.2)
//   grade_coverage_gap        — slice exceeds GPX bounds (spec 2.7)
//   malformed_segment_weight  — negative / NaN segment weight (spec 3.1)
//   surface_pct_not_normalized — surface mix doesn't sum to 100 ±2% (spec 2.3)
//   unknown_bike_param        — id not in POSITIONS / DRIVETRAINS / TIRE_MULTIPLIERS
//   unknown_surface_id        — id not in SURFACES (spec 2.3)
//
// Add new categories here when introducing them in helpers — single source
// of truth for the warning vocabulary makes future UI grouping easier.

let buffer = [];
let bufferEnabled = false;

/**
 * Log a structured warning.
 *
 * @param {string} category - short snake_case identifier (see header).
 * @param {string} message - human-readable description.
 * @param {object} [detail] - optional structured detail object for debugging.
 */
export function fitWarn(category, message, detail) {
  // Always console-log for now — keeps existing dev workflow intact.
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[fitWarn:${category}] ${message}`, detail ?? '');
  }
  // Optional in-memory buffer for future UI consumption (off by default).
  if (bufferEnabled) {
    buffer.push({ category, message, detail, ts: Date.now() });
  }
}

/**
 * Enable / disable the in-memory warnings buffer. Off by default to avoid
 * unbounded memory growth in long-lived sessions.
 *
 * Future use: enable when the ANALYZE tab opens, drain into the UI when it
 * closes, then disable again.
 *
 * @param {boolean} on
 */
export function enableFitWarnBuffer(on) {
  bufferEnabled = !!on;
  if (!on) buffer = [];
}

/**
 * Drain (and clear) the in-memory warnings buffer.
 * @returns {Array<{category, message, detail, ts}>}
 */
export function drainFitWarnBuffer() {
  const out = buffer;
  buffer = [];
  return out;
}

// ─── Sanity check ────────────────────────────────────────────────────────
//
// Calling fitWarn should print to console without throwing:
//   fitWarn('test_category', 'just verifying it works', { a: 1 });
//   // → [fitWarn:test_category] just verifying it works { a: 1 }
//
// Buffer flow:
//   enableFitWarnBuffer(true);
//   fitWarn('a', 'msg1');
//   fitWarn('b', 'msg2', { x: 1 });
//   const drained = drainFitWarnBuffer();
//   // drained.length === 2; drained[1].detail.x === 1
//   enableFitWarnBuffer(false);

export default fitWarn;
