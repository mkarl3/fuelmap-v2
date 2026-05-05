// Reference data tables — catalogs that drive bike profiles, surface mixes,
// rider phenotypes, and zone systems.
//
// These are NOT physics constants (those live in physicsConstants.js) and
// NOT fallback defaults (those live in defaults.js). They are user-facing
// catalogs that the rider/UI selects from.
//
// Each table that contributes to fallback resolution carries a `default: true`
// flag on its canonical entry — `bikePhysics` looks up the flag rather than
// using a magic-number array index, per spec 2.4.
//
// See FuelMAP_Physics_Spec_v0_3 CC#5 for the tier framework.

// ─── SURFACES ────────────────────────────────────────────────────────────
// id    : enum tag matching the `id` field in plan surface mixes
// label : UI-facing label
// Crr   : rolling resistance coefficient (scaled by tire multiplier)
// viOffset : additive VI contribution per spec 3.9 (legacy — slated for
//            relocation into a Crr adjustment per spec, but preserved for
//            current callers until that migration lands)
// default : single canonical entry used when caller can't resolve an id

export const SURFACES = Object.freeze([
  { id: 'tarmac',    label: 'Tarmac',         Crr: 0.0040, viOffset: 0.000, default: true },
  { id: 'chip_seal', label: 'Chip Seal',      Crr: 0.0055, viOffset: 0.010 },
  { id: 'gravel_1',  label: 'Level 1 Gravel', Crr: 0.0065, viOffset: 0.020 },
  { id: 'gravel_2',  label: 'Level 2 Gravel', Crr: 0.0090, viOffset: 0.056 },
  { id: 'gravel_3',  label: 'Level 3 Gravel', Crr: 0.0120, viOffset: 0.060 },
  { id: 'dirt',      label: 'Dirt/Trail',     Crr: 0.0200, viOffset: 0.080 },
]);

// ─── POSITIONS ───────────────────────────────────────────────────────────
// CdA (m²) — aerodynamic drag area. Default flagged on `road_casual` — that's
// the index `[1]` fallback the legacy code used in bikePhysics.

export const POSITIONS = Object.freeze([
  { id: 'road_race',    label: 'Road — Race',      CdA: 0.28 },
  { id: 'road_casual',  label: 'Road — Casual',    CdA: 0.32, default: true },
  { id: 'gravel_race',  label: 'Gravel — Race',    CdA: 0.38 },
  { id: 'gravel_relax', label: 'Gravel — Relaxed', CdA: 0.42 },
  { id: 'mtb_race',     label: 'MTB — Race',       CdA: 0.50 },
  { id: 'mtb_relax',    label: 'MTB — Relaxed',    CdA: 0.58 },
]);

// ─── DRIVETRAINS ─────────────────────────────────────────────────────────
// eta — drivetrain efficiency (1 - frictional loss). Default flagged on
// `road_std` — the `[1]` fallback in legacy bikePhysics. Note the slight
// asymmetry: DEFAULTS.bikePhysics.eta = 0.975, but `road_std` = 0.976. The
// 0.975 fallback was the legacy magic constant from the PHYSICS = {...}
// object; the table value is what the user actually selects. Both are
// preserved as-is for migration safety.

export const DRIVETRAINS = Object.freeze([
  { id: 'road_wax',   label: 'Road — Wax',                eta: 0.984 },
  { id: 'road_std',   label: 'Road — Standard',           eta: 0.976, default: true },
  { id: 'gravel_wax', label: 'Gravel 1x — Wax',           eta: 0.978 },
  { id: 'gravel_std', label: 'Gravel 1x — Standard',      eta: 0.970 },
  { id: 'mtb_wax',    label: 'MTB Large Cassette — Wax',  eta: 0.972 },
  { id: 'mtb_std',    label: 'MTB Large Cassette — Standard', eta: 0.964 },
]);

// ─── TIRE_MULTIPLIERS ────────────────────────────────────────────────────
// mult — multiplier on Crr to account for tire size/pressure.

export const TIRE_MULTIPLIERS = Object.freeze([
  { id: 'road_23_25',   label: 'Road 23–25mm',    mult: 0.90 },
  { id: 'road_28_32',   label: 'Road 28–32mm',    mult: 1.00, default: true },
  { id: 'gravel_35_40', label: 'Gravel 35–40mm',  mult: 1.15 },
  { id: 'gravel_40_50', label: 'Gravel 40–50mm',  mult: 1.28 },
  { id: 'mtb_2_2_4',    label: 'MTB 2.2-2.4 in',  mult: 1.50 },
  { id: 'mtb_2_4_plus', label: 'MTB 2.4+ in',     mult: 1.75 },
]);

