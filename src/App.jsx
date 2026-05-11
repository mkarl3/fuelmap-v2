import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, ReferenceLine, ReferenceArea } from "recharts";
import { loadAllRaces, saveRace, updateRace, deleteRace } from './db.js';
import { parseFIT, inferHasPower, inferHasHR } from './parsers/fitParser';
import {
  powerAtSpeed, speedAtPower, gradeForSlice, rhoFromTemp, bikePhysics, blendedCrr,
  gradeCategory, carbOxidationRate, recommendIntakeRate, computeZoneDist,
  computeVI, estimateDuration, computeCP, deriveWPrime, getSegmentIF,
  buildWbal, buildWbalFromRawSeries, buildPerClimbStats, detectClimbs,
  buildPowerStream, buildPowerStreamWithSurge, flatIFForTargetNP,
  alignFitToGpx,
  fitWarn,
  computeNP,
  COGGAN_ZONES, DEFAULTS,
} from './physics/index.js';
// (Prompt 3 rewrote detectClimbs to use the new climbCategory(climbStats)
// from the physics module. The legacy local climbCategory(avgGradePct) was
// deleted at the same time. climbCategory is still not imported here because
// nothing in App.jsx-level code calls it directly — only detectClimbs does,
// which is now in physics.)

// Defensive unwrap for physics helpers that return structured errors per CC#6.
// Most existing Step 3/4 call sites never pass invalid input (e.g., negative
// power to speedAtPower), so the error path here is dead code in normal flow
// — but will catch and log if upstream code regresses. UI surfacing of these
// errors comes in a later prompt.
function _physicsUnwrap(result, fallback = 0) {
  if (result && typeof result === 'object' && result.ok === false) {
    // Single hook for the future warnings-UI prompt: every actual unwrap
    // goes through fitWarn so the UI consumer doesn't need to grep call
    // sites. console.error retained for the current dev-tools workflow.
    fitWarn(`physics_unwrap_${result.reason}`,
      `Physics helper returned structured error: ${result.reason}`,
      result.detail ?? null);
    console.error('[physics] failed:', result.reason, result.detail ?? '');
    return fallback;
  }
  return result;
}

// ── Climb-cap defaults (Prompt 4A Group C / spec 4.2) ─────────────────────
// Coefficients live in DEFAULTS.climbCapDefaults per CC#5. These helpers
// build and patch the in-memory `{moderate, steep, wall} -> {min, max}`
// shape PlanTab keeps in state. `min` is opt-in (default 0); only `max`
// gets auto-populated. User edits persist; on user-clear (max → 0), the
// auto-restore path in computePlan refills from the FTP-based default.
function buildDefaultClimbCaps(ftp) {
  if (!(ftp > 0)) return null; // bug indicator — caller surfaces error
  const c = DEFAULTS.climbCapDefaults;
  return {
    moderate: { min: 0, max: Math.round(ftp * c.moderatePctFtp) },
    steep:    { min: 0, max: Math.round(ftp * c.steepPctFtp)    },
    wall:     { min: 0, max: Math.round(ftp * c.wallPctFtp)     },
  };
}

// Build a complete athleteSnapshot for plan persistence (B-6). Captures every
// field the plan-time math or analyze-time analysis may need. Backward compat
// for legacy saves without these fields lives at the consumer site (fall back
// to currentAthlete profile values when a snapshot field is missing on reload).
//
// Notes:
//  • `wPrime` here is the explicit override if set (post-B-18 Tier 0) or the
//    derived value at plan-time (Tier 2/3). Either way it's the value the
//    plan-time W'bal sim used.
//  • `cpTests` is captured by reference clone so subsequent profile edits
//    don't mutate the saved race's CP context.
//  • `cpTestedAt` preserves the timestamp stamp used by Athlete-modal
//    "tested on …" display.
function buildAthleteSnapshot(athlete) {
  return {
    id:                  athlete?.id ?? null,
    name:                athlete?.name ?? '',
    ftp:                 athlete?.ftp ?? 0,
    weight:              athlete?.weight ?? 0,
    wPrime:              _physicsUnwrap(deriveWPrime(athlete), DEFAULTS.wPrimeFallbackJ),
    phenotype:           athlete?.phenotype ?? 'allrounder',
    maxHR:               athlete?.maxHR ?? null,
    cpTests:             Array.isArray(athlete?.cpTests) ? athlete.cpTests.map(t => ({ ...t })) : [],
    cpTestedAt:          athlete?.cpTestedAt ?? null,
    maxCarbIntakeGPerHr: athlete?.maxCarbIntakeGPerHr ?? 90,
  };
}

// Returns a NEW caps object with all `max` fields populated (preserving
// existing positive values). Returns null if FTP is missing/invalid —
// caller treats that as a bug indicator and surfaces via _physicsUnwrap.
function ensureClimbCapsPopulated(caps, ftp) {
  const defaults = buildDefaultClimbCaps(ftp);
  if (!defaults) return null;
  const out = {};
  for (const cat of ['moderate', 'steep', 'wall']) {
    const cur = caps?.[cat] ?? { min: 0, max: 0 };
    out[cat] = {
      min: typeof cur.min === 'number' && cur.min >= 0 ? cur.min : 0,
      max: cur.max > 0 ? cur.max : defaults[cat].max,
    };
  }
  return out;
}

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
// Source of truth: FuelMAP Brand & Design System v2
const T = {
  // Backgrounds & Surfaces
  bg:          "#0D0D0F", // Page BG
  surface:     "#141416", // Cards / panels
  surface2:    "#1C1C20", // Inputs / rows
  surface3:    "#242428", // Hover states
  border:      "#2A2A30", // Dividers
  borderLight: "#363640", // Active borders

  // Text Hierarchy
  text:        "#F0F0F5", // Primary
  textMuted:   "#8888A0", // Labels / subtext
  textDim:     "#44444C", // Disabled / faint

  // Neon Accents
  green:  "#00FF8C", // Fuel Green  — success / positive / reserves healthy
  blue:   "#00D4FF", // Signal Cyan — info / plan lines / target zones
  gold:   "#FFB800", // Power Amber — warning / caution / fatigue
  red:    "#FF3347", // Redline     — danger / bonk / peak power
  purple: "#A855F7", // W-Prime     — anaerobic capacity / W-bal

  // Zone fills — brand rule: 0.06–0.15 alpha
  zoneBlue: "rgba(0,212,255,0.10)",
  zoneGold: "rgba(255,184,0,0.10)",
  zoneRed:  "rgba(255,51,71,0.10)",
};

const SURFACES = [
  { id: "tarmac",    label: "Tarmac",         Crr: 0.0040, viOffset: 0.000 },
  { id: "chip_seal", label: "Chip Seal",      Crr: 0.0055, viOffset: 0.010 },
  { id: "gravel_1",  label: "Level 1 Gravel", Crr: 0.0065, viOffset: 0.020 },
  { id: "gravel_2",  label: "Level 2 Gravel", Crr: 0.0090, viOffset: 0.056 },
  { id: "gravel_3",  label: "Level 3 Gravel", Crr: 0.0120, viOffset: 0.060 },
  { id: "dirt",      label: "Dirt/Trail",     Crr: 0.0200, viOffset: 0.080 },
];

const POSITIONS = [
  { id: "road_race",     label: "Road — Race",       CdA: 0.28 },
  { id: "road_casual",   label: "Road — Casual",     CdA: 0.32 },
  { id: "gravel_race",   label: "Gravel — Race",     CdA: 0.38 },
  { id: "gravel_relax",  label: "Gravel — Relaxed",  CdA: 0.42 },
  { id: "mtb_race",      label: "MTB — Race",        CdA: 0.50 },
  { id: "mtb_relax",     label: "MTB — Relaxed",     CdA: 0.58 },
];

const DRIVETRAINS = [
  { id: "road_wax",      label: "Road — Wax",                eta: 0.984 },
  { id: "road_std",      label: "Road — Standard",           eta: 0.976 },
  { id: "gravel_wax",    label: "Gravel 1x — Wax",           eta: 0.978 },
  { id: "gravel_std",    label: "Gravel 1x — Standard",      eta: 0.970 },
  { id: "mtb_wax",       label: "MTB Large Cassette — Wax",  eta: 0.972 },
  { id: "mtb_std",       label: "MTB Large Cassette — Standard", eta: 0.964 },
];

const TIRE_MULTIPLIERS = [
  { id: "road_23_25",  label: "Road 23–25mm",     mult: 0.90 },
  { id: "road_28_32",  label: "Road 28–32mm",     mult: 1.00 },
  { id: "gravel_35_40",label: "Gravel 35–40mm",   mult: 1.15 },
  { id: "gravel_40_50",label: "Gravel 40–50mm",   mult: 1.28 },
  { id: "mtb_2_2_4",   label: "MTB 2.2-2.4 in",  mult: 1.50 },
  { id: "mtb_2_4_plus",label: "MTB 2.4+ in",     mult: 1.75 },
];

const DEFAULT_BIKE = {
  id: 1, name: "2021 Trek Emonda",
  weight: 7.7,
  positionId: "road_race",
  drivetrainId: "road_wax",
  tireId: "road_28_32",
};

// (B-7: `ifForTargetDuration` retired. Function had no callers in App.jsx and
// was not part of the spec; flagged for removal in Prompt 3. Now deleted.)

// ─── CLIMB DETECTION ─────────────────────────────────────────────────────────
// Scans 1-min block grade stream, groups consecutive ≥3% blocks into climbs.
// Gap tolerance: 2 consecutive sub-threshold blocks allowed within a climb (false-flat).
// Minimum length: 1 block (1 min) — punchy kickers on gravel count.
// Returns array of climb objects with category assigned.
const CLIMB_CATEGORIES = [
  { id: "moderate", label: "Moderate", minGrade: 3,  maxGrade: 6,  color: "rgba(0,212,255,0.18)",  borderColor: "rgba(0,212,255,0.5)"  },
  { id: "steep",    label: "Steep",    minGrade: 6,  maxGrade: 10, color: "rgba(255,184,0,0.18)",  borderColor: "rgba(255,184,0,0.5)"  },
  { id: "wall",     label: "Wall",     minGrade: 10, maxGrade: 99, color: "rgba(255,51,71,0.22)",  borderColor: "rgba(255,51,71,0.6)"  },
];

// ─── PER-CLIMB PACING STATS ───────────────────────────────────────────────────
// Maps each detected GPX climb onto movingPowerSeries (1-second) and actualWbalRaw
// to produce per-climb NP, avg power, and W'bal remaining at climb exit.
//
// Alignment: cumulative distance from movingDistSeries (meters) matched against
// climb.startDistKm / (startDistKm + lengthKm) in meters, accounting for the same
// gpxOffsetM used in buildTerrainStream so both are in the same coordinate frame.
//
// Returns array of { climbId, category, startDistKm, lengthKm, avgGrade, peakGradePct,
//   np, avgP, pctFTP, wbalPctAtExit } — one entry per detected climb.
// ─────────────────────────────────────────────────────────────────────────────

// Realistic glycogen: ~300g base + small weight component (trained athlete)
function startingGlycogen(weightKg) { return Math.round(weightKg * 5.5); }

// 4C sub-step 1: fully parameterized on `blockMinutes` so the function works
// at any block resolution. All internal time-dependent constants now scale
// with the block size. Callers pass `blockMinutes=1` post-rebuild (1-min
// powerStream on plan side; 1-min aggregated FIT stream on actual side).
function buildNutritionOverlay(stream, intakeEvents, athlete, preRaceMeal, blockMinutes = 1) {
  if (!stream || stream.length === 0) return [];
  const glycogenScale = 0.7 + (preRaceMeal / 300) * 0.45;
  let glycogenReserve = Math.round(startingGlycogen(athlete.weight) * glycogenScale);
  const maxGlycogen = startingGlycogen(athlete.weight) * 1.15;
  const MAX_ABSORPTION = 90; // g/hr max intestinal absorption
  const ABSORB_WINDOW_MIN = 20; // realistic absorption window for gels/chews/bars

  // Spread each intake event over enough blocks to cover ABSORB_WINDOW_MIN of
  // ride time. Independent of block resolution.
  const ABSORB_BLOCKS = Math.max(1, Math.round(ABSORB_WINDOW_MIN / blockMinutes));
  const absQueue = new Array(stream.length).fill(0);
  for (const e of intakeEvents) {
    const startBlock = stream.findIndex(pt => pt.time >= e.time);
    if (startBlock === -1) continue;
    const gPerBlock = (e.carbs || 0) / ABSORB_BLOCKS;
    for (let b = startBlock; b < Math.min(startBlock + ABSORB_BLOCKS, stream.length); b++) {
      absQueue[b] += gPerBlock;
    }
  }

  return stream.map((pt, idx) => {
    const burnRate = carbOxidationRate(pt.power, athlete.ftp); // g/hr
    const burned = burnRate * (blockMinutes / 60); // g burned this block

    const scheduledIntake = absQueue[idx];
    const maxAbsorbThisBlock = MAX_ABSORPTION * (blockMinutes / 60);
    const actualAbsorbed = Math.min(scheduledIntake, maxAbsorbThisBlock);
    const overLimit = Math.max(0, scheduledIntake - maxAbsorbThisBlock);

    // Point-in-time intake for reference markers (one block's window).
    const pointIntake = intakeEvents
      .filter(e => e.time >= pt.time && e.time < pt.time + blockMinutes)
      .reduce((s, e) => s + (e.carbs || 0), 0);

    glycogenReserve = Math.min(maxGlycogen, Math.max(0, glycogenReserve - burned + actualAbsorbed));

    return {
      ...pt,
      burnRate: Math.round(burnRate),
      glycogenReserve: Math.round(glycogenReserve),
      reservePct: Math.round((glycogenReserve / maxGlycogen) * 100),
      gutPool: 0,
      intakeRate: Math.round(actualAbsorbed * (60 / blockMinutes)), // g/block → g/hr
      intake: Math.round(pointIntake),
      actualAbsorbed: Math.round(actualAbsorbed),
      overLimit: Math.round(overLimit),
    };
  });
}


// ─── GPX PARSER ───────────────────────────────────────────────────────────────
function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const trkpts = Array.from(doc.querySelectorAll("trkpt"));
  if (trkpts.length < 2) return null;

  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // Pass 1: build cumulative-distance point array
  const pts = [];
  let totalDist = 0;
  for (let i = 0; i < trkpts.length; i++) {
    const pt = trkpts[i];
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    const ele = parseFloat(pt.querySelector("ele")?.textContent || 0);
    if (i > 0) {
      const prev = pts[pts.length - 1];
      totalDist += haversine(prev.lat, prev.lon, lat, lon);
    }
    // 4C sub-step 2 fix: keep `cumDistM` (parseGPX internal binary-search uses
    // it) AND set `distM` to satisfy `alignFitToGpx`'s documented input shape.
    // Pre-fix, the field-name mismatch silently made every aligned point's
    // `gpxDistM` null — breaking bucketByTerrain on-route grade lookup,
    // per-climb stats membership, and Scheme D plan-line rendering.
    pts.push({ lat, lon, ele, cumDistM: totalDist, distM: totalDist });
  }

  // Pass 2: total gain/loss with 5-point centered moving-average smoothing.
  // Raw integration over every adjacent track point counts every GPS/barometric
  // noise wiggle as gain or loss, over-counting by ~25% vs Garmin/Strava reported
  // values. Both Garmin and Strava apply light smoothing before integrating to
  // filter out micro-noise. Validated: TDL 60mi route reports 2053ft gain after
  // smoothing vs Garmin's 2077ft (within 1.2%); raw integration produced 2628ft.
  // Smoothing is applied ONLY to the gain/loss totals — pass 3 buckets and the
  // elevation profile chart still use raw pts[].ele via sampleEle() to preserve
  // resolution for per-segment grade calculations and chart rendering.
  const smoothedEle = pts.map((_, i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(pts.length - 1, i + 2);
    let sum = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += pts[j].ele; n++; }
    return sum / n;
  });
  let elevGain = 0, elevLoss = 0;
  for (let i = 1; i < smoothedEle.length; i++) {
    const dEle = smoothedEle[i] - smoothedEle[i-1];
    if (dEle > 0) elevGain += dEle; else elevLoss += Math.abs(dEle);
  }

  // Helper: interpolate elevation at any cumulative distance
  const sampleEle = (distM) => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      pts[m].cumDistM <= distM ? lo = m : hi = m;
    }
    const sp = pts[hi].cumDistM - pts[lo].cumDistM;
    const tt = sp > 0 ? Math.min(1, Math.max(0, (distM - pts[lo].cumDistM) / sp)) : 0;
    return pts[lo].ele + tt * (pts[hi].ele - pts[lo].ele);
  };

  // Pass 3: bucket into 200 equal-distance segments covering 100% of route
  const NUM_BUCKETS = 200;
  const bucketDistM = totalDist / NUM_BUCKETS;
  const segmentGrades = [];
  const elevProfile = [];

  for (let b = 0; b < NUM_BUCKETS; b++) {
    const startM = b * bucketDistM;
    const endM = Math.min(startM + bucketDistM, totalDist);
    const eleStart = sampleEle(startM);
    const eleEnd = sampleEle(endM);
    const grade = bucketDistM > 1 ? (eleEnd - eleStart) / bucketDistM : 0;
    // clamp to realistic road grades
    const clampedGrade = Math.max(-0.20, Math.min(0.20, grade));
    segmentGrades.push({ distM: bucketDistM, gradeDecimal: clampedGrade });
    elevProfile.push({ dist: Math.round(startM / 100) / 10, ele: Math.round(eleStart) });
  }

  // Compute bearing for each bucket (degrees, 0=N, 90=E, 180=S, 270=W)
  const bearingBetween = (lat1, lon1, lat2, lon2) => {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1r = lat1 * Math.PI / 180, lat2r = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2r);
    const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };
  const samplePt = (distM) => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; pts[m].cumDistM <= distM ? lo = m : hi = m; }
    return pts[lo];
  };
  const courseBearings = [];
  let bearingSum = 0;
  for (let b = 0; b < NUM_BUCKETS; b++) {
    const p1 = samplePt(b * bucketDistM);
    const p2 = samplePt(Math.min((b + 1) * bucketDistM, totalDist));
    const bearing = bearingBetween(p1.lat, p1.lon, p2.lat, p2.lon);
    courseBearings.push(bearing);
    bearingSum += bearing;
  }
  const avgCourseBearing = Math.round(bearingSum / NUM_BUCKETS);

  return {
    totalDistKm: Math.round(totalDist / 100) / 10,
    elevGainM: Math.round(elevGain),
    elevLossM: Math.round(elevLoss),
    segmentGrades,
    elevProfile,
    courseBearings,
    avgCourseBearing,
    _gpxPts: pts, // {lat, lon, ele, cumDistM, distM} — used for FIT-to-GPX position alignment
  };
}

// (4C sub-step 1: `buildPowerStreamFromFIT` was retired here. It produced
//  5-min FIT blocks from `fitData.blockMap` to match the legacy parser. Both
//  the helper and `blockMap` itself are gone — consumers now build a 1-min
//  stream directly from `movingPowerSeries`/`movingHRSeries`/`movingDistSeries`
//  via the `fitMinStream` useMemo in AnalyzeTab. Keeps the rebuild's
//  "visuals at 1-min, math at 1-sec" principle consistent.)

