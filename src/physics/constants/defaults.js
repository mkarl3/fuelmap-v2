// Reference values used when athlete/bike data is incomplete.
//
// These are NOT physics constants (those live in physicsConstants.js) and
// NOT function-specific tuning (those live at the top of their respective
// function files per CC#5). They are the values to fall back to when the
// caller hasn't provided them — e.g., a fresh athlete profile with no bike
// configured, or a plan-build call that doesn't override defaults.
//
// See FuelMAP_Physics_Spec_v0_3 CC#5 for the tier framework.

export const DEFAULTS = Object.freeze({
  // ── Bike physics defaults ─────────────────────────────────────────────
  // Used when the athlete has no bike profile yet, or when `bikePhysics`
  // can't resolve one of the configured ids. See spec 2.4.
  bikePhysics: Object.freeze({
    CdA:      0.32,   // m² — matches POSITIONS `road_casual` (default: true)
    eta:      0.975,  // dimensionless — slightly below `road_std` 0.976
    tireMult: 1.00,   // matches TIRE_MULTIPLIERS `road_28_32` (default: true)
  }),

  /** Default rolling resistance coefficient. Matches SURFACES `tarmac`
   *  (default: true). Used when surface mix is missing or unresolvable. */
  Crr: 0.004,

  // ── Speed solver bounds ───────────────────────────────────────────────
  /** Upper bound on `speedAtPower` binary search. Raised from 25 m/s
   *  per spec 2.2 — real race descents can hit 70+ mph (≈31 m/s).
   *  Still a sanity bound to prevent runaway iteration. */
  maxRideSpeedMs: 35,

  // ── W' derivation ─────────────────────────────────────────────────────
  /** Default W'/FTP coefficient used when no CP test data and no phenotype
   *  are available. See spec 3.2 Tier 3. */
  wPrimePerWattFtp: 75,

  /** Floor for W' values returned from `fitCPModel`. CP fits that produce
   *  W' below this likely indicate bad test data. `deriveWPrime` applies
   *  this floor and fires `fitWarn` per spec 3.2. */
  wPrimeFloorJ: 5000,

  /** Hardcoded W' fallback used when ALL of CP-fit / phenotype / FTP-based
   *  derivation fail (no athlete data at all). Spec 3.2 calls this a bug
   *  indicator — caller should typically return a structured error. Kept
   *  as a default for backwards compatibility during migration. */
  wPrimeFallbackJ: 20000,

  // ── Climb cap defaults (spec 4.2 Group C) ─────────────────────────────
  // Used to PRE-POPULATE the PLAN-tab climb cap fields when a race is
  // first created. Not a fallback consulted during plan generation —
  // values flow into the user-editable race object on creation, then
  // come back as user-edited values from there.
  climbCapDefaults: Object.freeze({
    moderatePctFtp: 1.05,
    steepPctFtp:    1.15,
    wallPctFtp:     1.30,
  }),

  // ── Descent floor model (spec 4.2 Group B) ────────────────────────────
  // Replaces the legacy 20W hard floor with grade-dependent realistic
  // descent power. Tuned against TDL and Barry-Roubaix during Step 6
  // implementation; coefficients here are the spec's starting point.
  descentFloors: Object.freeze({
    /** 0% to -2%: shallow / false-flat. Rider keeps pedaling. */
    shallowGradeMaxPct: -2,
    shallowFloorFactor: 0.50, // × baseTargetW

    /** -2% to -6%: rolling descent. Partial pedaling. */
    rollingGradeMaxPct: -6,
    rollingFloorFactor: 0.30, // × baseTargetW

    /** Steeper than -6%: mostly coasting. */
    steepFloorFactor:   0.15, // × FTP
  }),

  // ── Stop detection (used by FIT parser) ───────────────────────────────
  /** Speed below this counts as "stopped" for the legacy speed heuristic
   *  fallback in stop-detection. Matches Garmin's 0.5 m/s convention. */
  stopSpeedThresholdMs: 0.5,

  /** Minimum consecutive seconds below `stopSpeedThresholdMs` to count
   *  as a real stop (filters traffic-light slowdowns from accumulating). */
  stopMinDurationSec: 5,

  // ── FIT→GPX initial-position matching (legacy gpxOffsetM model) ───────
  /** Maximum cumulative-distance window into the GPX route to search for
   *  the closest match to the FIT file's first GPS coordinate. Protects
   *  loop courses (where the route's last point is geographically near the
   *  start) from collapsing the offset to ~routeLen instead of ~0.
   *
   *  2 km matches the existing 2 km acceptance threshold in the same code
   *  path and stays safely below any realistic loop circumference. The
   *  whole `gpxOffsetM` model is slated for replacement by `alignFitToGpx`
   *  per CC#8 in Prompt 4, at which point this constant goes away too. */
  gpsMatchSearchWindowM: 2000,
});