// ─── COGGAN_ZONES ────────────────────────────────────────────────────────
// Six standard Coggan power zones, expressed as fractional FTP ranges.
// Replaces the legacy POWER_ZONES object (which had a latent boundary
// inconsistency: const said [0.55, 0.75, 0.90, 1.05, 1.20] but
// computeZoneDist binned at the spec values). Bin edges below match
// `computeZoneDist`'s actual binning logic and the spec, closing the gap.
//
// Colors copied verbatim from existing POWER_ZONES const for visual continuity.
//
// Bins are half-open: ftpRangeLow ≤ pct < ftpRangeHigh.
// Z6's upper bound is Infinity — anything above 1.21 × FTP.

export const COGGAN_ZONES = Object.freeze([
  { id: 'z1', name: 'Active Recovery', ftpRangeLow: 0,    ftpRangeHigh: 0.55, color: '#00D4FF' },
  { id: 'z2', name: 'Endurance',       ftpRangeLow: 0.55, ftpRangeHigh: 0.76, color: '#00FF8C' },
  { id: 'z3', name: 'Tempo',           ftpRangeLow: 0.76, ftpRangeHigh: 0.91, color: '#FFB800' },
  { id: 'z4', name: 'Threshold',       ftpRangeLow: 0.91, ftpRangeHigh: 1.06, color: '#FF8C00' },
  { id: 'z5', name: 'VO2max',          ftpRangeLow: 1.06, ftpRangeHigh: 1.21, color: '#FF3347' },
  { id: 'z6', name: 'Anaerobic',       ftpRangeLow: 1.21, ftpRangeHigh: Infinity, color: '#A855F7' },
]);

// ─── RIDER_PHENOTYPES ────────────────────────────────────────────────────
// Used by deriveWPrime Tier 2: when no CP test data exists, multiply FTP
// by the phenotype's wMult to estimate W' (joules). Coefficients derived
// from typical sprinter/all-rounder/climber/endurance W' literature.

export const RIDER_PHENOTYPES = Object.freeze([
  { id: 'sprinter',   label: 'Sprinter',    wMult: 110, desc: 'Short, explosive efforts are your strength; you excel in bunch sprints and punchy attacks but fade on long sustained climbs.' },
  { id: 'allrounder', label: 'All-Rounder', wMult: 75,  desc: 'Competitive across most terrain; no standout weakness, no standout strength.', default: true },
  { id: 'climber',    label: 'Climber',     wMult: 55,  desc: 'Sustained high-power output is your engine; you thrive on long climbs but have limited snap above threshold.' },
  { id: 'endurance',  label: 'Endurance',   wMult: 45,  desc: 'Built for the long haul; efficiency and fat oxidation are your strengths, anaerobic capacity is not.' },
]);

// ─── CLIMB_CATEGORIES ────────────────────────────────────────────────────
// Display reference data only. Per Mike's confirmation, this table holds
// id/name/colors and the FTP-percentage cap defaults used to pre-populate
// the PLAN-tab climb cap fields at race creation.
//
// Climb-detection thresholds (3% grade floor, 2-block gap tolerance, 200m
// minimum length) live as function-local constants in `detectClimbs` per
// spec 3.8. Do NOT add detection thresholds here.
//
// Grade-classification boundaries used by the new `gradeCategory(gradePct)`
// and `climbCategory(climbStats)` functions (spec 2.6) belong inside those
// functions, not here. This table answers "how do I render category X" and
// "what FTP% should I suggest as a starting cap for category X" — nothing
// about detecting or classifying.

export const CLIMB_CATEGORIES = Object.freeze([
  { id: 'moderate', name: 'Moderate', color: 'rgba(0,212,255,0.18)', borderColor: 'rgba(0,212,255,0.5)', ftpCapDefault: 1.05 },
  { id: 'steep',    name: 'Steep',    color: 'rgba(255,184,0,0.18)', borderColor: 'rgba(255,184,0,0.5)', ftpCapDefault: 1.15 },
  { id: 'wall',     name: 'Wall',     color: 'rgba(255,51,71,0.22)', borderColor: 'rgba(255,51,71,0.6)', ftpCapDefault: 1.30 },
]);