// TODO(weather): replace manual entry with API fetch once deployed
// fetchWeather(lat, lon, raceDate) → setWeatherContext(result)
// Air density correction: rho varies ~4% between 0°C and 35°C
function degToCompass(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function minsToHHMM(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

// ─── DEFAULT DATA ─────────────────────────────────────────────────────────────
// Rider phenotype definitions — used for W' estimation when CP test data is absent
const RIDER_PHENOTYPES = [
  { id: "sprinter",   label: "Sprinter",    desc: "Short, explosive efforts are your strength; you excel in bunch sprints and punchy attacks but fade on long sustained climbs.", wMult: 110 },
  { id: "allrounder", label: "All-Rounder", desc: "Competitive across most terrain; no standout weakness, no standout strength.", wMult: 75 },
  { id: "climber",    label: "Climber",     desc: "Sustained high-power output is your engine; you thrive on long climbs but have limited snap above threshold.", wMult: 55 },
  { id: "endurance",  label: "Endurance",   desc: "Built for the long haul; efficiency and fat oxidation are your strengths, anaerobic capacity is not.", wMult: 45 },
];

// Derive W' (joules) from athlete data.
// Priority: (1) CP test result, (2) phenotype × FTP, (3) FTP × 75 fallback, (4) 20000 J hardcoded
const DEFAULT_ATHLETE = {
  id: 1, name: "Athlete 1", ftp: 250, weight: 79.4,
  maxHR: 175,
  wPrime: 20000,
  phenotype: "allrounder",
  cpTests: [{ secs: 0, watts: 0 }, { secs: 0, watts: 0 }, { secs: 0, watts: 0 }],
  cpTestedAt: null,
  maxCarbIntakeGPerHr: 90,
};
const DEFAULT_PRODUCTS = [
  { id: 1, name: "Gel (Maurten 100)", carbs: 25, sodium: 55 },
  { id: 2, name: "Chews (Clif Bloks)", carbs: 24, sodium: 50 },
  { id: 3, name: "Bar (Maurten 160)", carbs: 40, sodium: 55 },
  { id: 4, name: "Drink Mix (Maurten 160)", carbs: 40, sodium: 110 },
  { id: 5, name: "Banana", carbs: 27, sodium: 1 },
  { id: 6, name: "Custom Food", carbs: 30, sodium: 100 },
];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${T.bg}; color: ${T.text}; font-family: 'Barlow', sans-serif; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: ${T.surface}; }
  ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 3px; }
  input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; background: ${T.border}; border-radius: 2px; outline: none; cursor: pointer; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; background: ${T.blue}; border-radius: 50%; cursor: pointer; }
  input[type=range]::-webkit-slider-thumb:hover { background: #6db3ff; }
  select, input[type=text], input[type=number] { background: ${T.surface2}; border: 1px solid ${T.border}; color: ${T.text}; padding: 6px 10px; border-radius: 4px; font-family: 'Barlow', sans-serif; font-size: 13px; outline: none; }
  input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type=number] { -moz-appearance: textfield; }
  select:focus, input:focus { border-color: ${T.blue}; }
  button { cursor: pointer; font-family: 'Barlow', sans-serif; }
  .tab-btn { background: none; border: none; color: ${T.textMuted}; font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 600; letter-spacing: 0.08em; padding: 10px 16px; border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tab-btn.active { color: ${T.text}; border-bottom-color: ${T.red}; }
  .tab-btn:hover { color: ${T.text}; }
  .card { background: ${T.surface}; border: 1px solid ${T.border}; border-radius: 6px; padding: 20px; margin-bottom: 16px; }
  .card-header { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: ${T.textMuted}; text-transform: uppercase; margin-bottom: 16px; }
  .stat-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat-box { background: ${T.surface2}; border: 1px solid ${T.border}; border-radius: 4px; padding: 10px 14px; flex: 1; min-width: 80px; }
  .stat-label { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: ${T.textMuted}; text-transform: uppercase; margin-bottom: 4px; font-family: 'Barlow Condensed', sans-serif; }
  .stat-value { font-size: 20px; font-weight: 700; font-family: 'Barlow Condensed', sans-serif; }
  .stat-unit { font-size: 11px; color: ${T.textMuted}; margin-left: 2px; }
  .btn-primary { background: ${T.red}; color: #fff; border: none; padding: 9px 20px; border-radius: 4px; font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; transition: background 0.15s; }
  .btn-primary:hover { background: #e83c32; }
  .btn-secondary { background: ${T.surface2}; color: ${T.text}; border: 1px solid ${T.border}; padding: 7px 14px; border-radius: 4px; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; transition: all 0.15s; }
  .btn-secondary:hover { background: ${T.border}; }
  .drop-zone { border: 1px dashed ${T.border}; border-radius: 6px; padding: 32px; text-align: center; cursor: pointer; transition: border-color 0.15s; }
  .drop-zone:hover { border-color: ${T.blue}; }
  .drop-zone.active { border-color: ${T.blue}; background: rgba(0,212,255,0.05); }
  .mode-btn { background: ${T.surface2}; border: 1px solid ${T.border}; color: ${T.textMuted}; padding: 7px 14px; border-radius: 4px; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; transition: all 0.15s; }
  .mode-btn.active { background: ${T.surface}; border-color: ${T.blue}; color: ${T.text}; }
  .alert { padding: 10px 14px; border-radius: 4px; font-size: 13px; margin-bottom: 8px; display: flex; align-items: flex-start; gap: 8px; }
  .alert-warn { background: rgba(255,184,0,0.1); border: 1px solid rgba(255,184,0,0.3); color: ${T.gold}; }
  .alert-danger { background: rgba(255,51,71,0.1); border: 1px solid rgba(255,51,71,0.3); color: ${T.red}; }
  .alert-info { background: rgba(0,212,255,0.1); border: 1px solid rgba(0,212,255,0.3); color: ${T.blue}; }
  .pct-pill { display: inline-block; padding: 2px 7px; border-radius: 3px; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; }
  .tooltip-custom { background: ${T.surface}; border: 1px solid ${T.border}; padding: 8px 12px; border-radius: 4px; font-size: 12px; }
  @keyframes fm-spin { to { transform: rotate(360deg); } }
  .fm-spinner { width: 36px; height: 36px; border: 3px solid ${T.border}; border-top-color: ${T.blue}; border-radius: 50%; animation: fm-spin 0.8s linear infinite; }
`;

// ─── ZONE COLOR HELPER ────────────────────────────────────────────────────────
function zoneColor(pctFTP, opacity = 1) {
  if (pctFTP < 0.55) return `rgba(0,212,255,${opacity})`;    // Z1 Recovery   — Signal Cyan
  if (pctFTP < 0.75) return `rgba(0,255,140,${opacity})`;    // Z2 Endurance  — Fuel Green
  if (pctFTP < 0.91) return `rgba(255,184,0,${opacity})`;    // Z3 Tempo      — Power Amber
  if (pctFTP < 1.06) return `rgba(255,140,0,${opacity})`;    // Z4 Threshold  — Amber-Orange
  if (pctFTP < 1.21) return `rgba(255,51,71,${opacity})`;    // Z5 VO2 Max    — Redline
  return               `rgba(168,85,247,${opacity})`;         // Z6 Anaerobic  — W-Prime
}

// Zone comparison — layout:
//   Zone names (evenly spaced, full readable width)
//   Plan % values
//   Plan bar
//   ── divider ──
//   Actual bar
//   Actual % values
//   Execution indicator (single pill with label + detail)
function ZoneComparisonBar({ actualStream, plannedStream, ftp }) {
  const actual  = computeZoneDist(actualStream, ftp);
  const planned = plannedStream ? computeZoneDist(plannedStream, ftp) : null;

  const indicator = planned ? (() => {
    const aH = (actual.find(z=>z.id==="z4")?.pct||0)  + (actual.find(z=>z.id==="z5")?.pct||0)  + (actual.find(z=>z.id==="z6")?.pct||0);
    const pH = (planned.find(z=>z.id==="z4")?.pct||0) + (planned.find(z=>z.id==="z5")?.pct||0) + (planned.find(z=>z.id==="z6")?.pct||0);
    const aL = (actual.find(z=>z.id==="z1")?.pct||0)  + (actual.find(z=>z.id==="z2")?.pct||0);
    const pL = (planned.find(z=>z.id==="z1")?.pct||0) + (planned.find(z=>z.id==="z2")?.pct||0);
    const hd = aH - pH, ld = aL - pL;
    if (Math.abs(hd) <= 5 && Math.abs(ld) <= 5)
      return { label: "On Target",            color: T.green, detail: "Zone distribution matched plan" };
    if (hd > 5)
      return { label: "Went Harder Than Plan", color: T.red,   detail: `+${hd}% more time in Z4–Z6 than planned` };
    if (ld > 5)
      return { label: "Went Easier Than Plan", color: T.gold,  detail: `+${ld}% more time in Z1–Z2 than planned` };
    return   { label: "Mixed",                 color: T.blue,  detail: "Zone shifts offset each other" };
  })() : null;

  // Full-width bar — segments sized by zone %
  const FullBar = ({ zones, opacity }) => (
    <div style={{ display: "flex", width: "100%", height: 10, borderRadius: 4, overflow: "hidden", gap: 1 }}>
      {zones.map(z => (
        <div key={z.id} style={{ flex: Math.max(z.pct, 1), background: z.color, opacity }}
          title={`${z.name}: ${z.pct}%`} />
      ))}
    </div>
  );

  // Values row — flex widths match the corresponding bar
  const ValRow = ({ zones, colorize }) => (
    <div style={{ display: "flex", width: "100%" }}>
      {zones.map(z => (
        <div key={z.id} style={{ flex: Math.max(z.pct, 1), textAlign: "center", fontSize: 11,
          fontFamily: "Barlow Condensed", fontWeight: 700,
          color: colorize ? z.color : T.textDim }}>
          {z.pct}%
        </div>
      ))}
    </div>
  );

  // Row label (PLAN / ACTUAL) flush left, small
  const RowLabel = ({ text }) => (
    <div style={{ fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700,
      letterSpacing: "0.1em", textTransform: "uppercase", color: T.textDim, marginBottom: 3 }}>
      {text}
    </div>
  );

  return (
    <div>
      {/* Zone names — evenly distributed, readable, color-coded. Not tied to bar widths. */}
      <div style={{ display: "flex", justifyContent: "space-between", width: "100%", marginBottom: 8 }}>
        {COGGAN_ZONES.map(z => (
          <div key={z.id} style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700,
            color: z.color, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
            {z.name}
          </div>
        ))}
      </div>

      {/* Plan */}
      {planned && (
        <div style={{ marginBottom: 2 }}>
          <RowLabel text="Plan" />
          <ValRow zones={planned} colorize={false} />
          <div style={{ marginTop: 3 }}>
            <FullBar zones={planned} opacity={0.45} />
          </div>
        </div>
      )}

      {/* Divider */}
      <div style={{ borderTop: `1px solid ${T.border}`, margin: "8px 0" }} />

      {/* Actual */}
      <div>
        <FullBar zones={actual} opacity={1} />
        <div style={{ marginTop: 3, marginBottom: 2 }}>
          <ValRow zones={actual} colorize={true} />
        </div>
        <RowLabel text="Actual" />
      </div>

      {/* Execution indicator — single pill: label + detail */}
      {indicator && (
        <div style={{ marginTop: 10 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700,
            color: indicator.color,
            background: `${indicator.color}18`,
            border: `1px solid ${indicator.color}55`,
            borderRadius: 4, padding: "4px 12px",
            letterSpacing: "0.05em",
          }}>
            <span>{indicator.label}</span>
            <span style={{ fontWeight: 400, color: indicator.color, opacity: 0.85 }}>·</span>
            <span style={{ fontWeight: 400 }}>{indicator.detail}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TERRAIN CLASSIFICATION ───────────────────────────────────────────────────
// Classifies each moving-time second into climb / flat / descent.
//
// **CC#8 (Prompt 4B Step 5):** when `alignment` is provided (per-second
// `alignFitToGpx` output), each on-route second's grade is looked up at the
// aligned GPX distance directly. Off-route seconds (rider deviated from the
// route) fall back to the FIT-altitude grade window for that second only —
// no constant gpxOffsetM single-point offset, no smearing of off-route detours
// onto the planned route. Pre-CC#8 single-point offset model is gone.
//
// Priority:
//   1. alignment[i].onRoute  → GPX segment grade at alignment[i].gpxDistM
//   2. FIT altitude (60s rolling)  → for off-route or no-alignment cases
//
// FIT fallback: 60-second rolling altitude delta / distance covered.
//   60s chosen over 30s — validation showed 60s stdev=2.54% vs 30s=3.42%,
//   and terrain distribution matched GPX much more closely (66% flat vs 68% GPX).
// Thresholds: >2% = climb, <-2% = descent, else flat.
//   Validated against Barry-Roubaix GPX: FIT-60s gives climb=23%/flat=66%/descent=12%
//   vs GPX 17%/68%/15% — close enough for terrain bucketing.
function buildTerrainStream(movingPowerSeries, movingAltSeries, movingDistSeries, gpxRoute, alignment = null) {
  const n = movingPowerSeries.length;
  const CLIMB = 0.02, DESCENT = -0.02;
  const grades = new Float32Array(n);

  const hasDistData = movingDistSeries && movingDistSeries.some(d => d > 0);
  const hasAlignment = Array.isArray(alignment) && alignment.length === n;
  const hasGpxRoute = gpxRoute?.segmentGrades?.length > 0;

  // Build cumulative-grade lookup once if GPX is available.
  let cumSegs = null;
  if (hasGpxRoute) {
    let cumBuild = 0;
    cumSegs = gpxRoute.segmentGrades.map(s => {
      cumBuild += s.distM;
      return { cumDistM: cumBuild, gradeDecimal: s.gradeDecimal };
    });
  }
  const gradeAtGpxDist = (distM) => {
    if (!cumSegs) return 0;
    // Linear scan — segmentGrades is 200 entries, fast enough.
    for (let i = 0; i < cumSegs.length; i++) {
      if (distM <= cumSegs[i].cumDistM) return cumSegs[i].gradeDecimal;
    }
    return cumSegs[cumSegs.length - 1].gradeDecimal;
  };

  // Compute FIT-altitude fallback grade for ALL seconds first — used when
  // alignment is missing or a particular second is off-route.
  const fitGrade = new Float32Array(n);
  if (movingAltSeries) {
    // FIT fallback: smooth altitude first (15s median) to remove GPS spikes,
    // then 60s rolling grade window. Clamp to ±25% to eliminate residual glitches.
    // Validated: smoothed 60s window gives climb=22%/flat=67%/descent=11% on Barry-Roubaix,
    // matching GPX ground truth (12%/77%/11%) much more closely than raw altitude.
    const SMOOTH = 15;
    const altSmoothed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const window = [];
      for (let j = Math.max(0, i - SMOOTH); j <= Math.min(n - 1, i + SMOOTH); j++) {
        const a = movingAltSeries[j];
        if (a !== null && a !== undefined && a > 0) window.push(a); // exclude null/zero (no GPS fix)
      }
      if (window.length > 0) {
        window.sort((a, b) => a - b);
        altSmoothed[i] = window[Math.floor(window.length / 2)]; // median
      } else {
        altSmoothed[i] = movingAltSeries[i] ?? 0;
      }
    }
    for (let i = 60; i < n; i++) {
      const altDelta = altSmoothed[i] - altSmoothed[i - 60];
      let dist = hasDistData
        ? (() => { let d = 0; for (let j = i-60; j < i; j++) d += (movingDistSeries[j] || 0); return d; })()
        : 60 * 4.5;
      const rawGrade = dist > 4 ? altDelta / dist : 0;
      fitGrade[i] = Math.max(-0.25, Math.min(0.25, rawGrade)); // clamp ±25%
    }
  }

  // Per-second grade selection: alignment-driven GPX lookup when on-route,
  // FIT fallback when off-route or alignment unavailable.
  for (let i = 0; i < n; i++) {
    if (hasAlignment && alignment[i].onRoute && hasGpxRoute) {
      grades[i] = gradeAtGpxDist(alignment[i].gpxDistM);
    } else {
      grades[i] = fitGrade[i];
    }
  }

  // Classify — use Array.from so we get a plain string array, not a TypedArray
  // (Float32Array.map returns a Float32Array, converting strings to NaN)
  return Array.from(grades, g => g > CLIMB ? 'climb' : g < DESCENT ? 'descent' : 'flat');
}

// Bucket moving-time data by terrain type.
//
// **CC#8 (Prompt 4B Step 5):** signature changed — `fitFirstGPS` parameter is
// gone, replaced by `alignment` (the output of `alignFitToGpx` aligning the
// FIT's per-moving-second GPS path to the GPX route). The pre-CC#8 single-
// point gpxOffsetM model assumed a constant offset between FIT distance and
// GPX distance, which broke on loop courses (Prompt 3.5) and on any ride
// where the rider went off-route. Per-second alignment handles both cases:
// loop-course start/end ambiguity is resolved by per-point nearest-neighbor,
// and off-route seconds are flagged so they don't smear onto planned-route
// terrain stats.
function bucketByTerrain(movingPowerSeries, movingAltSeries, movingDistSeries, movingHRSeries, gpxRoute, ftp, alignment, thirdsByRouteDistance = null) {
  const terrain = buildTerrainStream(movingPowerSeries, movingAltSeries, movingDistSeries, gpxRoute, alignment);
  const n = movingPowerSeries.length;
  // 4C sub-step 6 — third-index lookup. When `thirdsByRouteDistance` is
  // provided (route-distance-bucketed sets of indices), use it so terrain
  // thirds match every other "thirds" card on the page. Off-route seconds
  // (not in any route-third set) get assigned to the nearest moving-time
  // third as a non-disruptive fallback. When unavailable, legacy moving-time
  // index thirds.
  const t1End = Math.floor(n / 3);
  const t2End = Math.floor(2 * n / 3);
  let thirdIdxAt;
  if (thirdsByRouteDistance) {
    const memberOf = new Int8Array(n).fill(-1);
    for (let t = 0; t < 3; t++) {
      for (const idx of thirdsByRouteDistance[t]) memberOf[idx] = t;
    }
    thirdIdxAt = (i) => {
      const t = memberOf[i];
      if (t >= 0) return t;
      return i < t1End ? 0 : i < t2End ? 1 : 2; // off-route: time-fallback
    };
  } else {
    thirdIdxAt = (i) => i < t1End ? 0 : i < t2End ? 1 : 2;
  }

  const buckets = {
    climb:   { npPowers: [], powers: [], speeds: [], hrs: [], thirds: [{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]}] },
    flat:    { npPowers: [], powers: [], speeds: [], hrs: [], thirds: [{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]}] },
    descent: { npPowers: [], powers: [], speeds: [], hrs: [], thirds: [{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]}] },
  };

  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    const p = movingPowerSeries[i];
    const spd = movingDistSeries?.[i] || 0;
    const thirdIdx = thirdIdxAt(i);
    // npPowers includes zeros — rolling window must operate on contiguous seconds
    // to correctly weight recovery/coasting within each terrain type
    buckets[t].npPowers.push(p);
    buckets[t].thirds[thirdIdx].npPowers.push(p);
    if (p <= 0) continue; // exclude zeros from avg power, speed, HR accounting
    buckets[t].powers.push(p);
    if (spd) buckets[t].speeds.push(spd);
    if (movingHRSeries?.[i] > 0) buckets[t].hrs.push(movingHRSeries[i]);
    buckets[t].thirds[thirdIdx].powers.push(p);
    if (spd) buckets[t].thirds[thirdIdx].speeds.push(spd);
  }

  const npOf = (powers) => {
    if (!powers.length) return 0;
    const rolling = powers.map((_, i, a) => {
      const w = a.slice(Math.max(0, i - 29), i + 1);
      return w.reduce((s, p) => s + p, 0) / w.length;
    });
    return Math.round(Math.pow(rolling.reduce((s, p) => s + p ** 4, 0) / rolling.length, 0.25));
  };
  const avgOf  = (arr) => arr.length ? Math.round(arr.reduce((s,v)=>s+v,0)/arr.length) : 0;
  const avgSpd = (arr) => arr.length ? Math.round(arr.reduce((s,v)=>s+v,0)/arr.length * 2.237 * 10) / 10 : 0;

  const results = {};
  for (const [name, b] of Object.entries(buckets)) {
    const ap    = avgOf(b.powers);
    const np    = npOf(b.npPowers); // use contiguous series including zeros
    const vi    = ap > 0 ? Math.round(np / ap * 1000) / 1000 : 0;
    const spd   = avgSpd(b.speeds);
    const avgHR = b.hrs.length ? Math.round(b.hrs.reduce((s,h)=>s+h,0)/b.hrs.length) : 0;
    const pctFTP = ftp > 0 ? Math.round(np / ftp * 100) : 0;
    // Per-third NP also uses npPowers (contiguous including zeros)
    const thirds = b.thirds.map(th => ({
      avgP: avgOf(th.powers),
      np:   npOf(th.npPowers),
      avgSpd: avgSpd(th.speeds),
      count: th.powers.length,
    }));
    results[name] = {
      avgP: ap, np, vi, avgSpd: spd, avgHR, pctFTP,
      timeMins: Math.round(b.npPowers.length / 60),
      timePct:  Math.round(b.npPowers.length / n * 100),
      count: b.powers.length,
      thirds,
    };
  }
  return results;
}
const CustomTooltip = ({ active, payload, label, unit = "min" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 12 }}>
      <div style={{ color: T.textMuted, marginBottom: 4 }}>{label}{unit ? ` ${unit}` : ""}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || T.text }}>
          {p.name}: {typeof p.value === "number" ? Math.round(p.value) : p.value}
          {p.unit ? ` ${p.unit}` : ""}
        </div>
      ))}
    </div>
  );
};

// ─── POWER ZONE BAR (recharts custom shape) ───────────────────────────────────
const ZoneBar = (props) => {
  const { x, y, width, height, pctFTP, opacity = 0.7 } = props;
  if (!height || height < 0) return null;
  return <rect x={x} y={y} width={width} height={height} fill={zoneColor(pctFTP, opacity)} rx={1} />;
};

// ─── ELEVATION + POWER DUAL CHART ────────────────────────────────────────────
// 4C sub-step 1: prop renamed `displayStream` → `powerStream`. The 2-min
// `displayStream` aggregation was retired; this chart now consumes the 1-min
// `powerStream` directly. `peakGrade` was promoted onto `powerStream` so the
// elevation overlay still has terrain-peak emphasis.
function ElevPowerChart({ powerStream, gpxStats, ftp, imperial = false, detectedClimbs = [], durationMin, estimatedDurationMin }) {
  if (!powerStream || powerStream.length === 0) return null;

  const elevProfile = gpxStats?.elevProfile || [];
  const totalDistKm = gpxStats?.totalDistKm || 1;

  const eleAtDistKm = (km) => {
    if (elevProfile.length === 0) return 0;
    const idx = Math.min(elevProfile.length - 1,
      Math.max(0, Math.floor((km / totalDistKm) * elevProfile.length)));
    return elevProfile[idx].ele;
  };

  const blockDistKm = totalDistKm / powerStream.length;

  // Scale block timestamps from raw physics duration → VI-corrected duration so data
  // fills the full x-axis. VI correction stretches real-world time but doesn't change
  // the terrain order — each block covers the same distance, just takes longer.
  const rawDuration = estimatedDurationMin ?? (powerStream[powerStream.length - 1]?.time ?? 1);
  const totalDurationMin = durationMin ?? rawDuration;
  const viScale = rawDuration > 0 ? totalDurationMin / rawDuration : 1;

  const data = powerStream.map((pt) => {
    const midDistKm = pt.distKm + blockDistKm / 2;
    const eleM = eleAtDistKm(midDistKm);
    const ele = imperial ? Math.round(eleM * 3.281) : Math.round(eleM);
    return { ...pt, time: Math.round(pt.time * viScale), ele };
  });

  const eleUnit = imperial ? "ft" : "m";
  const eles = data.map(d => d.ele).filter(e => e > 0);
  const roundTo = imperial ? 50 : 10;
  const minEle = eles.length ? Math.floor(Math.min(...eles) / roundTo) * roundTo : 0;
  const maxEle = eles.length ? Math.ceil( Math.max(...eles) / roundTo) * roundTo : (imperial ? 1640 : 500);
  const useFTP = ftp || 250;

  const fmtTime = (mins) => {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${h}:${String(m).padStart(2, "0")}`;
  };

  const PowerBar = (props) => {
    const { x, y, width, height } = props;
    if (!height || height <= 0) return null;
    const pct = (props.power || 0) / useFTP;
    return <rect x={x} y={y} width={Math.max(1, width)} height={height} fill={zoneColor(pct, 0.75)} rx={1} />;
  };

  // Map climb distance fractions → scaled time axis values for ReferenceArea
  const climbBands = detectedClimbs.map(c => {
    const catDef = CLIMB_CATEGORIES.find(x => x.id === c.category);
    return {
      ...c,
      x1: Math.round(c.startDistFrac * totalDurationMin),
      x2: Math.round(c.endDistFrac   * totalDurationMin),
      color:  catDef?.color       ?? "rgba(255,255,255,0.08)",
      stroke: catDef?.borderColor ?? "rgba(255,255,255,0.2)",
    };
  });

  return (
    <div style={{ height: 200, marginTop: 8 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 44, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
          <XAxis dataKey="time" type="number" domain={[0, totalDurationMin]} tick={{ fill: T.textDim, fontSize: 10 }} tickFormatter={fmtTime} />
          <YAxis yAxisId="ele" domain={[minEle, maxEle]} tick={{ fill: T.textDim, fontSize: 10 }} width={40}
            tickFormatter={v => `${v}${eleUnit}`} />
          <YAxis yAxisId="pwr" orientation="right" domain={[0, Math.ceil(useFTP * 1.4 / 50) * 50]}
            tick={{ fill: T.textDim, fontSize: 10 }} width={40} tickFormatter={v => `${v}w`} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload;
              const speedVal = imperial
                ? `${Math.round((d?.speedKph || 0) * 0.621)}mph`
                : `${d?.speedKph}kph`;
              const activeBand = climbBands.find(b => label >= b.x1 && label <= b.x2);
              return (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 12 }}>
                  <div style={{ color: T.textMuted, marginBottom: 4 }}>{fmtTime(label)} · {d?.distKm}km</div>
                  {activeBand && (
                    <div style={{ color: activeBand.stroke, marginBottom: 4, fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      {activeBand.category} #{activeBand.id} · {activeBand.lengthKm}km · avg {activeBand.avgGrade}% · peak {activeBand.peakGradePct}% · +{imperial ? Math.round(activeBand.gainM * 3.281) : activeBand.gainM}{eleUnit}
                    </div>
                  )}
                  <div style={{ color: zoneColor((d?.power||0)/useFTP) }}>Power: {d?.power}w ({Math.round((d?.power||0)/useFTP*100)}% FTP)</div>
                  <div style={{ color: T.textMuted }}>Elev: {d?.ele}{eleUnit} · Avg grade: {d?.grade}% · Peak: {d?.peakGrade}%</div>
                  <div style={{ color: T.blue }}>Speed: {speedVal}</div>
                </div>
              );
            }}
          />
          {/* Climb bands constrained to elevation axis range only */}
          {climbBands.map((b, i) => (
            <ReferenceArea key={i} yAxisId="ele" x1={b.x1} x2={b.x2} y1={minEle} y2={maxEle}
              fill={b.color} stroke={b.stroke} strokeWidth={1} strokeDasharray="3 3" />
          ))}
          <Area yAxisId="ele" type="monotone" dataKey="ele"
            fill="rgba(100,100,110,0.35)" stroke="rgba(160,160,170,0.6)" strokeWidth={1.5}
            name="Elevation" unit={eleUnit} />
          <Bar yAxisId="pwr" dataKey="power" name="Power" unit="w" shape={PowerBar} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── BURN RATE CHART ──────────────────────────────────────────────────────────
function BurnRateChart({ overlayData, durationMin, blockMin = 5, estimatedDurationMin }) {
  if (!overlayData || overlayData.length === 0) return null;

  const rawDuration = estimatedDurationMin ?? (overlayData[overlayData.length - 1]?.time ?? 1);
  const totalDurationMin = durationMin ?? rawDuration;
  const viScale = rawDuration > 0 ? totalDurationMin / rawDuration : 1;

  // Duration-based intake targets (sports nutrition research)
  const getTargetBounds = (dur) => {
    if (dur < 60)  return { low: 0,  high: 20 };
    if (dur < 90)  return { low: 30, high: 60 };
    if (dur < 120) return { low: 45, high: 60 };
    return             { low: 60, high: 90 };
  };
  const { low: TARGET_LOW, high: TARGET_HIGH } = getTargetBounds(totalDurationMin || 240);

  // Build cumulative burn and intake from the overlay data
  let cumBurn = 0, cumIntake = 0;
  const data = overlayData.map(pt => {
    cumBurn += pt.burnRate * (blockMin / 60);
    cumIntake += pt.actualAbsorbed;
    const elapsed = pt.time / 60; // hours elapsed (raw — used for target rate calc)
    return {
      ...pt,
      time: Math.round(pt.time * viScale),
      cumBurn: Math.round(cumBurn),
      cumIntake: Math.round(cumIntake),
      deficit: Math.round(cumBurn - cumIntake),
      targetLow:  elapsed > 0 ? Math.round(TARGET_LOW  * elapsed) : 0,
      targetHigh: elapsed > 0 ? Math.round(TARGET_HIGH * elapsed) : 0,
    };
  });

  const maxVal = Math.max(...data.map(d => d.cumBurn)) * 1.1;

  return (
    <div style={{ height: 180, marginTop: 8 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="deficitGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={T.red} stopOpacity={0.25} />
              <stop offset="100%" stopColor={T.red} stopOpacity={0.03} />
            </linearGradient>
            <linearGradient id="targetZoneGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={T.green} stopOpacity={0.20} />
              <stop offset="100%" stopColor={T.green} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
          <XAxis dataKey="time" type="number" domain={[0, totalDurationMin]} tick={{ fill: T.textDim, fontSize: 10 }} tickFormatter={v => { const h = Math.floor(v/60); const m = String(Math.round(v%60)).padStart(2,'0'); return `${h}:${m}`; }} />
          <YAxis tick={{ fill: T.textDim, fontSize: 10 }} width={36} domain={[0, Math.ceil(maxVal / 50) * 50]} tickFormatter={v => `${v}g`} />
          <Tooltip content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0]?.payload;
            const inZone = d?.cumIntake >= d?.targetLow && d?.cumIntake <= d?.targetHigh;
            const belowZone = d?.cumIntake < d?.targetLow;
            return (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 12 }}>
                <div style={{ color: T.textMuted, marginBottom: 4 }}>t={label}m</div>
                <div style={{ color: T.gold }}>Burned: {d?.cumBurn}g</div>
                <div style={{ color: T.blue }}>Absorbed: {d?.cumIntake}g</div>
                <div style={{ color: T.green, fontSize: 11 }}>Target zone: {d?.targetLow}–{d?.targetHigh}g</div>
                <div style={{ color: belowZone ? T.red : inZone ? T.green : T.gold, fontWeight: 700, marginTop: 2 }}>
                  {belowZone ? `↓ Below target by ${d?.targetLow - d?.cumIntake}g` : inZone ? "✓ On target" : `↑ Above target (near ceiling)`}
                </div>
              </div>
            );
          }} />
          {/* Target zone band — green fill between 60 and 90 g/hr accumulated */}
          <Area type="monotone" dataKey="targetHigh" stroke="none" fill="url(#targetZoneGrad)" dot={false} legendType="none" activeDot={false} />
          <Area type="monotone" dataKey="targetLow" stroke="none" fill={T.bg} dot={false} legendType="none" activeDot={false} />
          {/* Target zone boundary lines */}
          <Line type="monotone" dataKey="targetHigh" stroke={T.green} strokeWidth={1} strokeDasharray="4 3" dot={false} legendType="none" opacity={0.6} />
          <Line type="monotone" dataKey="targetLow" stroke={T.green} strokeWidth={1} strokeDasharray="4 3" dot={false} legendType="none" opacity={0.4} />
          {/* Deficit fill between burn and intake */}
          <Area type="monotone" dataKey="cumBurn" stroke="none" fill="url(#deficitGrad)" dot={false} legendType="none" activeDot={false} />
          <Line type="monotone" dataKey="cumBurn" stroke={T.gold} strokeWidth={2.5} dot={false} name="Cumulative Burn" />
          <Line type="monotone" dataKey="cumIntake" stroke={T.blue} strokeWidth={2.5} dot={false} name="Cumulative Absorbed" />
          {/* Intake event markers */}
          {overlayData.filter(pt => pt.intake > 0).map((pt, i) => (
            <ReferenceLine key={i} x={pt.time} stroke={`${T.blue}80`} strokeDasharray="3 3"
              label={{ value: `+${pt.intake}g`, fill: T.blue, fontSize: 9, position: "top" }} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      {/* Legend */}
      <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 6, fontSize: 11, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 20, height: 2, background: T.gold }} />
          <span style={{ color: T.textMuted }}>Cumulative burn</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 20, height: 2, background: T.blue }} />
          <span style={{ color: T.textMuted }}>Cumulative absorbed</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 16, height: 10, background: "rgba(0,255,140,0.2)", border: "1px dashed rgba(0,255,140,0.6)", borderRadius: 2 }} />
          <span style={{ color: T.textMuted }}>Target zone ({TARGET_LOW}–{TARGET_HIGH}g/hr)</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 12, height: 10, background: "rgba(255,51,71,0.2)", borderRadius: 2 }} />
          <span style={{ color: T.textMuted }}>Deficit</span>
        </div>
      </div>
    </div>
  );
}

// ─── GLYCOGEN CHART ───────────────────────────────────────────────────────────
function GlycogenChart({ overlayData, athlete, durationMin, estimatedDurationMin }) {
  if (!overlayData || overlayData.length === 0) return null;
  const maxG = Math.round(startingGlycogen(athlete.weight) * 1.15);
  const warnLine = Math.round(maxG * 0.3);
  const bonkLine = Math.round(maxG * 0.1);
  const fmtTime = v => { const h = Math.floor(v/60); const m = String(Math.round(v%60)).padStart(2,'0'); return `${h}:${m}`; };
  const rawDuration = estimatedDurationMin ?? (overlayData[overlayData.length - 1]?.time ?? 1);
  const totalDurationMin = durationMin ?? rawDuration;
  const viScale = rawDuration > 0 ? totalDurationMin / rawDuration : 1;
  const data = overlayData.map(pt => ({ ...pt, time: Math.round(pt.time * viScale) }));

  return (
    <div style={{ height: 160, marginTop: 8 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
          <XAxis dataKey="time" type="number" domain={[0, totalDurationMin]} tick={{ fill: T.textDim, fontSize: 10 }} tickFormatter={fmtTime} />
          <YAxis tick={{ fill: T.textDim, fontSize: 10 }} width={32} domain={[0, maxG]} />
          <Tooltip content={<CustomTooltip unit="min" />} />
          <ReferenceLine y={warnLine} stroke={T.gold} strokeDasharray="4 2" label={{ value: "WARN", fill: T.gold, fontSize: 10 }} />
          <ReferenceLine y={bonkLine} stroke={T.red} strokeDasharray="4 2" label={{ value: "BONK", fill: T.red, fontSize: 10 }} />
          <Bar dataKey="power" name="Power" unit="w" fill={T.zoneGold} opacity={0.4} shape={(props) => <ZoneBar {...props} pctFTP={props.pctFTP} opacity={0.35} />} />
          <Line type="monotone" dataKey="glycogenReserve" stroke={T.green} strokeWidth={2} dot={false} name="Glycogen" unit="g" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── W'BAL CHART ──────────────────────────────────────────────────────────────
// B-22: PLAN-tab W'bal advisory caption. Always present below the PLAN W'bal
// chart; NOT shown on ANALYZE tab. Declared once so future copy iterations are
// a single-edit change.
const WBAL_ADVISORY_TEXT = "Predicted W'bal doesn't account for unmodeled surges from group dynamics, attacks, or other in-race variability. Use as a directional estimate.";

function WbalChart({ wbalData, athlete, gpxStats = null, imperial = false, durationMin, estimatedDurationMin }) {
  if (!wbalData || wbalData.length === 0) return null;
  const wPrime = _physicsUnwrap(deriveWPrime(athlete), DEFAULTS.wPrimeFallbackJ);
  const rawDuration = estimatedDurationMin ?? (wbalData[wbalData.length - 1]?.time ?? 1);
  const totalDurationMin = durationMin ?? rawDuration;
  const viScale = rawDuration > 0 ? totalDurationMin / rawDuration : 1;

  // Attach elevation to each wbal point by mapping time → distance fraction → elevProfile
  const elevProfile = gpxStats?.elevProfile || [];
  const hasAlt = elevProfile.length > 0 && totalDurationMin > 0;
  const altVals = wbalData.map(pt => {
    if (!hasAlt) return null;
    const frac = rawDuration > 0 ? pt.time / rawDuration : 0;
    const idx = Math.min(elevProfile.length - 1, Math.floor(frac * elevProfile.length));
    const eleM = elevProfile[idx]?.ele ?? null;
    return eleM !== null ? (imperial ? Math.round(eleM * 3.281) : eleM) : null;
  });
  const eleUnit = imperial ? "ft" : "m";
  const validAlts = altVals.filter(a => a !== null);
  const altMin = validAlts.length ? Math.floor(Math.min(...validAlts) / 10) * 10 : 0;
  const altMax = validAlts.length ? Math.ceil(Math.max(...validAlts) / 10) * 10 : 400;

  // 4B.5: do NOT round to integer minutes here. Post-CC#7 PLAN-side wbalData
  // is per-second (~12k entries with fractional-minute `time`); rounding
  // collapsed 60 consecutive points onto the same x and produced a staircase.
  // ANALYZE-side feeds 1-min `chartData` from `buildWbalFromRawSeries`, where
  // `pt.time` is integer minutes anyway — viScale stays a no-op rescale there.
  const data = wbalData.map((pt, i) => ({ ...pt, time: pt.time * viScale, altM: altVals[i] }));

  const fmtTime = (mins) => {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${h}:${String(m).padStart(2, "0")}`;
  };

  return (
    <div style={{ height: 180, marginTop: 8 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: hasAlt ? 44 : 8, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="wbalLineGradPlan" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#00FF8C" />
              <stop offset="60%"  stopColor="#00FF8C" />
              <stop offset="80%"  stopColor="#FFB800" />
              <stop offset="90%"  stopColor="#FF3347" />
              <stop offset="100%" stopColor="#FF3347" />
            </linearGradient>
            <linearGradient id="elevFillPlan" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#363640" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#363640" stopOpacity={0.2} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
          <XAxis dataKey="time" type="number" domain={[0, totalDurationMin]} tick={{ fill: T.textDim, fontSize: 10 }} tickFormatter={fmtTime} />
          <YAxis yAxisId="pct" domain={[0, 100]} tick={{ fill: T.textDim, fontSize: 10 }} width={36}
            tickFormatter={v => `${v}%`} />
          {hasAlt && (
            <YAxis yAxisId="alt" orientation="right" domain={[altMin, altMax]}
              tick={{ fill: T.textDim, fontSize: 10 }} width={40}
              tickFormatter={v => `${v}${eleUnit}`} />
          )}
          <Tooltip content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0]?.payload;
            const pct = Math.round(d?.wbalPct ?? 0);   // 4B.5: round at display; series carries float
            const lc = pct >= 40 ? "#00FF8C" : pct >= 20 ? "#FFB800" : "#FF3347";
            return (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 12 }}>
                <div style={{ color: T.textMuted, marginBottom: 3 }}>{fmtTime(d?.time)}</div>
                <div style={{ color: lc }}>W'bal: {pct}% ({Math.round((d?.wbal ?? 0) / 1000 * 10) / 10} kJ)</div>
                {hasAlt && d?.altM != null && <div style={{ color: T.textDim }}>Elevation: {d.altM}{eleUnit}</div>}
              </div>
            );
          }} />
          <ReferenceLine yAxisId="pct" y={40} stroke="#FFB800" strokeDasharray="4 3" strokeWidth={1}
            label={{ value: "Warn", fill: "#FFB800", fontSize: 9, position: "insideTopRight" }} />
          <ReferenceLine yAxisId="pct" y={20} stroke="#FF3347" strokeDasharray="4 3" strokeWidth={1}
            label={{ value: "Bonk", fill: "#FF3347", fontSize: 9, position: "insideTopRight" }} />
          {hasAlt && (
            <Area yAxisId="alt" type="monotone" dataKey="altM"
              fill="url(#elevFillPlan)" stroke="rgba(54,54,64,0.6)"
              strokeWidth={1} dot={false} />
          )}
          <Line yAxisId="pct" type="monotone" dataKey="wbalPct"
            stroke="url(#wbalLineGradPlan)" strokeWidth={2.5} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: T.textMuted, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ display: "inline-block", width: 16, height: 3, background: "linear-gradient(to right, #00FF8C, #FFB800, #FF3347)", borderRadius: 1 }} />
          W' Balance
        </span>
        {hasAlt && (
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, background: "rgba(54,54,64,0.8)", borderRadius: 2 }} />
            Elevation
          </span>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ display: "inline-block", width: 16, height: 1, borderTop: "1.5px dashed #FFB800" }} />
          Warn 40%
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ display: "inline-block", width: 16, height: 1, borderTop: "1.5px dashed #FF3347" }} />
          Bonk 20%
        </span>
      </div>
    </div>
  );
}

// ─── INTAKE EVENT ROW ─────────────────────────────────────────────────────────
function IntakeRow({ event, onRemove, products }) {
  const prod = products.find(p => p.id === event.productId);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: T.surface2, borderRadius: 4, marginBottom: 6 }}>
      <span style={{ color: T.textMuted, fontSize: 11, fontFamily: "Barlow Condensed", minWidth: 36 }}>
        {minsToHHMM(event.time)}
      </span>
      <span style={{ flex: 1, fontSize: 13 }}>{event.name}</span>
      <span style={{ color: T.gold, fontSize: 12, fontFamily: "Barlow Condensed" }}>{event.carbs}g</span>
      <button onClick={onRemove} style={{ background: "none", border: "none", color: T.textDim, fontSize: 14, padding: "0 4px" }}>×</button>
    </div>
  );
}

// ─── INTAKE FORM ──────────────────────────────────────────────────────────────
function IntakeForm({ products, onAdd, maxTime }) {
  const [selProd, setSelProd] = useState(products[0]?.id || 1);
  const [timeMin, setTimeMin] = useState(30);

  const handleAdd = () => {
    const prod = products.find(p => p.id === Number(selProd));
    if (!prod) return;
    onAdd({ id: Date.now(), time: timeMin, productId: prod.id, name: prod.name, carbs: prod.carbs, sodium: prod.sodium });
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
      <select value={selProd} onChange={e => setSelProd(Number(e.target.value))} style={{ flex: 2, minWidth: 140 }}>
        {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.carbs}g)</option>)}
      </select>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <label style={{ fontSize: 11, color: T.textMuted, whiteSpace: "nowrap" }}>@ min</label>
        <input type="number" value={timeMin} onChange={e => setTimeMin(Number(e.target.value))} min={0} max={maxTime} style={{ width: 60 }} />
      </div>
      <button className="btn-secondary" onClick={handleAdd}>+ Add</button>
    </div>
  );
}

// ─── FILE DROP ZONE ───────────────────────────────────────────────────────────
function DropZone({ accept, label, onFile, loaded }) {
  const [drag, setDrag] = useState(false);
  const inp = useRef();

  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    if (accept === ".fit") {
      reader.readAsArrayBuffer(file);
      reader.onload = e => onFile(e.target.result, file.name);
    } else {
      reader.readAsText(file);
      reader.onload = e => onFile(e.target.result, file.name);
    }
  };

  return (
    <div
      className={`drop-zone${drag ? " active" : ""}`}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
      onClick={() => inp.current.click()}
    >
      <input ref={inp} type="file" accept={accept} style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
      {loaded
        ? <span style={{ color: T.green, fontSize: 13 }}>✓ {loaded}</span>
        : <span style={{ color: T.textDim, fontSize: 13 }}>{label}</span>
      }
    </div>
  );
}

// ─── WATT INPUT ───────────────────────────────────────────────────────────────
// Module-level component so React doesn't remount it on every PlanTab render.
// Uses local string state + onBlur to commit — avoids one-digit-at-a-time bug.
function WattInput({ value, onChange, placeholder = "none" }) {
  const [str, setStr] = useState(value > 0 ? String(value) : "");
  // Sync display when parent resets value to 0 (e.g. clear button)
  useEffect(() => { setStr(value > 0 ? String(value) : ""); }, [value]);
  return (
    <div style={{ position: "relative", width: 72 }}>
      <input type="number" min={0} max={2000} step={5}
        value={str}
        placeholder={placeholder}
        onChange={e => setStr(e.target.value)}
        onBlur={() => {
          const num = parseInt(str, 10);
          if (str === "" || isNaN(num) || num <= 0) { onChange(0); setStr(""); }
          else { onChange(num); setStr(String(num)); }
        }}
        style={{ width: "100%", paddingRight: 14, fontSize: 11 }} />
      {value > 0 && <span style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: T.textMuted, pointerEvents: "none" }}>w</span>}
    </div>
  );
}

// ─── ATHLETE MODAL ────────────────────────────────────────────────────────────
// ─── BIKE MODAL ───────────────────────────────────────────────────────────────
function BikeModal({ bike, onSave, onClose, imperial }) {
  const [form, setForm] = useState({ ...bike });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const { CdA, eta, tireMult } = _physicsUnwrap(bikePhysics(form), DEFAULTS.bikePhysics);
  // Local display string for weight — avoids mid-keystroke unit conversion mangling the field
  const [weightStr, setWeightStr] = useState(
    imperial ? String(Math.round((bike.weight ?? 0) * 2.205 * 10) / 10) : String(bike.weight ?? 0)
  );
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 24, width: 380 }}>
        <div className="card-header" style={{ marginBottom: 16 }}>{bike.id ? "Edit Bike" : "New Bike"}</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Name</label>
          <input type="text" value={form.name} onChange={e => set("name", e.target.value)} style={{ width: "100%" }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Weight ({imperial ? "lb" : "kg"})</label>
          <input type="number" value={weightStr}
            onChange={e => setWeightStr(e.target.value)}
            onBlur={() => {
              const num = parseFloat(weightStr);
              if (!isNaN(num) && num > 0)
                set("weight", imperial ? Math.round(num / 2.205 * 100) / 100 : num);
            }}
            style={{ width: "100%" }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Position</label>
          <select value={form.positionId} onChange={e => set("positionId", e.target.value)} style={{ width: "100%" }}>
            {POSITIONS.map(p => <option key={p.id} value={p.id}>{p.label} (CdA {p.CdA})</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Drivetrain</label>
          <select value={form.drivetrainId} onChange={e => set("drivetrainId", e.target.value)} style={{ width: "100%" }}>
            {DRIVETRAINS.map(d => <option key={d.id} value={d.id}>{d.label} (η {d.eta})</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Tire Type</label>
          <select value={form.tireId} onChange={e => set("tireId", e.target.value)} style={{ width: "100%" }}>
            {TIRE_MULTIPLIERS.map(t => <option key={t.id} value={t.id}>{t.label} (×{t.mult} Crr)</option>)}
          </select>
        </div>

        {/* Live physics summary */}
        <div style={{ background: T.surface2, borderRadius: 4, padding: "10px 12px", marginBottom: 16, display: "flex", gap: 16, fontSize: 12 }}>
          <div><span style={{ color: T.textMuted }}>CdA </span><span style={{ fontFamily: "Barlow Condensed", fontWeight: 700 }}>{CdA}</span></div>
          <div><span style={{ color: T.textMuted }}>η </span><span style={{ fontFamily: "Barlow Condensed", fontWeight: 700 }}>{eta}</span></div>
          <div><span style={{ color: T.textMuted }}>Tire ×Crr </span><span style={{ fontFamily: "Barlow Condensed", fontWeight: 700 }}>{tireMult}</span></div>
          <div><span style={{ color: T.textMuted }}>Weight </span><span style={{ fontFamily: "Barlow Condensed", fontWeight: 700 }}>{imperial ? Math.round(form.weight * 2.205 * 10)/10 : form.weight}{imperial ? "lb" : "kg"}</span></div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => { onSave(form); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function AthleteModal({ athlete, onSave, onClose, imperial }) {
  const blankTests = [{ secs: 0, watts: 0 }, { secs: 0, watts: 0 }, { secs: 0, watts: 0 }];
  const [form, setForm] = useState({
    phenotype: "allrounder",
    cpTests: blankTests,
    cpTestedAt: null,
    maxCarbIntakeGPerHr: 90,  // backward-compat for athletes saved before this field existed
    ...athlete,
  });
  const [cpOpen, setCpOpen] = useState(false);

  // B-24: Override section auto-opens for existing athletes whose saved
  // `wPrime` is set, so the user can see the value driving Tier 0 and clear
  // it if desired. New athletes (`id === null`) start with the section
  // closed regardless of the form's wPrime default — they shouldn't be
  // pre-saddled with an override they didn't ask for.
  const _initialWPrimeJ = Number(athlete?.wPrime);
  const _hasInitialOverride = athlete?.id != null && _initialWPrimeJ > 0;
  const [overrideOpen, setOverrideOpen] = useState(_hasInitialOverride);
  const [overrideVal, setOverrideVal] = useState(
    _hasInitialOverride ? String(Math.round(_initialWPrimeJ / 100) / 10) : ""
  );

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Local display string for weight — avoids mid-keystroke unit conversion mangling the field
  const [weightStr, setWeightStr] = useState(
    imperial ? String(Math.round((athlete.weight ?? 0) * 2.205 * 10) / 10) : String(athlete.weight ?? 0)
  );

  // B-24: Live derivation that ignores `form.wPrime` (the override path).
  // The "Anaerobic Reserve" display in this modal needs to react to live
  // edits of phenotype/FTP/cpTests so the user sees what *would* be saved
  // if they cleared the override. Passing `wPrime: null` to deriveWPrime
  // forces Tier 0 to skip and walks Tier 1 → 2 → 3 from current form state.
  const derivedWPrime = _physicsUnwrap(
    deriveWPrime({ ...form, wPrime: null }),
    DEFAULTS.wPrimeFallbackJ,
  );
  const cpResult = computeCP(form.cpTests);

  // B-24: Single source of truth for "is the override active?" — purely the
  // input field's content (whitespace-only treated as empty). NOT gated on
  // `overrideOpen` (which is just visual chrome — collapsing the section
  // shouldn't silently clear the value).
  const _overrideTrimmed = overrideVal.trim();
  const overrideJ = _overrideTrimmed === ""
    ? null
    : Math.round(Number(_overrideTrimmed) * 1000);
  // Active W' the form would save right now: override wins when set; else
  // the live derivation walks the lower tiers.
  const activeWPrimeJ = (overrideJ != null && overrideJ > 0) ? overrideJ : derivedWPrime;

  // Determine confidence label
  const hasValidCpTests = cpResult !== null;
  const confidenceLabel = () => {
    if (hasValidCpTests) {
      const fit = cpResult.r2;
      if (fit >= 97) return { text: `CP test · ${fit}% fit ✓`, color: T.green };
      if (fit >= 90) return { text: `CP test · ${fit}% fit`, color: T.gold };
      return { text: `CP test · ${fit}% fit — low confidence`, color: T.red };
    }
    return { text: "Estimated from athlete profile. Enter test data below for most accurate result.", color: T.textMuted };
  };
  const conf = confidenceLabel();

  // CP test section status badge
  const cpBadge = () => {
    if (hasValidCpTests) {
      const fit = cpResult.r2;
      const daysAgo = form.cpTestedAt ? Math.floor((Date.now() - new Date(form.cpTestedAt)) / 86400000) : null;
      const stale = daysAgo !== null && daysAgo > 90;
      if (stale) return { text: `${fit}% fit · ${daysAgo}d ago ⚠`, color: T.gold };
      return { text: `${fit}% fit ✓`, color: T.green };
    }
    return { text: "NOT COMPLETED ⚠", color: T.gold };
  };
  const badge = cpBadge();

  // Parse MM:SS input fields into seconds
  const testMins = (i) => Math.floor((form.cpTests[i]?.secs || 0) / 60);
  const testSecs = (i) => (form.cpTests[i]?.secs || 0) % 60;
  const setTestTime = (i, mins, secs) => {
    const updated = form.cpTests.map((t, idx) => idx === i ? { ...t, secs: mins * 60 + secs } : t);
    set("cpTests", updated);
  };
  const setTestWatts = (i, w) => {
    const updated = form.cpTests.map((t, idx) => idx === i ? { ...t, watts: w } : t);
    set("cpTests", updated);
  };

  const CP_TEST_TARGETS = ["~3 min", "~5 min", "~12 min"];

  const handleSave = () => {
    const saved = { ...form };
    // B-24: Override input is the authoritative write path for `wPrime`.
    // When the field has content → store the override (J). When empty/cleared
    // → store `null` so deriveWPrime's Tier 0 skips and lower tiers (CP test /
    // phenotype / FTP) drive the math. Storing 0 would collide with Tier 0's
    // `> 0` guard and is semantically different — avoid.
    saved.wPrime = (overrideJ != null && overrideJ > 0) ? overrideJ : null;
    // Stamp cpTestedAt if tests are valid and not previously stamped
    if (hasValidCpTests && !saved.cpTestedAt) saved.cpTestedAt = new Date().toISOString();
    onSave(saved);
    onClose();
  };

  const ph = RIDER_PHENOTYPES.find(p => p.id === form.phenotype);
  // B-24: Display reflects what would be saved right now — same priority as
  // handleSave (override → derivation). Updates reactively on every input
  // change because both `overrideJ` and `derivedWPrime` are computed inline.
  const displayWkJ = Math.round(activeWPrimeJ / 100) / 10;

  const sectionDivider = (label) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "20px 0 14px" }}>
      <div style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.12em", color: T.textMuted, textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ flex: 1, height: 1, background: T.border }} />
    </div>
  );

  const inputStyle = { width: "100%", background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 4, padding: "7px 10px", color: T.text, fontSize: 13, fontFamily: "Barlow, sans-serif" };
  const labelStyle = { fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 24, width: 380, maxHeight: "90vh", overflowY: "auto" }}>
        <div className="card-header" style={{ marginBottom: 16 }}>{athlete.id ? "Edit Athlete" : "New Athlete"}</div>

        {/* ── BASIC FIELDS ── */}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Name</label>
          <input style={inputStyle} type="text" value={form.name} onChange={e => set("name", e.target.value)} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>FTP (w)</label>
          <input style={inputStyle} type="number"
            value={form.ftp || ""}
            onChange={e => set("ftp", e.target.value === "" ? 0 : Number(e.target.value))} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Max HR (bpm)</label>
          <input style={inputStyle} type="number"
            value={form.maxHR || ""}
            onChange={e => set("maxHR", e.target.value === "" ? 0 : Number(e.target.value))} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Weight ({imperial ? "lb" : "kg"})</label>
          <input style={inputStyle} type="number"
            value={weightStr}
            onChange={e => setWeightStr(e.target.value)}
            onBlur={() => {
              const num = parseFloat(weightStr);
              if (!isNaN(num) && num > 0) {
                set("weight", imperial ? Math.round(num / 2.205 * 100) / 100 : num);
              }
            }} />
        </div>

        {/* ── POWER PROFILE SECTION ── */}
        {sectionDivider("Power Profile")}

        {/* Rider Phenotype */}
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Rider Phenotype</label>
          <select style={inputStyle} value={form.phenotype || "allrounder"} onChange={e => set("phenotype", e.target.value)}>
            {RIDER_PHENOTYPES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {ph && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 5, lineHeight: 1.4 }}>{ph.desc}</div>}
        </div>

        {/* W' display */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.12em", color: T.textMuted, textTransform: "uppercase", marginBottom: 6 }}>Anaerobic Reserve</div>
          {/* Row 1: number + W' tag + confidence warning */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
              <div style={{ fontFamily: "Barlow Condensed", fontSize: 28, fontWeight: 700, color: T.text }}>{displayWkJ} kJ</div>
              <div style={{ fontSize: 11, color: T.textDim, fontFamily: "Barlow Condensed" }}>W'</div>
            </div>
            <div style={{ fontSize: 11, color: conf.color, lineHeight: 1.4 }}>{conf.text}</div>
          </div>
          {/* Row 2: description */}
          <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
            Anaerobic reserve represents your available energy for surges and climbs above threshold. Typical range: 15–35 kJ in trained athletes.
          </div>
        </div>

        {/* CP Test collapsible */}
        <div style={{ background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 8 }}>
          <button onClick={() => setCpOpen(o => !o)}
            style={{ width: "100%", background: "none", border: "none", padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", color: T.text }}>
            <span style={{ fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Critical Power Test Data</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.08em", color: badge.color }}>{badge.text}</span>
              <span style={{ color: T.textMuted, fontSize: 12 }}>{cpOpen ? "▲" : "▼"}</span>
            </div>
          </button>

          {cpOpen && (
            <div style={{ padding: "0 12px 14px" }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
                Enter average power from 3 steady, evenly-paced max efforts.
              </div>

              {/* Column headers */}
              <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr", gap: 6, marginBottom: 6 }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em" }}>Target</div>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em" }}>Duration</div>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em" }}>Avg Power</div>
              </div>

              {CP_TEST_TARGETS.map((target, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr", gap: 6, marginBottom: 8, alignItems: "center" }}>
                  <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed" }}>{target}</div>
                  {/* MM : SS */}
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="number" min="0" max="59"
                      value={testMins(i) || ""}
                      placeholder="MM"
                      onChange={e => setTestTime(i, Number(e.target.value) || 0, testSecs(i))}
                      style={{ ...inputStyle, width: 48, textAlign: "center", padding: "6px 4px" }} />
                    <span style={{ color: T.textMuted, fontSize: 13 }}>:</span>
                    <input type="number" min="0" max="59"
                      value={testSecs(i) || ""}
                      placeholder="SS"
                      onChange={e => setTestTime(i, testMins(i), Number(e.target.value) || 0)}
                      style={{ ...inputStyle, width: 48, textAlign: "center", padding: "6px 4px" }} />
                  </div>
                  {/* Watts */}
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="number" min="0"
                      value={form.cpTests[i]?.watts || ""}
                      placeholder="W"
                      onChange={e => setTestWatts(i, Number(e.target.value) || 0)}
                      style={{ ...inputStyle, padding: "6px 8px" }} />
                  </div>
                </div>
              ))}

              {/* Clear button — disabled when all fields are already blank */}
              {(() => {
                const cpEmpty = form.cpTests.every(t => !t.secs && !t.watts) && !form.cpTestedAt;
                return (
                  <button
                    className="btn-secondary"
                    disabled={cpEmpty}
                    style={{ fontSize: 11, marginTop: 4, marginBottom: 8, opacity: cpEmpty ? 0.35 : 1, cursor: cpEmpty ? "default" : "pointer" }}
                    onClick={() => {
                      set("cpTests", [{ secs: 0, watts: 0 }, { secs: 0, watts: 0 }, { secs: 0, watts: 0 }]);
                      set("cpTestedAt", null);
                    }}
                  >
                    Clear Values
                  </button>
                );
              })()}

              {/* Live CP result */}
              {cpResult && (
                <div style={{ marginTop: 10, padding: "10px 12px", background: T.bg, borderRadius: 4, border: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", gap: 20 }}>
                    <div>
                      <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em" }}>CP</div>
                      <div style={{ fontFamily: "Barlow Condensed", fontSize: 18, fontWeight: 700, color: T.text }}>{cpResult.cp}w</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em" }}>W'</div>
                      <div style={{ fontFamily: "Barlow Condensed", fontSize: 18, fontWeight: 700, color: T.text }}>{Math.round(cpResult.wPrime / 100) / 10} kJ</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em" }}>Fit</div>
                      <div style={{ fontFamily: "Barlow Condensed", fontSize: 18, fontWeight: 700, color: cpResult.r2 >= 97 ? T.green : cpResult.r2 >= 90 ? T.gold : T.red }}>{cpResult.r2}%</div>
                    </div>
                  </div>
                  {cpResult.r2 < 95 && (
                    <div style={{ fontSize: 11, color: T.gold, marginTop: 8 }}>Low fit — one or more efforts may have been unevenly paced. Re-test or enter W' manually for best accuracy.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Manual override */}
        <div style={{ background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 6, marginBottom: 16 }}>
          <button onClick={() => setOverrideOpen(o => !o)}
            style={{ width: "100%", background: "none", border: "none", padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", color: T.text }}>
            <span style={{ fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Override W' Manually</span>
            <span style={{ color: T.textMuted, fontSize: 12 }}>{overrideOpen ? "▲" : "▼"}</span>
          </button>
          {overrideOpen && (
            <div style={{ padding: "0 12px 14px" }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 8 }}>Enter a known W' value from lab testing or a trusted source.</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="number" min="0" placeholder="kJ"
                  value={overrideVal}
                  onChange={e => setOverrideVal(e.target.value)}
                  style={{ ...inputStyle, width: 100 }} />
                <span style={{ fontSize: 12, color: T.textMuted }}>kJ</span>
              </div>
            </div>
          )}
        </div>

        {/* ── NUTRITION SECTION ── */}
        {sectionDivider("Nutrition")}
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Max Carb Intake (g/hr)</label>
          <input style={inputStyle} type="number" min="60" max="150" step="1"
            value={form.maxCarbIntakeGPerHr ?? ""}
            onChange={e => set("maxCarbIntakeGPerHr", e.target.value === "" ? 90 : Number(e.target.value))} />
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 5, lineHeight: 1.4 }}>
            Default 90 g/hr. Trained athletes may sustain 100–120+. Limited by gut absorption, not by power output.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── PLAN TAB ─────────────────────────────────────────────────────────────────
function PlanTab({ athlete: currentAthlete, athletes, setActiveAthleteId, products, races, setRaces, imperial, bikes, setBikes, activeBikeId, setActiveBikeId }) {
  const [gpxFile, setGpxFile] = useState(null);
  const [surfaceMix, setSurfaceMix] = useState([
    { id: "tarmac",   pct: 30  },
    { id: "gravel_2", pct: 60  },
    { id: "dirt",     pct: 10  },
  ]);
  const [gpxStats, setGpxStats] = useState(null);
  const [manualDist, setManualDist] = useState(100);
  const [manualGain, setManualGain] = useState(1500);
  const [pacingMode, setPacingMode] = useState("constant_if");
  const [targetIF, setTargetIF] = useState(0.76);
  const [maxPower, setMaxPower] = useState("");
  // Climb-cap state pre-populates from FTP per spec 4.2 Group C. User edits
  // persist; on user-clear the computePlan auto-restore path refills.
  const [climbCategories, setClimbCategories] = useState(() =>
    buildDefaultClimbCaps(currentAthlete?.ftp) ?? {
      moderate: { min: 0, max: 0 },
      steep:    { min: 0, max: 0 },
      wall:     { min: 0, max: 0 },
    });
  // TODO(weather): populated by fetchWeather() in full app
  const [weatherContext, setWeatherContext] = useState({
    tempC: null,       // null = not set; affects rho (air density)
    precipPct: null,   // informational only for now
    windSpeedMs: 0,    // m/s; fed into physics model
    windDirDeg: 270,   // degrees from; fed into physics model
    windEff: 30,       // % effectiveness (accounts for gusts, shelter, heading variation)
  });
  const [goalTimeMin, setGoalTimeMin] = useState(240);
  const [numSegments, setNumSegments] = useState(3);
  const [segments, setSegments] = useState([]);
  const [pacingPlan, setPacingPlan] = useState(null);
  const [preRaceMeal, setPreRaceMeal] = useState(120);
  const [intakeEvents, setIntakeEvents] = useState([]);
  const [planName, setPlanName] = useState("Race Plan");
  const [saved, setSaved] = useState(false);
  const [activeRaceId, setActiveRaceId] = useState(null);
  const [snapshotAthlete, setSnapshotAthlete] = useState(null);
  const [snapshotBike, setSnapshotBike] = useState(null);

  // When a race is loaded, physics use the snapshot; otherwise use the current active athlete/bike.
  const athlete = snapshotAthlete ?? currentAthlete;
  const currentActiveBike = (bikes || []).find(b => b.id === activeBikeId) || DEFAULT_BIKE;

  const effectiveStats = gpxStats || {
    totalDistKm: manualDist,
    elevGainM: manualGain,
    elevLossM: Math.round(manualGain * 0.85),
    segmentGrades: [],
    elevProfile: [],
  };
  const activeBike = snapshotBike ?? currentActiveBike;
  const { CdA, eta, tireMult } = _physicsUnwrap(bikePhysics(activeBike), DEFAULTS.bikePhysics);

  const handleGPX = (text, name) => {
    const stats = parseGPX(text);
    if (stats) { setGpxStats(stats); setGpxFile(name); }
  };


  const buildSegments = (n) => {
    const dist = effectiveStats.totalDistKm;
    const segLen = dist / n;
    return Array.from({ length: n }, (_, i) => ({
      id: i, startKm: Math.round(i * segLen * 10) / 10,
      endKm: Math.round((i + 1) * segLen * 10) / 10, targetIF: 0.76
    }));
  };

  // Average headwind for summary display in the weather card
  const avgCourseBearing = gpxStats?.avgCourseBearing ?? 0;
  const windHeadMs = weatherContext.windSpeedMs > 0
    ? weatherContext.windSpeedMs * Math.cos(
        ((weatherContext.windDirDeg - avgCourseBearing) * Math.PI) / 180
      )
    : 0;
  // Note: buildPowerStream uses per-block bearings from gpxStats.courseBearings
  // Air density from temperature (falls back to standard if not set)
  const rhoActual = rhoFromTemp(weatherContext.tempC);

  const computePlan = () => {
    try {
      const Crr = _physicsUnwrap(blendedCrr(surfaceMix, tireMult), DEFAULTS.Crr);
      const effWindMs = weatherContext.windSpeedMs * (weatherContext.windEff / 100);
      const mxPwr = maxPower !== "" ? Number(maxPower) : Infinity;

      // Group C auto-restore: refill any cleared / zero `max` cap from the
      // FTP-based defaults before calling buildPowerStream. If the resolved
      // caps differ from current state, also update state so the UI shows
      // the restored values. If FTP is missing, populatedCaps is null —
      // buildPowerStream's structured-error guard surfaces that case.
      const populatedCaps = ensureClimbCapsPopulated(climbCategories, athlete?.ftp);
      const capsForPlan = populatedCaps ?? climbCategories;
      if (populatedCaps && JSON.stringify(populatedCaps) !== JSON.stringify(climbCategories)) {
        setClimbCategories(populatedCaps);
      }

      let strat;
      if (pacingMode === "constant_if") {
        const flatIF = flatIFForTargetNP(
          targetIF, effectiveStats, athlete, Crr, mxPwr, CdA, eta,
          activeBike.weight, rhoActual, effWindMs, weatherContext.windDirDeg,
          capsForPlan
        );
        // Spec 4.1 #2: flatIFForTargetNP can return a structured error when
        // the requested NP IF is unreachable under the current caps. Surface
        // to the user with the maxAchievableIF info so they can adjust.
        if (flatIF && typeof flatIF === 'object' && flatIF.ok === false) {
          alert(
            flatIF.reason === 'target_unreachable_with_caps'
              ? `Target NP IF ${targetIF.toFixed(2)} is not achievable on this course with your current climb caps. ` +
                `Maximum achievable: ${flatIF.maxAchievableIF.toFixed(2)}. ` +
                `Either lower your NP IF target or raise your climb caps.`
              : `Plan generation failed: ${flatIF.reason}`
          );
          return;
        }
        strat = { mode: "constant_if", targetIF: flatIF };
      } else if (pacingMode === "segments") {
        strat = { mode: "segments", segments };
      } else {
        if (goalTimeMin > 0) {
          let lo = 0.30, hi = 1.15;
          for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            const testStrat = { mode: "constant_if", targetIF: mid };
            // Search applies caps (spec 4.1 #1) — same physics in search and final.
            const testResult = buildPowerStream(effectiveStats, athlete, testStrat, Crr, mxPwr, CdA, eta, activeBike.weight, rhoActual, effWindMs, weatherContext.windDirDeg, capsForPlan);
            if (testResult && typeof testResult === 'object' && testResult.ok === false) break;
            const testVI = computeVI(effectiveStats, surfaceMix, testResult.estimatedDurationMin);
            testVI.correctedDurationMin > goalTimeMin ? lo = mid : hi = mid;
          }
          strat = { mode: "constant_if", targetIF: Math.min(1.05, Math.max(0.30, (lo + hi) / 2)) };
        } else {
          strat = { mode: "constant_if", targetIF: 0.76 };
        }
      }
      // B-23: final plan uses two-pass surge factor on detected climbs.
      // Search loops (flatIFForTargetNP, goal-time search, requiredIF preview)
      // still use static-cap buildPowerStream — converged IF then feeds the
      // surge-adjusted final pass. Routes with no detected climbs skip pass 2.
      const result = buildPowerStreamWithSurge(effectiveStats, athlete, strat, Crr, mxPwr, CdA, eta, activeBike.weight, rhoActual, effWindMs, weatherContext.windDirDeg, capsForPlan);
      // Group C: buildPowerStream may return a structured error if the climb-
      // cap auto-restore couldn't run (FTP missing). Surface to the user.
      if (result && typeof result === 'object' && result.ok === false) {
        alert(`Plan generation failed: ${result.reason}.${
          result.reason === 'climb_cap_unset'
            ? ' Athlete FTP is required for climb-cap defaults — please set FTP in the athlete profile.'
            : ''
        }`);
        return;
      }
      const viData = computeVI(effectiveStats, surfaceMix, result.estimatedDurationMin);
      setPacingPlan({ ...result, ...viData, resolvedNpIF: result.ifActual });
      setSaved(false);
    } catch(e) {
      alert("Plan computation error: " + e.message + "\n" + e.stack?.split('\n').slice(0,3).join('\n'));
    }
  };

  const overlayData = pacingPlan
    ? buildNutritionOverlay(pacingPlan.powerStream, intakeEvents, athlete, preRaceMeal, 1) : [];
  // CC#7 (Prompt 4B Step 2): prefer per-second stream at dt=1 for PLAN-side
  // W'bal — matches ANALYZE side's 1-sec math and device numbers. Legacy
  // plans (saved before 4B) lack `powerStreamPerSec`; fall back to 1-min
  // blocks at dt=60 — sub-1% drift, acceptable until next recompute.
  const wbalData = pacingPlan
    ? (pacingPlan.powerStreamPerSec
        ? buildWbal(pacingPlan.powerStreamPerSec, athlete, { blockSeconds: 1 })
        : buildWbal(pacingPlan.powerStream, athlete))
    : [];

  // Sensitivity analysis state — sliders adjust inputs, show Δ duration live
  const [sensOpen, setSensOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sensPower,  setSensPower]  = useState(0);  // % adjustment to IF
  const [sensWeight, setSensWeight] = useState(0);  // lbs/kg delta
  const [sensCdA,    setSensCdA]    = useState(0);  // % adjustment to CdA
  const [sensCrr,    setSensCrr]    = useState(0);  // % adjustment to Crr

  const sensBaseDuration = pacingPlan?.estimatedDurationMin ?? 0;
  const sensAdjDuration = pacingPlan ? (() => {
    const Crr = _physicsUnwrap(blendedCrr(surfaceMix, tireMult), DEFAULTS.Crr) * (1 + sensCrr / 100);
    const adjCdA = CdA * (1 + sensCdA / 100);
    const adjIF = pacingPlan.ifActual * (1 + sensPower / 100);
    const weightDeltaKg = imperial ? sensWeight / 2.205 : sensWeight;
    const adjAthlete = { ...athlete, weight: Math.max(40, athlete.weight + weightDeltaKg) };
    const adjBase = _physicsUnwrap(estimateDuration(effectiveStats, athlete, pacingPlan.ifActual, _physicsUnwrap(blendedCrr(surfaceMix, tireMult), DEFAULTS.Crr), CdA, eta, activeBike.weight, rhoActual), 0);
    const adjNew  = _physicsUnwrap(estimateDuration(effectiveStats, adjAthlete, adjIF, Crr, adjCdA, eta, activeBike.weight, rhoActual), 0);
    return sensBaseDuration + (adjNew - adjBase);
  })() : 0;
  const sensDeltaMin = sensAdjDuration - sensBaseDuration;
  const sensAnyActive = sensPower !== 0 || sensWeight !== 0 || sensCdA !== 0 || sensCrr !== 0;

  const saveOrUpdateRace = async () => {
    const raceRecord = {
      name: planName,
      updatedAt: new Date().toISOString(),
      status: 'planned',
      // B-6: complete snapshot of athlete state at plan time. Centralized via
      // buildAthleteSnapshot — all fields plan/analyze math may consume.
      athleteSnapshot: buildAthleteSnapshot(athlete),
      bikeSnapshot: {
        id: activeBike.id, name: activeBike.name, weight: activeBike.weight,
        positionId: activeBike.positionId, drivetrainId: activeBike.drivetrainId, tireId: activeBike.tireId,
      },
      athleteId: currentAthlete.id,
      bikeId: currentActiveBike.id,
      plan: {
        route: gpxStats,
        gpxFileName: gpxFile,
        pacingPlan,
        nutritionPlan: { preRaceMeal, intakeEvents: [...intakeEvents] },
        conditions: { ...weatherContext },
        surfaceMix: [...surfaceMix],
        climbCategories: { ...climbCategories },
        pacingMode,
        targetIF,
        maxPower: maxPower === '' ? null : Number(maxPower),
        goalTimeMin,
        segments: [...segments],
      },
    };
    try {
      if (activeRaceId) {
        await updateRace(activeRaceId, raceRecord);
        setRaces(prev => prev.map(r => r.id === activeRaceId ? { ...r, ...raceRecord, id: activeRaceId } : r));
      } else {
        raceRecord.createdAt = new Date().toISOString();
        raceRecord.fit = null;
        const newId = await saveRace(raceRecord);
        setRaces(prev => [...prev, { ...raceRecord, id: newId }]);
        setActiveRaceId(newId);
      }
      setSaved(true);
    } catch (e) {
      alert('Failed to save race: ' + e.message);
    }
  };

  const loadRace = (race) => {
    setActiveRaceId(race.id);
    setSnapshotAthlete(race.athleteSnapshot);
    setSnapshotBike(race.bikeSnapshot ?? null);
    setGpxStats(race.plan.route ?? null);
    setGpxFile(race.plan.gpxFileName ?? null);
    setSurfaceMix(race.plan.surfaceMix ?? [{ id: "tarmac", pct: 30 }, { id: "gravel_2", pct: 60 }, { id: "dirt", pct: 10 }]);
    setWeatherContext(race.plan.conditions ?? { tempC: null, precipPct: null, windSpeedMs: 0, windDirDeg: 270, windEff: 30 });
    setPacingMode(race.plan.pacingMode ?? 'constant_if');
    setTargetIF(race.plan.targetIF ?? 0.76);
    setMaxPower(race.plan.maxPower != null ? String(race.plan.maxPower) : '');
    // Group C: backward-compat for races saved before pre-population existed.
    // ensureClimbCapsPopulated preserves user-set positive values and fills
    // any zero/missing `max` from the FTP-based defaults.
    const savedCaps = race.plan.climbCategories ?? { moderate: { min: 0, max: 0 }, steep: { min: 0, max: 0 }, wall: { min: 0, max: 0 } };
    setClimbCategories(ensureClimbCapsPopulated(savedCaps, currentAthlete?.ftp) ?? savedCaps);
    setGoalTimeMin(race.plan.goalTimeMin ?? 240);
    setSegments(race.plan.segments ?? []);
    setNumSegments(race.plan.segments?.length ?? 3);
    setPreRaceMeal(race.plan.nutritionPlan?.preRaceMeal ?? 120);
    setIntakeEvents(race.plan.nutritionPlan?.intakeEvents ?? []);
    setPlanName(race.name);
    setPacingPlan(null);
    setSaved(false);
  };

  const startNewRace = () => {
    setActiveRaceId(null);
    setSnapshotAthlete(null);
    setSnapshotBike(null);
    setPlanName('Race Plan');
    setSaved(false);
    // Reset climb caps to FTP-based defaults so the new race doesn't inherit
    // the previous race's edits (Group C — fresh races start fresh).
    setClimbCategories(buildDefaultClimbCaps(currentAthlete?.ftp) ?? {
      moderate: { min: 0, max: 0 },
      steep:    { min: 0, max: 0 },
      wall:     { min: 0, max: 0 },
    });
  };

  const updateAthleteProfile = async () => {
    // B-6: complete athleteSnapshot via shared buildAthleteSnapshot helper.
    const snap = buildAthleteSnapshot(currentAthlete);
    setSnapshotAthlete(snap);
    if (activeRaceId) {
      try {
        await updateRace(activeRaceId, { athleteSnapshot: snap, athleteId: currentAthlete.id, updatedAt: new Date().toISOString() });
        setRaces(prev => prev.map(r => r.id === activeRaceId ? { ...r, athleteSnapshot: snap } : r));
      } catch (e) { alert('Failed to update athlete: ' + e.message); }
    }
  };

  const refreshBikeSpecs = async () => {
    const snap = {
      id: currentActiveBike.id, name: currentActiveBike.name, weight: currentActiveBike.weight,
      positionId: currentActiveBike.positionId, drivetrainId: currentActiveBike.drivetrainId, tireId: currentActiveBike.tireId,
    };
    setSnapshotBike(snap);
    if (activeRaceId) {
      try {
        await updateRace(activeRaceId, { bikeSnapshot: snap, bikeId: currentActiveBike.id, updatedAt: new Date().toISOString() });
        setRaces(prev => prev.map(r => r.id === activeRaceId ? { ...r, bikeSnapshot: snap } : r));
      } catch (e) { alert('Failed to update bike: ' + e.message); }
    }
  };

  // Alerts
  const alerts = [];
  if (pacingPlan) {
    if (pacingPlan.tss > 400) alerts.push({ type: "warn", msg: `TSS of ${pacingPlan.tss} is very high — expect significant fatigue accumulation.` });
    if (pacingPlan.ifActual > 0.95) alerts.push({ type: "danger", msg: `IF of ${pacingPlan.ifActual} is near-maximal. Verify this is achievable for the full duration.` });
    const bonkPt = overlayData.find(d => d.reservePct < 10);
    // W' alerts
    if (wbalData.length > 0) {
      const wPrime = _physicsUnwrap(deriveWPrime(athlete), DEFAULTS.wPrimeFallbackJ);
      const depletedPt = wbalData.find(d => d.wbal === 0);
      const critPt = wbalData.find(d => d.wbalPct <= 20);
      const warnPt = wbalData.find(d => d.wbalPct <= 40);
      const minWbal = Math.min(...wbalData.map(d => d.wbal));
      if (depletedPt) {
        alerts.push({ type: "danger", msg: `W' fully depleted at ${minsToHHMM(depletedPt.time)} — plan requires more anaerobic capacity than you have. Reduce power ceiling or IF.` });
      } else if (critPt) {
        alerts.push({ type: "danger", msg: `W' drops to critical level (${critPt.wbalPct}%) at ${minsToHHMM(critPt.time)}. High blowup risk late in the ride.` });
      } else if (warnPt) {
        alerts.push({ type: "warn", msg: `W' drops below 40% at ${minsToHHMM(warnPt.time)} (min: ${Math.round(minWbal/1000*10)/10}kJ). Consider a power ceiling on climbs.` });
      }
    }
  }

  // Real-time IF preview for Time Target mode.
  // Runs the full buildStream binary search to show the actual NP IF —
  // flat-road IF understates effort by 0.20-0.25 on variable terrain.
  // ~1ms in JS, safe to run on every render.
  const requiredIF = (() => {
    if (pacingMode !== "time_targets" || goalTimeMin <= 0 || !effectiveStats?.totalDistKm) return null;
    const Crr = _physicsUnwrap(blendedCrr(surfaceMix, tireMult), DEFAULTS.Crr);
    const effWind = weatherContext.windSpeedMs * (weatherContext.windEff / 100);
    const mxPwr = maxPower !== "" ? Number(maxPower) : Infinity;
    // Live preview also uses the auto-restored caps so search-with-caps
    // behavior matches what computePlan will produce when the user clicks Generate.
    const previewCaps = ensureClimbCapsPopulated(climbCategories, athlete?.ftp) ?? climbCategories;
    let lo = 0.30, hi = 1.15;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const strat = { mode: "constant_if", targetIF: mid };
      // Search applies caps (spec 4.1 #1).
      const r = buildPowerStream(effectiveStats, athlete, strat, Crr, mxPwr, CdA, eta, activeBike.weight, rhoActual, effWind, weatherContext.windDirDeg, previewCaps);
      if (r && typeof r === 'object' && r.ok === false) return null;
      const vi = computeVI(effectiveStats, surfaceMix, r.estimatedDurationMin);
      vi.correctedDurationMin > goalTimeMin ? lo = mid : hi = mid;
    }
    const finalStrat = { mode: "constant_if", targetIF: (lo + hi) / 2 };
    const finalResult = buildPowerStream(effectiveStats, athlete, finalStrat, Crr, mxPwr, CdA, eta, activeBike.weight, rhoActual, effWind, weatherContext.windDirDeg, previewCaps);
    if (finalResult && typeof finalResult === 'object' && finalResult.ok === false) return null;
    return Math.round(finalResult.ifActual * 100) / 100;
  })();

  return (
    <div>
      {/* ── RACE selector card ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">Race</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: (snapshotAthlete) ? 12 : 0 }}>
          <select
            value={activeRaceId ?? ""}
            onChange={e => {
              const id = Number(e.target.value);
              const race = races.find(r => r.id === id);
              if (race) loadRace(race);
            }}
            style={{ flex: 1, fontSize: 12 }}
          >
            <option value="">— New Race —</option>
            {races.map(r => (
              <option key={r.id} value={r.id}>
                {r.name}{r.status === 'analyzed' ? ' ✓' : ''}
              </option>
            ))}
          </select>
          {activeRaceId && (
            <button className="btn-secondary" style={{ fontSize: 11, whiteSpace: "nowrap" }} onClick={startNewRace}>
              + New
            </button>
          )}
        </div>
        {snapshotAthlete && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Athlete snapshot row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", width: 44, flexShrink: 0 }}>Athlete</span>
              <span style={{ fontSize: 12, flex: 1, color: T.text }}>
                {snapshotAthlete.name} — {snapshotAthlete.ftp}w
                {snapshotAthlete.ftp !== currentAthlete.ftp && (
                  <span style={{ fontSize: 10, color: T.gold, marginLeft: 8 }}>(current: {currentAthlete.ftp}w)</span>
                )}
              </span>
              <button className="btn-secondary" style={{ fontSize: 10, padding: "3px 8px", whiteSpace: "nowrap" }} onClick={updateAthleteProfile}>
                Update Athlete Profile
              </button>
            </div>
            {/* Bike snapshot row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", width: 44, flexShrink: 0 }}>Bike</span>
              <span style={{ fontSize: 12, flex: 1, color: T.text }}>
                {snapshotBike?.name ?? activeBike.name}
                {snapshotBike && snapshotBike.name !== currentActiveBike.name && (
                  <span style={{ fontSize: 10, color: T.gold, marginLeft: 8 }}>(current: {currentActiveBike.name})</span>
                )}
              </span>
              <button className="btn-secondary" style={{ fontSize: 10, padding: "3px 8px", whiteSpace: "nowrap" }} onClick={refreshBikeSpecs}>
                Refresh Bike Specs
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Step 1 — Route */}
      <div className="card">
        <div className="card-header">01 — Route</div>
        <DropZone accept=".gpx" label="Drop GPX file or click to upload" onFile={handleGPX} loaded={gpxFile} />
        {/* Athlete + Bike selectors */}
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", whiteSpace: "nowrap", width: 36 }}>Athlete</label>
          <select value={currentAthlete.id} onChange={e => setActiveAthleteId(Number(e.target.value))} style={{ flex: 1, fontSize: 12 }}>
            {athletes.map(a => <option key={a.id} value={a.id}>{a.name} — {a.ftp}w · {imperial ? Math.round(a.weight * 2.205) : a.weight}{imperial ? "lb" : "kg"}</option>)}
          </select>
        </div>
        {/* Bike selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", whiteSpace: "nowrap", width: 36 }}>Bike</label>
          <select value={activeBikeId} onChange={e => setActiveBikeId(Number(e.target.value))} style={{ flex: 1, fontSize: 12 }}>
            {(bikes || []).map(b => {
              const { CdA: bCdA, eta: bEta } = _physicsUnwrap(bikePhysics(b), DEFAULTS.bikePhysics);
              return <option key={b.id} value={b.id}>{b.name} — CdA {bCdA} · η {bEta} · {imperial ? Math.round(b.weight * 2.205 * 10)/10 : b.weight}{imperial ? 'lb' : 'kg'}</option>;
            })}
          </select>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Surface Mix</label>
            {(() => {
              const total = surfaceMix.reduce((s, x) => s + x.pct, 0);
              const crr = _physicsUnwrap(blendedCrr(surfaceMix), DEFAULTS.Crr);
              return (
                <span style={{ fontSize: 11, fontFamily: "Barlow Condensed" }}>
                  <span style={{ color: total === 100 ? T.textMuted : T.red }}>Total: {total}%</span>
                  <span style={{ color: T.textDim, marginLeft: 10 }}>Crr: {crr.toFixed(4)}</span>
                </span>
              );
            })()}
          </div>
          {surfaceMix.map((row, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 64px 28px", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <select
                value={row.id}
                onChange={e => setSurfaceMix(prev => prev.map((r, i) => i === idx ? { ...r, id: e.target.value } : r))}
                style={{ fontSize: 12 }}
              >
                {SURFACES.map(s => <option key={s.id} value={s.id}>{s.label} ({s.Crr.toFixed(4)})</option>)}
              </select>
              <div style={{ position: "relative" }}>
                <input
                  type="number" min={0} max={100} step={1} value={row.pct}
                  onChange={e => setSurfaceMix(prev => prev.map((r, i) => i === idx ? { ...r, pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } : r))}
                  style={{ width: "100%", paddingRight: 20, textAlign: "right" }}
                />
                <span style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted, pointerEvents: "none" }}>%</span>
              </div>
              {surfaceMix.length > 1 ? (
                <button onClick={() => {
                  const removed = surfaceMix[idx].pct;
                  const next = surfaceMix.filter((_, i) => i !== idx);
                  next[next.length - 1].pct = Math.min(100, next[next.length - 1].pct + removed);
                  setSurfaceMix([...next]);
                }} style={{ background: "none", border: "none", color: T.textDim, fontSize: 16, cursor: "pointer", padding: 0 }}>×</button>
              ) : <span />}
            </div>
          ))}
          {surfaceMix.length < 6 && (
            <button className="btn-secondary" style={{ fontSize: 11, marginTop: 2 }} onClick={() => {
              const used = new Set(surfaceMix.map(r => r.id));
              const next = SURFACES.find(s => !used.has(s.id));
              if (!next) return;
              setSurfaceMix(prev => [...prev, { id: next.id, pct: 0 }]);
            }}>+ Add Surface</button>
          )}
        </div>
        {!gpxFile && (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Distance ({imperial ? "mi" : "km"})</label>
              <input type="number" value={manualDist} onChange={e => setManualDist(Number(e.target.value))} style={{ width: "100%" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Elevation Gain ({imperial ? "ft" : "m"})</label>
              <input type="number" value={manualGain} onChange={e => setManualGain(Number(e.target.value))} style={{ width: "100%" }} />
            </div>
          </div>
        )}
        {effectiveStats && (
          <>
            <div className="stat-row" style={{ marginTop: 12 }}>
              <div className="stat-box">
                <div className="stat-label">Distance</div>
                <div className="stat-value">{imperial ? Math.round(effectiveStats.totalDistKm * 0.621) : effectiveStats.totalDistKm}<span className="stat-unit">{imperial ? "mi" : "km"}</span></div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Gain</div>
                <div className="stat-value">{imperial ? Math.round(effectiveStats.elevGainM * 3.281) : effectiveStats.elevGainM}<span className="stat-unit">{imperial ? "ft" : "m"}</span></div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Loss</div>
                <div className="stat-value">{imperial ? Math.round(effectiveStats.elevLossM * 3.281) : effectiveStats.elevLossM}<span className="stat-unit">{imperial ? "ft" : "m"}</span></div>
              </div>
            </div>
            {gpxStats?.elevProfile?.length > 0 && (() => {
              const distUnit = imperial ? "mi" : "km";
              const eleUnit  = imperial ? "ft" : "m";
              const roundTo  = imperial ? 50 : 10;
              const profileData = gpxStats.elevProfile.map(pt => ({
                dist: imperial ? Math.round(pt.dist * 0.621 * 10) / 10 : pt.dist,
                ele:  imperial ? Math.round(pt.ele * 3.281) : Math.round(pt.ele),
              }));
              const eleVals = profileData.map(p => p.ele);
              const eleMin  = Math.floor(Math.min(...eleVals) / roundTo) * roundTo;
              const eleMax  = Math.ceil( Math.max(...eleVals) / roundTo) * roundTo;
              return (
                <div style={{ height: 100, marginTop: 4 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={profileData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                      <XAxis dataKey="dist" tick={{ fill: T.textDim, fontSize: 10 }} tickFormatter={v => `${Math.round(v)}${distUnit}`} tickCount={6} />
                      <YAxis domain={[eleMin, eleMax]} tick={{ fill: T.textDim, fontSize: 10 }} width={36} tickFormatter={v => `${v}${eleUnit}`} />
                      <Area type="monotone" dataKey="ele" stroke="rgba(120,120,120,0.6)" fill="rgba(80,80,80,0.3)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* Race Conditions — manual entry now, fetch-ready for full app */}
      <div className="card">
        <div className="card-header">Race Conditions</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>
              Temp ({imperial ? "°F" : "°C"})
              <span style={{ color: T.textDim, marginLeft: 6, fontWeight: 400, textTransform: "none" }}>affects air density</span>
            </label>
            <input type="number" step={1} placeholder="e.g. 20"
              value={weatherContext.tempC === null ? "" : (imperial ? Math.round(weatherContext.tempC * 9/5 + 32) : weatherContext.tempC)}
              onChange={e => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                setWeatherContext(w => ({ ...w, tempC: imperial && v !== null ? Math.round((v - 32) * 5/9 * 10)/10 : v }));
              }}
              style={{ width: "100%" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>
              Precip Chance (%)
              <span style={{ color: T.textDim, marginLeft: 6, fontWeight: 400, textTransform: "none" }}>informational</span>
            </label>
            <input type="number" min={0} max={100} step={5} placeholder="e.g. 20"
              value={weatherContext.precipPct === null ? "" : weatherContext.precipPct}
              onChange={e => setWeatherContext(w => ({ ...w, precipPct: e.target.value === "" ? null : Math.max(0, Math.min(100, Number(e.target.value))) }))}
              style={{ width: "100%" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>
              Wind Speed ({imperial ? "mph" : "m/s"})
              <span style={{ color: T.textDim, marginLeft: 6, fontWeight: 400, textTransform: "none" }}>affects drag</span>
            </label>
            <input type="number" min={0} step={1} placeholder="0"
              value={weatherContext.windSpeedMs === 0 ? "" : (imperial ? Math.round(weatherContext.windSpeedMs * 2.237 * 10)/10 : weatherContext.windSpeedMs)}
              onChange={e => {
                const v = e.target.value === "" ? 0 : Number(e.target.value);
                setWeatherContext(w => ({ ...w, windSpeedMs: imperial ? Math.round(v / 2.237 * 100)/100 : v }));
              }}
              style={{ width: "100%" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>
              Wind From
            </label>
            <select
              value={String(weatherContext.windDirDeg)}
              onChange={e => setWeatherContext(w => ({ ...w, windDirDeg: Number(e.target.value) }))}
              style={{ width: "100%" }}>
              {[["N",0],["NNE",22],["NE",45],["ENE",67],["E",90],["ESE",112],["SE",135],["SSE",157],
                ["S",180],["SSW",202],["SW",225],["WSW",247],["W",270],["WNW",292],["NW",315],["NNW",337]
              ].map(([label, deg]) => (
                <option key={deg} value={String(deg)}>{label} ({deg}°)</option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>
              Wind Effectiveness
              <span style={{ color: T.textDim, marginLeft: 6, fontWeight: 400, textTransform: "none" }}>accounts for gusts, shelter, heading variation</span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="range" min={10} max={75} step={5}
                value={weatherContext.windEff}
                onChange={e => setWeatherContext(w => ({ ...w, windEff: Number(e.target.value) }))}
                style={{ flex: 1 }} />
              <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 14, minWidth: 36, color: weatherContext.windEff > 50 ? T.red : weatherContext.windEff > 25 ? T.gold : T.green }}>
                {weatherContext.windEff}%
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.textDim, marginTop: 2 }}>
              <span>10% Gusty / Sheltered</span><span>30% Typical / Partial Exposure</span><span>75% Steady &amp; Full Exposure</span>
            </div>
          </div>
        </div>
        {/* Live summary — only shown when something is set */}
        {(weatherContext.tempC !== null || weatherContext.precipPct !== null || weatherContext.windSpeedMs > 0) && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {weatherContext.tempC !== null && (
              <span style={{ fontSize: 12, background: T.surface2, padding: "4px 10px", borderRadius: 3, fontFamily: "Barlow Condensed" }}>
                <span style={{ color: T.textMuted }}>Temp </span>
                <span style={{ color: T.text }}>{imperial ? Math.round(weatherContext.tempC * 9/5 + 32) : weatherContext.tempC}{imperial ? "°F" : "°C"}</span>
                <span style={{ color: T.textDim, marginLeft: 6, fontSize: 11 }}>ρ={rhoFromTemp(weatherContext.tempC).toFixed(3)}</span>
              </span>
            )}
            {weatherContext.precipPct !== null && (
              <span style={{ fontSize: 12, background: T.surface2, padding: "4px 10px", borderRadius: 3, fontFamily: "Barlow Condensed" }}>
                <span style={{ color: T.textMuted }}>Precip </span>
                <span style={{ color: weatherContext.precipPct > 50 ? T.gold : T.text }}>{weatherContext.precipPct}%</span>
              </span>
            )}
            {weatherContext.windSpeedMs > 0 && (() => {
              const effMs = weatherContext.windSpeedMs * (weatherContext.windEff / 100);
              const effHeadMs = effMs * Math.cos(((weatherContext.windDirDeg - avgCourseBearing) * Math.PI) / 180);
              const color = effHeadMs > 1 ? T.red : effHeadMs < -1 ? T.green : T.gold;
              const label = effHeadMs > 1 ? "headwind" : effHeadMs < -1 ? "tailwind" : "crosswind";
              return (
                <span style={{ fontSize: 12, background: T.surface2, padding: "4px 10px", borderRadius: 3, fontFamily: "Barlow Condensed" }}>
                  <span style={{ color: T.textMuted }}>Wind </span>
                  <span style={{ color: T.text }}>{imperial ? Math.round(weatherContext.windSpeedMs * 2.237 * 10)/10 : weatherContext.windSpeedMs}{imperial ? "mph" : "m/s"} from {degToCompass(weatherContext.windDirDeg)}</span>
                  <span style={{ color: T.textDim, marginLeft: 4 }}>({weatherContext.windEff}% eff)</span>
                  {gpxStats && <span style={{ color, marginLeft: 6 }}>≈ {Math.abs(Math.round(effHeadMs * 10)/10)} m/s {label}</span>}
                </span>
              );
            })()}
          </div>
        )}
      </div>

      {/* Step 2 — Pacing Strategy */}
      <div className="card">
        <div className="card-header">02 — Pacing Strategy</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {[["constant_if", "Normalized Power"], ["segments", "By Segment"], ["time_targets", "Time Target"]].map(([mode, label]) => (
            <button key={mode} className={`mode-btn${pacingMode === mode ? " active" : ""}`} onClick={() => setPacingMode(mode)}>{label}</button>
          ))}
        </div>

        {pacingMode === "constant_if" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: T.textMuted }}>Target NP</label>
              <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 16, color: zoneColor(targetIF) }}>{Math.round(targetIF * athlete.ftp)}w</span>
            </div>
            <input type="range" min="100" max="350" step="5"
              value={Math.round(targetIF * athlete.ftp)}
              onChange={e => setTargetIF(Math.round((Number(e.target.value) / athlete.ftp) * 100) / 100)} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.textDim, marginTop: 4 }}>
              <span>100w (recovery)</span>
              <span>{Math.round(athlete.ftp * 0.80)}w (race)</span>
              <span>350w (threshold)</span>
            </div>
            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted }}>Estimated IF: </span>
              <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: zoneColor(targetIF) }}>{targetIF.toFixed(2)}</span>
            </div>
          </div>
        )}

        {pacingMode === "segments" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: T.textMuted }}>Segments: {numSegments}</label>
              <input type="range" min="2" max="6" value={numSegments} onChange={e => { const n = Number(e.target.value); setNumSegments(n); setSegments(buildSegments(n)); }} style={{ width: 120 }} />
              {segments.length === 0 && <button className="btn-secondary" onClick={() => setSegments(buildSegments(numSegments))}>Init</button>}
            </div>
            {segments.map((seg, i) => (
              <div key={seg.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, padding: "8px 12px", background: T.surface2, borderRadius: 4 }}>
                <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", minWidth: 80 }}>{seg.startKm}–{seg.endKm} km</span>
                <input type="range" min="55" max="105" value={Math.round(seg.targetIF * 100)}
                  onChange={e => setSegments(prev => prev.map(s => s.id === seg.id ? { ...s, targetIF: Number(e.target.value) / 100 } : s))}
                  style={{ flex: 1 }} />
                <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: zoneColor(seg.targetIF), minWidth: 32 }}>{seg.targetIF.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}

        {pacingMode === "time_targets" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: T.textMuted }}>Goal Time</label>
              <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 16, color: requiredIF ? zoneColor(requiredIF) : T.text }}>{minsToHHMM(goalTimeMin)}</span>
            </div>
            <input type="range" min="60" max="720" value={goalTimeMin} onChange={e => setGoalTimeMin(Number(e.target.value))} />
            {requiredIF && (
              <div style={{ marginTop: 10 }}>
                <span style={{ fontSize: 12, color: T.textMuted }}>Estimated required IF: </span>
                <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: zoneColor(requiredIF) }}>{requiredIF.toFixed(2)}</span>
                <span style={{ fontSize: 11, color: T.textDim, marginLeft: 6 }}>({Math.round(requiredIF * athlete.ftp)}w NP)</span>
                {requiredIF > 1.0 && <span className="alert alert-danger" style={{ marginTop: 8, display: "block" }}>⚠ Goal requires IF &gt; 1.0 — may be unrealistic</span>}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, padding: "12px 14px", background: T.surface2, borderRadius: 4, display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
            Max Power Ceiling
          </label>
          <div style={{ position: "relative", width: 90 }}>
            <input
              type="number" min={50} max={2000} step={5}
              value={maxPower}
              onChange={e => setMaxPower(e.target.value)}
              placeholder="none"
              style={{ width: "100%", paddingRight: 18 }}
            />
            {maxPower !== "" && <span style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: T.textMuted, pointerEvents: "none" }}>w</span>}
          </div>
          {maxPower !== "" && (
            <span style={{ fontSize: 11, color: T.textMuted }}>
              {Math.round(Number(maxPower) / athlete.ftp * 100)}% FTP
              <button onClick={() => setMaxPower("")} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", marginLeft: 8, fontSize: 13 }}>×</button>
            </span>
          )}
          {maxPower === "" && <span style={{ fontSize: 11, color: T.textDim }}>No ceiling set</span>}
        </div>

        {/* Climb Strategy */}
        {(() => {
          const detectedClimbs = gpxStats ? detectClimbs(gpxStats) : [];
          const [climbDetailOpen, setClimbDetailOpen] = useState(false);
          const catCounts = { moderate: 0, steep: 0, wall: 0 };
          detectedClimbs.forEach(c => { catCounts[c.category] = (catCounts[c.category] || 0) + 1; });

          return (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
                Sustained Climb Strategy
              </div>
              <div style={{ fontSize: 10, color: T.textDim, marginBottom: 8, lineHeight: 1.4 }}>
                Power limits for short, steep climbs may briefly exceed these caps to account for surging
              </div>
              {!gpxStats && (
                <div style={{ fontSize: 11, color: T.textDim, padding: "8px 12px", background: T.surface2, borderRadius: 4 }}>
                  Upload a GPX file to enable climb detection
                </div>
              )}
              {gpxStats && detectedClimbs.length === 0 && (
                <div style={{ fontSize: 11, color: T.textDim, padding: "8px 12px", background: T.surface2, borderRadius: 4 }}>
                  No climbs ≥ 3% detected on this route
                </div>
              )}
              {gpxStats && detectedClimbs.length > 0 && (
                <>
                  {/* Category tiles */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {CLIMB_CATEGORIES.map(cat => {
                      const count = catCounts[cat.id] || 0;
                      const settings = climbCategories[cat.id];
                      const hasSettings = settings.min > 0 || settings.max > 0;
                      return (
                        <div key={cat.id} style={{
                          flex: 1, minWidth: 130, padding: "10px 12px",
                          background: T.surface2, borderRadius: 4,
                          border: `1px solid ${hasSettings ? cat.borderColor : T.border}`,
                          opacity: count === 0 ? 0.45 : 1,
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                            <span style={{ fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, color: cat.borderColor, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                              {cat.label}
                            </span>
                            <span style={{ fontSize: 10, color: T.textDim }}>
                              {cat.minGrade}–{cat.id === "wall" ? "∞" : cat.maxGrade}%
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 8 }}>
                            {count} climb{count !== 1 ? "s" : ""}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 10, color: T.textDim, width: 28 }}>Min</span>
                              <WattInput value={settings.min}
                                onChange={v => setClimbCategories(prev => ({ ...prev, [cat.id]: { ...prev[cat.id], min: v } }))} />
                              {settings.min > 0 && <span style={{ fontSize: 10, color: settings.min > athlete.ftp ? T.red : T.textDim }}>{Math.round(settings.min / athlete.ftp * 100)}%</span>}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 10, color: T.textDim, width: 28 }}>Max</span>
                              <WattInput value={settings.max}
                                onChange={v => setClimbCategories(prev => ({ ...prev, [cat.id]: { ...prev[cat.id], max: v } }))} />
                              {settings.max > 0 && <span style={{ fontSize: 10, color: settings.max > athlete.ftp ? T.gold : T.textDim }}>{Math.round(settings.max / athlete.ftp * 100)}%</span>}
                            </div>
                            {settings.min > 0 && settings.max > 0 && settings.min > settings.max && (
                              <div style={{ fontSize: 10, color: T.red }}>⚠ Min exceeds Max</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Collapsible climb detail table */}
                  <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                    <button onClick={() => setClimbDetailOpen(v => !v)}
                      style={{ background: "none", border: "none", color: T.textMuted, fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0 }}>
                      <span>Course Climb Detail</span>
                      <span style={{ fontSize: 10, color: T.textDim }}>{climbDetailOpen ? "▲ hide" : `▼ ${detectedClimbs.length} climbs`}</span>
                    </button>
                    {climbDetailOpen && (
                      <div style={{ marginTop: 8, overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                          <thead>
                            <tr style={{ color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10 }}>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>#</th>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>Start</th>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>Length</th>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>Avg</th>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>Peak</th>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>Gain</th>
                              <th style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.border}` }}>Cat</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detectedClimbs.map(c => {
                              const catDef = CLIMB_CATEGORIES.find(x => x.id === c.category);
                              const distLabel = imperial
                                ? `mi ${Math.round(c.startDistKm * 0.621 * 10) / 10}`
                                : `km ${c.startDistKm}`;
                              const lenLabel = imperial
                                ? `${Math.round(c.lengthKm * 0.621 * 100) / 100}mi`
                                : `${c.lengthKm}km`;
                              const gainLabel = imperial
                                ? `${Math.round(c.gainM * 3.281)}ft`
                                : `${c.gainM}m`;
                              return (
                                <tr key={c.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                                  <td style={{ padding: "5px 8px", color: T.textDim }}>{c.id}</td>
                                  <td style={{ padding: "5px 8px", color: T.textMuted, fontFamily: "Barlow Condensed" }}>{distLabel}</td>
                                  <td style={{ padding: "5px 8px", color: T.textMuted, fontFamily: "Barlow Condensed" }}>{lenLabel}</td>
                                  <td style={{ padding: "5px 8px", color: T.text, fontFamily: "Barlow Condensed" }}>{c.avgGrade}%</td>
                                  <td style={{ padding: "5px 8px", color: T.text, fontFamily: "Barlow Condensed" }}>{c.peakGradePct}%</td>
                                  <td style={{ padding: "5px 8px", color: T.text, fontFamily: "Barlow Condensed" }}>{gainLabel}</td>
                                  <td style={{ padding: "5px 8px" }}>
                                    <span style={{ color: catDef?.borderColor, fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 10, textTransform: "uppercase" }}>
                                      {cat => cat?.label ?? c.category}
                                      {CLIMB_CATEGORIES.find(x => x.id === c.category)?.label}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })()}

        <button className="btn-primary" style={{ marginTop: 16, width: "100%" }} onClick={computePlan}>
          Compute Pacing Plan
        </button>
      </div>

      {/* Step 3 — Pacing Plan */}
      {pacingPlan && (
        <div className="card">
          <div className="card-header">03 — Pacing Plan</div>
          <div className="stat-row">
            <div className="stat-box" style={{ minWidth: 120 }}>
              <div className="stat-label">Moving Time</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                {minsToHHMM(pacingPlan.correctedDurationMin)}
              </div>
              <div style={{ fontSize: 10, color: T.textDim, marginTop: 3 }}>
                est. range {minsToHHMM(pacingPlan.durationLoMin)}–{minsToHHMM(pacingPlan.durationHiMin)}
              </div>
            </div>
            <div className="stat-box"><div className="stat-label">Avg Power</div><div className="stat-value">{pacingPlan.avgPower}<span className="stat-unit">w</span></div></div>
            <div className="stat-box"><div className="stat-label">NP</div><div className="stat-value">{pacingPlan.normalizedPower}<span className="stat-unit">w</span></div></div>
            <div className="stat-box"><div className="stat-label">IF</div><div className="stat-value" style={{ color: zoneColor(pacingPlan.ifActual) }}>{pacingPlan.ifActual.toFixed(2)}</div></div>
            <div className="stat-box"><div className="stat-label">TSS</div><div className="stat-value">{pacingPlan.tss}</div></div>
            <div className="stat-box"><div className="stat-label">Avg Speed</div><div className="stat-value">{imperial ? Math.round(pacingPlan.avgSpeedKph * 0.621) : pacingPlan.avgSpeedKph}<span className="stat-unit">{imperial ? "mph" : "kph"}</span></div></div>
          </div>
          {wbalData.length > 0 && (() => {
            const wPrime = _physicsUnwrap(deriveWPrime(athlete), DEFAULTS.wPrimeFallbackJ);
            const minWbal = Math.min(...wbalData.map(d => d.wbal));
            const minPct = Math.round((minWbal / wPrime) * 100);
            const color = minPct > 40 ? T.green : minPct > 20 ? T.gold : T.red;
            return (
              <div className="stat-row">
                <div className="stat-box">
                  <div className="stat-label">W' Min</div>
                  <div className="stat-value" style={{ color }}>{Math.round(minWbal / 100) / 10}<span className="stat-unit">kJ</span></div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">W' Min %</div>
                  <div className="stat-value" style={{ color }}>{minPct}<span className="stat-unit">%</span></div>
                </div>
                <div className="stat-box" style={{ flex: 3 }}>
                  <div className="stat-label">W' Reserve</div>
                  <div style={{ height: 6, background: T.border, borderRadius: 3, marginTop: 10, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${minPct}%`, background: color, borderRadius: 3 }} />
                  </div>
                </div>
              </div>
            );
          })()}

          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Elevation + Power
          </div>
          <ElevPowerChart powerStream={pacingPlan.powerStream} gpxStats={gpxStats} ftp={athlete.ftp} imperial={imperial} detectedClimbs={gpxStats ? detectClimbs(gpxStats) : []} durationMin={pacingPlan.correctedDurationMin} estimatedDurationMin={pacingPlan.estimatedDurationMin} />

          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6, marginTop: 14, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            W' Balance
          </div>
          <WbalChart wbalData={wbalData} athlete={athlete} gpxStats={gpxStats} imperial={imperial} durationMin={pacingPlan.correctedDurationMin} estimatedDurationMin={pacingPlan.estimatedDurationMin} />
          {/* B-22: advisory caption — PLAN tab only */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, borderTop: `0.5px solid ${T.border}`, paddingTop: 10, marginTop: 8, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
            <span aria-hidden="true" style={{ flexShrink: 0, fontSize: 14, color: T.textDim, lineHeight: 1 }}>ⓘ</span>
            <span>{WBAL_ADVISORY_TEXT}</span>
          </div>

          {alerts.map((a, i) => (
            <div key={i} className={`alert alert-${a.type}`} style={{ marginTop: 8 }}>⚠ {a.msg}</div>
          ))}

          {/* Sensitivity Analysis */}
          <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <button
              onClick={() => setSensOpen(v => !v)}
              style={{ background: "none", border: "none", color: T.textMuted, fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0 }}>
              <span style={{ color: sensAnyActive ? T.blue : T.textMuted }}>Sensitivity Analysis</span>
              <span style={{ fontSize: 10, color: T.textDim }}>{sensOpen ? "▲ hide" : "▼ show"}</span>
              {sensAnyActive && (
                <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 13,
                  color: sensDeltaMin < -0.5 ? T.green : sensDeltaMin > 0.5 ? T.red : T.textMuted }}>
                  {sensDeltaMin > 0.5 ? "+" : ""}{minsToHHMM(Math.abs(Math.round(sensDeltaMin)))} {sensDeltaMin > 0.5 ? "slower" : sensDeltaMin < -0.5 ? "faster" : ""}
                </span>
              )}
            </button>

            {sensOpen && (
              <div style={{ marginTop: 14 }}>
                {/* Adjusted duration summary */}
                <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                  <div className="stat-box" style={{ flex: 1 }}>
                    <div className="stat-label">Baseline</div>
                    <div className="stat-value" style={{ fontSize: 17 }}>{minsToHHMM(sensBaseDuration)}</div>
                  </div>
                  <div className="stat-box" style={{ flex: 1 }}>
                    <div className="stat-label">Adjusted</div>
                    <div className="stat-value" style={{ fontSize: 17, color: sensDeltaMin < -0.5 ? T.green : sensDeltaMin > 0.5 ? T.red : T.textMuted }}>
                      {sensAnyActive ? minsToHHMM(Math.round(sensAdjDuration)) : "—"}
                    </div>
                  </div>
                  <div className="stat-box" style={{ flex: 1 }}>
                    <div className="stat-label">Delta</div>
                    <div className="stat-value" style={{ fontSize: 17, color: sensDeltaMin < -0.5 ? T.green : sensDeltaMin > 0.5 ? T.red : T.textMuted }}>
                      {sensAnyActive ? `${sensDeltaMin >= 0 ? "+" : ""}${minsToHHMM(Math.abs(Math.round(sensDeltaMin)))}` : "—"}
                    </div>
                  </div>
                  {sensAnyActive && (
                    <button className="btn-secondary" style={{ fontSize: 11, alignSelf: "center" }}
                      onClick={() => { setSensPower(0); setSensWeight(0); setSensCdA(0); setSensCrr(0); }}>
                      Reset
                    </button>
                  )}
                </div>

                {/* Sliders */}
                {[
                  { label: "Power", value: sensPower, set: setSensPower, unit: "%", color: T.blue,
                    hint: `${sensPower >= 0 ? "+" : ""}${sensPower}% → IF ${(pacingPlan.ifActual * (1 + sensPower/100)).toFixed(2)}` },
                  { label: imperial ? "Weight (lb)" : "Weight (kg)", value: sensWeight, set: setSensWeight, unit: imperial ? "lb" : "kg", color: T.gold,
                    hint: `${sensWeight >= 0 ? "+" : ""}${sensWeight}${imperial ? "lb" : "kg"} → ${imperial ? Math.round((athlete.weight + sensWeight/2.205) * 2.205) : Math.round(athlete.weight + sensWeight)}${imperial ? "lb" : "kg"} total` },
                  { label: "Aerodynamics (CdA)", value: sensCdA, set: setSensCdA, unit: "%", color: T.gold,
                    hint: `${sensCdA >= 0 ? "+" : ""}${sensCdA}% → CdA ${(CdA * (1 + sensCdA/100)).toFixed(3)}` },
                  { label: "Rolling Resistance (Crr)", value: sensCrr, set: setSensCrr, unit: "%", color: T.gold,
                    hint: `${sensCrr >= 0 ? "+" : ""}${sensCrr}% → Crr ${(_physicsUnwrap(blendedCrr(surfaceMix, tireMult), DEFAULTS.Crr) * (1 + sensCrr/100)).toFixed(4)}` },
                ].map(({ label, value, set, unit, color, hint }) => (
                  <div key={label} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, alignItems: "baseline" }}>
                      <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
                      <span style={{ fontSize: 11, fontFamily: "Barlow Condensed", color: value !== 0 ? color : T.textDim }}>{hint}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 10, color: T.textDim, minWidth: 28, textAlign: "right" }}>-20{unit}</span>
                      <input type="range" min={-20} max={20} step={unit === "%" ? 1 : (imperial ? 1 : 0.5)}
                        value={value}
                        onChange={e => set(Number(e.target.value))}
                        style={{ flex: 1 }} />
                      <span style={{ fontSize: 10, color: T.textDim, minWidth: 28 }}>+20{unit}</span>
                    </div>
                    <div style={{ textAlign: "center", marginTop: 2 }}>
                      {value !== 0 && (
                        <button onClick={() => set(0)} style={{ background: "none", border: "none", color: T.textDim, fontSize: 10, cursor: "pointer" }}>reset</button>
                      )}
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>
                  Adjustments affect duration estimate only — recompute the plan to apply changes.
                </div>
              </div>
            )}
          </div>

        </div>
      )}

      {/* Step 4 — Nutrition */}
      {pacingPlan && (
        <div className="card">
          <div className="card-header">04 — Nutrition Plan</div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: T.textMuted }}>Pre-race Meal Carbs</label>
              <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700 }}>{preRaceMeal}g</span>
            </div>
            <input type="range" min="0" max="300" value={preRaceMeal} onChange={e => setPreRaceMeal(Number(e.target.value))} />
          </div>

          <IntakeForm products={products} onAdd={e => setIntakeEvents(prev => [...prev, e].sort((a, b) => a.time - b.time))} maxTime={pacingPlan.estimatedDurationMin} />
          {intakeEvents.map(e => (
            <IntakeRow key={e.id} event={e} products={products} onRemove={() => setIntakeEvents(prev => prev.filter(x => x.id !== e.id))} />
          ))}

          {overlayData.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, marginTop: 12, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>Glycogen Reserve</div>
              <GlycogenChart overlayData={overlayData} athlete={athlete} durationMin={pacingPlan.correctedDurationMin} estimatedDurationMin={pacingPlan.estimatedDurationMin} />
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, marginTop: 12, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>Cumulative Burn vs Intake</div>
              <BurnRateChart overlayData={overlayData} durationMin={pacingPlan?.correctedDurationMin} blockMin={2} estimatedDurationMin={pacingPlan?.estimatedDurationMin} />
              <div style={{ marginTop: 12, padding: "10px 14px", background: T.surface2, borderRadius: 4, fontSize: 12 }}>
                <span style={{ color: T.textMuted }}>Total planned carbs: </span>
                <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: T.blue }}>
                  {intakeEvents.reduce((s, e) => s + e.carbs, 0) + preRaceMeal}g
                </span>
                <span style={{ color: T.textMuted, marginLeft: 16 }}>Avg intake rate: </span>
                <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: T.blue }}>
                  {Math.round(intakeEvents.reduce((s, e) => s + e.carbs, 0) / (pacingPlan.estimatedDurationMin / 60))}g/hr
                </span>
              </div>
            </>
          )}

          <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
            {/* Nutrition alerts */}
            {(() => {
              const nutritionAlerts = [];
              if (overlayData.length > 0) {
                const bonkPt = overlayData.find(d => d.reservePct < 10);
                const warnPt = overlayData.find(d => d.reservePct < 30);
                const overLimitPt = overlayData.find(d => d.overLimit > 0);
                if (bonkPt) nutritionAlerts.push({ type: "danger", msg: `Projected glycogen depletion (bonk risk) at ${minsToHHMM(bonkPt.time)}. Add carbs.` });
                else if (warnPt) nutritionAlerts.push({ type: "warn", msg: `Glycogen drops below 30% at ${minsToHHMM(warnPt.time)}. Consider adding carbs.` });
                if (overLimitPt) nutritionAlerts.push({ type: "warn", msg: `Absorption ceiling exceeded at ${minsToHHMM(overLimitPt.time)} — spread intake more evenly.` });
              }
              return nutritionAlerts.length > 0 ? (
                <div style={{ width: "100%", marginBottom: 8 }}>
                  {nutritionAlerts.map((a, i) => (
                    <div key={i} className={`alert alert-${a.type}`} style={{ marginBottom: 6 }}>⚠ {a.msg}</div>
                  ))}
                </div>
              ) : null;
            })()}
          </div>
        </div>
      )}

      {/* RACE PLAN card */}
      {pacingPlan && (
        <div className="card">
          <div className="card-header">Race Plan</div>

          {/* Save / Update race */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input type="text" value={planName} onChange={e => setPlanName(e.target.value)} style={{ flex: 1 }} placeholder="Race name" />
            <button className="btn-primary" onClick={saveOrUpdateRace}>{activeRaceId ? "Update Race" : "Save Race"}</button>
          </div>
          {saved && <div style={{ color: T.green, fontSize: 12, marginBottom: 12 }}>✓ Race saved</div>}

          {/* Plan Details */}
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
            <button
              onClick={() => setDetailsOpen(v => !v)}
              style={{ background: "none", border: "none", color: T.textMuted, fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0 }}>
              <span>Plan Details</span>
              <span style={{ fontSize: 10, color: T.textDim }}>{detailsOpen ? "▲ hide" : "▼ show"}</span>
            </button>
            {detailsOpen && (
              <div style={{ marginTop: 12, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Seg", "Seg Time", "Elapsed", `Seg Dist`, `Elapsed Dist`, "Speed", "Power", "Grade", "Nutrition"].map(h => (
                        <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", color: T.textMuted, textTransform: "uppercase", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let elapsedDist = 0;
                      const tableStream = pacingPlan.powerStream;
                      return tableStream.map((pt, i) => {
                        const nextTime = i < tableStream.length - 1
                          ? tableStream[i + 1].time : pacingPlan.estimatedDurationMin;
                        const segMins = nextTime - pt.time;
                        const elapsedTime = Math.round(nextTime);
                        const segDistKm = pt.speedKph > 0 ? pt.speedKph * (segMins / 60) : 0;
                        elapsedDist += segDistKm;
                        const distUnit = imperial ? "mi" : "km";
                        const segDistDisplay = imperial ? Math.round(segDistKm * 0.621 * 10) / 10 : Math.round(segDistKm * 10) / 10;
                        const elapsedDistDisplay = imperial ? Math.round(elapsedDist * 0.621 * 10) / 10 : Math.round(elapsedDist * 10) / 10;
                        const speedDisplay = imperial ? Math.round(pt.speedKph * 0.621 * 10) / 10 : pt.speedKph;
                        const speedUnit = imperial ? "mph" : "kph";
                        const gradeColor = pt.grade > 8 ? T.red : pt.grade > 4 ? T.gold : pt.grade < -4 ? T.blue : T.text;
                        const powerColor = zoneColor(pt.pctFTP);
                        // Nutrition consumed in this segment
                        const segNutrition = intakeEvents
                          .filter(e => e.time >= pt.time && e.time < nextTime)
                          .map(e => `${e.name} (${e.carbs}g)`)
                          .join(", ");
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? "transparent" : `${T.surface2}66` }}>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed", color: T.textMuted }}>{i + 1}</td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed" }}>{minsToHHMM(Math.round(segMins))}</td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed" }}>{minsToHHMM(elapsedTime)}</td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed" }}>{segDistDisplay} <span style={{ color: T.textDim, fontSize: 10 }}>{distUnit}</span></td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed" }}>{elapsedDistDisplay} <span style={{ color: T.textDim, fontSize: 10 }}>{distUnit}</span></td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed" }}>{speedDisplay} <span style={{ color: T.textDim, fontSize: 10 }}>{speedUnit}</span></td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed", color: powerColor }}>{pt.power} <span style={{ color: T.textDim, fontSize: 10 }}>w</span></td>
                            <td style={{ padding: "5px 10px", fontFamily: "Barlow Condensed", color: gradeColor }}>{pt.grade > 0 ? "+" : ""}{pt.grade} <span style={{ color: T.textDim, fontSize: 10 }}>%</span></td>
                            <td style={{ padding: "5px 10px", color: segNutrition ? T.blue : T.textDim, fontSize: 11 }}>{segNutrition || "—"}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Saved Races */}
      {races.length > 0 && (
        <div className="card">
          <div className="card-header">Saved Races</div>
          {races.map(r => (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 10px", marginBottom: 6, borderRadius: 4,
              background: r.id === activeRaceId ? `${T.blue}14` : T.surface2,
              border: `1px solid ${r.id === activeRaceId ? T.blue : T.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  {r.plan?.pacingPlan
                    ? `${minsToHHMM(r.plan.pacingPlan.correctedDurationMin ?? r.plan.pacingPlan.estimatedDurationMin)} · TSS ${r.plan.pacingPlan.tss} · IF ${r.plan.pacingPlan.ifActual?.toFixed(2)}`
                    : "No plan computed"}
                </div>
              </div>
              <span style={{
                fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.08em",
                textTransform: "uppercase", padding: "2px 6px", borderRadius: 2, flexShrink: 0,
                background: r.status === 'analyzed' ? `${T.green}20` : `${T.gold}20`,
                color: r.status === 'analyzed' ? T.green : T.gold,
              }}>
                {r.status === 'analyzed' ? 'Analyzed' : 'Planned'}
              </span>
              <button className="btn-secondary" style={{ fontSize: 10, padding: "3px 8px", flexShrink: 0 }} onClick={() => loadRace(r)}>
                Load
              </button>
              <button
                onClick={async () => {
                  if (!window.confirm(`Delete "${r.name}"?`)) return;
                  try {
                    await deleteRace(r.id);
                    setRaces(prev => prev.filter(x => x.id !== r.id));
                    if (activeRaceId === r.id) startNewRace();
                  } catch (e) { alert('Delete failed: ' + e.message); }
                }}
                style={{ background: "none", border: "none", color: T.textDim, fontSize: 18, cursor: "pointer", padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ANALYZE TAB ──────────────────────────────────────────────────────────────
function AnalyzeTab({ athlete, products, races, setRaces, imperial }) {
  const [selectedRaceId, setSelectedRaceId] = useState("");
  const [fitFile, setFitFile] = useState(null);
  const [fitData, setFitData] = useState(null);
  const [fitSaved, setFitSaved] = useState(false);
  const [actualIntake, setActualIntake] = useState([]);
  const [fitError, setFitError] = useState(null);
  const [noPowerToastDismissed, setNoPowerToastDismissed] = useState(false);
  // B-32: visible while parseFIT runs AND while the subsequent render's
  // alignFitToGpx useMemo blocks (5–9s on typical fixtures). Cleared in the
  // same render that paints results.
  const [fitProcessing, setFitProcessing] = useState(false);

  // Derived: does the loaded FIT have power / HR? Falls back to inferring from
  // the data shape, so old saved races without explicit hasPower/hasHR flags
  // still work correctly.
  const hasPower = inferHasPower(fitData);
  const hasHR    = inferHasHR(fitData);

  // When the selected race changes, auto-load stored FIT data if present.
  useEffect(() => {
    if (!selectedRaceId) { setFitSaved(false); setNoPowerToastDismissed(false); return; }
    const race = races.find(r => r.id === Number(selectedRaceId));
    if (race?.fit) {
      setFitData(race.fit);
      setFitFile(race.fit.fileName ?? 'Saved FIT');
      setFitError(null);
      setFitSaved(true);
      setNoPowerToastDismissed(false);
    } else {
      setFitData(null);
      setFitFile(null);
      setFitSaved(false);
      setNoPowerToastDismissed(false);
    }
  }, [selectedRaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shim: map new race schema onto the old selectedPlan shape so all downstream
  // references (selectedPlan.pacingPlan, selectedPlan.route, etc.) work unchanged.
  const selectedRace = races.find(r => r.id === Number(selectedRaceId));
  const selectedPlan = selectedRace ? {
    id: selectedRace.id,
    name: selectedRace.name,
    pacingPlan:    selectedRace.plan?.pacingPlan    ?? null,
    route:         selectedRace.plan?.route         ?? null,
    nutritionPlan: selectedRace.plan?.nutritionPlan ?? null,
    athleteSnapshot: selectedRace.athleteSnapshot,
  } : null;

  const saveFitToRace = async () => {
    if (!fitData || !selectedRaceId) return;
    const fitRecord = {
      fileName:          fitFile,
      savedAt:           new Date().toISOString(),
      elapsedMin:        fitData.elapsedMin,
      movingMin:         fitData.movingMin,
      stoppedMin:        fitData.stoppedMin,
      durationMin:       fitData.durationMin ?? fitData.movingMin,
      rawAvgPower:       fitData.rawAvgPower,
      rawNP:             fitData.rawNP,
      totalRecords:      fitData.totalRecords,
      movingPowerSeries: fitData.movingPowerSeries,
      movingDistSeries:  fitData.movingDistSeries,
      movingAltSeries:   fitData.movingAltSeries,
      movingHRSeries:    fitData.movingHRSeries,
      firstGPS:          fitData.firstGPS,
      // New additive fields (forward-compat). Old saves loaded later won't
      // have these — downstream code falls back via inferHasPower/inferHasHR.
      movingCadenceSeries: fitData.movingCadenceSeries ?? null,
      movingTempSeries:    fitData.movingTempSeries    ?? null,
      movingGPSPath:       fitData.movingGPSPath       ?? null,
      fullGPSPath:         fitData.fullGPSPath         ?? null,
      laps:                fitData.laps               ?? null,
      hasPower:            typeof fitData.hasPower === 'boolean' ? fitData.hasPower : undefined,
      hasHR:               typeof fitData.hasHR    === 'boolean' ? fitData.hasHR    : undefined,
    };
    try {
      const id = Number(selectedRaceId);
      await updateRace(id, { fit: fitRecord, status: 'analyzed', updatedAt: new Date().toISOString() });
      setRaces(prev => prev.map(r => r.id === id ? { ...r, fit: fitRecord, status: 'analyzed' } : r));
      setFitSaved(true);
    } catch (e) {
      alert('Failed to save FIT data: ' + e.message);
    }
  };

  const handleFIT = async (buffer, name) => {
    // B-32: show the loading overlay BEFORE parseFIT or alignment can block.
    // The setTimeout(0) yield is essential — without it the overlay state
    // update and the parseFIT await would chain inside the same task, and
    // the loading frame would never paint before the heavy work began.
    setFitProcessing(true);
    setFitError(null);
    await new Promise(r => setTimeout(r, 0));
    let result = null;
    try { result = await parseFIT(buffer); }
    catch { result = null; }
    if (result) {
      setFitData(result);
      setFitFile(name);
      setFitSaved(false);
      // Reset the no-power dismissal so the toast reappears for each new upload.
      setNoPowerToastDismissed(false);
    } else {
      setFitError("Could not parse FIT file. Ensure the file is a valid .fit activity file, not a course or workout file.");
    }
    // The setFitData above triggers a re-render that runs the alignFitToGpx
    // useMemo synchronously (5–9s blocking). Clearing fitProcessing here
    // batches with setFitData, so the overlay disappears in the same commit
    // that paints results — the user sees the spinner during alignment and
    // results appear when work is done.
    setFitProcessing(false);
  };

  // 4C sub-step 1: 1-min FIT aggregation. Built from per-second moving series
  // — power avg, HR avg (zeros excluded), per-block distance accumulation
  // (cumulative `fitDistM` enables the FIT-distance x-axis arriving in
  // sub-step 2). Replaces the retired 5-min `fitPowerStream`.
  const fitMinStream = useMemo(() => {
    const power = fitData?.movingPowerSeries;
    if (!power || power.length === 0) return [];
    const hr = fitData?.movingHRSeries ?? [];
    const dist = fitData?.movingDistSeries ?? [];
    const out = [];
    let cumDistM = 0;
    for (let i = 0; i < power.length; i += 60) {
      const slicePower = power.slice(i, i + 60);
      const sliceHR = hr.slice(i, i + 60).filter(h => h > 0);
      const sliceDist = dist.slice(i, i + 60);
      const blockDistM = sliceDist.reduce((s, d) => s + (d || 0), 0);
      const blockStartM = cumDistM;
      cumDistM += blockDistM;
      const avgP = Math.round(slicePower.reduce((s, p) => s + p, 0) / slicePower.length);
      out.push({
        time: Math.round(i / 60),                     // minute index
        power: avgP,
        pctFTP: athlete.ftp > 0 ? avgP / athlete.ftp : 0,
        hr: sliceHR.length ? Math.round(sliceHR.reduce((s, h) => s + h, 0) / sliceHR.length) : 0,
        fitDistM: blockStartM,                        // cumulative FIT distance at block start
        blockDistM,                                   // distance covered in this block
      });
    }
    return out;
  }, [fitData?.movingPowerSeries, fitData?.movingHRSeries, fitData?.movingDistSeries, athlete.ftp]);

  const fitOverlay = fitMinStream.length
    ? buildNutritionOverlay(fitMinStream, actualIntake, athlete, 120, 1) : [];

  // CC#8 (Prompt 4B Step 5): per-second FIT-to-GPX alignment. One pass; both
  // bucketByTerrain and perClimbStats consume the same alignment array. Off-
  // route seconds (rider deviated from the planned route) are flagged so they
  // don't smear onto planned-route grade lookup or per-climb stats.
  // Empty when: no plan loaded, plan saved before _gpxPts were captured, or
  // FIT saved before movingGPSPath was added (legacy save). Downstream code
  // tolerates empty/null alignment by falling back to FIT-altitude grade.
  const gpxRouteForAlign = selectedPlan?.route ?? null;
  // Memoized: alignment is O(N×M) and runs ~9 s on BR-sized rides. Caching
  // across re-renders keyed off the two inputs (object identity stable across
  // tab interactions) avoids recomputing on every state change. Spatial-index
  // optimization for the cold path is deferred to the perf-focused prompt.
  const alignment = useMemo(() => {
    if (!fitData?.movingGPSPath?.length || !gpxRouteForAlign?._gpxPts?.length) return null;
    // Backward compat: legacy saved races persisted `_gpxPts` with only
    // `cumDistM` (parseGPX internal name). `alignFitToGpx` reads `distM` per
    // its documented contract. Map cumDistM→distM for any point missing it
    // so old saves work without re-save. Post-fix parseGPX sets both fields,
    // so new saves bypass this mapping cheaply.
    const gpxPts = gpxRouteForAlign._gpxPts.map(p =>
      typeof p.distM === 'number' ? p : { ...p, distM: p.cumDistM ?? 0 });
    return alignFitToGpx(fitData.movingGPSPath, gpxPts);
  }, [fitData?.movingGPSPath, gpxRouteForAlign?._gpxPts]);

  // 4C sub-step 6 — route-distance thirds. Single derivation drives every
  // fade-analysis section (Fade Analysis NP, Effort vs Plan IF, Cardiac
  // Efficiency, Threshold Exposure, Terrain × thirds, W'bal peak-burn third)
  // so cards rendered next to each other agree on what "first third" means.
  // Off-route seconds excluded from each set (no GPX position to bucket by).
  // When alignment is unavailable, returns null and consumers fall back to
  // legacy moving-time index thirds.
  const thirdsByRouteDistance = useMemo(() => {
    if (!alignment?.length || !selectedPlan?.route?.totalDistKm) return null;
    const totalRouteM = selectedPlan.route.totalDistKm * 1000;
    const t1End = totalRouteM / 3;
    const t2End = (totalRouteM * 2) / 3;
    const sets = [[], [], []];
    for (let i = 0; i < alignment.length; i++) {
      const a = alignment[i];
      if (!a.onRoute || a.gpxDistM == null) continue;
      const idx = a.gpxDistM < t1End ? 0 : a.gpxDistM < t2End ? 1 : 2;
      sets[idx].push(i);
    }
    return sets;
  }, [alignment, selectedPlan?.route?.totalDistKm]);

  // Terrain analysis — GPX if plan loaded, FIT altitude fallback otherwise.
  // 4C sub-step 6: thirdsByRouteDistance threaded through so per-bucket thirds
  // align with all other thirds on the page.
  const terrainBuckets = fitData?.movingPowerSeries?.length
    ? bucketByTerrain(
        fitData.movingPowerSeries,
        fitData.movingAltSeries,
        fitData.movingDistSeries,
        fitData.movingHRSeries,
        gpxRouteForAlign,
        athlete.ftp,
        alignment,
        thirdsByRouteDistance,
      )
    : null;
  const actualMetrics = fitMinStream.length ? (() => {
    // Use pre-computed values from parseFIT — these use the correct 30-sec rolling NP
    // method on raw 1-second data, matching how TrainingPeaks/Garmin calculate NP.
    const avgPwr = fitData.rawAvgPower;
    const np     = fitData.rawNP;
    const ifAct  = Math.round((np / athlete.ftp) * 100) / 100;
    const dur    = fitData.movingMin;
    const tss    = Math.round((dur / 60) * ifAct * ifAct * 100);
    return { avgPwr, np, ifAct, dur, tss };
  })() : null;

  // W'bal on actual ride — use raw 1-second moving-time power series for accuracy.
  // Block averages mask short surges; this is the correct approach for race analysis.
  const actualWbalRaw = fitData?.movingPowerSeries?.length
    ? buildWbalFromRawSeries(fitData.movingPowerSeries, athlete, fitData.movingAltSeries)
    : null;
  const actualWbal = actualWbalRaw?.chartData ?? [];

  // Per-climb pacing stats — requires GPX (for climb detection) + FIT.
  // CC#8: pass `alignment` through to buildPerClimbStats. Climb membership is
  // determined per-second from alignment[i].gpxDistM — off-route seconds are
  // skipped so detours don't get attributed to a planned climb.
  const perClimbStats = (() => {
    const gpxStats = selectedPlan?.route ?? null;
    if (!gpxStats?.segmentGrades?.length || !fitData?.movingPowerSeries?.length) return [];
    const climbs = detectClimbs(gpxStats);
    if (!climbs.length) return [];
    return buildPerClimbStats(
      climbs,
      fitData.movingPowerSeries,
      fitData.movingDistSeries,
      actualWbalRaw,
      athlete.ftp,
      alignment,
    );
  })();

  // Execution score: IF delta — 0 delta = 100%, each 0.01 IF = 2 points off, capped 0–100.
  const execScore = selectedPlan && actualMetrics ? (() => {
    const plannedIF = selectedPlan.pacingPlan.ifActual;
    const actualIF  = actualMetrics.ifAct;
    const delta     = Math.abs(actualIF - plannedIF);
    return Math.max(0, Math.min(100, Math.round(100 - delta * 200)));
  })() : null;

  // 4C sub-step 2 — Scheme D plan-vs-actual data prep.
  //
  // `alignedPlanBlocks`: each plan block annotated with the FIT-distance
  // range where on-route FIT seconds fell inside the block's GPX-distance
  // range. `skipped` is true if the rider never visited that block's GPX
  // range — the plan line will have a natural break there. Built via single
  // walk over alignment + binary search on block start distances (O(N+M·log B)).
  const alignedPlanBlocks = useMemo(() => {
    const ps = selectedPlan?.pacingPlan?.powerStream;
    if (!ps?.length || !alignment?.length) return null;
    const totalDistM = (selectedPlan?.route?.totalDistKm ?? 0) * 1000;
    const blockStartsM = ps.map(b => b.distKm * 1000);
    const blockEndsM = ps.map((_, i) =>
      i < ps.length - 1 ? ps[i + 1].distKm * 1000 : totalDistM);
    const fitMin = new Array(ps.length).fill(Infinity);
    const fitMax = new Array(ps.length).fill(-Infinity);
    for (let i = 0; i < alignment.length; i++) {
      const a = alignment[i];
      if (!a.onRoute || a.gpxDistM == null) continue;
      // Largest block index with blockStartsM[idx] <= gpxDistM.
      let lo = 0, hi = blockStartsM.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (blockStartsM[mid] <= a.gpxDistM) lo = mid;
        else hi = mid - 1;
      }
      if (a.gpxDistM < blockEndsM[lo]) {
        if (a.fitDistM < fitMin[lo]) fitMin[lo] = a.fitDistM;
        if (a.fitDistM > fitMax[lo]) fitMax[lo] = a.fitDistM;
      }
    }
    return ps.map((block, i) => ({
      ...block,
      fitDistMin: isFinite(fitMin[i]) ? fitMin[i] : null,
      fitDistMax: isFinite(fitMax[i]) ? fitMax[i] : null,
      skipped:    !isFinite(fitMin[i]),
    }));
  }, [selectedPlan?.pacingPlan, selectedPlan?.route?.totalDistKm, alignment]);

  // 4C sub-step 4 — off-route span detection. Walks `alignment` to find
  // contiguous runs of off-route seconds, classified as pre/mid/post relative
  // to the rider's first/last on-route second. Each span is rendered as a
  // gray <ReferenceArea> on the Power Analysis chart so the user can see
  // pre-route warmup, mid-route detours, and post-route cooldown at a glance.
  // Tiny spans (< MIN_SPAN_M, GPS jitter) are filtered out.
  const offRouteSpans = useMemo(() => {
    if (!alignment?.length) return null;
    const MIN_SPAN_M = 50; // suppress single-point GPS jitters
    let firstOnRouteIdx = -1, lastOnRouteIdx = -1;
    for (let i = 0; i < alignment.length; i++) {
      if (alignment[i].onRoute) {
        if (firstOnRouteIdx === -1) firstOnRouteIdx = i;
        lastOnRouteIdx = i;
      }
    }
    if (firstOnRouteIdx === -1) return []; // no on-route seconds at all
    const spans = [];
    let runStart = -1;
    for (let i = 0; i <= alignment.length; i++) {
      const off = i < alignment.length && !alignment[i].onRoute;
      if (off && runStart === -1) runStart = i;
      else if (!off && runStart !== -1) {
        const startFitM = alignment[runStart].fitDistM;
        const endFitM = i < alignment.length
          ? alignment[i].fitDistM
          : alignment[alignment.length - 1].fitDistM;
        const lengthM = endFitM - startFitM;
        if (lengthM >= MIN_SPAN_M) {
          const category =
            i - 1 < firstOnRouteIdx ? 'pre' :
            runStart > lastOnRouteIdx ? 'post' :
            'mid';
          spans.push({ startFitM, endFitM, lengthM, category });
        }
        runStart = -1;
      }
    }
    return spans;
  }, [alignment]);

  // Overlay chart data — Scheme D rendering. X-axis is FIT distance; each
  // row carries actual power + the plan power for whichever plan block
  // covers the rider's GPX-distance position during that FIT minute.
  //
  // Mapping: each fitMinStream row corresponds to alignment seconds
  // [blockIdx*60 .. (blockIdx+1)*60). For on-route seconds in that range,
  // we average their gpxDistM to get the rider's representative GPX
  // position during this minute. Then we find the plan block whose GPX
  // range contains that position. Off-route minutes (no on-route seconds)
  // get plannedPower=undefined → recharts renders a break.
  //
  // Why not bucket by `block.fitDistMin/fitDistMax`: on rides with
  // non-monotonic alignment (rider returns near earlier route territory,
  // or goes off-route and comes back close to where they left), a block's
  // fitDistMin/fitDistMax extremes can span most of the ride and every
  // fitPt matches that one block — producing a flat plan line.
  //
  // Legacy fallback: when `alignment` is unavailable (saved race without
  // `_gpxPts` on the route or `movingGPSPath` on the FIT — pre-Prompt-3.5 /
  // pre-4B-Step-5 saves), match each FIT minute to the nearest plan block
  // by **time**. Approximate positioning; re-save upgrades it automatically.
  const planMin = selectedPlan?.pacingPlan?.powerStream ?? null;
  // Plan-block GPX bounds, computed once per plan: each block i covers
  // gpxDistM [blockStartsM[i], blockEndsM[i]).
  const planBlockBounds = useMemo(() => {
    if (!planMin?.length) return null;
    const totalDistM = (selectedPlan?.route?.totalDistKm ?? 0) * 1000;
    const startsM = planMin.map(b => b.distKm * 1000);
    const endsM = planMin.map((_, i) =>
      i < planMin.length - 1 ? planMin[i + 1].distKm * 1000 : totalDistM);
    return { startsM, endsM };
  }, [planMin, selectedPlan?.route?.totalDistKm]);

  const overlayChartData = useMemo(() => {
    if (!fitMinStream.length) return [];
    const distScale = imperial ? 1 / 1609.344 : 1 / 1000; // m → mi or km
    const useAlignment = !!alignment && !!planBlockBounds;
    return fitMinStream.map((fitPt, blockIdx) => {
      const fitDistDisp = fitPt.fitDistM * distScale;
      let plannedPower;
      let offRoute = false;
      if (useAlignment) {
        // Average gpxDistM of on-route seconds within this minute.
        const startSec = blockIdx * 60;
        const endSec = Math.min(startSec + 60, alignment.length);
        let sumGpx = 0, count = 0;
        for (let s = startSec; s < endSec; s++) {
          const a = alignment[s];
          if (a && a.onRoute && a.gpxDistM != null) {
            sumGpx += a.gpxDistM;
            count++;
          }
        }
        if (count > 0) {
          const avgGpxDistM = sumGpx / count;
          // Binary search for plan block containing avgGpxDistM.
          const { startsM, endsM } = planBlockBounds;
          let lo = 0, hi = startsM.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (startsM[mid] <= avgGpxDistM) lo = mid;
            else hi = mid - 1;
          }
          if (avgGpxDistM < endsM[lo]) plannedPower = planMin[lo].power;
        } else {
          // Entire minute off-route — flag for tooltip; plannedPower stays undefined.
          offRoute = true;
        }
      } else if (planMin && planMin.length > 0) {
        // Legacy time-nearest fallback.
        const nearest = planMin.reduce((best, pt) =>
          Math.abs(pt.time - fitPt.time) < Math.abs(best.time - fitPt.time) ? pt : best
        );
        plannedPower = nearest.power;
      }
      return { ...fitPt, fitDistDisp, actualPower: fitPt.power, plannedPower, offRoute };
    });
  }, [fitMinStream, alignment, planMin, planBlockBounds, imperial]);

  const alerts = [];
  if (actualMetrics) {
    if (selectedPlan) {
      const rawSeries = fitData?.movingPowerSeries ?? [];
      const firstHourSecs = rawSeries.slice(0, 3600);
      const firstHourActual = firstHourSecs.length ? Math.round(firstHourSecs.reduce((s, p) => s + p, 0) / firstHourSecs.length) : 0;
      const lastThirdSecs = rawSeries.slice(-Math.floor(rawSeries.length / 3));
      const lastThirdActual = lastThirdSecs.length ? Math.round(lastThirdSecs.reduce((s, p) => s + p, 0) / lastThirdSecs.length) : 0;
      if (firstHourActual > selectedPlan.pacingPlan.normalizedPower * 1.05) alerts.push({ type: "warn", msg: "Went out harder than planned in first hour." });
      if (lastThirdActual < selectedPlan.pacingPlan.normalizedPower * 0.9) alerts.push({ type: "warn", msg: "Significant power drop in final third — possible fade or under-fueling." });
    }
    const bonkPt = fitOverlay.find(d => d.reservePct < 10);
    if (bonkPt) alerts.push({ type: "danger", msg: `Glycogen depletion likely around ${minsToHHMM(bonkPt.time)}.` });
    // W'bal alerts on actual ride
    if (actualWbalRaw) {
      const { minWbalPct, minWbalTime, wPrime } = actualWbalRaw;
      const depletedPt = actualWbal.find(d => d.wbalPct === 0);
      const critPt     = actualWbal.find(d => d.wbalPct <= 20);
      const warnPt     = actualWbal.find(d => d.wbalPct <= 40);
      if (depletedPt) alerts.push({ type: "danger", msg: `W' fully depleted at ${minsToHHMM(depletedPt.time)} — this explains any blowup or severe fade.` });
      else if (critPt) alerts.push({ type: "danger", msg: `W' dropped to critical level (${critPt.wbalPct}%) at ${minsToHHMM(critPt.time)}.` });
      else if (warnPt) alerts.push({ type: "warn", msg: `W' dropped below 40% at ${minsToHHMM(warnPt.time)} (min: ${Math.round(actualWbalRaw.minWbal/1000*10)/10}kJ).` });
    }
  }

  return (
    <div>
      {/* B-32: loading overlay during FIT processing — covers parseFIT and the
          subsequent alignFitToGpx useMemo blocking render. */}
      {fitProcessing && (
        <div role="status" aria-live="polite" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: "28px 36px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, minWidth: 240 }}>
            <div className="fm-spinner" aria-hidden="true" />
            <div style={{ fontSize: 12, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Processing ride data…
            </div>
          </div>
        </div>
      )}
      {/* Load section */}
      <div className="card">
        <div className="card-header">Load Data</div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: T.textMuted, display: "block", marginBottom: 4 }}>Race</label>
          <select value={selectedRaceId} onChange={e => setSelectedRaceId(e.target.value)} style={{ width: "100%" }}>
            <option value="">— Standalone (no race selected) —</option>
            {races.map(r => (
              <option key={r.id} value={r.id}>
                {r.name}{r.status === 'analyzed' ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </div>
        <DropZone accept=".fit" label="Drop .fit file or click to upload" onFile={handleFIT} loaded={fitFile} />
        {fitError && <div className="alert alert-danger" style={{ marginTop: 8 }}>{fitError}</div>}
        {/* No-power dismissible toast — appears immediately on parse, before metadata. */}
        {fitData && !hasPower && !noPowerToastDismissed && (
          <div className="alert alert-warn" style={{ marginTop: 8, justifyContent: "space-between", alignItems: "flex-start" }}>
            <span>⚠ This file has no power data. Time, distance, elevation, and heart rate metrics will be shown. Power-based analysis is unavailable.</span>
            <button onClick={() => setNoPowerToastDismissed(true)}
              style={{ background: "none", border: "none", color: T.gold, fontSize: 16, cursor: "pointer", padding: "0 4px", marginLeft: 8, lineHeight: 1 }}>
              ×
            </button>
          </div>
        )}
        {fitData && (
          <div style={{ marginTop: 10, fontSize: 12, color: T.textMuted, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>{fitData.totalRecords.toLocaleString()} records · Moving: {minsToHHMM(fitData.movingMin)} · Elapsed: {minsToHHMM(fitData.elapsedMin)}</span>
            {!hasPower && (
              <span style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: T.gold, background: "rgba(255,184,0,0.12)", border: `1px solid rgba(255,184,0,0.4)`, padding: "2px 8px", borderRadius: 3 }}>
                ⚠ no power data
              </span>
            )}
          </div>
        )}
        {fitData && selectedRaceId && (
          <div style={{ marginTop: 10 }}>
            {fitSaved
              ? <div style={{ fontSize: 12, color: T.green }}>✓ FIT data saved to race</div>
              : <button className="btn-primary" onClick={saveFitToRace} style={{ fontSize: 12 }}>Update Race with FIT Data</button>
            }
          </div>
        )}
      </div>

      {/* Planned vs Actual header — power-dependent */}
      {hasPower && selectedPlan && actualMetrics && (
        <div className="card">
          <div className="card-header">Planned vs Actual</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 8 }}>
            {[
              ["Moving Time",
                selectedPlan.pacingPlan.durationLoMin
                  ? `${minsToHHMM(selectedPlan.pacingPlan.durationLoMin)}–${minsToHHMM(selectedPlan.pacingPlan.durationHiMin)}`
                  : minsToHHMM(selectedPlan.pacingPlan.estimatedDurationMin),
                minsToHHMM(actualMetrics.dur), ""],
              ["Avg Power", (selectedPlan.pacingPlan.avgPower ?? Math.round(selectedPlan.pacingPlan.normalizedPower * 0.97)) + "w", actualMetrics.avgPwr + "w", ""],
              ["NP", selectedPlan.pacingPlan.normalizedPower + "w", actualMetrics.np + "w", ""],
              ["IF", selectedPlan.pacingPlan.ifActual.toFixed(2), actualMetrics.ifAct.toFixed(2), ""],
              ["TSS", selectedPlan.pacingPlan.tss, actualMetrics.tss, ""],
            ].map(([label, planned, actual]) => (
              <div key={label} style={{ background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 4, padding: "10px 12px" }}>
                <div className="stat-label" style={{ marginBottom: 6 }}>{label}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2 }}>Plan: <span style={{ color: T.text, fontFamily: "Barlow Condensed" }}>{planned}</span></div>
                <div style={{ fontSize: 11, color: T.textMuted }}>Act: <span style={{ color: T.blue, fontFamily: "Barlow Condensed" }}>{actual}</span></div>
              </div>
            ))}
          </div>
          {execScore !== null && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted }}>Pacing Execution Score</span>
              <div style={{ flex: 1, height: 6, background: T.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${execScore}%`, background: execScore > 80 ? T.green : execScore > 60 ? T.gold : T.red, borderRadius: 3, transition: "width 0.5s" }} />
              </div>
              <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 16, color: execScore > 80 ? T.green : execScore > 60 ? T.gold : T.red }}>{execScore}%</span>
            </div>
          )}
          {/* TODO(roadmap): Speed Efficiency section - compare actual flat terrain speed vs
               physics model prediction. Shows whether the athlete was faster/slower than
               predicted at their actual power output. Surfaces equipment/conditions delta.
               Framing: model calibration check, not race execution insight.
               Natural home here at the bottom of Planned vs Actual. */}
          {/* TODO(roadmap): Adaptive Profile Calibration - use Speed Efficiency delta across
               multiple races to back-solve CdA and Crr. If athlete consistently runs 8% slower
               than model on flat terrain, CdA or Crr is likely underestimated. Could surface
               suggested profile adjustments after 3+ races on similar terrain. Feasibility:
               high - we have all required inputs (actual speed, actual power, known grade,
               athlete weight, bike profile). Requires multi-race data store (localStorage or
               backend). Flag for post-persistence implementation. */}
        </div>
      )}

      {/* Elapsed / Stopped time card — standalone, shown whenever FIT is loaded */}
      {fitData && (fitData.elapsedMin !== fitData.movingMin) && (
        <div className="card">
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <div className="stat-box">
              <div className="stat-label">Elapsed Time</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{minsToHHMM(fitData.elapsedMin)}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Moving Time</div>
              <div className="stat-value" style={{ fontSize: 18, color: T.blue }}>{minsToHHMM(fitData.movingMin)}</div>
            </div>
            <div className="stat-box">
              <div className="stat-label">Stopped</div>
              <div className="stat-value" style={{ fontSize: 18, color: T.textMuted }}>{minsToHHMM(fitData.stoppedMin)}</div>
              <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>aid stations / stops</div>
            </div>
          </div>
        </div>
      )}

      {/* Standalone actual metrics — always shown when FIT is loaded (with or without a plan).
          Power-dependent (NP / IF / TSS / zone distribution all need power). */}
      {hasPower && actualMetrics && !selectedPlan && (
        <div className="card">
          <div className="card-header">Ride Summary</div>
          <div className="stat-row">
            {[
              ["Moving Time", minsToHHMM(actualMetrics.dur), null],
              ["Avg Power",   actualMetrics.avgPwr + "w", null],
              ["NP",          actualMetrics.np + "w", null],
              ["IF",          actualMetrics.ifAct.toFixed(2), zoneColor(actualMetrics.ifAct)],
              ["TSS",         actualMetrics.tss, null],
            ].map(([label, val, color]) => (
              <div key={label} className="stat-box">
                <div className="stat-label">{label}</div>
                <div className="stat-value" style={{ color: color || T.text }}>{val}</div>
              </div>
            ))}
          </div>
          {/* Power zone distribution */}
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Power Zone Distribution</div>
            <ZoneComparisonBar actualStream={fitMinStream} plannedStream={null} ftp={athlete.ftp} />
          </div>
        </div>
      )}

      {/* Power Analysis — actual as filled area (zone-colored stroke), planned as muted line.
           Gap between the two = delta at a glance. Standalone mode: area only, no planned line. */}
      {hasPower && fitMinStream.length > 0 && (() => {
        const allVals = overlayChartData.flatMap(d => [d.actualPower || 0, d.plannedPower || 0]).filter(Boolean);
        const yMax = Math.ceil((Math.max(...allVals) * 1.12) / 50) * 50;
        const yMin = Math.max(0, Math.floor((Math.min(...allVals) * 0.88) / 50) * 50);
        return (
          <div className="card">
            <div className="card-header">Power Analysis</div>
            <div style={{ height: 210 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={overlayChartData} margin={{ top: 8, right: 44, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id="actualAreaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={T.blue} stopOpacity={0.18} />
                      <stop offset="95%" stopColor={T.blue} stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
                  {/* 4C sub-step 4: off-route bands — pre-route warmup,
                      mid-route detour, post-route cooldown. Rendered before
                      Area/Line so they sit behind the data. */}
                  {offRouteSpans?.map((span, i) => {
                    const distScale = imperial ? 1 / 1609.344 : 1 / 1000;
                    return (
                      <ReferenceArea key={`offrt-${i}`}
                        x1={span.startFitM * distScale} x2={span.endFitM * distScale}
                        fill={T.textMuted} fillOpacity={0.10}
                        stroke="none" />
                    );
                  })}
                  {/* 4C sub-step 2: x-axis is FIT distance (km/mi) — Scheme D. */}
                  <XAxis dataKey="fitDistDisp" type="number" domain={['dataMin', 'dataMax']}
                    tick={{ fill: T.textDim, fontSize: 10 }}
                    tickFormatter={v => `${Math.round(v)}${imperial ? "mi" : "km"}`} />
                  <YAxis domain={[yMin, yMax]} tick={{ fill: T.textDim, fontSize: 10 }}
                    width={40} tickFormatter={v => `${v}w`} />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    const ap = d?.actualPower || 0;
                    const pp = d?.plannedPower;
                    const isOffRoute = !!d?.offRoute;
                    const pct = ap / athlete.ftp;
                    const zLabel = pct < 0.55 ? "Z1" : pct < 0.75 ? "Z2" : pct < 0.85 ? "Z3" : pct < 0.95 ? "Z4" : "Z5";
                    const delta = pp != null ? ap - pp : null;
                    const distLabel = `${(d?.fitDistDisp ?? 0).toFixed(1)}${imperial ? "mi" : "km"}`;
                    const timeLabel = minsToHHMM(d?.time || 0);
                    return (
                      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 12 }}>
                        <div style={{ color: T.textMuted, marginBottom: 4 }}>{distLabel} · {timeLabel}</div>
                        <div style={{ color: zoneColor(pct) }}>
                          Actual: <strong>{ap}w</strong>
                          <span style={{ fontSize: 10, color: T.textDim, marginLeft: 5 }}>{Math.round(pct*100)}% FTP · {zLabel}</span>
                        </div>
                        {isOffRoute ? (
                          <div style={{ color: T.textDim, marginTop: 2, fontStyle: 'italic' }}>
                            Off Route
                          </div>
                        ) : pp != null && (
                          <div style={{ color: T.textMuted, marginTop: 2 }}>
                            Planned: {pp}w
                            <span style={{ marginLeft: 8, color: delta > 0 ? T.green : delta < 0 ? T.red : T.textDim, fontFamily: "Barlow Condensed", fontWeight: 700 }}>
                              {delta > 0 ? "+" : ""}{delta}w
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  }} />
                  {/* Actual — filled area with zone-colored stroke */}
                  <Area dataKey="actualPower" name="Actual"
                    type="monotone"
                    stroke={T.blue} strokeWidth={2}
                    fill="url(#actualAreaFill)"
                    dot={false} activeDot={{ r: 3, fill: T.blue }}
                  />
                  {/* Planned — thin muted line, no fill. Recedes behind actual.
                      4C sub-step 2: connectNulls={false} so plan line breaks
                      naturally at off-route stretches and skipped blocks
                      (where plannedPower is undefined for that x position). */}
                  {selectedPlan && (
                    <Line dataKey="plannedPower" name="Planned"
                      type="monotone"
                      stroke="rgba(0,212,255,0.35)" strokeWidth={1.5}
                      strokeDasharray="5 3"
                      dot={false}
                      connectNulls={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* Legend */}
            <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 11, color: T.textMuted }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ display: "inline-block", width: 20, height: 2, background: T.blue, borderRadius: 1 }} />
                Actual
              </span>
              {selectedPlan && (
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ display: "inline-block", width: 20, height: 0, borderTop: "1.5px dashed rgba(0,212,255,0.45)" }} />
                  Planned
                </span>
              )}
              {selectedPlan && (
                <span style={{ fontSize: 10, color: T.textDim, marginLeft: 4 }}>gap = delta vs plan</span>
              )}
            </div>
            {/* Zone distribution */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>
                Power Zone Distribution
              </div>
              <ZoneComparisonBar
                actualStream={fitMinStream}
                plannedStream={selectedPlan?.pacingPlan?.powerStream ?? null}
                ftp={athlete.ftp}
              />
            </div>

            {/* Fade Analysis — only shown when a plan is selected */}
            {selectedPlan && (() => {
              // B-21: per-third NP via canonical computeNP on per-second data on
              // BOTH sides. Pre-fix, ACTUAL ran 30-sec rolling window over 1-sec
              // data (correct) while PLAN ran window=1 over 1-min blocks (no
              // rolling at all). The drift was 1–3W per third on PLAN side vs
              // canonical math (per Validation Report Finding F-6). Now both
              // sides route through `computeNP` and produce coherent numbers.
              //
              // Legacy saves without `powerStreamPerSec` (pre-4B / CC#7) fall
              // back to the 1-min `powerStream` block-NP approximation. The
              // approximation is what the saved race shipped with; respecting
              // the no-retroactive-recompute principle.
              const blockNPApprox = (blocks) => {
                if (!blocks || blocks.length === 0) return 0;
                const powers = blocks.map(b => b.power);
                // 4th-power mean of 1-min averages. No rolling window at this
                // resolution. Used only on legacy saves.
                return Math.round(Math.pow(
                  powers.reduce((s, p) => s + p ** 4, 0) / powers.length, 0.25));
              };

              // 4C sub-step 6 — bucket BOTH actual and plan by route-distance
              // thirds. Same boundaries on both sides so they're apples-to-apples
              // (and consistent with every other "thirds" section on the page).
              // Falls back to legacy moving-time index thirds when alignment is
              // unavailable (legacy save with no _gpxPts/movingGPSPath).
              const splitPerSecByDistKm = (perSec, t1Km, t2Km) => {
                if (!perSec?.length) return [[], [], []];
                return [
                  perSec.filter(p => p.distKm < t1Km).map(p => p.power),
                  perSec.filter(p => p.distKm >= t1Km && p.distKm < t2Km).map(p => p.power),
                  perSec.filter(p => p.distKm >= t2Km).map(p => p.power),
                ];
              };
              const splitTimeThirdsLegacy = (stream) => {
                if (!stream || stream.length === 0) return [[], [], []];
                const maxTime = stream[stream.length - 1].time;
                const t1 = maxTime / 3, t2 = maxTime * 2 / 3;
                return [
                  stream.filter(pt => pt.time < t1),
                  stream.filter(pt => pt.time >= t1 && pt.time < t2),
                  stream.filter(pt => pt.time >= t2),
                ];
              };

              // ACTUAL side: per-second movingPowerSeries bucketed via
              // thirdsByRouteDistance (route-distance bins, off-route excluded).
              // Falls back to elapsed-time thirds when alignment unavailable.
              const rps = fitData.movingPowerSeries;
              const actualThirdPowers = thirdsByRouteDistance
                ? thirdsByRouteDistance.map(idxs => idxs.map(i => rps[i]))
                : (() => {
                    const stream = rps.map((p, i) => ({ power: p, time: i / 60 }));
                    return splitTimeThirdsLegacy(stream).map(third => third.map(b => b.power));
                  })();
              const actualNPs = actualThirdPowers.map(powers => computeNP(powers));

              // PLAN side: prefer per-second `powerStreamPerSec` (CC#7 canonical
              // path). Legacy saves without it fall back to 1-min powerStream
              // block-NP approximation per the no-retroactive-recompute rule.
              const planPerSec = selectedPlan.pacingPlan.powerStreamPerSec;
              const totalKm = selectedPlan?.route?.totalDistKm ?? 0;
              let plannedNPs;
              if (planPerSec?.length && totalKm > 0) {
                const t1Km = totalKm / 3, t2Km = totalKm * 2 / 3;
                const planThirdPowers = splitPerSecByDistKm(planPerSec, t1Km, t2Km);
                plannedNPs = planThirdPowers.map(powers => computeNP(powers));
              } else {
                // Legacy fallback: 1-min powerStream block-NP approximation.
                const legacyStream = selectedPlan.pacingPlan.powerStream;
                const plannedThirds = totalKm > 0
                  ? (() => {
                      const t1Km = totalKm / 3, t2Km = totalKm * 2 / 3;
                      return [
                        legacyStream.filter(pt => pt.distKm < t1Km),
                        legacyStream.filter(pt => pt.distKm >= t1Km && pt.distKm < t2Km),
                        legacyStream.filter(pt => pt.distKm >= t2Km),
                      ];
                    })()
                  : splitTimeThirdsLegacy(legacyStream);
                plannedNPs = plannedThirds.map(third => blockNPApprox(third));
              }

              // Color per third: within ±10% = blue (on plan), over >10% = red (too hard), under >10% = green (too easy)
              const thirdColor = (actual, planned) => {
                if (!planned) return T.textDim;
                const delta = (actual - planned) / planned * 100;
                if (delta > 10)   return "#FF3347"; // Too hard
                if (delta < -10)  return "#00FF8C"; // Too easy
                return "#00D4FF";                   // On plan
              };

              const colors = actualNPs.map((np, i) => thirdColor(np, plannedNPs[i]));
              const deltas = actualNPs.map((np, i) => plannedNPs[i] ? Math.round((np - plannedNPs[i]) / plannedNPs[i] * 100) : 0);

              // Insight: read the trend pattern
              const pattern = colors.map(c => c === "#00D4FF" ? "on" : c === "#FF3347" ? "over" : "under");
              const insightText = (() => {
                if (pattern.every(p => p === "on"))    return { label: "On Plan",                color: "#00D4FF", detail: "NP held within 10% of plan across all three thirds" };
                if (pattern.every(p => p === "over"))  return { label: "Consistently Too Hard",  color: "#FF3347", detail: `Averaged ${Math.round(deltas.reduce((s,d)=>s+d,0)/3)}% above planned NP throughout` };
                if (pattern.every(p => p === "under")) return { label: "Consistently Too Easy",  color: "#00FF8C", detail: `Averaged ${Math.round(Math.abs(deltas.reduce((s,d)=>s+d,0)/3))}% below planned NP throughout` };
                if (pattern[0] === "over" && pattern[2] === "under") return { label: "Went Out Too Hard",     color: "#FF3347", detail: `Started ${deltas[0]}% over plan, faded to ${deltas[2]}% under by the final third` };
                if (pattern[0] === "under" && pattern[2] === "over") return { label: "Strong Negative Split", color: "#00FF8C", detail: `Held back early (${deltas[0]}% under), finished ${deltas[2]}% above plan` };
                if (pattern[2] === "under") return { label: "Late Fade",     color: "#FFB800", detail: `Final third dropped to ${deltas[2]}% vs plan — fatigue or conservative finish` };
                if (pattern[2] === "over")  return { label: "Strong Finish", color: "#00FF8C", detail: `Final third was ${deltas[2]}% above plan — good reserve management` };
                return { label: "Mixed Pacing", color: "#00D4FF", detail: "Uneven distribution across thirds — review segment targets" };
              })();

              const THIRD_LABELS = ["First Third", "Second Third", "Last Third"];

              return (
                <div style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      Fade Analysis
                    </div>
                    <div style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", fontWeight: 400, letterSpacing: "0.05em", marginTop: 2 }}>
                      Normalized Power (NP) — physiological cost per third
                    </div>
                  </div>

                  {/* Third headers — equal width */}
                  <div style={{ display: "flex", width: "100%", marginBottom: 6 }}>
                    {THIRD_LABELS.map(label => (
                      <div key={label} style={{ flex: 1, textAlign: "center", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {label}
                      </div>
                    ))}
                  </div>

                  {/* PLAN label above planned values */}
                  <div style={{ fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textDim, marginBottom: 3 }}>Plan</div>
                  <div style={{ display: "flex", width: "100%", marginBottom: 6 }}>
                    {plannedNPs.map((np, i) => (
                      <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim }}>
                        {np}w
                      </div>
                    ))}
                  </div>

                  {/* Color-coded bars — three equal columns */}
                  <div style={{ display: "flex", width: "100%", height: 10, gap: 6, marginBottom: 6 }}>
                    {colors.map((color, i) => (
                      <div key={i} style={{ flex: 1, borderRadius: 3, background: color, opacity: 0.85 }}
                        title={`${THIRD_LABELS[i]}: ${deltas[i] > 0 ? "+" : ""}${deltas[i]}% vs plan`}
                      />
                    ))}
                  </div>

                  {/* Actual NP, then ACTUAL label below */}
                  <div style={{ display: "flex", width: "100%", marginBottom: 3 }}>
                    {actualNPs.map((np, i) => (
                      <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, color: colors[i] }}>
                        {np}w
                        <span style={{ fontSize: 9, color: colors[i], opacity: 0.8, marginLeft: 3 }}>
                          {deltas[i] > 0 ? `+${deltas[i]}%` : `${deltas[i]}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.textDim, marginBottom: 8 }}>Actual</div>

                  {/* Insight pill */}
                  <div style={{ marginTop: 8 }}>
                    <div style={{
                      display: "inline-flex", alignItems: "center", gap: 8,
                      fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700,
                      color: insightText.color,
                      background: `${insightText.color}18`,
                      border: `1px solid ${insightText.color}55`,
                      borderRadius: 4, padding: "4px 12px",
                      letterSpacing: "0.05em",
                    }}>
                      <span>{insightText.label}</span>
                      <span style={{ fontWeight: 400, opacity: 0.85 }}>·</span>
                      <span style={{ fontWeight: 400 }}>{insightText.detail}</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* ── EFFORT & FATIGUE ───────────────────────────────────────────
           Power-dependent: every section in this card (Cardiac Efficiency,
           Threshold Exposure, Effort vs Plan, Anaerobic Reserve) is built on
           the moving power series. Hide the entire card when no power data. */}
      {hasPower && fitMinStream.length > 0 && fitMinStream.some(b => b.hr > 0) && (() => {
        const maxHR    = athlete.maxHR || 185;
        const rawSeries = fitData?.movingPowerSeries ?? [];
        const rawHR     = fitData?.movingHRSeries ?? [];
        const n = rawSeries.length;

        // 4C sub-step 6 — bucket per-second power and HR by route-distance
        // thirds when alignment is available; fall back to moving-time index
        // thirds otherwise. All "thirds" sections on this card share the same
        // boundaries so they read consistently.
        let rawThirds, hrThirds_secs;
        if (thirdsByRouteDistance) {
          rawThirds = thirdsByRouteDistance.map(idxs => idxs.map(i => rawSeries[i]));
          hrThirds_secs = thirdsByRouteDistance.map(idxs => idxs.map(i => rawHR[i]));
        } else {
          const third = Math.floor(n / 3);
          rawThirds = [
            rawSeries.slice(0, third),
            rawSeries.slice(third, third * 2),
            rawSeries.slice(third * 2),
          ];
          hrThirds_secs = [
            rawHR.slice(0, third),
            rawHR.slice(third, third * 2),
            rawHR.slice(third * 2),
          ];
        }

        const avgHR  = arr => { const v = arr.filter(h => h > 0); return v.length ? Math.round(v.reduce((s,h)=>s+h,0)/v.length) : 0; };
        const avgPwr = arr => arr.length ? Math.round(arr.filter(p => p > 0).reduce((s,p) => s + p, 0) / arr.filter(p => p > 0).length) : 0;

        const hrThirds  = hrThirds_secs.map(avgHR);
        const pwrThirds = rawThirds.map(avgPwr);
        // HR zone color by % of maxHR
        const hrZoneColor = (hr) => {
          const pct = hr / maxHR * 100;
          if (pct < 75)  return "#00D4FF"; // easy
          if (pct < 85)  return "#00FF8C"; // moderate
          if (pct < 90)  return "#FFB800"; // hard
          return "#FF3347";               // very hard
        };
        const hrColors = hrThirds.map(hrZoneColor);

        // Cardiac drift: HR change T1→T3 with power context
        const hrDrift   = hrThirds[2] - hrThirds[0];
        const pwrChange = pwrThirds[2] - pwrThirds[0];

        const THIRD_LABELS = ["First Third", "Second Third", "Last Third"];
        const sectionLabel = (text) => (
          <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>{text}</div>
        );

        return (
          <div className="card">
            <div className="card-header">Effort Analysis</div>

            {/* ── HR by Third — side-by-side power + HR columns, narrative insight ── */}
            {sectionLabel("Cardiac Efficiency")}
            <div style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", fontWeight: 400, letterSpacing: "0.05em", marginTop: -4, marginBottom: 10 }}>
              Avg Power — cardiac drift vs power output per third
            </div>

            {/* Column headers */}
            <div style={{ display: "flex", width: "100%", marginBottom: 8 }}>
              <div style={{ width: 56, flexShrink: 0 }} />
              {THIRD_LABELS.map(l => (
                <div key={l} style={{ flex: 1, textAlign: "center", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{l}</div>
              ))}
            </div>

            {/* Power row */}
            <div style={{ display: "flex", width: "100%", alignItems: "center", marginBottom: 6 }}>
              <div style={{ width: 56, flexShrink: 0, fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Avg Pwr</div>
              {pwrThirds.map((pwr, i) => {
                const delta = i > 0 ? Math.round((pwr - pwrThirds[0]) / pwrThirds[0] * 100) : null;
                return (
                  <div key={i} style={{ flex: 1, textAlign: "center" }}>
                    <span style={{ fontSize: 13, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.text }}>{pwr}w</span>
                    {delta !== null && (
                      <span style={{ fontSize: 9, fontFamily: "Barlow Condensed", color: delta >= 0 ? "#00FF8C" : "#FFB800", marginLeft: 4 }}>
                        {delta > 0 ? "+" : ""}{delta}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* HR color bar */}
            <div style={{ display: "flex", width: "100%", height: 8, gap: 4, marginBottom: 6, paddingLeft: 64 }}>
              {hrColors.map((color, i) => (
                <div key={i} style={{ flex: 1, borderRadius: 3, background: color, opacity: 0.8 }}
                  title={`${THIRD_LABELS[i]}: ${hrThirds[i]}bpm`} />
              ))}
            </div>

            {/* HR row */}
            <div style={{ display: "flex", width: "100%", alignItems: "center", marginBottom: 12 }}>
              <div style={{ width: 56, flexShrink: 0, fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>HR</div>
              {hrThirds.map((hr, i) => {
                const delta = i > 0 ? hrThirds[i] - hrThirds[0] : null;
                return (
                  <div key={i} style={{ flex: 1, textAlign: "center" }}>
                    <span style={{ fontSize: 13, fontFamily: "Barlow Condensed", fontWeight: 700, color: hrColors[i] }}>{hr}bpm</span>
                    {delta !== null && (
                      <span style={{ fontSize: 9, fontFamily: "Barlow Condensed", color: delta > 3 ? "#FF3347" : delta < -3 ? "#00FF8C" : T.textDim, marginLeft: 4 }}>
                        {delta > 0 ? "+" : ""}{delta}
                      </span>
                    )}
                    <div style={{ fontSize: 9, color: T.textDim, marginTop: 1 }}>{Math.round(hr / maxHR * 100)}% max</div>
                  </div>
                );
              })}
            </div>

            {/* Narrative insight */}
            {(() => {
              const pwrDropPct  = Math.round((pwrThirds[2] - pwrThirds[0]) / pwrThirds[0] * 100);
              const hrDropPct   = hrThirds[0] > 0 ? Math.round((hrThirds[2] - hrThirds[0]) / hrThirds[0] * 100) : 0;
              const decoupling  = Math.round((hrDropPct - pwrDropPct) * 10) / 10; // positive = HR held higher than power warranted

              let narrative, color;

              if (Math.abs(decoupling) <= 3) {
                narrative = `HR and power tracked closely across all three thirds (${Math.abs(decoupling)}% decoupling). Aerobic system was well-matched to the effort — good pacing control.`;
                color = "#00D4FF";
              } else if (decoupling > 3 && pwrDropPct < -5) {
                narrative = `Power dropped ${Math.abs(pwrDropPct)}% from T1 to T3, but HR only dropped ${Math.abs(hrDropPct)}% — HR stayed elevated relative to output. Classic fatigue signature: the engine was working harder to produce less.`;
                color = "#FF3347";
              } else if (decoupling > 3 && pwrDropPct >= -5) {
                narrative = `Power held relatively steady (${pwrDropPct > 0 ? "+" : ""}${pwrDropPct}%) but HR climbed ${hrDropPct > 0 ? "+" : ""}${hrDropPct}% — textbook cardiac drift. Likely caused by heat, dehydration, or cumulative fatigue late in the race.`;
                color = "#FFB800";
              } else if (decoupling < -3) {
                narrative = `HR fell ${Math.abs(hrDropPct)}% while power dropped ${Math.abs(pwrDropPct)}% — HR dropped proportionally more than power. Could indicate favorable conditions in T3 (tailwind, descent) or a conservative finish.`;
                color = "#00FF8C";
              } else {
                narrative = `Mixed HR response across thirds. Review the power chart for terrain context.`;
                color = T.textMuted;
              }

              return (
                <div style={{ padding: "10px 12px", background: `${color}10`, border: `1px solid ${color}30`, borderRadius: 4, borderLeft: `3px solid ${color}` }}>
                  <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{narrative}</div>
                  <div style={{ fontSize: 10, color: T.textDim, marginTop: 4, fontFamily: "Barlow Condensed" }}>
                    PwHR decoupling: <span style={{ color, fontWeight: 700 }}>{decoupling > 0 ? "+" : ""}{decoupling}%</span>
                    <span style={{ marginLeft: 8 }}>· under 5% = well-matched aerobic effort</span>
                  </div>
                </div>
              );
            })()}

            {/* ── Threshold Exposure (absolute — no plan comparison) ── */}
            <div style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
              {sectionLabel("Threshold Exposure  (Z4+ · >91% FTP)")}
              {(() => {
                const threshWatts = athlete.ftp * 0.91;
                const rawSeries = fitData?.movingPowerSeries ?? [];
                const totalSecs = rawSeries.length;
                const rideMins = totalSecs / 60;
                // 4C sub-step 6 — route-distance thirds when alignment available.
                let rawThirds;
                if (thirdsByRouteDistance) {
                  rawThirds = thirdsByRouteDistance.map(idxs => idxs.map(i => rawSeries[i]));
                } else {
                  const third = Math.floor(totalSecs / 3);
                  rawThirds = [
                    rawSeries.slice(0, third),
                    rawSeries.slice(third, third * 2),
                    rawSeries.slice(third * 2),
                  ];
                }
                const actualThreshMins = rawThirds.map(t =>
                  Math.round(t.filter(w => w >= threshWatts).length / 60 * 10) / 10
                );
                const totalActualMins = Math.round(actualThreshMins.reduce((s, m) => s + m, 0) * 10) / 10;

                // Absolute benchmarks scaled to ride duration
                // ~6% of ride time above threshold = moderate, ~12% = aggressive
                const modThresh = Math.round(rideMins * 0.06 * 10) / 10;
                const aggThresh = Math.round(rideMins * 0.12 * 10) / 10;

                const barColor = (mins) => {
                  if (mins < 0.5) return T.border;
                  if (mins <= modThresh) return "#00D4FF";
                  if (mins <= aggThresh) return "#FFB800";
                  return "#FF3347";
                };
                const colors = actualThreshMins.map(barColor);

                const firstTwoThirds = actualThreshMins[0] + actualThreshMins[1];
                const frontLoadPct = totalActualMins > 0.5 ? Math.round(firstTwoThirds / totalActualMins * 100) : 0;

                const narrative = (() => {
                  if (totalActualMins < 0.5) return {
                    text: "No meaningful time above threshold. Either a very conservative effort, favorable terrain, or your FTP may be set slightly high. Check your FTP if this doesn't match how the effort felt.",
                    color: "#00D4FF"
                  };
                  if (totalActualMins > aggThresh && frontLoadPct >= 70) return {
                    text: `${totalActualMins} min above threshold — aggressive load (>${aggThresh} min benchmark for this ride length) and ${frontLoadPct}% of it in the first two thirds. Front-loading threshold work draws down glycogen and anaerobic reserves early. Any late-race fade in the Fade Analysis above is likely a downstream effect of this distribution.`,
                    color: "#FF3347"
                  };
                  if (totalActualMins > aggThresh) return {
                    text: `${totalActualMins} min above threshold exceeds the aggressive benchmark (${aggThresh} min) for a ${Math.round(rideMins)}-minute ride. The load was relatively spread across the race — cumulative fatigue built gradually rather than hitting a wall early.`,
                    color: "#FFB800"
                  };
                  if (frontLoadPct >= 75 && totalActualMins >= modThresh) return {
                    text: `${totalActualMins} min above threshold — moderate load, but ${frontLoadPct}% concentrated in the first two thirds. Even at reasonable total volume, front-loading threshold work is a common source of late-race fade. Watch for correlation in the Fade Analysis above.`,
                    color: "#FFB800"
                  };
                  return {
                    text: `${totalActualMins} min above threshold — ${totalActualMins <= modThresh ? "conservative to moderate" : "moderate"} load for a ${Math.round(rideMins)}-minute ride. Distribution across thirds was ${frontLoadPct < 65 ? "well balanced" : "slightly front-loaded"} — ${frontLoadPct < 65 ? "good discipline about when you went hard." : "keep an eye on pacing in the first half of future efforts."}`,
                    color: "#00D4FF"
                  };
                })();

                return (
                  <div>
                    <div style={{ display: "flex", width: "100%", marginBottom: 6 }}>
                      <div style={{ width: 56, flexShrink: 0 }} />
                      {THIRD_LABELS.map(l => (
                        <div key={l} style={{ flex: 1, textAlign: "center", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{l}</div>
                      ))}
                    </div>
                    <div style={{ display: "flex", width: "100%", height: 8, gap: 4, marginBottom: 4, paddingLeft: 64 }}>
                      {colors.map((color, i) => (
                        <div key={i} style={{ flex: 1, borderRadius: 3, background: color, opacity: 0.85 }} />
                      ))}
                    </div>
                    <div style={{ display: "flex", width: "100%", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ width: 56, flexShrink: 0, fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Actual</div>
                      {actualThreshMins.map((m, i) => (
                        <div key={i} style={{ flex: 1, textAlign: "center" }}>
                          <span style={{ fontSize: 13, fontFamily: "Barlow Condensed", fontWeight: 700, color: colors[i] }}>
                            {m.toFixed(1)}<span style={{ fontSize: 9, marginLeft: 2 }}>min</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 10 }}>
                      Total: <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: totalActualMins > aggThresh ? "#FF3347" : totalActualMins > modThresh ? "#FFB800" : "#00D4FF" }}>{totalActualMins.toFixed(1)} min</span>
                      <span style={{ color: T.textDim, marginLeft: 8, fontSize: 10 }}>benchmarks: {modThresh}m moderate · {aggThresh}m aggressive</span>
                    </div>
                    <div style={{ padding: "10px 12px", background: `${narrative.color}10`, border: `1px solid ${narrative.color}30`, borderRadius: 4, borderLeft: `3px solid ${narrative.color}` }}>
                      <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{narrative.text}</div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── Effort vs Plan (IF-based — only shown when plan selected) ── */}
            {selectedPlan && (() => {
              const planPowerStream = selectedPlan.pacingPlan.powerStream;
              if (!planPowerStream || planPowerStream.length === 0) return null;

              // B-21: Per-third NP via canonical computeNP on per-second data on
              // BOTH sides. Pre-fix, the local `npIF` helper ran a 30-sec rolling
              // window only on 1-sec data; on 1-min blocks the window degenerated
              // to 1 (no rolling) — drift 1–3W per third on PLAN. Now both sides
              // route through canonical `computeNP`.
              //
              // Legacy saves without `powerStreamPerSec` fall back to 1-min
              // block-NP approximation (no-retroactive-recompute principle).
              const blockNPApprox = (blocks) => {
                if (!blocks || blocks.length === 0) return 0;
                const powers = blocks.map(b => b.power);
                return Math.pow(
                  powers.reduce((s, p) => s + p ** 4, 0) / powers.length, 0.25);
              };

              // ACTUAL side: per-second movingPowerSeries bucketed via
              // thirdsByRouteDistance. Falls back to elapsed-time index thirds
              // when alignment unavailable.
              const rawSeries = fitData?.movingPowerSeries ?? [];
              const fitN = rawSeries.length;
              const actualThirdPowers = (thirdsByRouteDistance && selectedPlan?.route?.totalDistKm)
                ? thirdsByRouteDistance.map(idxs => idxs.map(i => rawSeries[i]))
                : [
                    rawSeries.slice(0, Math.floor(fitN / 3)),
                    rawSeries.slice(Math.floor(fitN / 3), Math.floor(2 * fitN / 3)),
                    rawSeries.slice(Math.floor(2 * fitN / 3)),
                  ];
              const actualNPs = actualThirdPowers.map(powers => computeNP(powers));
              const actualIFs = actualNPs.map(np => Math.round(np / athlete.ftp * 100) / 100);

              // PLAN side: prefer per-second `powerStreamPerSec`. Legacy saves
              // without it use 1-min block-NP approximation.
              const planPerSec = selectedPlan.pacingPlan.powerStreamPerSec;
              const totalKm = selectedPlan?.route?.totalDistKm ?? 0;
              let plannedNPs;
              if (planPerSec?.length && totalKm > 0) {
                const t1Km = totalKm / 3, t2Km = totalKm * 2 / 3;
                plannedNPs = [
                  computeNP(planPerSec.filter(p => p.distKm < t1Km).map(p => p.power)),
                  computeNP(planPerSec.filter(p => p.distKm >= t1Km && p.distKm < t2Km).map(p => p.power)),
                  computeNP(planPerSec.filter(p => p.distKm >= t2Km).map(p => p.power)),
                ];
              } else {
                // Legacy fallback: 1-min block-NP on powerStream.
                const planN = planPowerStream.length;
                const planThirds = totalKm > 0
                  ? (() => {
                      const t1Km = totalKm / 3, t2Km = totalKm * 2 / 3;
                      return [
                        planPowerStream.filter(pt => pt.distKm < t1Km),
                        planPowerStream.filter(pt => pt.distKm >= t1Km && pt.distKm < t2Km),
                        planPowerStream.filter(pt => pt.distKm >= t2Km),
                      ];
                    })()
                  : [
                      planPowerStream.slice(0, Math.floor(planN / 3)),
                      planPowerStream.slice(Math.floor(planN / 3), Math.floor(2 * planN / 3)),
                      planPowerStream.slice(Math.floor(2 * planN / 3)),
                    ];
                plannedNPs = planThirds.map(third => Math.round(blockNPApprox(third)));
              }
              const plannedIFs = plannedNPs.map(np => Math.round(np / athlete.ftp * 100) / 100);
              const deltas = actualIFs.map((a, i) => plannedIFs[i] > 0 ? Math.round((a - plannedIFs[i]) / plannedIFs[i] * 100) : 0);

              const barColor = (delta) => {
                if (Math.abs(delta) <= 5) return "#00D4FF"; // on plan
                if (delta > 5)  return "#FF3347";           // over plan
                return "#00FF8C";                           // under plan
              };
              const colors = deltas.map(barColor);

              const pattern = colors.map(c => c === "#00D4FF" ? "on" : c === "#FF3347" ? "over" : "under");
              const narrative = (() => {
                if (pattern.every(p => p === "on")) return {
                  text: "Executed the plan cleanly across all three thirds. Effort matched intent within 5% throughout — this is the pacing discipline that separates good race execution from great.",
                  color: "#00D4FF"
                };
                if (pattern[0] === "over" && pattern[2] === "under") return {
                  text: `Started ${deltas[0]}% above planned IF and faded to ${deltas[2]}% below by the final third. Classic front-loaded burn pattern — went out harder than the plan called for and paid for it late. The plan was designed to prevent exactly this.`,
                  color: "#FF3347"
                };
                if (pattern[0] === "under" && pattern[2] === "over") return {
                  text: `Held back ${Math.abs(deltas[0])}% in the first third and finished ${deltas[2]}% above plan — a strong negative split. Either very conservative early pacing or a course that demanded more effort late. Either way, reserves were well managed.`,
                  color: "#00FF8C"
                };
                if (pattern.every(p => p === "over")) return {
                  text: `Ran ${Math.round(deltas.reduce((s,d)=>s+d,0)/3)}% above planned IF consistently across all three thirds. Either the plan IF was set too conservatively, or conditions were harder than expected. If this matches how the effort felt, consider revising your target IF upward for similar courses.`,
                  color: "#FF3347"
                };
                if (pattern.every(p => p === "under")) return {
                  text: `Rode ${Math.round(Math.abs(deltas.reduce((s,d)=>s+d,0)/3))}% below planned IF throughout. Left performance on the table — either very conservative pacing or the plan IF was set too aggressively for the conditions.`,
                  color: "#00FF8C"
                };
                if (pattern[2] === "under") return {
                  text: `First two thirds within range but final third dropped ${Math.abs(deltas[2])}% below plan. Late fade — either cumulative fatigue, fueling shortfall, or the course got harder. Cross-reference with glycogen and W'bal sections.`,
                  color: "#FFB800"
                };
                return {
                  text: `Mixed execution — ${pattern.map((p, i) => `T${i+1}: ${deltas[i] > 0 ? "+" : ""}${deltas[i]}%`).join(", ")} vs plan. Review the power chart for terrain context on the off-thirds.`,
                  color: "#FFB800"
                };
              })();

              return (
                <div style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
                  {sectionLabel("Effort vs Plan  (NP IF per third)")}
                  <div style={{ display: "flex", width: "100%", marginBottom: 6 }}>
                    <div style={{ width: 56, flexShrink: 0 }} />
                    {THIRD_LABELS.map(l => (
                      <div key={l} style={{ flex: 1, textAlign: "center", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{l}</div>
                    ))}
                  </div>

                  {/* Planned IF row */}
                  <div style={{ display: "flex", width: "100%", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ width: 56, flexShrink: 0, fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Plan</div>
                    {plannedIFs.map((ifv, i) => (
                      <div key={i} style={{ flex: 1, textAlign: "center", fontSize: 13, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim }}>
                        {ifv.toFixed(2)}
                      </div>
                    ))}
                  </div>

                  {/* Color bar */}
                  <div style={{ display: "flex", width: "100%", height: 8, gap: 4, marginBottom: 4, paddingLeft: 64 }}>
                    {colors.map((color, i) => (
                      <div key={i} style={{ flex: 1, borderRadius: 3, background: color, opacity: 0.85 }}
                        title={`${THIRD_LABELS[i]}: ${deltas[i] > 0 ? "+" : ""}${deltas[i]}% vs plan`} />
                    ))}
                  </div>

                  {/* Actual IF row */}
                  <div style={{ display: "flex", width: "100%", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ width: 56, flexShrink: 0, fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>Actual</div>
                    {actualIFs.map((ifv, i) => (
                      <div key={i} style={{ flex: 1, textAlign: "center" }}>
                        <span style={{ fontSize: 13, fontFamily: "Barlow Condensed", fontWeight: 700, color: colors[i] }}>
                          {ifv.toFixed(2)}
                        </span>
                        <span style={{ fontSize: 9, fontFamily: "Barlow Condensed", color: colors[i], marginLeft: 4 }}>
                          {deltas[i] > 0 ? "+" : ""}{deltas[i]}%
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Narrative */}
                  <div style={{ padding: "10px 12px", background: `${narrative.color}10`, border: `1px solid ${narrative.color}30`, borderRadius: 4, borderLeft: `3px solid ${narrative.color}` }}>
                    <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{narrative.text}</div>
                  </div>
                </div>
              );
            })()}

            {/* ── Anaerobic Reserve ── */}
            {actualWbalRaw && (
              <div style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
                {sectionLabel("Anaerobic Reserve (W')")}
                {(() => {
                  const { minWbal, minWbalPct, minWbalTime, peakBurnJ, peakBurnTime, wPrime, chartData } = actualWbalRaw;

                  // 4C sub-step 6 — third labels for peak-burn and min-W'bal
                  // events. Bucketed by route-distance third when alignment is
                  // available (so labels match other "thirds" cards on the
                  // page). Falls back to moving-time index thirds otherwise.
                  const totalSecs = fitData.movingPowerSeries.length;
                  const thirdLabelFor = (secIdx) => {
                    if (thirdsByRouteDistance) {
                      // Find which route-third this second-index belongs to.
                      for (let t = 0; t < 3; t++) {
                        if (thirdsByRouteDistance[t].includes(secIdx)) {
                          return t === 0 ? "T1 (first third)"
                               : t === 1 ? "T2 (second third)"
                               : "T3 (final third)";
                        }
                      }
                      return "(off-route)";
                    }
                    const t1EndSecs = Math.floor(totalSecs / 3);
                    const t2EndSecs = Math.floor(2 * totalSecs / 3);
                    return secIdx <= t1EndSecs ? "T1 (first third)"
                         : secIdx <= t2EndSecs ? "T2 (second third)"
                         : "T3 (final third)";
                  };
                  const peakThird = thirdLabelFor(peakBurnTime);
                  const minThird  = thirdLabelFor(minWbalTime);
                  // Moving-time third boundaries — used by the W'bal chart's
                  // vertical reference lines (chart x-axis is moving time, so
                  // boundaries need to be a single time value). The narrative
                  // gating below uses `peakThird` instead — route-distance
                  // aware, consistent with other cards.
                  const t1EndSecs = Math.floor(totalSecs / 3);
                  const t2EndSecs = Math.floor(2 * totalSecs / 3);

                  const wDrawnPct  = Math.round((wPrime - minWbal) / wPrime * 100);
                  const wDrawnKj   = Math.round((wPrime - minWbal) / 100) / 10;
                  const peakKjFmt  = Math.round(peakBurnJ / 100) / 10;
                  const wPrimeKj   = Math.round(wPrime / 100) / 10;
                  const minKjFmt   = Math.round(minWbal / 100) / 10;
                  const minTimeFmt = minsToHHMM(Math.round(minWbalTime / 60));
                  const peakTimeFmt= minsToHHMM(Math.round(peakBurnTime / 60));

                  const riskColor  = minWbalPct < 20 ? "#FF3347" : minWbalPct < 40 ? "#FFB800" : "#00FF8C";
                  const riskLabel  = minWbalPct < 20 ? "critical — near blowup threshold"
                    : minWbalPct < 40 ? "significant draw — fatigue risk"
                    : "well managed";

                  const narrative = (() => {
                    if (minWbalPct < 20) return {
                      text: `Your anaerobic reserve dropped to ${minWbalPct}% (${minKjFmt} kJ) at ${minTimeFmt} — below the 20% danger threshold where forced power reduction typically occurs. The largest single-second burn (${peakKjFmt} kJ/s) happened in ${peakThird}. At this level of depletion your body has little choice but to slow down regardless of motivation. If you experienced a sharp power drop late in the race, this is the physiological explanation.`,
                      color: "#FF3347"
                    };
                    if (minWbalPct < 40 && peakThird.startsWith("T1")) return {
                      text: `W' dropped to ${minWbalPct}% (${minKjFmt} kJ remaining from ${wPrimeKj} kJ). The largest burn occurred early — in ${peakThird} at ${peakTimeFmt}. Early match-burning is a common pattern in races with aggressive starts or punchy opening climbs. The body can recover W' at sub-threshold effort, but if power stayed elevated those early draws compound into late-race fatigue. Cross-reference with Threshold Exposure above.`,
                      color: "#FFB800"
                    };
                    if (minWbalPct < 40) return {
                      text: `W' dropped to ${minWbalPct}% — a draw of ${wDrawnPct}% of total anaerobic budget. The minimum occurred in ${minThird} at ${minTimeFmt}, with peak burn in ${peakThird}. At this depletion level you were working in borrowed territory. Check whether this timing aligns with a climb or surge in the power chart.`,
                      color: "#FFB800"
                    };
                    if (peakThird.startsWith("T1")) return {
                      text: `W' was well managed overall, dropping to ${minWbalPct}% at minimum. The largest burn occurred early in ${peakThird} — likely a race start surge or opening climb — but you recovered effectively. Good match management: spend hard when needed, recover between efforts.`,
                      color: "#00FF8C"
                    };
                    return {
                      text: `Anaerobic reserve was well managed throughout — minimum ${minWbalPct}% (${minKjFmt} kJ), comfortably above the 20% danger threshold. Largest burn in ${peakThird} at ${peakTimeFmt}. You had matches to spend and used them appropriately. Any late-race fade is more likely aerobic or nutritional in origin than anaerobic depletion.`,
                      color: "#00FF8C"
                    };
                  })();

                  // Chart: burn bars (per minute) + W'bal line
                  const n = chartData.length;
                  const t1EndMin = Math.round(t1EndSecs / 60);
                  const t2EndMin = Math.round(t2EndSecs / 60);

                  return (
                    <div>
                      {/* Stats row */}
                      <div className="stat-row" style={{ marginBottom: 12 }}>
                        <div className="stat-box">
                          <div className="stat-label">Min W'bal</div>
                          <div className="stat-value" style={{ fontSize: 22, color: riskColor }}>{minWbalPct}%</div>
                          <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>{minKjFmt} of {wPrimeKj} kJ · {minTimeFmt}</div>
                        </div>
                        <div className="stat-box">
                          <div className="stat-label">Total Drawn</div>
                          <div className="stat-value" style={{ fontSize: 22, color: riskColor }}>{wDrawnPct}%</div>
                          <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>{wDrawnKj} kJ spent</div>
                        </div>
                        <div className="stat-box">
                          <div className="stat-label">Peak Burn</div>
                          <div className="stat-value" style={{ fontSize: 22, color: T.purple }}>{peakKjFmt}<span style={{ fontSize: 12, color: T.textMuted, marginLeft: 3 }}>kJ/s</span></div>
                          <div style={{ fontSize: 10, color: T.textDim, marginTop: 2 }}>{peakThird} · {peakTimeFmt}</div>
                        </div>
                      </div>

                      {/* Risk label */}
                      <div style={{ fontSize: 11, fontFamily: "Barlow Condensed", color: riskColor, marginBottom: 10 }}>
                        W' STATUS: <span style={{ fontWeight: 700, textTransform: "uppercase" }}>{riskLabel}</span>
                        <span style={{ color: T.textDim, marginLeft: 8, fontWeight: 400 }}>· 20% = danger · 40% = caution</span>
                      </div>

                      {/* Combo chart: elevation area (terrain context) + W'bal line */}
                      <div style={{ height: 160, marginBottom: 10 }}>
                        {(() => {
                          const hasAlt = actualWbalRaw?.hasAltitude && chartData.some(d => d.altM !== null);
                          const altVals = chartData.map(d => d.altM).filter(a => a !== null);
                          const altMin  = hasAlt ? Math.floor(Math.min(...altVals) / 10) * 10 : 0;
                          const altMax  = hasAlt ? Math.ceil(Math.max(...altVals) / 10) * 10 : 400;
                          return (
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                                <defs>
                                  <linearGradient id="wbalLineGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%"   stopColor="#00FF8C" />
                                    <stop offset="60%"  stopColor="#00FF8C" />
                                    <stop offset="80%"  stopColor="#FFB800" />
                                    <stop offset="90%"  stopColor="#FF3347" />
                                    <stop offset="100%" stopColor="#FF3347" />
                                  </linearGradient>
                                  <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%"  stopColor="#363640" stopOpacity={0.8} />
                                    <stop offset="95%" stopColor="#363640" stopOpacity={0.2} />
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="2 4" stroke={T.border} />
                                <XAxis dataKey="time" tick={{ fill: T.textDim, fontSize: 9 }} tickFormatter={v => `${Math.floor(v/60)}:${String(v%60).padStart(2,'0')}`} />
                                <YAxis yAxisId="pct" domain={[0, 100]} tick={{ fill: T.textDim, fontSize: 9 }} width={32} tickFormatter={v => `${v}%`} />
                                {hasAlt && <YAxis yAxisId="alt" orientation="right" domain={[altMin, altMax]} tick={{ fill: T.textDim, fontSize: 9 }} width={36} tickFormatter={v => `${v}m`} />}
                                <Tooltip content={({ active, payload }) => {
                                  if (!active || !payload?.length) return null;
                                  const d = payload[0]?.payload;
                                  const pct = d?.wbalPct ?? 0;
                                  const lc = pct >= 40 ? "#00FF8C" : pct >= 20 ? "#FFB800" : "#FF3347";
                                  return (
                                    <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 11 }}>
                                      <div style={{ color: T.textMuted, marginBottom: 3 }}>{d?.time}m</div>
                                      <div style={{ color: lc }}>W'bal: {pct}% ({Math.round((d?.wbal ?? 0)/1000*10)/10} kJ)</div>
                                      {hasAlt && d?.altM != null && <div style={{ color: T.textDim }}>Elevation: {d.altM}m</div>}
                                    </div>
                                  );
                                }} />
                                {/* Third dividers */}
                                <ReferenceLine yAxisId="pct" x={t1EndMin} stroke={T.border} strokeDasharray="3 3" label={{ value: "T2", fill: T.textDim, fontSize: 8 }} />
                                <ReferenceLine yAxisId="pct" x={t2EndMin} stroke={T.border} strokeDasharray="3 3" label={{ value: "T3", fill: T.textDim, fontSize: 8 }} />
                                {/* Warn 40% */}
                                <ReferenceLine yAxisId="pct" y={40} stroke="#FFB800" strokeDasharray="4 3" strokeWidth={1}
                                  label={{ value: "Warn", fill: "#FFB800", fontSize: 9, position: "insideTopRight" }} />
                                {/* Bonk 20% */}
                                <ReferenceLine yAxisId="pct" y={20} stroke="#FF3347" strokeDasharray="4 3" strokeWidth={1}
                                  label={{ value: "Bonk", fill: "#FF3347", fontSize: 9, position: "insideTopRight" }} />
                                {/* Elevation area (background terrain context) */}
                                {hasAlt && (
                                  <Area yAxisId="alt" type="monotone" dataKey="altM"
                                    fill="url(#elevFill)" stroke="rgba(54,54,64,0.6)"
                                    strokeWidth={1} dot={false} />
                                )}
                                {/* W'bal line — color-coded via gradient */}
                                <Line yAxisId="pct" type="monotone" dataKey="wbalPct"
                                  stroke="url(#wbalLineGrad)" strokeWidth={2.5} dot={false} />
                              </ComposedChart>
                            </ResponsiveContainer>
                          );
                        })()}
                      </div>

                      {/* Legend */}
                      <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 10, color: T.textMuted, flexWrap: "wrap" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ display: "inline-block", width: 16, height: 3, background: "linear-gradient(to right, #00FF8C, #FFB800, #FF3347)", borderRadius: 1 }} />
                          W' Balance
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ display: "inline-block", width: 10, height: 10, background: "rgba(54,54,64,0.8)", borderRadius: 2 }} />
                          Elevation
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ display: "inline-block", width: 16, height: 1, borderTop: "1.5px dashed #FFB800" }} />
                          Warn 40%
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ display: "inline-block", width: 16, height: 1, borderTop: "1.5px dashed #FF3347" }} />
                          Bonk 20%
                        </span>
                      </div>

                      {/* Narrative */}
                      <div style={{ padding: "10px 12px", background: `${narrative.color}10`, border: `1px solid ${narrative.color}30`, borderRadius: 4, borderLeft: `3px solid ${narrative.color}` }}>
                        <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{narrative.text}</div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── RACE INTELLIGENCE ────────────────────────────────────────────── */}
      {terrainBuckets && fitMinStream.length > 0 && (() => {
        const { climb, flat, descent } = terrainBuckets;
        const hasGPX = !!(selectedPlan?.route?.segmentGrades?.length);
        const FTP = athlete.ftp;

        const sectionLabel = (text) => (
          <div style={{ fontSize: 10, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>{text}</div>
        );

        const narrativeBlock = (text, color) => (
          <div style={{ padding: "10px 12px", background: `${color}10`, border: `1px solid ${color}30`, borderRadius: 4, borderLeft: `3px solid ${color}`, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{text}</div>
          </div>
        );

        // ── Terrain Performance ──────────────────────────────────────────
        const TERRAIN = [
          { key: "climb",   label: "Climb",   icon: "↑", color: "#FF3347" },
          { key: "flat",    label: "Flat",    icon: "→", color: "#00D4FF" },
          { key: "descent", label: "Descent", icon: "↓", color: "#00FF8C" },
        ];

        return (
          <div className="card">
            <div className="card-header">Terrain Analysis</div>
            {!hasGPX && (
              <div style={{ fontSize: 10, color: T.textDim, marginBottom: 14, fontStyle: "italic" }}>
                Terrain classification estimated from GPS altitude data. Load a GPX route for higher accuracy.
              </div>
            )}

            {/* ── Thirds by Terrain ── */}
            {(() => {
              const hasClimb   = climb.count > 60;
              const hasDescent = descent.count > 60;
              const hasFlat    = flat.count > 60;
              if (!hasClimb && !hasFlat) return null;

              const fade = (thirds) => {
                const t1 = thirds[0].np, t3 = thirds[2].np;
                return t1 > 0 && t3 > 0 ? Math.round((t3 - t1) / t1 * 100) : null;
              };

              const climbFadePct   = fade(climb.thirds);
              const flatFadePct    = fade(flat.thirds);
              const descentFadePct = fade(descent.thirds);

              const trendColor = (pct, isDesc = false) => {
                if (pct === null) return T.textDim;
                if (isDesc) return Math.abs(pct) <= 8 ? "#00D4FF" : pct < -8 ? "#FFB800" : "#00FF8C";
                return pct >= -5 ? "#00FF8C" : pct >= -15 ? "#FFB800" : "#FF3347";
              };

              // Global max across all terrain thirds — bars proportional to reality, use NP
              const allPowers = TERRAIN.flatMap(t =>
                terrainBuckets[t.key].thirds.map(th => th.np)
              ).filter(p => p > 0);
              const globalMaxP = Math.max(...allPowers, 1);

              const THIRD_LABELS = ["T1", "T2", "T3"];

              return (
                <div style={{ marginTop: 0 }}>
                  {sectionLabel("Terrain Analysis")}

                  {/* Distribution bar — inside section */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", width: "100%", marginBottom: 4 }}>
                      {TERRAIN.map(t => terrainBuckets[t.key].timePct > 0 && (
                        <div key={t.key} style={{ flex: terrainBuckets[t.key].timePct, textAlign: "center" }}>
                          <div style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, color: t.color, textTransform: "uppercase", letterSpacing: "0.05em" }}>{t.label}</div>
                          <div style={{ fontSize: 9, color: T.textDim }}>{terrainBuckets[t.key].timePct}% · {terrainBuckets[t.key].timeMins}min</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", width: "100%", height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}>
                      {TERRAIN.map(t => terrainBuckets[t.key].timePct > 0 && (
                        <div key={t.key} style={{ flex: terrainBuckets[t.key].timePct, background: t.color, opacity: 0.7 }} />
                      ))}
                    </div>
                  </div>

                  {/* One column per terrain */}
                  <div style={{ display: "flex", width: "100%", gap: 8 }}>
                    {TERRAIN.map(t => {
                      const thirds = terrainBuckets[t.key].thirds;
                      const t1val  = thirds[0].np;
                      if (terrainBuckets[t.key].count < 60) return null;
                      return (
                        <div key={t.key} style={{ flex: 1 }}>
                          {/* Terrain label */}
                          <div style={{ textAlign: "center", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, color: t.color, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                            {t.icon} {t.label}
                          </div>

                          {/* NP values per third */}
                          <div style={{ display: "flex", gap: 3, marginBottom: 6 }}>
                            {thirds.map((th, ti) => {
                              const val   = th.np;
                              const delta = ti > 0 && t1val > 0 && val > 0 ? Math.round((val - t1val) / t1val * 100) : null;
                              const dc    = trendColor(delta, t.key === 'descent');
                              return (
                                <div key={ti} style={{ flex: 1, textAlign: "center" }}>
                                  {val > 0 ? (
                                    <>
                                      <div style={{ fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.text, lineHeight: 1.2 }}>{val}w</div>
                                      {delta !== null
                                        ? <div style={{ fontSize: 9, fontFamily: "Barlow Condensed", color: dc, lineHeight: 1.1 }}>{delta > 0 ? "+" : ""}{delta}%</div>
                                        : <div style={{ height: 11 }} />
                                      }
                                    </>
                                  ) : <div style={{ fontSize: 9, color: T.textDim }}>—</div>}
                                </div>
                              );
                            })}
                          </div>

                          {/* Bars — proportional to global NP max, aligned at bottom */}
                          <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 32 }}>
                            {thirds.map((th, ti) => {
                              const val  = th.np;
                              const barH = val > 0 ? Math.max(3, (val / globalMaxP) * 30) : 0;
                              return (
                                <div key={ti} style={{ flex: 1, height: barH, background: t.color, opacity: 0.7, borderRadius: "2px 2px 0 0" }} />
                              );
                            })}
                          </div>

                          {/* Third labels below bars */}
                          <div style={{ display: "flex", gap: 3, marginTop: 3 }}>
                            {THIRD_LABELS.map(lbl => (
                              <div key={lbl} style={{ flex: 1, textAlign: "center", fontSize: 7, color: T.textDim, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1.2 }}>{lbl}</div>
                            ))}
                          </div>

                          {/* Overall NP + VI for this terrain type */}
                          <div style={{ textAlign: "center", marginTop: 6, fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed" }}>
                            NP {terrainBuckets[t.key].np}w · VI {terrainBuckets[t.key].vi.toFixed(2)}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Cross-terrain narrative */}
                  <div style={{ marginTop: 16 }}>
                  {(() => {
                    const insights = [];

                    if (climbFadePct !== null && hasClimb) {
                      const c1 = climb.thirds[0].np, c3 = climb.thirds[2].np;
                      if (climbFadePct <= -15) insights.push({ color: "#FF3347", text: `Climb NP dropped ${Math.abs(climbFadePct)}% from first to final third (${c1}w → ${c3}w). Significant climb fade — you were meaningfully weaker on ascents late in the race. This is the clearest indicator of pacing too hard early on climbs.` });
                      else if (climbFadePct <= -8) insights.push({ color: "#FFB800", text: `Climb NP dropped ${Math.abs(climbFadePct)}% first to final third (${c1}w → ${c3}w). Moderate climb fade — worth tracking whether this correlates with the overall power fade above.` });
                      else insights.push({ color: "#00FF8C", text: `Climb NP held well across all three thirds (${c1}w → ${c3}w, ${climbFadePct > 0 ? "+" : ""}${climbFadePct}%). Consistent climbing strength throughout — good aerobic reserve management.` });
                    }

                    if (flatFadePct !== null && hasFlat) {
                      const f1 = flat.thirds[0].np, f3 = flat.thirds[2].np;
                      if (flatFadePct <= -12) insights.push({ color: "#FFB800", text: `Flat terrain NP also dropped ${Math.abs(flatFadePct)}% first to final third (${f1}w → ${f3}w). Fade on flat terrain alongside climb fade confirms systemic fatigue — not just terrain-specific difficulty.` });
                    }

                    if (descentFadePct !== null && hasDescent) {
                      const d1 = descent.thirds[0].np, d3 = descent.thirds[2].np;
                      if (descentFadePct <= -15) insights.push({ color: "#FFB800", text: `Descent NP dropped ${Math.abs(descentFadePct)}% first to final third (${d1}w → ${d3}w). Meaningful loss of power on descents late in the race — a secondary fatigue indicator.` });
                    }

                    if (!insights.length) return null;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {insights.map((ins, i) => (
                          <div key={i} style={{ padding: "10px 12px", background: `${ins.color}10`, border: `1px solid ${ins.color}30`, borderRadius: 4, borderLeft: `3px solid ${ins.color}` }}>
                            <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{ins.text}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  </div>
                </div>
              );
            })()}

            {/* ── Overall terrain insight (climb vs flat comparison) ── */}
            {(() => {
              const hasClimb   = climb.count > 60;
              const hasDescent = descent.count > 60;
              const hasFlat    = flat.count > 60;
              if (!hasClimb && !hasFlat) return null;

              const climbVsFlat   = hasClimb && hasFlat ? Math.round((climb.np - flat.np) / flat.np * 100) : null;
              const descentVsFlat = hasDescent && hasFlat ? Math.round((descent.np - flat.np) / flat.np * 100) : null;
              const climbHRvFlat  = hasClimb && hasFlat && climb.avgHR > 0 && flat.avgHR > 0 ? climb.avgHR - flat.avgHR : null;
              const lines = [];

              if (climbVsFlat !== null) {
                if (climbVsFlat > 15) lines.push(`Climb NP was ${climbVsFlat}% above flat (${climb.np}w vs ${flat.np}w). Aggressive climb pacing — primary source of W' draws and likely contributed to any late-race fade.`);
                else if (climbVsFlat > 5) lines.push(`Climb NP was ${climbVsFlat}% above flat (${climb.np}w vs ${flat.np}w). Moderate climb aggression — acceptable on shorter climbs but worth monitoring on longer efforts.`);
                else if (climbVsFlat >= -5) lines.push(`Climb NP matched flat closely (${climb.np}w vs ${flat.np}w, ${climbVsFlat > 0 ? "+" : ""}${climbVsFlat}%). Good terrain pacing discipline.`);
                else lines.push(`Climb NP was ${Math.abs(climbVsFlat)}% below flat (${climb.np}w vs ${flat.np}w). Conservative climb pacing — you may have left time on the table on ascents.`);
              }
              if (descentVsFlat !== null && descent.np > 0) {
                if (descentVsFlat > 10) lines.push(`Descent NP was ${descentVsFlat}% above flat (${descent.np}w) — working hard on descents costs W' and glycogen when terrain could provide free recovery.`);
                else if (descentVsFlat < -15) lines.push(`Low descent NP (${descent.np}w, ${Math.abs(descentVsFlat)}% below flat) — good use of descents as recovery time.`);
              }
              if (climbHRvFlat !== null && climbHRvFlat > 15) lines.push(`HR was ${climbHRvFlat}bpm higher on climbs than flat (${climb.avgHR} vs ${flat.avgHR}bpm) — cardiovascular cost of climb efforts was significant.`);

              if (!lines.length) return null;
              const color = climbVsFlat > 15 ? "#FF3347" : climbVsFlat > 5 ? "#FFB800" : "#00FF8C";
              return (
                <div style={{ marginTop: 10 }}>
                  {lines.map((text, i) => (
                    <div key={i} style={{ padding: "10px 12px", background: `${i===0?color:"#00D4FF"}10`, border: `1px solid ${i===0?color:"#00D4FF"}30`, borderRadius: 4, borderLeft: `3px solid ${i===0?color:"#00D4FF"}`, marginBottom: i<lines.length-1?8:0 }}>
                      <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{text}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* ── Climb Pacing Table — power-dependent (NP per climb, W'bal at exit) ── */}
            {hasPower && perClimbStats.length > 0 && (() => {
              const hasPlan = !!(selectedPlan?.pacingPlan?.powerStream);
              const catDotColor = (cat) => {
                if (cat === "wall")   return T.red;
                if (cat === "steep")  return T.gold;
                return T.blue;
              };
              const plannedNPForClimb = (cs) => {
                if (!hasPlan) return null;
                // 4C sub-step 1: consume powerStream (1-min) directly. Was displayStream (2-min).
                const ds = selectedPlan.pacingPlan.powerStream;
                const totalPlanMin = ds[ds.length - 1]?.time ?? 1;
                const gpxStats = selectedPlan.route;
                const startFrac = cs.startDistKm / (gpxStats.totalDistKm || 1);
                const endFrac   = (cs.startDistKm + cs.lengthKm) / (gpxStats.totalDistKm || 1);
                const t1 = startFrac * totalPlanMin;
                const t2 = endFrac   * totalPlanMin;
                // Expand window by one block width (1 min) each side to guarantee at
                // least one block is captured for any climb ≥ 1 min on the course.
                const BLOCK_MIN = 1;
                const blocks = ds.filter(b => b.time >= t1 - BLOCK_MIN && b.time <= t2 + BLOCK_MIN);
                if (!blocks.length) return null;
                const powers = blocks.map(b => b.power).filter(p => p > 0);
                if (!powers.length) return null;
                const rolling = powers.map((_, i, a) => {
                  const w = a.slice(Math.max(0, i - 1), i + 1);
                  return w.reduce((s, p) => s + p, 0) / w.length;
                });
                return Math.round(Math.pow(rolling.reduce((s, p) => s + p ** 4, 0) / rolling.length, 0.25));
              };
              return (
                <div style={{ marginTop: 20 }}>
                  {sectionLabel("Climb Pacing")}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "Barlow Condensed" }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                          {["#", imperial ? "Start (mi)" : "Start (km)", imperial ? "Dist (mi)" : "Dist (km)", "Avg%", "Peak%", "Power", "W′"].map((h, i) => (
                            <th key={i} style={{ padding: "4px 6px", color: T.textDim, fontWeight: 700, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", textAlign: i >= 5 ? "center" : i === 0 ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {perClimbStats.map((cs, rowIdx) => {
                          const dotColor  = catDotColor(cs.category);
                          const startDisp = imperial ? Math.round(cs.startDistKm * 0.6214 * 10) / 10 : Math.round(cs.startDistKm * 10) / 10;
                          const lenDisp   = imperial ? Math.round(cs.lengthKm * 0.6214 * 100) / 100 : Math.round(cs.lengthKm * 100) / 100;
                          const plannedNP = plannedNPForClimb(cs);
                          const wPct      = cs.wbalPctAtExit;
                          const wDotColor = wPct === null ? T.textDim : wPct <= 20 ? T.red : wPct <= 40 ? T.gold : T.green;
                          const wLabel    = wPct === null ? "—" : `${wPct}%`;
                          const rowAnchor = hasPlan && plannedNP ? plannedNP : !hasPlan ? athlete.ftp : null;
                          const isOnTarget = rowAnchor > 0 && cs.np > 0 && Math.abs((cs.np - rowAnchor) / rowAnchor * 100) <= 10;

                          return (
                            <tr key={cs.climbId} style={{ borderBottom: `1px solid ${T.border}`, background: isOnTarget ? `${T.green}12` : rowIdx % 2 === 0 ? "transparent" : `${T.surface2}50`, boxShadow: isOnTarget ? `inset 0 0 0 1px ${T.green}30` : "none" }}>
                              <td style={{ padding: "6px 6px", whiteSpace: "nowrap" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                                  <span style={{ color: T.text, fontWeight: 700 }}>{cs.climbId}</span>
                                </div>
                              </td>
                              <td style={{ padding: "6px 6px", color: T.textMuted, textAlign: "right" }}>{startDisp}</td>
                              <td style={{ padding: "6px 6px", color: T.textMuted, textAlign: "right" }}>{lenDisp}</td>
                              <td style={{ padding: "6px 6px", color: T.text, textAlign: "right", fontWeight: 700 }}>{cs.avgGrade}%</td>
                              <td style={{ padding: "6px 6px", color: T.textMuted, textAlign: "right" }}>{cs.peakGradePct}%</td>
                              <td style={{ padding: "6px 8px", minWidth: 110 }}>
                                {(() => {
                                  // Zero-centered delta sparkline.
                                  // Anchor = planned NP (plan loaded) or FTP (no plan).
                                  // Bar extends RIGHT (red) if over anchor, LEFT (blue) if under.
                                  // ±20% = full half-width. Clips at edge.
                                  const LABEL_W = 52;
                                  const MAX_DELTA_PCT = 20;
                                  const anchor = hasPlan && plannedNP ? plannedNP : !hasPlan ? athlete.ftp : null;
                                  const deltaPct = anchor > 0 ? (cs.np - anchor) / anchor * 100 : 0;
                                  const clampedPct = Math.max(-MAX_DELTA_PCT, Math.min(MAX_DELTA_PCT, deltaPct));
                                  const halfW = `calc((100% - ${LABEL_W}px) / 2)`;
                                  const barFrac = Math.abs(clampedPct) / MAX_DELTA_PCT;
                                  const isOver = clampedPct >= 0;
                                  const isOnTarget = anchor > 0 && cs.np > 0 && Math.abs(deltaPct) <= 10;
                                  const barColor = isOver ? T.red : T.blue;
                                  const deltaSign = deltaPct > 0 ? "+" : "";
                                  const deltaLabel = anchor > 0 ? `${deltaSign}${Math.round(deltaPct)}%` : "—";
                                  return (
                                    <div style={{ position: "relative", height: 18, display: "flex", alignItems: "center", borderRadius: 3 }}>
                                      {/* Left half track */}
                                      <div style={{ position: "absolute", top: 6, bottom: 6, left: 0, width: halfW, background: T.surface2, borderRadius: "2px 0 0 2px" }} />
                                      {/* Right half track */}
                                      <div style={{ position: "absolute", top: 6, bottom: 6, left: halfW, right: LABEL_W, background: T.surface2, borderRadius: "0 2px 2px 0" }} />
                                      {/* Delta bar — grows from center */}
                                      {anchor > 0 && cs.np > 0 && (
                                        <div style={{
                                          position: "absolute", top: 4, bottom: 4,
                                          left:  isOver ? halfW : `calc(${halfW} - ${halfW} * ${barFrac})`,
                                          width: `calc(${halfW} * ${barFrac})`,
                                          background: barColor,
                                          borderRadius: isOver ? "0 2px 2px 0" : "2px 0 0 2px",
                                          opacity: 0.85,
                                        }} />
                                      )}
                                      {/* Center anchor dash */}
                                      <div style={{ position: "absolute", top: 2, bottom: 2, left: halfW, width: 2, background: "rgba(255,255,255,0.55)", borderRadius: 1, transform: "translateX(-1px)" }} />
                                      {/* Label: delta % · planned · actual */}
                                      <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: LABEL_W, display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "center", gap: 1 }}>
                                        <span style={{ fontSize: 9, fontFamily: "Barlow Condensed", fontWeight: 700, color: isOnTarget ? T.green : anchor > 0 && cs.np > 0 ? barColor : T.textMuted, lineHeight: 1 }}>{deltaLabel}</span>
                                        {anchor > 0 && (
                                          <span style={{ fontSize: 8, fontFamily: "Barlow Condensed", color: T.textDim, lineHeight: 1 }}>
                                            <span style={{ color: T.textDim, opacity: 0.6 }}>P </span>{Math.round(anchor)}w
                                          </span>
                                        )}
                                        <span style={{ fontSize: 8, fontFamily: "Barlow Condensed", color: T.textDim, lineHeight: 1 }}>
                                          <span style={{ color: T.textDim, opacity: 0.6 }}>A </span>{cs.np}w
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })()}
                              </td>
                              <td style={{ padding: "6px 6px", textAlign: "center" }}>
                                <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: wDotColor, boxShadow: wPct !== null ? `0 0 4px ${wDotColor}80` : "none" }} />
                                  <span style={{ fontSize: 10, color: T.textDim }}>{wLabel}</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {[{ color: T.blue, label: "Moderate" }, { color: T.gold, label: "Steep" }, { color: T.red, label: "Wall" }].map(l => (
                      <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: l.color }} />
                        <span style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.06em" }}>{l.label}</span>
                      </div>
                    ))}
                    <div style={{ width: 1, height: 10, background: T.border }} />
                    {[{ color: T.green, label: "W′ >40%" }, { color: T.gold, label: "W′ 20–40%" }, { color: T.red, label: "W′ <20%" }].map(l => (
                      <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: l.color }} />
                        <span style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.06em" }}>{l.label}</span>
                      </div>
                    ))}
                    <div style={{ width: 1, height: 10, background: T.border }} />
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <div style={{ width: 10, height: 6, background: T.blue, borderRadius: "2px 0 0 2px", opacity: 0.85 }} />
                        <div style={{ width: 2, height: 10, background: "rgba(255,255,255,0.55)", borderRadius: 1 }} />
                        <div style={{ width: 0 }} />
                      </div>
                      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.06em" }}>Under {hasPlan ? "plan" : "FTP"}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <div style={{ width: 0 }} />
                        <div style={{ width: 2, height: 10, background: "rgba(255,255,255,0.55)", borderRadius: 1 }} />
                        <div style={{ width: 10, height: 6, background: T.red, borderRadius: "0 2px 2px 0", opacity: 0.85 }} />
                      </div>
                      <span style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", textTransform: "uppercase", letterSpacing: "0.06em" }}>Over {hasPlan ? "plan" : "FTP"}</span>
                    </div>
                    <span style={{ fontSize: 9, color: T.textDim, fontFamily: "Barlow Condensed", letterSpacing: "0.04em" }}>±20% max</span>
                  </div>

                  {/* Climb pacing narrative */}
                  {(() => {
                    if (!perClimbStats.length) return null;

                    // Classify each climb: over (+>5%), under (<-5%), on-target
                    const withDelta = hasPlan
                      ? perClimbStats.map(cs => {
                          const pNP = plannedNPForClimb(cs);
                          const delta = pNP > 0 ? Math.round((cs.np - pNP) / pNP * 100) : null;
                          return { ...cs, plannedNP: pNP, delta };
                        })
                      : perClimbStats.map(cs => ({ ...cs, plannedNP: null, delta: null }));

                    // W' depletion pattern
                    const depleted = perClimbStats.filter(cs => cs.wbalPctAtExit !== null && cs.wbalPctAtExit <= 20);
                    const warned   = perClimbStats.filter(cs => cs.wbalPctAtExit !== null && cs.wbalPctAtExit > 20 && cs.wbalPctAtExit <= 40);

                    let narrativeText = null;
                    let narrativeColor = T.green;

                    if (hasPlan) {
                      const over  = withDelta.filter(c => c.delta !== null && c.delta > 5);
                      const under = withDelta.filter(c => c.delta !== null && c.delta < -5);
                      const onTgt = withDelta.filter(c => c.delta !== null && Math.abs(c.delta) <= 10);
                      const total = withDelta.filter(c => c.delta !== null).length;

                      if (total === 0) {
                        narrativeText = "No planned climb targets to compare against.";
                        narrativeColor = T.textDim;
                      } else if (over.length === total) {
                        const avgOver = Math.round(over.reduce((s, c) => s + c.delta, 0) / over.length);
                        narrativeText = `Consistently over-paced every climb by an average of ${avgOver}% vs plan.${depleted.length > 0 ? ` W′ dropped into the red on ${depleted.length} climb${depleted.length > 1 ? "s" : ""} — likely contributing to late-race fatigue.` : ""}`;
                        narrativeColor = T.red;
                      } else if (under.length === total) {
                        const avgUnder = Math.abs(Math.round(under.reduce((s, c) => s + c.delta, 0) / under.length));
                        narrativeText = `Consistently under-paced every climb by an average of ${avgUnder}% vs plan. If you finished strong, there may have been time left on the table on the climbs.`;
                        narrativeColor = T.blue;
                      } else if (onTgt.length === total) {
                        narrativeText = `Clean climb execution — all climbs within 5% of plan.${depleted.length === 0 && warned.length === 0 ? " W′ reserves stayed healthy throughout." : ""}`;
                        narrativeColor = T.green;
                      } else {
                        // Mixed — find the most notable pattern
                        const worstOver  = over.length  ? over.reduce((a, b)  => Math.abs(b.delta) > Math.abs(a.delta) ? b : a,  over[0])  : null;
                        const worstUnder = under.length ? under.reduce((a, b) => Math.abs(b.delta) > Math.abs(a.delta) ? b : a, under[0]) : null;
                        const parts = [];
                        if (over.length)  parts.push(`${over.length} climb${over.length > 1 ? "s" : ""} over-paced (biggest: Climb ${worstOver.climbId} at +${worstOver.delta}%)`);
                        if (under.length) parts.push(`${under.length} under-paced (biggest: Climb ${worstUnder.climbId} at ${worstUnder.delta}%)`);
                        if (onTgt.length) parts.push(`${onTgt.length} on target`);
                        narrativeText = `Mixed climb pacing — ${parts.join(", ")}.${depleted.length > 0 ? ` W′ hit critical levels on Climb${depleted.length > 1 ? "s" : ""} ${depleted.map(c => c.climbId).join(", ")}.` : ""}`;
                        narrativeColor = over.length > under.length ? T.gold : T.blue;
                      }
                    } else {
                      // No plan — summarize effort level and W' cost
                      const highEffort = perClimbStats.filter(cs => cs.pctFTP >= 85);
                      const modEffort  = perClimbStats.filter(cs => cs.pctFTP >= 75 && cs.pctFTP < 85);
                      if (depleted.length > 0) {
                        narrativeText = `${depleted.length} climb${depleted.length > 1 ? "s" : ""} pushed W′ into the red — those efforts carried significant anaerobic cost. Load a plan to see execution vs target.`;
                        narrativeColor = T.red;
                      } else if (highEffort.length >= perClimbStats.length / 2) {
                        narrativeText = `Most climbs were ridden above 85% FTP. High aerobic stress — check whether late-race power held up on the terrain analysis above.`;
                        narrativeColor = T.gold;
                      } else {
                        narrativeText = `Climb effort levels were moderate (avg ${Math.round(perClimbStats.reduce((s, c) => s + c.pctFTP, 0) / perClimbStats.length)}% FTP). Load a plan to compare against targets.`;
                        narrativeColor = T.green;
                      }
                    }

                    if (!narrativeText) return null;
                    return (
                      <div style={{ marginTop: 10, padding: "10px 12px", background: `${narrativeColor}10`, border: `1px solid ${narrativeColor}30`, borderRadius: 4, borderLeft: `3px solid ${narrativeColor}` }}>
                        <div style={{ fontSize: 11, color: T.text, lineHeight: 1.6 }}>{narrativeText}</div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

          </div>
        );
      })()}

      {/* Nutrition Analysis */}
      {fitMinStream.length > 0 && (
        <div className="card">
          <div className="card-header">Nutrition Analysis</div>
          <IntakeForm products={products} onAdd={e => setActualIntake(prev => [...prev, e].sort((a, b) => a.time - b.time))} maxTime={fitData?.durationMin || 360} />
          {actualIntake.map(e => (
            <IntakeRow key={e.id} event={e} products={products} onRemove={() => setActualIntake(prev => prev.filter(x => x.id !== e.id))} />
          ))}
          {fitOverlay.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, marginTop: 12, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>Cumulative Burn vs Intake</div>
              <BurnRateChart overlayData={fitOverlay} durationMin={fitData?.durationMin} />
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, marginTop: 12, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>Glycogen Reserve</div>
              <GlycogenChart overlayData={fitOverlay} athlete={athlete} />

              {selectedPlan && (
                <div style={{ marginTop: 12, padding: "10px 14px", background: T.surface2, borderRadius: 4, fontSize: 12 }}>
                  <div style={{ display: "flex", gap: 24 }}>
                    <div>
                      <span style={{ color: T.textMuted }}>Planned carbs: </span>
                      <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700 }}>{selectedPlan.nutritionPlan.intakeEvents.reduce((s, e) => s + e.carbs, 0)}g</span>
                    </div>
                    <div>
                      <span style={{ color: T.textMuted }}>Actual carbs: </span>
                      <span style={{ fontFamily: "Barlow Condensed", fontWeight: 700, color: T.blue }}>{actualIntake.reduce((s, e) => s + e.carbs, 0)}g</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="card">
          <div className="card-header">Analysis Alerts</div>
          {alerts.map((a, i) => (
            <div key={i} className={`alert alert-${a.type}`}>⚠ {a.msg}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ATHLETES TAB ─────────────────────────────────────────────────────────────
function AthletesTab({ athletes, setAthletes, activeAthleteId, setActiveAthleteId, imperial }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const saveAthlete = (form) => {
    if (form.id) {
      setAthletes(prev => prev.map(a => a.id === form.id ? form : a));
    } else {
      setAthletes(prev => [...prev, { ...form, id: Date.now() }]);
    }
  };

  // B-26: Saved races persist plan-time state via athleteSnapshot (B-6); they
  // remain renderable after the source athlete is deleted. No guard here.
  const deleteAthlete = (id) => {
    const remaining = athletes.filter(a => a.id !== id);
    if (id === activeAthleteId && remaining.length > 0) {
      setActiveAthleteId(remaining[0].id);
    }
    setAthletes(remaining);
    setConfirmDelete(null);
  };

  const onlyOne = athletes.length === 1;

  return (
    <div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="card-header" style={{ margin: 0 }}>Athlete Roster</div>
          <button className="btn-primary" onClick={() => { setEditing({ id: null, name: "", ftp: 289, weight: 86.2, wPrime: 20000, phenotype: "allrounder", cpTests: [{ secs: 0, watts: 0 }, { secs: 0, watts: 0 }, { secs: 0, watts: 0 }], cpTestedAt: null, maxCarbIntakeGPerHr: 90 }); setShowModal(true); }}>+ Add</button>
        </div>
        {athletes.map(a => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: T.surface2, border: `1px solid ${a.id === activeAthleteId ? T.blue : T.border}`, borderRadius: 6, marginBottom: 8, cursor: "pointer" }}
            onClick={() => setActiveAthleteId(a.id)}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: T.border, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 14 }}>
              {a.name.charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name}</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>
                FTP {a.ftp}w · {imperial ? Math.round(a.weight * 2.205) : a.weight}{imperial ? "lb" : "kg"} · {Math.round((a.ftp / a.weight) * 10) / 10} w/kg
                {" · W' "}{Math.round(_physicsUnwrap(deriveWPrime(a), DEFAULTS.wPrimeFallbackJ) / 100) / 10}kJ
                {a.phenotype && ` · ${RIDER_PHENOTYPES.find(p => p.id === a.phenotype)?.label || ""}`}
              </div>
            </div>
            {a.id === activeAthleteId && (
              <span style={{ fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.blue, letterSpacing: "0.08em" }}>ACTIVE</span>
            )}
            <button
              title="Edit"
              style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 14, padding: "0 4px" }}
              onClick={e => { e.stopPropagation(); setEditing(a); setShowModal(true); }}
            >✎</button>
            <button
              disabled={onlyOne}
              title={onlyOne ? "Cannot delete the only athlete. Add another athlete first." : "Delete"}
              style={{ background: "none", border: "none", color: T.textDim, cursor: onlyOne ? "not-allowed" : "pointer", fontSize: 14, padding: "0 4px", opacity: onlyOne ? 0.3 : 1 }}
              onClick={e => { e.stopPropagation(); if (!onlyOne) setConfirmDelete(a); }}
            >×</button>
          </div>
        ))}
      </div>
      {showModal && (
        <AthleteModal athlete={editing} onSave={saveAthlete} onClose={() => { setShowModal(false); setEditing(null); }} imperial={imperial} />
      )}
      {confirmDelete && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 24, width: 380 }}>
            <div className="card-header" style={{ marginBottom: 12 }}>Delete athlete?</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>
              Delete athlete '{confirmDelete.name}'? This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => deleteAthlete(confirmDelete.id)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LIBRARY TAB ──────────────────────────────────────────────────────────────
// ─── BIKES TAB ────────────────────────────────────────────────────────────────
function BikesTab({ bikes, setBikes, activeBikeId, setActiveBikeId, imperial }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const saveBike = (form) => {
    if (form.id) setBikes(prev => prev.map(b => b.id === form.id ? form : b));
    else setBikes(prev => [...prev, { ...form, id: Date.now() }]);
  };

  // B-26: Saved races persist plan-time state via bikeSnapshot; they remain
  // renderable after the source bike is deleted. No guard here.
  const deleteBike = (id) => {
    const remaining = bikes.filter(b => b.id !== id);
    if (id === activeBikeId && remaining.length > 0) {
      setActiveBikeId(remaining[0].id);
    }
    setBikes(remaining);
    setConfirmDelete(null);
  };

  const onlyOne = bikes.length === 1;

  return (
    <div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="card-header" style={{ margin: 0 }}>Bike Garage</div>
          <button className="btn-primary" onClick={() => { setEditing({ id: null, name: "", weight: 8, positionId: "road_casual", drivetrainId: "road_std", tireId: "road_28_32" }); setShowModal(true); }}>+ Add</button>
        </div>
        {bikes.map(b => {
          const { CdA, eta, tireMult } = _physicsUnwrap(bikePhysics(b), DEFAULTS.bikePhysics);
          const pos = POSITIONS.find(p => p.id === b.positionId);
          const dt = DRIVETRAINS.find(d => d.id === b.drivetrainId);
          const tire = TIRE_MULTIPLIERS.find(t => t.id === b.tireId);
          return (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: T.surface2, border: `1px solid ${b.id === activeBikeId ? T.blue : T.border}`, borderRadius: 6, marginBottom: 8, cursor: "pointer" }}
              onClick={() => setActiveBikeId(b.id)}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: T.border, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Barlow Condensed", fontWeight: 700, fontSize: 14 }}>
                {b.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{b.name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  {imperial ? Math.round(b.weight * 2.205) : b.weight}{imperial ? "lb" : "kg"}
                  <span style={{ marginLeft: 8 }}>{pos?.label}</span>
                  <span style={{ marginLeft: 8 }}>{dt?.label}</span>
                </div>
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
                  CdA {CdA} · η {eta} · Tire ×{tireMult}
                </div>
              </div>
              <button
                title="Edit"
                style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 14, padding: "0 4px" }}
                onClick={e => { e.stopPropagation(); setEditing(b); setShowModal(true); }}
              >✎</button>
              <button
                disabled={onlyOne}
                title={onlyOne ? "Cannot delete the only bike. Add another bike first." : "Delete"}
                style={{ background: "none", border: "none", color: T.textDim, cursor: onlyOne ? "not-allowed" : "pointer", fontSize: 14, padding: "0 4px", opacity: onlyOne ? 0.3 : 1 }}
                onClick={e => { e.stopPropagation(); if (!onlyOne) setConfirmDelete(b); }}
              >×</button>
            </div>
          );
        })}
      </div>
      {showModal && <BikeModal bike={editing} onSave={saveBike} onClose={() => { setShowModal(false); setEditing(null); }} imperial={imperial} />}
      {confirmDelete && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 24, width: 380 }}>
            <div className="card-header" style={{ marginBottom: 12 }}>Delete bike?</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>
              Delete bike '{confirmDelete.name}'? This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => deleteBike(confirmDelete.id)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LibraryTab({ products, setProducts }) {
  const [form, setForm] = useState({ name: "", carbs: 0, sodium: 0 });
  const [editingId, setEditingId] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isEditing = editingId !== null;

  const startEdit = (p) => {
    setEditingId(p.id);
    setForm({ name: p.name, carbs: p.carbs, sodium: p.sodium });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm({ name: "", carbs: 0, sodium: 0 });
  };

  const submit = () => {
    if (!form.name) return;
    if (isEditing) {
      setProducts(prev => prev.map(x => x.id === editingId ? { ...x, ...form } : x));
    } else {
      setProducts(prev => [...prev, { id: Date.now(), ...form }]);
    }
    cancelEdit();
  };

  const iconBtn = { background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 14, padding: "0 4px" };

  return (
    <div>
      <div className="card">
        <div className="card-header">Nutrition Products</div>
        <div style={{ display: "grid", gridTemplateColumns: isEditing ? "2fr 80px 80px 80px 80px" : "2fr 80px 80px 80px", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input type="text" placeholder="Product name" value={form.name} onChange={e => set("name", e.target.value)} />
          <input type="number" placeholder="Carbs g" value={form.carbs || ""} onChange={e => set("carbs", Number(e.target.value))} />
          <input type="number" placeholder="Na mg" value={form.sodium || ""} onChange={e => set("sodium", Number(e.target.value))} />
          <button className="btn-primary" onClick={submit}>{isEditing ? "Save" : "Add"}</button>
          {isEditing && <button className="btn-secondary" onClick={cancelEdit}>Cancel</button>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 80px 80px 56px", gap: 0 }}>
          {[["Name", "2fr"], ["Carbs", ""], ["Na (mg)", ""], ["", ""]].map(([h]) => (
            <div key={h} style={{ padding: "6px 10px", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", color: T.textMuted, textTransform: "uppercase", borderBottom: `1px solid ${T.border}` }}>{h}</div>
          ))}
          {products.map(p => (
            <>
              <div key={`n${p.id}`} style={{ padding: "8px 10px", fontSize: 13, borderBottom: `1px solid ${T.border}`, background: p.id === editingId ? T.surface2 : "transparent" }}>{p.name}</div>
              <div key={`c${p.id}`} style={{ padding: "8px 10px", fontSize: 13, color: T.gold, fontFamily: "Barlow Condensed", borderBottom: `1px solid ${T.border}`, background: p.id === editingId ? T.surface2 : "transparent" }}>{p.carbs}g</div>
              <div key={`s${p.id}`} style={{ padding: "8px 10px", fontSize: 13, color: T.textMuted, fontFamily: "Barlow Condensed", borderBottom: `1px solid ${T.border}`, background: p.id === editingId ? T.surface2 : "transparent" }}>{p.sodium}</div>
              <div key={`a${p.id}`} style={{ padding: "8px 4px", borderBottom: `1px solid ${T.border}`, display: "flex", gap: 2, justifyContent: "flex-end", background: p.id === editingId ? T.surface2 : "transparent" }}>
                <button title="Edit" onClick={() => startEdit(p)} style={iconBtn}>✎</button>
                <button title="Delete" onClick={() => setProducts(prev => prev.filter(x => x.id !== p.id))} style={iconBtn}>×</button>
              </div>
            </>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

export default function App() {
  const [tab, setTab] = useState("MODEL");
  const [imperial, setImperial] = useState(() => lsGet('fm_imperial', true));
  const [athletes, setAthletes] = useState(() => lsGet('fm_athletes', [DEFAULT_ATHLETE]));
  const [activeAthleteId, setActiveAthleteId] = useState(() => lsGet('fm_activeAthleteId', 1));
  const [bikes, setBikes] = useState(() => lsGet('fm_bikes', [DEFAULT_BIKE]));
  const [activeBikeId, setActiveBikeId] = useState(() => lsGet('fm_activeBikeId', 1));
  const [products, setProducts] = useState(() => lsGet('fm_products', DEFAULT_PRODUCTS));
  const [races, setRaces] = useState([]);

  const athlete = athletes.find(a => a.id === activeAthleteId) || athletes[0];

  // Persist profile data to localStorage whenever it changes
  useEffect(() => { localStorage.setItem('fm_imperial',        JSON.stringify(imperial));        }, [imperial]);
  useEffect(() => { localStorage.setItem('fm_athletes',        JSON.stringify(athletes));        }, [athletes]);
  useEffect(() => { localStorage.setItem('fm_activeAthleteId', JSON.stringify(activeAthleteId)); }, [activeAthleteId]);
  useEffect(() => { localStorage.setItem('fm_bikes',           JSON.stringify(bikes));           }, [bikes]);
  useEffect(() => { localStorage.setItem('fm_activeBikeId',    JSON.stringify(activeBikeId));    }, [activeBikeId]);
  useEffect(() => { localStorage.setItem('fm_products',        JSON.stringify(products));        }, [products]);

  // Load races from IndexedDB on mount
  useEffect(() => {
    loadAllRaces().then(setRaces).catch(() => {});
  }, []);

  return (
    <>
      <style>{css}</style>
      <div style={{ minHeight: "100vh", background: T.bg }}>
        {/* Header */}
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, zIndex: 50 }}>
          <div style={{ maxWidth: 800, margin: "0 auto", padding: "0 16px", display: "flex", alignItems: "center", gap: 0 }}>
            {/* Logo */}
            <div style={{ fontFamily: "Barlow Condensed", fontWeight: 800, fontSize: 18, letterSpacing: "0.12em", color: T.red, marginRight: 24, padding: "12px 0", whiteSpace: "nowrap" }}>
              FUEL<span style={{ color: T.text }}>MAP</span>
              <span style={{ fontSize: 10, color: T.textDim, marginLeft: 4, fontWeight: 400 }}>v2</span>
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", flex: 1 }}>
              {["MODEL", "ANALYZE", "PERFORM", "ATHLETES", "GEAR", "LIBRARY"].map(t => (
                <button key={t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>{t}</button>
              ))}
            </div>

            {/* Controls */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: 16 }}>
              <button onClick={() => setImperial(v => !v)} style={{ background: "none", border: `1px solid ${T.border}`, color: imperial ? T.text : T.textMuted, padding: "4px 10px", borderRadius: 3, fontFamily: "Barlow Condensed", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer" }}>
                {imperial ? "IMP" : "MET"}
              </button>
              <div style={{ fontFamily: "Barlow Condensed", fontSize: 12, color: T.textMuted, whiteSpace: "nowrap" }}>
                <span style={{ color: T.blue }}>{athlete.name}</span>
                <span style={{ color: T.textDim, marginLeft: 6 }}>{athlete.ftp}w</span>
                {bikes && bikes.length > 0 && (() => { const b = bikes.find(x => x.id === activeBikeId); return b ? <span style={{ color: T.textDim, marginLeft: 8 }}>· {b.name}</span> : null; })()}
              </div>
            </div>
          </div>
        </div>

        {/* Content — all tabs stay mounted; inactive ones are hidden via CSS so
            in-session state (GPX, FIT, plan calculations) survives tab switches. */}
        <div style={{ maxWidth: 800, margin: "0 auto", padding: "20px 16px" }}>
          <div style={{ display: tab === "MODEL"    ? undefined : "none" }}>
            <PlanTab athlete={athlete} athletes={athletes} setActiveAthleteId={setActiveAthleteId} products={products} races={races} setRaces={setRaces} imperial={imperial} bikes={bikes} setBikes={setBikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} />
          </div>
          <div style={{ display: tab === "ANALYZE"  ? undefined : "none" }}>
            <AnalyzeTab athlete={athlete} products={products} races={races} setRaces={setRaces} imperial={imperial} bikes={bikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} />
          </div>
          <div style={{ display: tab === "PERFORM"  ? undefined : "none" }}>
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 28, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.textMuted, letterSpacing: "0.1em", marginBottom: 12 }}>PERFORM</div>
              <div style={{ fontSize: 16, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.text, letterSpacing: "0.05em", marginBottom: 8 }}>Race Intelligence</div>
              <div style={{ fontSize: 13, color: T.textDim, maxWidth: 340, margin: "0 auto", lineHeight: 1.7 }}>
                Your complete post-race verdict. Coming Soon.
              </div>
              <div style={{ marginTop: 24, fontSize: 11, fontFamily: "Barlow Condensed", letterSpacing: "0.15em", color: T.textDim, textTransform: "uppercase" }}>
                <span style={{ color: "#FF3347" }}>M</span>odel · <span style={{ color: "#FF3347" }}>A</span>nalyze · <span style={{ color: "#FF3347" }}>P</span>erform
              </div>
            </div>
          </div>
          <div style={{ display: tab === "ATHLETES" ? undefined : "none" }}>
            <AthletesTab athletes={athletes} setAthletes={setAthletes} activeAthleteId={activeAthleteId} setActiveAthleteId={setActiveAthleteId} imperial={imperial} bikes={bikes} setBikes={setBikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} />
          </div>
          <div style={{ display: tab === "GEAR"     ? undefined : "none" }}>
            <BikesTab bikes={bikes} setBikes={setBikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} imperial={imperial} />
          </div>
          <div style={{ display: tab === "LIBRARY"  ? undefined : "none" }}>
            <LibraryTab products={products} setProducts={setProducts} />
          </div>
        </div>
      </div>
    </>
  );
}
