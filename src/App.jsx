import React, { useState, useCallback, useRef, useEffect } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, ReferenceLine, ReferenceArea } from "recharts";
import { loadAllRaces, saveRace, updateRace, deleteRace } from './db.js';

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

// ─── PHYSICS ENGINE ───────────────────────────────────────────────────────────
const PHYSICS = { CdA: 0.32, rho: 1.225, g: 9.81, eta: 0.975 };

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

// Compute weighted-average Crr from surface mix array [{id, pct}], modified by tire multiplier
function blendedCrr(mix, tireMult = 1.0) {
  return mix.reduce((sum, s) => {
    const surf = SURFACES.find(x => x.id === s.id);
    return sum + (surf?.Crr ?? 0.004) * tireMult * (s.pct / 100);
  }, 0);
}

// Estimate variability index correction factors from route profile and surface mix.
// Two-component model calibrated against Barry-Roubaix 2026 FIT data:
//   VI_grade   = residual grade effect the constant-speed model doesn't capture
//                = 1.020 + 0.107 × (totalVertM_per_km / 100)
//                Calibration: 28.1 m/km vert → VI_grade 1.050, matches literature
//   VI_terrain = weighted surface roughness offset (additive)
//                Calibrated: L2 gravel race = 1.092 total VI, terrain component = 0.042
// Returns { viGrade, viTerrain, viTotal, correctedDurationMin, durationLoMin, durationHiMin }
function computeVI(gpxStats, surfaceMix, physicsEstimateDurationMin) {
  const totalVertM = (gpxStats.elevGainM ?? 0) + (gpxStats.elevLossM ?? 0);
  const totalDistKm = gpxStats.totalDistKm ?? 1;
  const vertPerKm = totalVertM / totalDistKm;

  const viGrade = 1.020 + 0.107 * (vertPerKm / 100);

  const viTerrain = (surfaceMix ?? []).reduce((sum, s) => {
    const surf = SURFACES.find(x => x.id === s.id);
    return sum + (surf?.viOffset ?? 0) * (s.pct / 100);
  }, 0);

  const viTotal = viGrade + viTerrain;
  const correctedDurationMin = physicsEstimateDurationMin * viTotal;
  // ±5% uncertainty band
  const durationLoMin = physicsEstimateDurationMin * viTotal * 0.95;
  const durationHiMin = physicsEstimateDurationMin * viTotal * 1.05;

  return {
    viGrade: Math.round(viGrade * 1000) / 1000,
    viTerrain: Math.round(viTerrain * 1000) / 1000,
    viTotal: Math.round(viTotal * 1000) / 1000,
    correctedDurationMin: Math.round(correctedDurationMin),
    durationLoMin: Math.round(durationLoMin),
    durationHiMin: Math.round(durationHiMin),
  };
}

// Derive physics params from a bike profile object
function bikePhysics(bike) {
  const pos = POSITIONS.find(p => p.id === bike.positionId) ?? POSITIONS[1];
  const dt  = DRIVETRAINS.find(d => d.id === bike.drivetrainId) ?? DRIVETRAINS[1];
  const tire = TIRE_MULTIPLIERS.find(t => t.id === bike.tireId) ?? TIRE_MULTIPLIERS[1];
  return { CdA: pos.CdA, eta: dt.eta, tireMult: tire.mult };
}

function powerAtSpeed(v, grade, massKg, Crr = 0.004, CdA = 0.32, eta = 0.975, rho = 1.225, windMs = 0) {
  const Fg = massKg * PHYSICS.g * Math.sin(Math.atan(grade));
  const Fr = massKg * PHYSICS.g * Math.cos(Math.atan(grade)) * Crr;
  const vAir = Math.max(0, v + windMs);
  const Fa = 0.5 * rho * CdA * vAir * vAir;
  return Math.max(0, (Fg + Fr + Fa) * v / eta);
}

function speedAtPower(targetWatts, grade, massKg, Crr = 0.004, CdA = 0.32, eta = 0.975, rho = 1.225, windMs = 0) {
  if (targetWatts <= 0) return 0;
  let lo = 0.1, hi = 25, mid;
  for (let i = 0; i < 50; i++) {
    mid = (lo + hi) / 2;
    powerAtSpeed(mid, grade, massKg, Crr, CdA, eta, rho, windMs) < targetWatts ? lo = mid : hi = mid;
  }
  return mid;
}

function carbOxidationRate(watts, ftp) {
  const pct = watts / ftp;
  let carbPct;
  if (pct < 0.55) carbPct = 0.38;
  else if (pct < 0.65) carbPct = 0.52;
  else if (pct < 0.75) carbPct = 0.65;
  else if (pct < 0.85) carbPct = 0.78;
  else carbPct = 0.90;
  return (watts * 3.6 * carbPct) / 4; // g/hr — Jeukendrup fat/carb blend model
}

// Returns weighted average grade over a distance slice [startM, endM) from segmentGrades
function gradeForSlice(segs, startM, endM) {
  if (!segs || segs.length === 0) return 0;
  let cumM = 0, weightedGrade = 0, totalCovered = 0;
  for (const seg of segs) {
    const segStart = cumM, segEnd = cumM + seg.distM;
    cumM += seg.distM;
    if (segEnd <= startM) continue;
    if (segStart >= endM) break;
    const overlapStart = Math.max(segStart, startM);
    const overlapEnd = Math.min(segEnd, endM);
    const overlap = overlapEnd - overlapStart;
    weightedGrade += seg.gradeDecimal * overlap;
    totalCovered += overlap;
  }
  return totalCovered > 0 ? weightedGrade / totalCovered : 0;
}

// Estimate duration using the same model as buildPowerStream:
// rider holds flat-road speed at target IF, so duration = totalDist / flatSpeed
function estimateDuration(gpxStats, athlete, ifVal, Crr = 0.004, CdA = 0.32, eta = 0.975, bikeWeight = 0, rho = 1.225, windSpeedMs = 0, windDirDeg = 270) {
  const totalMass = athlete.weight + bikeWeight;
  const totalDistM = gpxStats.totalDistKm * 1000;
  // Duration based on flat-road speed at target IF — wind affects power demand not pace target
  const flatSpeed = speedAtPower(ifVal * athlete.ftp, 0, totalMass, Crr, CdA, eta, rho, 0);
  return flatSpeed > 0.1 ? (totalDistM / flatSpeed) / 60 : 9999;
}

// Binary search: find IF that produces targetDurationMin.
// Higher IF → higher flatSpeed → shorter duration.
// If duration > target (too slow), raise lo to increase IF.
function ifForTargetDuration(gpxStats, athlete, targetDurationMin, Crr = 0.004, CdA = 0.32, eta = 0.975, bikeWeight = 0, rho = 1.225, windSpeedMs = 0, windDirDeg = 270) {
  let lo = 0.30, hi = 1.15;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    estimateDuration(gpxStats, athlete, mid, Crr, CdA, eta, bikeWeight, rho, windSpeedMs, windDirDeg) > targetDurationMin ? lo = mid : hi = mid;
  }
  return Math.round((lo + hi) / 2 * 100) / 100;
}

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

function climbCategory(avgGradePct) {
  if (avgGradePct >= 10) return "wall";
  if (avgGradePct >= 6)  return "steep";
  return "moderate";
}

function detectClimbs(gpxStats) {
  if (!gpxStats?.segmentGrades || gpxStats.segmentGrades.length === 0) return [];
  const segs = gpxStats.segmentGrades;
  const totalDistM = gpxStats.totalDistKm * 1000;
  const GRADE_THRESHOLD = 0.03; // 3%
  const GAP_TOLERANCE   = 2;    // blocks of sub-threshold allowed mid-climb

  const climbs = [];
  let inClimb = false;
  let climbStart = 0;       // cumulative meters
  let gapCount = 0;
  let climbBlocks = [];     // { gradeDecimal, distM, startM }
  let cumM = 0;

  const flush = () => {
    if (climbBlocks.length === 0) return;
    // Trim trailing gap blocks
    while (climbBlocks.length > 0 && climbBlocks[climbBlocks.length - 1].gradeDecimal < GRADE_THRESHOLD) {
      climbBlocks.pop();
    }
    if (climbBlocks.length === 0) return;
    const startM  = climbBlocks[0].startM;
    const lengthM = climbBlocks.reduce((s, b) => s + b.distM, 0);
    const avgGrade = climbBlocks.reduce((s, b) => s + b.gradeDecimal * b.distM, 0) / lengthM;
    const peakGrade = Math.max(...climbBlocks.map(b => b.gradeDecimal));
    // Elevation gain: sum positive grade × distance
    const gainM = climbBlocks.reduce((s, b) => s + Math.max(0, b.gradeDecimal * b.distM), 0);
    const cat = climbCategory(avgGrade * 100);
    climbs.push({
      id: climbs.length + 1,
      startDistKm: Math.round(startM / 100) / 10,
      lengthKm:    Math.round(lengthM / 100) / 10,
      avgGrade:    Math.round(avgGrade * 1000) / 10,   // %
      peakGrade:   Math.round(peakGrade * 1000) / 10,  // %
      gainM:       Math.round(gainM),
      category:    cat,
      // Time-domain start for ReferenceArea — filled in after duration estimate
      startDistFrac: startM / totalDistM,
      endDistFrac:   Math.min(1, (startM + lengthM) / totalDistM),
    });
  };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isClimbing = seg.gradeDecimal >= GRADE_THRESHOLD;
    if (isClimbing) {
      if (!inClimb) { inClimb = true; gapCount = 0; climbBlocks = []; }
      gapCount = 0;
      climbBlocks.push({ gradeDecimal: seg.gradeDecimal, distM: seg.distM, startM: cumM });
    } else {
      if (inClimb) {
        gapCount++;
        climbBlocks.push({ gradeDecimal: seg.gradeDecimal, distM: seg.distM, startM: cumM });
        if (gapCount > GAP_TOLERANCE) {
          flush();
          inClimb = false; gapCount = 0; climbBlocks = [];
        }
      }
    }
    cumM += seg.distM;
  }
  if (inClimb) flush();
  return climbs;
}

// ─── PER-CLIMB PACING STATS ───────────────────────────────────────────────────
// Maps each detected GPX climb onto movingPowerSeries (1-second) and actualWbalRaw
// to produce per-climb NP, avg power, and W'bal remaining at climb exit.
//
// Alignment: cumulative distance from movingDistSeries (meters) matched against
// climb.startDistKm / (startDistKm + lengthKm) in meters, accounting for the same
// gpxOffsetM used in buildTerrainStream so both are in the same coordinate frame.
//
// Returns array of { climbId, category, startDistKm, lengthKm, avgGrade, peakGrade,
//   np, avgP, pctFTP, wbalPctAtExit } — one entry per detected climb.
function buildPerClimbStats(climbs, movingPowerSeries, movingDistSeries, actualWbalRaw, ftp, gpxOffsetM = 0) {
  if (!climbs?.length || !movingPowerSeries?.length || !movingDistSeries?.length) return [];

  // Build cumulative distance array from movingDistSeries, offset-adjusted so it
  // starts at gpxOffsetM (matching the terrain stream's coordinate frame).
  const cumDist = new Float32Array(movingDistSeries.length);
  let acc = gpxOffsetM;
  for (let i = 0; i < movingDistSeries.length; i++) {
    acc += movingDistSeries[i];
    cumDist[i] = acc;
  }

  // Wbal at each second — extract from actualWbalRaw chartData (1-min resolution).
  // We interpolate between minute marks for per-second approximation.
  const wbalChart = actualWbalRaw?.chartData ?? [];
  const wPrime    = actualWbalRaw ? (actualWbalRaw.wPrime ?? 20000) : 20000;
  const wbalAtSec = (secIdx) => {
    if (!wbalChart.length) return null;
    const minuteIdx = secIdx / 60;
    const lo = Math.floor(minuteIdx);
    const hi = Math.ceil(minuteIdx);
    if (lo >= wbalChart.length) return wbalChart[wbalChart.length - 1].wbalPct;
    if (hi >= wbalChart.length) return wbalChart[lo].wbalPct;
    const t = minuteIdx - lo;
    return Math.round(wbalChart[lo].wbalPct * (1 - t) + wbalChart[hi].wbalPct * t);
  };

  const npOf = (powers) => {
    if (!powers.length) return 0;
    const rolling = powers.map((_, i, a) => {
      const w = a.slice(Math.max(0, i - 29), i + 1);
      return w.reduce((s, p) => s + p, 0) / w.length;
    });
    return Math.round(Math.pow(rolling.reduce((s, p) => s + p ** 4, 0) / rolling.length, 0.25));
  };

  return climbs.map(climb => {
    const startM = climb.startDistKm * 1000;
    const endM   = startM + climb.lengthKm * 1000;

    // Collect power seconds within this climb's distance window
    const powers = [];
    let lastSecInClimb = -1;
    for (let i = 0; i < cumDist.length; i++) {
      if (cumDist[i] >= startM && cumDist[i] <= endM) {
        const p = movingPowerSeries[i];
        if (p > 0) powers.push(p);
        lastSecInClimb = i;
      }
    }

    const np    = npOf(powers);
    const avgP  = powers.length ? Math.round(powers.reduce((s, p) => s + p, 0) / powers.length) : 0;
    const pctFTP = ftp > 0 && np > 0 ? Math.round(np / ftp * 100) : 0;
    const wbalPctAtExit = lastSecInClimb >= 0 ? wbalAtSec(lastSecInClimb) : null;

    return {
      climbId:      climb.id,
      category:     climb.category,
      startDistKm:  climb.startDistKm,
      lengthKm:     climb.lengthKm,
      avgGrade:     climb.avgGrade,
      peakGrade:    climb.peakGrade,
      np, avgP, pctFTP,
      wbalPctAtExit,
      secondsInClimb: powers.length,
    };
  }).filter(c => c.secondsInClimb >= 20); // discard climbs with < 20s of data (missed alignment)
}

// ─────────────────────────────────────────────────────────────────────────────

// Binary search: find the flat-road IF that produces a desired NP IF after the full
// grade-aware simulation. User sets target NP IF (e.g. 0.76); this finds the flat-road
// speed that achieves it. Needed because grade variance inflates NP above the flat-road
// IF — on a hilly course targeting flat-road IF=0.76 can produce NP IF=0.85+.
// IMPORTANT: runs with no ceiling and no climb categories — both suppress NP and cause
// the search to over-compensate, spiraling to implausibly high IF and short durations.
// The ceiling/categories are applied in the single final buildPowerStream call in computePlan,
// where they correctly slow capped blocks without distorting the IF search.
// Runs ~30 iterations of buildPowerStream — only call on explicit user action.
function flatIFForTargetNP(targetNpIF, gpxStats, athlete, Crr, maxPower, CdA, eta, bikeWeight, rho, windSpeedMs, windDirDeg, climbCategories) {
  let lo = 0.30, hi = targetNpIF; // flat-road IF is always ≤ NP IF on variable terrain
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const strat = { mode: "constant_if", targetIF: mid };
    // No ceiling, no categories in search — see comment above
    const result = buildPowerStream(gpxStats, athlete, strat, Crr, Infinity, CdA, eta, bikeWeight, rho, windSpeedMs, windDirDeg, null);
    result.ifActual > targetNpIF ? hi = mid : lo = mid;
  }
  return (lo + hi) / 2;
}

function buildPowerStream(gpxStats, athlete, pacingStrategy, Crr = 0.004, maxPower = Infinity, CdA = 0.32, eta = 0.975, bikeWeight = 0, rho = 1.225, windSpeedMs = 0, windDirDeg = 270, climbCategories = null) {
  const totalMass = athlete.weight + bikeWeight;
  const totalDistM = gpxStats.totalDistKm * 1000;
  const avgGrade = totalDistM > 0
    ? (gpxStats.elevGainM - gpxStats.elevLossM) / totalDistM : 0;

  const segs = gpxStats.segmentGrades && gpxStats.segmentGrades.length > 0
    ? gpxStats.segmentGrades : [{ distM: totalDistM, gradeDecimal: avgGrade }];

  // Per-block bearing array from GPX (200 buckets). Falls back to avgCourseBearing or 0.
  const courseBearings = gpxStats.courseBearings || [];
  const avgBearing = gpxStats.avgCourseBearing || 0;
  // Compute headwind component for a given course bearing
  const headwindForBearing = (bearing) => {
    if (windSpeedMs === 0) return 0;
    const diff = ((windDirDeg - bearing) * Math.PI) / 180;
    return windSpeedMs * Math.cos(diff);
  };


  // Determine base IF and target duration
  const baseIF = pacingStrategy.mode === "constant_if"
    ? pacingStrategy.targetIF
    : (pacingStrategy.segments?.[0]?.targetIF ?? 0.75);

  // Flat-road speed at target IF — this is the reference speed the rider targets.
  // Duration is computed from this, matching estimateDuration exactly.
  const avgHeadwind = headwindForBearing(avgBearing);
  const flatWatts = baseIF * athlete.ftp;
  // Duration estimate: flat road, no wind (wind affects power not pace target)
  const flatSpeed = speedAtPower(flatWatts, 0, totalMass, Crr, CdA, eta, rho, 0); // m/s on flat
  const durationMin = flatSpeed > 0.1 ? (totalDistM / flatSpeed) / 60 : 180;

  // If a power ceiling is active, the ride will be slower than flatSpeed predicts.
  const effectiveWatts = Math.min(maxPower, baseIF * athlete.ftp);
  const effectiveFlatSpeed = speedAtPower(effectiveWatts, 0, totalMass, Crr, CdA, eta, rho, 0);
  const durationEstimate = effectiveFlatSpeed > 0.1 ? (totalDistM / effectiveFlatSpeed) / 60 : 180;

  // Build 1-min blocks for physics accuracy. At 1-min resolution, short punchy climbs
  // appear as distinct distance slices and the climb floor fires on actual GPX grades
  // rather than averaged-away 5-min grades. Each block covers a proportional distance slice.
  const blocks = Math.max(1, Math.ceil(durationEstimate / 1));
  const distPerBlock = totalDistM / blocks; // meters per 1-min block
  const powerStream = [];
  let actualDurationMin = 0;

  for (let i = 0; i < blocks; i++) {
    const blockStartM = i * distPerBlock;
    const blockEndM = blockStartM + distPerBlock;
    const grade = gradeForSlice(segs, blockStartM, blockEndM);

    // Warmup: first 3 blocks ramp from 70% to 100% of target speed.
    // Applied ONCE to targetSpeed only — gradeWatts derives from that reduced speed,
    // so warmup is already captured. Do NOT multiply blockWatts by warmupFactor again.
    const warmupFactor = i < 3 ? 0.7 + (i / 3) * 0.3 : 1.0;
    const segIF = pacingStrategy.mode === "segments"
      ? getSegmentIF(pacingStrategy.segments, blockStartM / totalDistM)
      : baseIF;

    // Map 1-min block index proportionally to the 200-bucket GPX bearing array.
    const bearingIdx = courseBearings.length > 0
      ? Math.min(courseBearings.length - 1, Math.floor(i / blocks * courseBearings.length))
      : 0;
    const blockBearing = courseBearings.length > 0 ? (courseBearings[bearingIdx] ?? avgBearing) : avgBearing;
    const blockHeadwind = headwindForBearing(blockBearing);

    // Target speed: flat-road speed at segIF, scaled by warmup. Wind excluded from pace target.
    const targetSpeed = speedAtPower(segIF * athlete.ftp, 0, totalMass, Crr, CdA, eta, rho, 0) * warmupFactor;

    // Power required to hold targetSpeed on this block's grade (no wind — rider backs off in wind).
    const gradeWatts = powerAtSpeed(Math.max(0.5, targetSpeed), grade, totalMass, Crr, CdA, eta, rho, 0);

    // Apply category-based climb power (min/max) if grade qualifies.
    // Categories take full precedence over global ceiling on climb blocks.
    // Global maxPower ceiling applies only to blocks where the grade demands
    // MORE than flat-road effort — i.e. actual hard efforts, not descents.
    // Applying the ceiling on descents (where gradeWatts > flatWatts because
    // the rider is trying to hold pace downhill) distorts NP calculation and
    // causes the back-solver to over-compensate, producing paradoxically faster
    // times with a ceiling than without.
    const gradePct = grade * 100;
    const flatWattsForBlock = segIF * athlete.ftp;
    const isEffortBlock = gradeWatts > flatWattsForBlock; // climb or headwind
    let blockFloor = 0;
    let blockCeiling = isEffortBlock ? Math.min(maxPower, athlete.ftp * 2) : athlete.ftp * 2;
    if (climbCategories && gradePct >= 3) {
      const cat = climbCategory(gradePct);
      const catSettings = climbCategories[cat];
      if (catSettings) {
        if (catSettings.min > 0) blockFloor   = catSettings.min;
        if (catSettings.max > 0) blockCeiling = catSettings.max;
      }
    }
    const blockWatts = Math.round(Math.min(blockCeiling, Math.max(blockFloor, Math.max(20, gradeWatts))));

    // Actual speed WITH wind — headwind slows you, tailwind helps.
    const speed = speedAtPower(blockWatts, grade, totalMass, Crr, CdA, eta, rho, blockHeadwind);
    const blockTimeMin = speed > 0.3 ? (distPerBlock / speed) / 60 : 1;
    const speedKph = Math.round(speed * 3.6 * 10) / 10;

    powerStream.push({
      time: Math.round(actualDurationMin),
      power: blockWatts,
      pctFTP: blockWatts / athlete.ftp,
      grade: Math.round(grade * 1000) / 10,
      distKm: Math.round(blockStartM / 100) / 10,
      speedKph,
    });
    actualDurationMin += blockTimeMin;
  }

  // NP: 30-second rolling average then 4th-power mean.
  // At 1-min blocks, window = ceil(30/60) = 1 block. Finer terrain resolution now feeds
  // into the 4th-power mean, producing more accurate NP on variable terrain.
  const rollingWindow = Math.max(1, Math.ceil(30 / (actualDurationMin / blocks * 60)));
  const blockPowers = powerStream.map(p => p.power);
  const rollingAvgs = blockPowers.map((_, i) => {
    const window = blockPowers.slice(Math.max(0, i - rollingWindow + 1), i + 1);
    return window.reduce((s, p) => s + p, 0) / window.length;
  });
  const normalizedPower = Math.round(Math.pow(
    rollingAvgs.reduce((s, p) => s + Math.pow(p, 4), 0) / rollingAvgs.length,
    0.25
  ));
  const avgPower = Math.round(powerStream.reduce((s, p) => s + p.power, 0) / blocks);
  const ifActual = Math.round((normalizedPower / athlete.ftp) * 100) / 100;
  const tss = Math.round((actualDurationMin / 60) * ifActual * ifActual * 100);

  // Build 2-min display stream by aggregating pairs of 1-min blocks.
  // Charts render displayStream; all physics (NP, W'bal, climb floor, nutrition) uses powerStream.
  const DISPLAY_BLOCK_MIN = 2;
  const displayStream = [];
  for (let i = 0; i < powerStream.length; i += DISPLAY_BLOCK_MIN) {
    const slice = powerStream.slice(i, i + DISPLAY_BLOCK_MIN);
    const avgDisplayPower = Math.round(slice.reduce((s, p) => s + p.power, 0) / slice.length);
    const peakGrade = Math.max(...slice.map(p => p.grade));
    const avgGrade = Math.round(slice.reduce((s, p) => s + p.grade, 0) / slice.length * 10) / 10;
    const avgSpeed = Math.round(slice.reduce((s, p) => s + p.speedKph, 0) / slice.length * 10) / 10;
    displayStream.push({
      time: slice[0].time,
      power: avgDisplayPower,
      pctFTP: avgDisplayPower / athlete.ftp,
      grade: avgGrade,
      peakGrade: Math.round(peakGrade * 10) / 10,
      distKm: slice[0].distKm,
      speedKph: avgSpeed,
    });
  }

  return {
    powerStream,      // 1-min blocks — NP, W'bal, nutrition physics
    displayStream,    // 2-min aggregates — charts only
    estimatedDurationMin: Math.round(actualDurationMin),
    avgSpeedKph: Math.round((gpxStats.totalDistKm / (actualDurationMin / 60)) * 10) / 10,
    avgPower,
    normalizedPower,
    tss,
    ifActual,
    // VI correction — caller must pass surfaceMix separately; stored here for display
    _physicsOnlyDurationMin: Math.round(actualDurationMin),
  };
}

function getSegmentIF(segments, progress) {
  if (!segments || segments.length === 0) return 0.75;
  const total = segments.reduce((s, seg) => s + (seg.endKm - seg.startKm), 0);
  let cumPct = 0;
  for (const seg of segments) {
    cumPct += (seg.endKm - seg.startKm) / total;
    if (progress <= cumPct) return seg.targetIF;
  }
  return segments[segments.length - 1].targetIF;
}

// Realistic glycogen: ~300g base + small weight component (trained athlete)
function startingGlycogen(weightKg) { return Math.round(weightKg * 5.5); }

// ─── W'BAL MODEL (Skiba 2012) ─────────────────────────────────────────────────
// powerStream blocks are 5-min (300s) each.
// Above CP (≈FTP): W' depletes at (power - CP) × blockSeconds joules
// Below CP: W' reconstitutes using Skiba exponential recovery.
// TODO(validation): Plan-side W'bal uses 1-min blocks which is a known limitation —
// it underestimates depletion from short surges. Acceptable for planning (forward model)
// but should not be used for actual ride analysis. Use buildWbalFromRawSeries for actuals.
function buildWbal(powerStream, athlete) {
  const CP = athlete.ftp;
  const wPrime = deriveWPrime(athlete);
  const blockSecs = 60; // 1-min blocks
  let wbal = wPrime;
  const result = [];

  for (const pt of powerStream) {
    const power = pt.power;
    if (power >= CP) {
      const cost = (power - CP) * blockSecs;
      wbal = Math.max(0, wbal - cost);
    } else {
      const tau = 546 * Math.exp(-0.01 * (CP - power)) + 316;
      wbal = wPrime - (wPrime - wbal) * Math.exp(-blockSecs / tau);
    }
    result.push({
      ...pt,
      wbal: Math.round(wbal),
      wbalPct: Math.round((wbal / wPrime) * 100),
    });
  }
  return result;
}

// 1-second W'bal from raw moving-time power series.
// Returns downsampled series at 1-minute resolution for charting,
// plus raw min/peak data for analysis.
// This is the correct approach for actual ride analysis — block averages
// mask short hard efforts entirely (a 30s 400w surge disappears in a 5-min average).
function buildWbalFromRawSeries(movingPowerSeries, athlete, movingAltSeries) {
  if (!movingPowerSeries || movingPowerSeries.length === 0) return { chartData: [], minWbal: null, minWbalTime: 0, peakBurnJ: 0, peakBurnTime: 0 };
  const CP     = athlete.ftp;
  const wPrime = deriveWPrime(athlete);
  let wbal     = wPrime;
  let prevWbal = wPrime;
  let minWbal  = wPrime;
  let minWbalTime = 0;
  let peakBurnJ   = 0;
  let peakBurnTime = 0;

  const minuteData = [];
  let minuteBurnJ   = 0;
  let minuteMinWbal = wPrime;
  let minuteAltSum  = 0;
  let minuteAltCnt  = 0;

  for (let i = 0; i < movingPowerSeries.length; i++) {
    const power = movingPowerSeries[i];
    if (power > CP) {
      wbal = Math.max(0, wbal - (power - CP));
    } else {
      const tau = 546 * Math.exp(-0.01 * (CP - power)) + 316;
      wbal = wPrime - (wPrime - wbal) * Math.exp(-1 / tau);
    }
    const burn = Math.max(0, prevWbal - wbal);
    minuteBurnJ   += burn;
    minuteMinWbal  = Math.min(minuteMinWbal, wbal);

    // Altitude accumulation for averaging
    const alt = movingAltSeries?.[i];
    if (alt !== null && alt !== undefined) { minuteAltSum += alt; minuteAltCnt++; }

    if (wbal < minWbal) { minWbal = wbal; minWbalTime = i; }
    if (burn > peakBurnJ) { peakBurnJ = burn; peakBurnTime = i; }
    prevWbal = wbal;

    if ((i + 1) % 60 === 0 || i === movingPowerSeries.length - 1) {
      const timeMin = Math.round((i + 1) / 60);
      minuteData.push({
        time:     timeMin,
        wbal:     Math.round(wbal),
        wbalPct:  Math.round(wbal / wPrime * 100),
        burnJ:    Math.round(minuteBurnJ),
        burnKj:   Math.round(minuteBurnJ / 100) / 10,
        minPct:   Math.round(minuteMinWbal / wPrime * 100),
        altM:     minuteAltCnt > 0 ? Math.round(minuteAltSum / minuteAltCnt * 10) / 10 : null,
      });
      minuteBurnJ   = 0;
      minuteMinWbal = wbal;
      minuteAltSum  = 0;
      minuteAltCnt  = 0;
    }
  }

  return {
    chartData:    minuteData,
    minWbal:      Math.round(minWbal),
    minWbalPct:   Math.round(minWbal / wPrime * 100),
    minWbalTime:  minWbalTime,
    peakBurnJ:    Math.round(peakBurnJ),
    peakBurnTime: peakBurnTime,
    wPrime,
    hasAltitude:  (movingAltSeries?.some(a => a !== null)) ?? false,
  };
}

function buildNutritionOverlay(displayStream, intakeEvents, athlete, preRaceMeal) {
  if (!displayStream || displayStream.length === 0) return [];
  const glycogenScale = 0.7 + (preRaceMeal / 300) * 0.45;
  let glycogenReserve = Math.round(startingGlycogen(athlete.weight) * glycogenScale);
  const maxGlycogen = startingGlycogen(athlete.weight) * 1.15;
  const MAX_ABSORPTION = 90; // g/hr max intestinal absorption

  // Spread each intake event over 10 blocks (~20 min at 2-min blocks) — realistic absorption
  // window for gels, chews, bars. Ceiling of 90g/hr still applies per block.
  const ABSORB_BLOCKS = 10;
  const absQueue = new Array(displayStream.length).fill(0);
  for (const e of intakeEvents) {
    const startBlock = displayStream.findIndex(pt => pt.time >= e.time);
    if (startBlock === -1) continue;
    const gPerBlock = (e.carbs || 0) / ABSORB_BLOCKS;
    for (let b = startBlock; b < Math.min(startBlock + ABSORB_BLOCKS, displayStream.length); b++) {
      absQueue[b] += gPerBlock;
    }
  }

  return displayStream.map((pt, idx) => {
    const burnRate = carbOxidationRate(pt.power, athlete.ftp); // g/hr
    const burned = burnRate * (2 / 60); // g burned this 2-min block

    const scheduledIntake = absQueue[idx];
    const maxAbsorbThisBlock = MAX_ABSORPTION * (2 / 60); // 3g per 2-min block
    const actualAbsorbed = Math.min(scheduledIntake, maxAbsorbThisBlock);
    const overLimit = Math.max(0, scheduledIntake - maxAbsorbThisBlock);

    // Point-in-time intake for reference markers (2-min window)
    const pointIntake = intakeEvents
      .filter(e => e.time >= pt.time && e.time < pt.time + 2)
      .reduce((s, e) => s + (e.carbs || 0), 0);

    glycogenReserve = Math.min(maxGlycogen, Math.max(0, glycogenReserve - burned + actualAbsorbed));

    return {
      ...pt,
      burnRate: Math.round(burnRate),
      glycogenReserve: Math.round(glycogenReserve),
      reservePct: Math.round((glycogenReserve / maxGlycogen) * 100),
      gutPool: 0,
      intakeRate: Math.round(actualAbsorbed * 12), // g/block → g/hr
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
    pts.push({ lat, lon, ele, cumDistM: totalDist });
  }

  // Pass 2: total gain/loss
  let elevGain = 0, elevLoss = 0;
  for (let i = 1; i < pts.length; i++) {
    const dEle = pts[i].ele - pts[i-1].ele;
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
    _gpxPts: pts, // {lat, lon, ele, cumDistM} — used for FIT-to-GPX position alignment
  };
}

// ─── FIT PARSER (minimal binary) ──────────────────────────────────────────────
// TODO(build): Replace this hand-rolled binary parser with `fit-file-parser` npm
// package when FuelMAP moves to a real build environment. The custom parser covers
// common Garmin fields but has known device compatibility gaps:
//   - Wahoo Bolt V1: power not written to record messages (session summary only)
//   - Some devices use only enhanced_speed/enhanced_altitude (handled)
//   - Developer fields (Wahoo custom data) not parsed
//   - Compressed timestamp records skipped
// fit-file-parser handles the full FIT spec across all manufacturers and would
// resolve all device compatibility issues in a single swap. High priority for
// first real build milestone.
function parseFIT(buffer) {
  const view = new DataView(buffer);
  const headerSize = view.getUint8(0);
  let offset = headerSize;
  const records = [];
  const localDefs = {};

  const POWER_FIELD = 7, HR_FIELD = 3, SPEED_FIELD = 6, TIMESTAMP_FIELD = 253,
        ALTITUDE_FIELD = 2, DISTANCE_FIELD = 5, LAT_FIELD = 0, LON_FIELD = 1,
        ENHANCED_SPEED_FIELD = 73,    // fallback when speed (field 6) absent
        ENHANCED_ALTITUDE_FIELD = 78; // fallback when altitude (field 2) absent

  try {
    while (offset < buffer.byteLength - 2) {
      const recordHeader = view.getUint8(offset++);
      if (recordHeader & 0x80) {
        // Compressed timestamp — advance past data fields using known definition
        const localMsgNum = (recordHeader >> 5) & 0x3;
        const def = localDefs[localMsgNum];
        if (def) { for (const f of def.fields) { if (f.size > 0 && f.size <= 8) offset += f.size; } }
        continue;
      }
      const msgType = (recordHeader >> 6) & 0x3;
      const localMsgNum = recordHeader & 0x0F;

      if (msgType === 1) { // definition
        offset++; // reserved
        const arch = view.getUint8(offset++);
        const globalMsgNum = arch === 0 ? view.getUint16(offset, true) : view.getUint16(offset, false);
        offset += 2;
        const numFields = view.getUint8(offset++);
        const fields = [];
        for (let f = 0; f < numFields; f++) {
          fields.push({ num: view.getUint8(offset), size: view.getUint8(offset + 1), type: view.getUint8(offset + 2) });
          offset += 3;
        }
        localDefs[localMsgNum] = { globalMsgNum, fields, arch };
      } else if (msgType === 0) { // data
        const def = localDefs[localMsgNum];
        if (!def) { break; }
        const rec = { globalMsgNum: def.globalMsgNum };
        for (const field of def.fields) {
          if (field.size <= 0 || field.size > 8) { offset += field.size; continue; }
          let val;
          try {
            val = field.size === 1 ? view.getUint8(offset)
              : field.size === 2 ? view.getUint16(offset, def.arch === 0)
              : field.size === 4 ? view.getUint32(offset, def.arch === 0)
              : view.getBigUint64(offset, def.arch === 0);
          } catch { val = 0; }
          rec[field.num] = val;
          offset += field.size;
        }
        if (def.globalMsgNum === 20) { // record message
          const power    = rec[POWER_FIELD];
          const hr       = rec[HR_FIELD];
          const ts       = rec[TIMESTAMP_FIELD];
          // Speed: prefer field 6 (speed), fall back to field 73 (enhanced_speed)
          // enhanced_speed is already in m/s; speed field 6 is raw mm/s uint16
          const speedRaw      = rec[SPEED_FIELD];
          const enhSpeedRaw   = rec[ENHANCED_SPEED_FIELD];
          // Altitude: prefer field 2 (altitude, raw * 0.2 - 500 = m),
          //           fall back to field 78 (enhanced_altitude, already in meters as uint32)
          const altRaw        = rec[ALTITUDE_FIELD];
          const enhAltRaw     = rec[ENHANCED_ALTITUDE_FIELD];
          const distRaw       = rec[DISTANCE_FIELD];
          const latRaw        = rec[LAT_FIELD];
          const lonRaw        = rec[LON_FIELD];

          if (power !== undefined && power !== 65535) {
            const toSignedInt32 = (v) => v > 0x7FFFFFFF ? v - 0x100000000 : v;
            const SEMICIRCLE_TO_DEG = 180 / 2147483648;

            // Speed stored as raw mm/s (field 6) or m/s * 1000 (enhanced field 73)
            // Both fields store as uint32 scaled the same way in this context (mm/s)
            const effectiveSpeedRaw = speedRaw ?? enhSpeedRaw ?? 0;

            // Altitude: field 2 raw * 0.2 - 500 = meters
            //           field 78 enhanced: same scaling (uint32, * 0.2 - 500)
            let altM = null;
            if (altRaw !== undefined) {
              altM = Math.round((Number(altRaw) * 0.2 - 500) * 10) / 10;
            } else if (enhAltRaw !== undefined) {
              altM = Math.round((Number(enhAltRaw) * 0.2 - 500) * 10) / 10;
            }

            records.push({
              power:   Number(power),
              hr:      hr ? Number(hr) : 0,
              ts:      ts ? Number(ts) : 0,
              speedMs: effectiveSpeedRaw ? Number(effectiveSpeedRaw) : 0,
              altM,
              dist:    distRaw !== undefined ? Number(distRaw) / 100 : null,
              lat:     latRaw !== undefined ? toSignedInt32(Number(latRaw)) * SEMICIRCLE_TO_DEG : null,
              lon:     lonRaw !== undefined ? toSignedInt32(Number(lonRaw)) * SEMICIRCLE_TO_DEG : null,
            });
          }
        }
      } else { break; }
    }
  } catch (e) { /* partial parse ok */ }

  if (records.length === 0) return null;

  // ── Elapsed time from timestamps ──────────────────────────────────────────
  const tsStart = records[0].ts;
  const tsEnd   = records[records.length - 1].ts;
  const elapsedSec = (tsStart > 0 && tsEnd > tsStart) ? (tsEnd - tsStart) : records.length;
  const elapsedMin = Math.round(elapsedSec / 60);

  // ── Moving time: exclude periods where speed < 0.5 m/s (500 mm/s) for ≥ 5 seconds ──
  // Threshold 0.5 m/s matches Garmin device moving-time methodology.
  // Strict zero misses slow rollout/rolldown around stops and understates stopped time.
  // Validated: Barry-Roubaix 2026 → 4:22 moving time matching Garmin Connect exactly.
  // speedMs field is raw mm/s (uint16) — compare against 500 (= 0.5 m/s).
  const byTs = {};
  for (const r of records) { if (r.ts > 0) byTs[r.ts - tsStart] = r; }
  let stoppedSec = 0;
  let inStop = false;
  let stopLen = 0;
  let stopStart = 0;
  const stoppedOffsets = new Set();
  const pendingStop = [];
  const STOP_SPEED_THRESHOLD = 500; // mm/s = 0.5 m/s ≈ 1.1 mph
  const STOP_MIN_DURATION    = 5;   // seconds — Garmin uses ~5s minimum
  for (let t = 0; t <= elapsedSec; t++) {
    const r = byTs[t];
    const isStopped = r ? r.speedMs < STOP_SPEED_THRESHOLD : false;
    if (isStopped) {
      if (!inStop) { inStop = true; stopLen = 0; }
      pendingStop.push(t);
      stopLen++;
    } else {
      if (inStop) {
        if (stopLen >= STOP_MIN_DURATION) {
          stoppedSec += stopLen;
          for (const s of pendingStop) stoppedOffsets.add(s);
        }
        inStop = false; stopLen = 0; pendingStop.length = 0;
      }
    }
  }
  if (inStop && stopLen >= STOP_MIN_DURATION) {
    stoppedSec += stopLen;
    for (const s of pendingStop) stoppedOffsets.add(s);
  }
  const movingMin = Math.round((elapsedSec - stoppedSec) / 60);
  const stoppedMin = Math.round(stoppedSec / 60);

  // ── NP and avgPower from raw 1-second data (correct 30-sec rolling average method) ──
  const powerByTs = {};
  for (const r of records) { if (r.ts > 0) powerByTs[r.ts - tsStart] = r.power; }
  const powerSeries = [];
  for (let t = 0; t <= elapsedSec; t++) powerSeries.push(powerByTs[t] !== undefined ? powerByTs[t] : 0);
  const rawAvgPower = Math.round(powerSeries.reduce((s, p) => s + p, 0) / powerSeries.length);
  const rollingAvgs = [];
  for (let i = 0; i < powerSeries.length; i++) {
    const w = powerSeries.slice(Math.max(0, i - 29), i + 1);
    rollingAvgs.push(w.reduce((s, p) => s + p, 0) / w.length);
  }
  const rawNP = Math.round(Math.pow(rollingAvgs.reduce((s, p) => s + Math.pow(p, 4), 0) / rollingAvgs.length, 0.25));

  // ── 5-min block map — keyed by MOVING time offset, stopped seconds excluded ──
  // TODO(validation): 5-min block averaging is appropriate for the power chart overlay
  // and zone distribution, but masks short hard efforts for any intensity-based metric.
  // Revisit block size for: zone distribution (coarse), HR per block (coarse),
  // fade analysis NP per third (acceptable — NP smooths naturally), threshold exposure
  // (minutes-based so block size matters less). W'bal already fixed to use 1-second data.
  // This ensures the power chart aligns with the plan (which predicts moving time only).
  // Stopped periods (aid stations, mechanicals) are stripped out before bucketing.
  const blockSize = 300; // seconds per block = 5 min
  const blockMap = {};
  let movingOffset = 0; // running moving-time counter in seconds
  for (let t = 0; t <= elapsedSec; t++) {
    if (stoppedOffsets.has(t)) continue; // skip stopped seconds
    const r = byTs[t];
    if (!r) { movingOffset++; continue; } // gap in recording — advance moving clock
    const block = Math.floor(movingOffset / blockSize) * 5; // key = moving minutes
    if (!blockMap[block]) blockMap[block] = { powers: [], hrs: [] };
    blockMap[block].powers.push(r.power);
    blockMap[block].hrs.push(r.hr);
    movingOffset++;
  }

  // Build moving-time 1-second power + altitude + distance delta + HR series
  // TODO(validation): 5-min block averaging is appropriate for the power chart overlay
  // and zone distribution, but masks short hard efforts for any intensity-based metric.
  // Revisit block size for: zone distribution (coarse), HR per block (coarse),
  // fade analysis NP per third (acceptable — NP smooths naturally), threshold exposure
  // (minutes-based so block size matters less). W'bal already fixed to use 1-second data.
  const movingPowerSeries = [];
  const movingAltSeries   = [];
  const movingDistSeries  = []; // per-second distance delta (m) — used for speed + terrain grade
  const movingHRSeries    = []; // per-second HR (bpm)
  let prevDistM = null;
  for (let t = 0; t <= elapsedSec; t++) {
    if (stoppedOffsets.has(t)) continue;
    const r = byTs[t];
    movingPowerSeries.push(r ? r.power : 0);
    movingAltSeries.push(r?.altM ?? null);
    movingHRSeries.push(r ? r.hr : 0);
    // Distance delta per second
    const distM = r?.dist ?? null;
    if (distM !== null && prevDistM !== null) {
      movingDistSeries.push(Math.max(0, distM - prevDistM));
    } else {
      movingDistSeries.push(0);
    }
    if (distM !== null) prevDistM = distM;
  }

  // First valid GPS coordinate — used to align FIT start position to GPX route
  const firstGPS = records.find(r => r.lat !== null && r.lon !== null && Math.abs(r.lat) > 0.01);

  return {
    blockMap,
    elapsedMin,
    movingMin,
    stoppedMin,
    durationMin: movingMin,
    totalRecords: records.length,
    rawAvgPower,
    rawNP,
    movingPowerSeries,
    movingAltSeries,
    movingDistSeries,
    movingHRSeries,
    firstGPS: firstGPS ? { lat: firstGPS.lat, lon: firstGPS.lon, dist: firstGPS.dist ?? 0 } : null,
  };
}

function buildPowerStreamFromFIT(fitData, athlete) {
  return Object.entries(fitData.blockMap).map(([time, data]) => {
    const power = Math.round(data.powers.reduce((a, b) => a + b, 0) / data.powers.length);
    const hr = Math.round(data.hrs.filter(h => h > 0).reduce((a, b) => a + b, 0) / (data.hrs.filter(h => h > 0).length || 1));
    return { time: Number(time), power, pctFTP: power / athlete.ftp, grade: 0, distKm: 0, speedKph: 0, hr };
  }).sort((a, b) => a.time - b.time);
}

// TODO(weather): replace manual entry with API fetch once deployed
// fetchWeather(lat, lon, raceDate) → setWeatherContext(result)
// Air density correction: rho varies ~4% between 0°C and 35°C
function rhoFromTemp(tempC) {
  // Ideal gas law approximation at sea level
  // rho = 1.225 * (288.15 / (273.15 + tempC))
  if (tempC === null || tempC === undefined) return 1.225;
  return 1.225 * (288.15 / (273.15 + tempC));
}

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
function deriveWPrime(athlete) {
  if (athlete.cpTests) {
    const filled = athlete.cpTests.filter(t => t.secs > 0 && t.watts > 0);
    if (filled.length >= 2) {
      // Fit CP model: energy = CP * t + W'  →  least-squares on (t, energy) pairs
      const n = filled.length;
      const pts = filled.map(t => ({ t: t.secs, e: t.watts * t.secs }));
      const sumT  = pts.reduce((s, p) => s + p.t, 0);
      const sumE  = pts.reduce((s, p) => s + p.e, 0);
      const sumTT = pts.reduce((s, p) => s + p.t * p.t, 0);
      const sumTE = pts.reduce((s, p) => s + p.t * p.e, 0);
      const denom = n * sumTT - sumT * sumT;
      if (denom !== 0) {
        const cp = (n * sumTE - sumT * sumE) / denom;
        const wPrime = (sumE - cp * sumT) / n;
        return Math.max(5000, Math.round(wPrime));
      }
    }
  }
  if (athlete.phenotype && athlete.ftp) {
    const ph = RIDER_PHENOTYPES.find(p => p.id === athlete.phenotype);
    if (ph) return Math.round(athlete.ftp * ph.wMult);
  }
  if (athlete.ftp) return Math.round(athlete.ftp * 75);
  return 20000;
}

// Compute CP and goodness-of-fit from cpTests array
function computeCP(cpTests) {
  const filled = (cpTests || []).filter(t => t.secs > 0 && t.watts > 0);
  if (filled.length < 2) return null;
  const n = filled.length;
  const pts = filled.map(t => ({ t: t.secs, e: t.watts * t.secs }));
  const sumT  = pts.reduce((s, p) => s + p.t, 0);
  const sumE  = pts.reduce((s, p) => s + p.e, 0);
  const sumTT = pts.reduce((s, p) => s + p.t * p.t, 0);
  const sumTE = pts.reduce((s, p) => s + p.t * p.e, 0);
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null;
  const cp = (n * sumTE - sumT * sumE) / denom;
  const wPrime = (sumE - cp * sumT) / n;
  // R² goodness of fit
  const meanE = sumE / n;
  const ssTot = pts.reduce((s, p) => s + Math.pow(p.e - meanE, 2), 0);
  const ssRes = pts.reduce((s, p) => s + Math.pow(p.e - (cp * p.t + wPrime), 2), 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { cp: Math.round(cp), wPrime: Math.max(5000, Math.round(wPrime)), r2: Math.round(r2 * 1000) / 10 };
}

const DEFAULT_ATHLETE = {
  id: 1, name: "Athlete 1", ftp: 250, weight: 79.4,
  maxHR: 175,
  wPrime: 20000,
  phenotype: "allrounder",
  cpTests: [{ secs: 0, watts: 0 }, { secs: 0, watts: 0 }, { secs: 0, watts: 0 }],
  cpTestedAt: null,
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

// ─── ZONE TIME DISTRIBUTION (6-zone Coggan) ──────────────────────────────────
// Z1 <55% | Z2 55–75% | Z3 76–90% | Z4 91–105% | Z5 106–120% | Z6 >121%
const POWER_ZONES = [
  { id: "z1", label: "Z1", max: 0.55,                color: "#00D4FF" }, // Recovery   — Signal Cyan
  { id: "z2", label: "Z2", min: 0.55, max: 0.75,    color: "#00FF8C" }, // Endurance  — Fuel Green
  { id: "z3", label: "Z3", min: 0.76, max: 0.90,    color: "#FFB800" }, // Tempo      — Power Amber
  { id: "z4", label: "Z4", min: 0.91, max: 1.05,    color: "#FF8C00" }, // Threshold  — Amber-Orange
  { id: "z5", label: "Z5", min: 1.06, max: 1.20,    color: "#FF3347" }, // VO2 Max    — Redline
  { id: "z6", label: "Z6", min: 1.21,               color: "#A855F7" }, // Anaerobic  — W-Prime
];

function computeZoneDist(powerStream, ftp) {
  if (!powerStream || powerStream.length === 0) return POWER_ZONES.map(z => ({ ...z, pct: 0, blocks: 0 }));
  const counts = [0, 0, 0, 0, 0, 0];
  for (const pt of powerStream) {
    const pct = pt.power / ftp;
    if      (pct < 0.55) counts[0]++;
    else if (pct < 0.76) counts[1]++;
    else if (pct < 0.91) counts[2]++;
    else if (pct < 1.06) counts[3]++;
    else if (pct < 1.21) counts[4]++;
    else                 counts[5]++;
  }
  const total = powerStream.length;
  return POWER_ZONES.map((z, i) => ({
    ...z,
    blocks: counts[i],
    pct: Math.round((counts[i] / total) * 100),
  }));
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

  const ZONE_NAMES = ["Recovery", "Endurance", "Tempo", "Threshold", "VO2 Max", "Anaerobic"];

  // Full-width bar — segments sized by zone %
  const FullBar = ({ zones, opacity }) => (
    <div style={{ display: "flex", width: "100%", height: 10, borderRadius: 4, overflow: "hidden", gap: 1 }}>
      {zones.map(z => (
        <div key={z.id} style={{ flex: Math.max(z.pct, 1), background: z.color, opacity }}
          title={`${z.label}: ${z.pct}%`} />
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
        {POWER_ZONES.map((z, i) => (
          <div key={z.id} style={{ fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700,
            color: z.color, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
            {ZONE_NAMES[i]}
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
// Priority: GPX segmentGrades (accurate, noise-free) → FIT 60s rolling altitude window.
// GPX approach: map each FIT second to route position via cumulative distance,
//   look up the GPX segment grade at that position.
// FIT fallback: 60-second rolling altitude delta / distance covered.
//   60s chosen over 30s — validation showed 60s stdev=2.54% vs 30s=3.42%,
//   and terrain distribution matched GPX much more closely (66% flat vs 68% GPX).
// Thresholds: >2% = climb, <-2% = descent, else flat.
//   Validated against Barry-Roubaix GPX: FIT-60s gives climb=23%/flat=66%/descent=12%
//   vs GPX 17%/68%/15% — close enough for terrain bucketing.
function buildTerrainStream(movingPowerSeries, movingAltSeries, movingDistSeries, gpxRoute, gpxOffsetM = 0) {
  const n = movingPowerSeries.length;
  const CLIMB = 0.02, DESCENT = -0.02;
  const grades = new Float32Array(n);

  const hasDistData = movingDistSeries && movingDistSeries.some(d => d > 0);

  if (gpxRoute?.segmentGrades?.length > 0 && hasDistData) {
    // segmentGrades[].distM is segment LENGTH, not cumulative — build cumulative array first
    const segs = gpxRoute.segmentGrades;
    let cumBuild = 0;
    const cumSegs = segs.map(s => { cumBuild += s.distM; return { cumDistM: cumBuild, gradeDecimal: s.gradeDecimal }; });
    let cumDistM = gpxOffsetM; // start at the offset so FIT position maps correctly onto GPX
    let segIdx = 0;
    // Position segIdx at the offset start
    while (segIdx < cumSegs.length - 1 && cumDistM > cumSegs[segIdx].cumDistM) segIdx++;
    for (let i = 0; i < n; i++) {
      cumDistM += (movingDistSeries[i] || 0);
      while (segIdx < cumSegs.length - 1 && cumDistM > cumSegs[segIdx].cumDistM) segIdx++;
      grades[i] = cumSegs[segIdx].gradeDecimal;
    }
  } else if (movingAltSeries) {
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
      grades[i] = Math.max(-0.25, Math.min(0.25, rawGrade)); // clamp ±25%
    }
  }

  // Classify — use Array.from so we get a plain string array, not a TypedArray
  // (Float32Array.map returns a Float32Array, converting strings to NaN)
  return Array.from(grades, g => g > CLIMB ? 'climb' : g < DESCENT ? 'descent' : 'flat');
}

// Bucket moving-time data by terrain type
function bucketByTerrain(movingPowerSeries, movingAltSeries, movingDistSeries, movingHRSeries, gpxRoute, ftp, fitFirstGPS) {
  // Compute GPS offset: how far into the GPX route the FIT recording started.
  // Common in races — rider starts Garmin in staging area before the start line.
  let gpxOffsetM = 0;
  if (gpxRoute?.segmentGrades?.length > 0 && fitFirstGPS) {
    if (gpxRoute._gpxPts) {
      // Best path: full GPX point array available — nearest-neighbor GPS match
      const haversine = (lat1, lon1, lat2, lon2) => {
        const R = 6371000, toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toRad)*Math.cos(lat2*toRad)*Math.sin(dLon/2)**2;
        return R * 2 * Math.asin(Math.sqrt(a));
      };
      const pts = gpxRoute._gpxPts;
      let minD = Infinity, minIdx = 0;
      for (let i = 0; i < pts.length; i++) {
        const d = haversine(pts[i].lat, pts[i].lon, fitFirstGPS.lat, fitFirstGPS.lon);
        if (d < minD) { minD = d; minIdx = i; }
      }
      // Only use GPS match if it found a reasonably close point (< 2km)
      gpxOffsetM = minD < 2000 ? pts[minIdx].cumDistM : 0;
    } else {
      // Fallback: _gpxPts not in saved plan (plan saved before this feature was added).
      // Use FIT's own cumulative distance at first GPS record as a rough proxy.
      // Note: this will be inaccurate if the rider started recording before the route start.
      // Re-save the plan after re-uploading the GPX to get accurate GPS offset matching.
      gpxOffsetM = fitFirstGPS.dist ?? 0;
    }
  }

  const terrain = buildTerrainStream(movingPowerSeries, movingAltSeries, movingDistSeries, gpxRoute, gpxOffsetM);
  const n = movingPowerSeries.length;
  const t1End = Math.floor(n / 3);
  const t2End = Math.floor(2 * n / 3);

  const buckets = {
    climb:   { npPowers: [], powers: [], speeds: [], hrs: [], thirds: [{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]}] },
    flat:    { npPowers: [], powers: [], speeds: [], hrs: [], thirds: [{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]}] },
    descent: { npPowers: [], powers: [], speeds: [], hrs: [], thirds: [{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]},{npPowers:[],powers:[],speeds:[]}] },
  };

  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    const p = movingPowerSeries[i];
    const spd = movingDistSeries?.[i] || 0;
    const thirdIdx = i < t1End ? 0 : i < t2End ? 1 : 2;
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
function ElevPowerChart({ displayStream, gpxStats, ftp, imperial = false, detectedClimbs = [], durationMin, estimatedDurationMin }) {
  if (!displayStream || displayStream.length === 0) return null;

  const elevProfile = gpxStats?.elevProfile || [];
  const totalDistKm = gpxStats?.totalDistKm || 1;

  const eleAtDistKm = (km) => {
    if (elevProfile.length === 0) return 0;
    const idx = Math.min(elevProfile.length - 1,
      Math.max(0, Math.floor((km / totalDistKm) * elevProfile.length)));
    return elevProfile[idx].ele;
  };

  const blockDistKm = totalDistKm / displayStream.length;

  // Scale block timestamps from raw physics duration → VI-corrected duration so data
  // fills the full x-axis. VI correction stretches real-world time but doesn't change
  // the terrain order — each block covers the same distance, just takes longer.
  const rawDuration = estimatedDurationMin ?? (displayStream[displayStream.length - 1]?.time ?? 1);
  const totalDurationMin = durationMin ?? rawDuration;
  const viScale = rawDuration > 0 ? totalDurationMin / rawDuration : 1;

  const data = displayStream.map((pt) => {
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
                      {activeBand.category} #{activeBand.id} · {activeBand.lengthKm}km · avg {activeBand.avgGrade}% · peak {activeBand.peakGrade}% · +{imperial ? Math.round(activeBand.gainM * 3.281) : activeBand.gainM}{eleUnit}
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
function WbalChart({ wbalData, athlete, gpxStats = null, imperial = false, durationMin, estimatedDurationMin }) {
  if (!wbalData || wbalData.length === 0) return null;
  const wPrime = deriveWPrime(athlete);
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

  const data = wbalData.map((pt, i) => ({ ...pt, time: Math.round(pt.time * viScale), altM: altVals[i] }));

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
            const pct = d?.wbalPct ?? 0;
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

// ─── ATHLETE MODAL ────────────────────────────────────────────────────────────
// ─── BIKE MODAL ───────────────────────────────────────────────────────────────
function BikeModal({ bike, onSave, onClose, imperial }) {
  const [form, setForm] = useState({ ...bike });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const { CdA, eta, tireMult } = bikePhysics(form);
  const displayWeight = imperial ? Math.round(form.weight * 2.205 * 10) / 10 : form.weight;
  const setWeight = (val) => set("weight", imperial ? Math.round(val / 2.205 * 10) / 10 : val);
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
          <input type="number" value={displayWeight} onChange={e => setWeight(Number(e.target.value))} style={{ width: "100%" }} />
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
    ...athlete,
  });
  const [cpOpen, setCpOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideVal, setOverrideVal] = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Live-derive W' from current form state
  const derivedWPrime = deriveWPrime(form);
  const cpResult = computeCP(form.cpTests);

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
      const stale = daysAgo !== null && daysAgo > 60;
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
    // Apply override if set
    if (overrideOpen && overrideVal !== "") {
      saved.wPrime = Math.round(Number(overrideVal) * 1000);
    } else {
      saved.wPrime = derivedWPrime;
    }
    // Stamp cpTestedAt if tests are valid and not previously stamped
    if (hasValidCpTests && !saved.cpTestedAt) saved.cpTestedAt = new Date().toISOString();
    onSave(saved);
    onClose();
  };

  const ph = RIDER_PHENOTYPES.find(p => p.id === form.phenotype);
  const displayWkJ = (overrideOpen && overrideVal !== "")
    ? (Math.round(Number(overrideVal) * 10) / 10)
    : (Math.round(derivedWPrime / 100) / 10);

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
          <input style={inputStyle} type="number" value={form.ftp} onChange={e => set("ftp", Number(e.target.value))} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Max HR (bpm)</label>
          <input style={inputStyle} type="number" value={form.maxHR || 185} onChange={e => set("maxHR", Number(e.target.value))} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Weight ({imperial ? "lb" : "kg"})</label>
          <input style={inputStyle} type="number"
            value={imperial ? Math.round(form.weight * 2.205 * 10) / 10 : form.weight}
            onChange={e => set("weight", imperial ? Math.round(Number(e.target.value) / 2.205 * 10) / 10 : Number(e.target.value))} />
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
  const [climbCategories, setClimbCategories] = useState({
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
  const { CdA, eta, tireMult } = bikePhysics(activeBike);

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
      const Crr = blendedCrr(surfaceMix, tireMult);
      const effWindMs = weatherContext.windSpeedMs * (weatherContext.windEff / 100);
      const mxPwr = maxPower !== "" ? Number(maxPower) : Infinity;
      let strat;
      if (pacingMode === "constant_if") {
        const flatIF = flatIFForTargetNP(
          targetIF, effectiveStats, athlete, Crr, mxPwr, CdA, eta,
          activeBike.weight, rhoActual, effWindMs, weatherContext.windDirDeg,
          climbCategories
        );
        strat = { mode: "constant_if", targetIF: flatIF };
      } else if (pacingMode === "segments") {
        strat = { mode: "segments", segments };
      } else {
        if (goalTimeMin > 0) {
          let lo = 0.30, hi = 1.15;
          for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            const testStrat = { mode: "constant_if", targetIF: mid };
            // No ceiling/categories in search loop — same reason as flatIFForTargetNP
            const testResult = buildPowerStream(effectiveStats, athlete, testStrat, Crr, Infinity, CdA, eta, activeBike.weight, rhoActual, effWindMs, weatherContext.windDirDeg, null);
            const testVI = computeVI(effectiveStats, surfaceMix, testResult.estimatedDurationMin);
            testVI.correctedDurationMin > goalTimeMin ? lo = mid : hi = mid;
          }
          strat = { mode: "constant_if", targetIF: Math.min(1.05, Math.max(0.30, (lo + hi) / 2)) };
        } else {
          strat = { mode: "constant_if", targetIF: 0.76 };
        }
      }
      const result = buildPowerStream(effectiveStats, athlete, strat, Crr, mxPwr, CdA, eta, activeBike.weight, rhoActual, effWindMs, weatherContext.windDirDeg, climbCategories);
      const viData = computeVI(effectiveStats, surfaceMix, result.estimatedDurationMin);
      setPacingPlan({ ...result, ...viData, resolvedNpIF: result.ifActual });
      setSaved(false);
    } catch(e) {
      alert("Plan computation error: " + e.message + "\n" + e.stack?.split('\n').slice(0,3).join('\n'));
    }
  };

  const overlayData = pacingPlan
    ? buildNutritionOverlay(pacingPlan.displayStream, intakeEvents, athlete, preRaceMeal) : [];
  const wbalData = pacingPlan ? buildWbal(pacingPlan.powerStream, athlete) : [];

  // Sensitivity analysis state — sliders adjust inputs, show Δ duration live
  const [sensOpen, setSensOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sensPower,  setSensPower]  = useState(0);  // % adjustment to IF
  const [sensWeight, setSensWeight] = useState(0);  // lbs/kg delta
  const [sensCdA,    setSensCdA]    = useState(0);  // % adjustment to CdA
  const [sensCrr,    setSensCrr]    = useState(0);  // % adjustment to Crr

  const sensBaseDuration = pacingPlan?.estimatedDurationMin ?? 0;
  const sensAdjDuration = pacingPlan ? (() => {
    const Crr = blendedCrr(surfaceMix, tireMult) * (1 + sensCrr / 100);
    const adjCdA = CdA * (1 + sensCdA / 100);
    const adjIF = pacingPlan.ifActual * (1 + sensPower / 100);
    const weightDeltaKg = imperial ? sensWeight / 2.205 : sensWeight;
    const adjAthlete = { ...athlete, weight: Math.max(40, athlete.weight + weightDeltaKg) };
    const adjBase = estimateDuration(effectiveStats, athlete, pacingPlan.ifActual, blendedCrr(surfaceMix, tireMult), CdA, eta, activeBike.weight, rhoActual);
    const adjNew  = estimateDuration(effectiveStats, adjAthlete, adjIF, Crr, adjCdA, eta, activeBike.weight, rhoActual);
    return sensBaseDuration + (adjNew - adjBase);
  })() : 0;
  const sensDeltaMin = sensAdjDuration - sensBaseDuration;
  const sensAnyActive = sensPower !== 0 || sensWeight !== 0 || sensCdA !== 0 || sensCrr !== 0;

  const saveOrUpdateRace = async () => {
    const raceRecord = {
      name: planName,
      updatedAt: new Date().toISOString(),
      status: 'planned',
      athleteSnapshot: {
        id: athlete.id, name: athlete.name, ftp: athlete.ftp,
        weight: athlete.weight, wPrime: deriveWPrime(athlete), phenotype: athlete.phenotype,
      },
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
    setClimbCategories(race.plan.climbCategories ?? { moderate: { min: 0, max: 0 }, steep: { min: 0, max: 0 }, wall: { min: 0, max: 0 } });
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
  };

  const updateAthleteProfile = async () => {
    const snap = {
      id: currentAthlete.id, name: currentAthlete.name, ftp: currentAthlete.ftp,
      weight: currentAthlete.weight, wPrime: deriveWPrime(currentAthlete), phenotype: currentAthlete.phenotype,
    };
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
      const wPrime = deriveWPrime(athlete);
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
    const Crr = blendedCrr(surfaceMix, tireMult);
    const effWind = weatherContext.windSpeedMs * (weatherContext.windEff / 100);
    let lo = 0.30, hi = 1.15;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const strat = { mode: "constant_if", targetIF: mid };
      // No ceiling/categories in search loop — same reason as flatIFForTargetNP
      const r = buildPowerStream(effectiveStats, athlete, strat, Crr, Infinity, CdA, eta, activeBike.weight, rhoActual, effWind, weatherContext.windDirDeg, null);
      const vi = computeVI(effectiveStats, surfaceMix, r.estimatedDurationMin);
      vi.correctedDurationMin > goalTimeMin ? lo = mid : hi = mid;
    }
    const finalStrat = { mode: "constant_if", targetIF: (lo + hi) / 2 };
    const finalResult = buildPowerStream(effectiveStats, athlete, finalStrat, Crr, Infinity, CdA, eta, activeBike.weight, rhoActual, effWind, weatherContext.windDirDeg, null);
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
              const { CdA: bCdA, eta: bEta } = bikePhysics(b);
              return <option key={b.id} value={b.id}>{b.name} — CdA {bCdA} · η {bEta} · {imperial ? Math.round(b.weight * 2.205 * 10)/10 : b.weight}{imperial ? 'lb' : 'kg'}</option>;
            })}
          </select>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Surface Mix</label>
            {(() => {
              const total = surfaceMix.reduce((s, x) => s + x.pct, 0);
              const crr = blendedCrr(surfaceMix);
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

          const WattInput = ({ value, onChange, placeholder = "none" }) => (
            <div style={{ position: "relative", width: 72 }}>
              <input type="number" min={0} max={2000} step={5} value={value || ""}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
                style={{ width: "100%", paddingRight: 14, fontSize: 11 }} />
              {value > 0 && <span style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: T.textMuted, pointerEvents: "none" }}>w</span>}
            </div>
          );

          return (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
                Climb Strategy
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
                                  <td style={{ padding: "5px 8px", color: T.text, fontFamily: "Barlow Condensed" }}>{c.peakGrade}%</td>
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
            const wPrime = deriveWPrime(athlete);
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
          <ElevPowerChart displayStream={pacingPlan.displayStream} gpxStats={gpxStats} ftp={athlete.ftp} imperial={imperial} detectedClimbs={gpxStats ? detectClimbs(gpxStats) : []} durationMin={pacingPlan.correctedDurationMin} estimatedDurationMin={pacingPlan.estimatedDurationMin} />

          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6, marginTop: 14, fontFamily: "Barlow Condensed", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            W' Balance
          </div>
          <WbalChart wbalData={wbalData} athlete={athlete} gpxStats={gpxStats} imperial={imperial} durationMin={pacingPlan.correctedDurationMin} estimatedDurationMin={pacingPlan.estimatedDurationMin} />

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
                    hint: `${sensCrr >= 0 ? "+" : ""}${sensCrr}% → Crr ${(blendedCrr(surfaceMix, tireMult) * (1 + sensCrr/100)).toFixed(4)}` },
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
                      const tableStream = pacingPlan.displayStream ?? pacingPlan.powerStream;
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

  // When the selected race changes, auto-load stored FIT data if present.
  useEffect(() => {
    if (!selectedRaceId) { setFitSaved(false); return; }
    const race = races.find(r => r.id === Number(selectedRaceId));
    if (race?.fit) {
      setFitData(race.fit);
      setFitFile(race.fit.fileName ?? 'Saved FIT');
      setFitError(null);
      setFitSaved(true);
    } else {
      setFitData(null);
      setFitFile(null);
      setFitSaved(false);
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
      rawAvgPower:       fitData.rawAvgPower,
      rawNP:             fitData.rawNP,
      totalRecords:      fitData.totalRecords,
      movingPowerSeries: fitData.movingPowerSeries,
      movingDistSeries:  fitData.movingDistSeries,
      movingAltSeries:   fitData.movingAltSeries,
      movingHRSeries:    fitData.movingHRSeries,
      blockMap:          fitData.blockMap,
      firstGPS:          fitData.firstGPS,
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

  const handleFIT = (buffer, name) => {
    const result = parseFIT(buffer);
    if (result) { setFitData(result); setFitFile(name); setFitError(null); setFitSaved(false); }
    else setFitError("Could not parse FIT file. If you're using a Wahoo Bolt V1 or older device, power data may not be written to record messages — try exporting from TrainingPeaks or use a Garmin device. Other formats: ensure the file is a valid .fit activity file, not a course or workout file.");
  };

  const fitPowerStream = fitData ? buildPowerStreamFromFIT(fitData, athlete) : [];
  const fitOverlay = fitPowerStream.length
    ? buildNutritionOverlay(fitPowerStream, actualIntake, athlete, 120) : [];

  // Terrain analysis — GPX if plan loaded, FIT altitude fallback otherwise
  const terrainBuckets = fitData?.movingPowerSeries?.length
    ? bucketByTerrain(
        fitData.movingPowerSeries,
        fitData.movingAltSeries,
        fitData.movingDistSeries,
        fitData.movingHRSeries,
        selectedPlan?.route ?? null,
        athlete.ftp,
        fitData.firstGPS ?? null
      )
    : null;
  const actualMetrics = fitPowerStream.length ? (() => {
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

  // Per-climb pacing stats — requires GPX (for climb detection) + FIT
  const perClimbStats = (() => {
    const gpxStats = selectedPlan?.route ?? null;
    if (!gpxStats?.segmentGrades?.length || !fitData?.movingPowerSeries?.length) return [];
    const climbs = detectClimbs(gpxStats);
    if (!climbs.length) return [];
    // Re-use same gpxOffsetM logic as bucketByTerrain for coordinate alignment
    let gpxOffsetM = 0;
    if (gpxStats && fitData.firstGPS) {
      if (gpxStats._gpxPts) {
        const haversine = (lat1, lon1, lat2, lon2) => {
          const R = 6371000, toRad = Math.PI / 180;
          const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
          const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toRad)*Math.cos(lat2*toRad)*Math.sin(dLon/2)**2;
          return R * 2 * Math.asin(Math.sqrt(a));
        };
        const pts = gpxStats._gpxPts;
        let minD = Infinity, minIdx = 0;
        for (let i = 0; i < pts.length; i++) {
          const d = haversine(pts[i].lat, pts[i].lon, fitData.firstGPS.lat, fitData.firstGPS.lon);
          if (d < minD) { minD = d; minIdx = i; }
        }
        gpxOffsetM = minD < 2000 ? pts[minIdx].cumDistM : 0;
      } else {
        gpxOffsetM = fitData.firstGPS.dist ?? 0;
      }
    }
    return buildPerClimbStats(climbs, fitData.movingPowerSeries, fitData.movingDistSeries, actualWbalRaw, athlete.ftp, gpxOffsetM);
  })();

  // Execution score: IF delta — 0 delta = 100%, each 0.01 IF = 2 points off, capped 0–100.
  const execScore = selectedPlan && actualMetrics ? (() => {
    const plannedIF = selectedPlan.pacingPlan.ifActual;
    const actualIF  = actualMetrics.ifAct;
    const delta     = Math.abs(actualIF - plannedIF);
    return Math.max(0, Math.min(100, Math.round(100 - delta * 200)));
  })() : null;

  // Overlay chart data
  // Align actual (5-min FIT blocks) and planned (2-min displayStream blocks) by time.
  // Index-based alignment broke when plan moved to 1-min physics / 2-min display blocks.
  // Strategy: use fitPowerStream as the time axis (it's the actual ride), and for each
  // FIT block find the nearest planned displayStream block by time.
  const planDisplay = selectedPlan?.pacingPlan?.displayStream ?? null;
  const overlayChartData = fitPowerStream.length
    ? fitPowerStream.map(fitPt => {
        let plannedPower = undefined;
        if (planDisplay && planDisplay.length > 0) {
          // Find closest displayStream block by time
          const nearest = planDisplay.reduce((best, pt) =>
            Math.abs(pt.time - fitPt.time) < Math.abs(best.time - fitPt.time) ? pt : best
          );
          plannedPower = nearest.power;
        }
        return { ...fitPt, actualPower: fitPt.power, plannedPower };
      })
    : [];

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
        {fitData && (
          <div style={{ marginTop: 10, fontSize: 12, color: T.textMuted }}>
            {fitData.totalRecords.toLocaleString()} records · Moving: {minsToHHMM(fitData.movingMin)} · Elapsed: {minsToHHMM(fitData.elapsedMin)}
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

      {/* Planned vs Actual header */}
      {selectedPlan && actualMetrics && (
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

      {/* Standalone actual metrics — always shown when FIT is loaded (with or without a plan) */}
      {actualMetrics && !selectedPlan && (
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
            <ZoneComparisonBar actualStream={fitPowerStream} plannedStream={null} ftp={athlete.ftp} />
          </div>
        </div>
      )}

      {/* Power Analysis — actual as filled area (zone-colored stroke), planned as muted line.
           Gap between the two = delta at a glance. Standalone mode: area only, no planned line. */}
      {fitPowerStream.length > 0 && (() => {
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
                  <XAxis dataKey="time" tick={{ fill: T.textDim, fontSize: 10 }}
                    tickFormatter={v => `${Math.floor(v/60)}:${String(v%60).padStart(2,"0")}`} />
                  <YAxis domain={[yMin, yMax]} tick={{ fill: T.textDim, fontSize: 10 }}
                    width={40} tickFormatter={v => `${v}w`} />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    const ap = d?.actualPower || 0;
                    const pp = d?.plannedPower;
                    const pct = ap / athlete.ftp;
                    const zLabel = pct < 0.55 ? "Z1" : pct < 0.75 ? "Z2" : pct < 0.85 ? "Z3" : pct < 0.95 ? "Z4" : "Z5";
                    const delta = pp != null ? ap - pp : null;
                    return (
                      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "8px 12px", borderRadius: 4, fontSize: 12 }}>
                        <div style={{ color: T.textMuted, marginBottom: 4 }}>{minsToHHMM(d?.time || 0)}</div>
                        <div style={{ color: zoneColor(pct) }}>
                          Actual: <strong>{ap}w</strong>
                          <span style={{ fontSize: 10, color: T.textDim, marginLeft: 5 }}>{Math.round(pct*100)}% FTP · {zLabel}</span>
                        </div>
                        {pp != null && (
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
                  {/* Planned — thin muted line, no fill. Recedes behind actual. */}
                  {selectedPlan && (
                    <Line dataKey="plannedPower" name="Planned"
                      type="monotone"
                      stroke="rgba(0,212,255,0.35)" strokeWidth={1.5}
                      strokeDasharray="5 3"
                      dot={false}
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
                actualStream={fitPowerStream}
                plannedStream={selectedPlan?.pacingPlan?.powerStream ?? null}
                ftp={athlete.ftp}
              />
            </div>

            {/* Fade Analysis — only shown when a plan is selected */}
            {selectedPlan && (() => {
              // blockMins: minutes per block in the stream (1-min for powerStream, 5-min for fitPowerStream)
              // Rolling window = 30 seconds worth of blocks, minimum 1
              const npOfStream = (stream, blockMins) => {
                if (!stream || stream.length === 0) return 0;
                const window = Math.max(1, Math.ceil(0.5 / blockMins)); // 0.5 min = 30 sec
                const powers = stream.map(b => b.power);
                const rolling = powers.map((_, i, a) => {
                  const w = a.slice(Math.max(0, i - window + 1), i + 1);
                  return w.reduce((s, p) => s + p, 0) / w.length;
                });
                return Math.round(Math.pow(rolling.reduce((s, p) => s + p ** 4, 0) / rolling.length, 0.25));
              };

              const splitThirds = (stream) => {
                if (!stream || stream.length === 0) return [[], [], []];
                const maxTime = stream[stream.length - 1].time;
                const t1 = maxTime / 3, t2 = maxTime * 2 / 3;
                return [
                  stream.filter(pt => pt.time < t1),
                  stream.filter(pt => pt.time >= t1 && pt.time < t2),
                  stream.filter(pt => pt.time >= t2),
                ];
              };

              const actualThirds  = splitThirds(fitData.movingPowerSeries.map((p, i) => ({ power: p, time: i / 60 })));
              // Use powerStream (1-min blocks) for planned thirds — displayStream is 2-min averages
              // which pre-flatten variance and systematically deflate NP per third
              const plannedThirds = splitThirds(selectedPlan.pacingPlan.powerStream);
              const actualNPs  = actualThirds.map(t => npOfStream(t, 1/60));  // movingPowerSeries = 1-second (1/60 min)
              const plannedNPs = plannedThirds.map(t => npOfStream(t, 1));    // powerStream = 1-min blocks

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

      {/* ── EFFORT & FATIGUE ─────────────────────────────────────────── */}
      {fitPowerStream.length > 0 && fitPowerStream.some(b => b.hr > 0) && (() => {
        const maxHR    = athlete.maxHR || 185;
        const rawSeries = fitData?.movingPowerSeries ?? [];
        const n = rawSeries.length;

        // Split movingPowerSeries into thirds by index (= moving-time thirds)
        const third = Math.floor(n / 3);
        const rawThirds = [
          rawSeries.slice(0, third),
          rawSeries.slice(third, third * 2),
          rawSeries.slice(third * 2),
        ];

        // HR still comes from fitPowerStream blocks (HR only stored at block level)
        const fitMaxTime = fitPowerStream[fitPowerStream.length - 1]?.time ?? 0;
        const ft1 = fitMaxTime / 3, ft2 = fitMaxTime * 2 / 3;
        const hrT1 = fitPowerStream.filter(pt => pt.time < ft1);
        const hrT2 = fitPowerStream.filter(pt => pt.time >= ft1 && pt.time < ft2);
        const hrT3 = fitPowerStream.filter(pt => pt.time >= ft2);
        const hrThirdsBlocks = [hrT1, hrT2, hrT3];

        const avgHR  = arr => { const v = arr.map(b => b.hr).filter(h => h > 0); return v.length ? Math.round(v.reduce((s,h)=>s+h,0)/v.length) : 0; };
        const avgPwr = arr => arr.length ? Math.round(arr.filter(p => p > 0).reduce((s,p) => s + p, 0) / arr.filter(p => p > 0).length) : 0;

        const hrThirds  = hrThirdsBlocks.map(avgHR);
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
                const third = Math.floor(totalSecs / 3);
                const rawThirds = [
                  rawSeries.slice(0, third),
                  rawSeries.slice(third, third * 2),
                  rawSeries.slice(third * 2),
                ];
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

              // Split actual by moving seconds, planned by powerStream (1-min) block count
              // Using movingPowerSeries for actuals (1-second) and powerStream for planned (1-min)
              // — both give accurate NP; 5-min block averaging suppresses variance before NP calc
              const rawSeries = fitData?.movingPowerSeries ?? [];
              const fitN  = rawSeries.length;
              const planN = planPowerStream.length;
              const actualThirds = [
                rawSeries.slice(0, Math.floor(fitN / 3)).map(p => ({ power: p })),
                rawSeries.slice(Math.floor(fitN / 3), Math.floor(2 * fitN / 3)).map(p => ({ power: p })),
                rawSeries.slice(Math.floor(2 * fitN / 3)).map(p => ({ power: p })),
              ];
              const planThirds = [
                planPowerStream.slice(0, Math.floor(planN / 3)),
                planPowerStream.slice(Math.floor(planN / 3), Math.floor(2 * planN / 3)),
                planPowerStream.slice(Math.floor(2 * planN / 3)),
              ];

              // NP IF per third: 30-sec rolling average → 4th-power mean → divide by FTP.
              // Arithmetic mean of power/ftp (avgIF) is materially lower than NP IF on variable
              // terrain — at IF 0.76 NP, avg power IF would be ~0.61. Must use NP methodology.
              const npIF = (stream, blockSecs) => {
                if (!stream || stream.length === 0) return 0;
                const powers = stream.map(b => b.power);
                const windowBlocks = Math.max(1, Math.ceil(30 / blockSecs));
                const rolling = powers.map((_, i) => {
                  const w = powers.slice(Math.max(0, i - windowBlocks + 1), i + 1);
                  return w.reduce((s, p) => s + p, 0) / w.length;
                });
                const np = Math.pow(rolling.reduce((s, p) => s + Math.pow(p, 4), 0) / rolling.length, 0.25);
                return Math.round(np / athlete.ftp * 100) / 100;
              };

              const actualIFs  = actualThirds.map(t => npIF(t, 1));    // movingPowerSeries = 1-second
              const plannedIFs = planThirds.map(t => npIF(t, 60));     // powerStream = 1-min blocks
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

                  // Third boundaries in seconds
                  const totalSecs  = fitData.movingPowerSeries.length;
                  const t1EndSecs  = Math.floor(totalSecs / 3);
                  const t2EndSecs  = Math.floor(2 * totalSecs / 3);

                  const peakThird  = peakBurnTime <= t1EndSecs ? "T1 (first third)"
                    : peakBurnTime <= t2EndSecs ? "T2 (second third)"
                    : "T3 (final third)";
                  const minThird   = minWbalTime <= t1EndSecs ? "T1 (first third)"
                    : minWbalTime <= t2EndSecs ? "T2 (second third)"
                    : "T3 (final third)";

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
                    if (minWbalPct < 40 && peakBurnTime <= t1EndSecs) return {
                      text: `W' dropped to ${minWbalPct}% (${minKjFmt} kJ remaining from ${wPrimeKj} kJ). The largest burn occurred early — in ${peakThird} at ${peakTimeFmt}. Early match-burning is a common pattern in races with aggressive starts or punchy opening climbs. The body can recover W' at sub-threshold effort, but if power stayed elevated those early draws compound into late-race fatigue. Cross-reference with Threshold Exposure above.`,
                      color: "#FFB800"
                    };
                    if (minWbalPct < 40) return {
                      text: `W' dropped to ${minWbalPct}% — a draw of ${wDrawnPct}% of total anaerobic budget. The minimum occurred in ${minThird} at ${minTimeFmt}, with peak burn in ${peakThird}. At this depletion level you were working in borrowed territory. Check whether this timing aligns with a climb or surge in the power chart.`,
                      color: "#FFB800"
                    };
                    if (peakBurnTime <= t1EndSecs) return {
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
      {terrainBuckets && fitPowerStream.length > 0 && (() => {
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

            {/* ── Climb Pacing Table ── */}
            {perClimbStats.length > 0 && (() => {
              const hasPlan = !!(selectedPlan?.pacingPlan?.displayStream);
              const catDotColor = (cat) => {
                if (cat === "wall")   return T.red;
                if (cat === "steep")  return T.gold;
                return T.blue;
              };
              const plannedNPForClimb = (cs) => {
                if (!hasPlan) return null;
                const ds = selectedPlan.pacingPlan.displayStream;
                const totalPlanMin = ds[ds.length - 1]?.time ?? 1;
                const gpxStats = selectedPlan.route;
                const startFrac = cs.startDistKm / (gpxStats.totalDistKm || 1);
                const endFrac   = (cs.startDistKm + cs.lengthKm) / (gpxStats.totalDistKm || 1);
                const t1 = startFrac * totalPlanMin;
                const t2 = endFrac   * totalPlanMin;
                // displayStream blocks are 2-min wide. A short climb may fall entirely
                // between two block time points, so strict t1<=b.time<=t2 returns empty.
                // Expand window by one block width (2 min) each side to guarantee at least
                // one block is captured for any climb ≥ 1 min on the course.
                const BLOCK_MIN = 2;
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
                              <td style={{ padding: "6px 6px", color: T.textMuted, textAlign: "right" }}>{cs.peakGrade}%</td>
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
      {fitPowerStream.length > 0 && (
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

  const saveAthlete = (form) => {
    if (form.id) {
      setAthletes(prev => prev.map(a => a.id === form.id ? form : a));
    } else {
      setAthletes(prev => [...prev, { ...form, id: Date.now() }]);
    }
  };

  return (
    <div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="card-header" style={{ margin: 0 }}>Athlete Roster</div>
          <button className="btn-primary" onClick={() => { setEditing({ id: null, name: "", ftp: 289, weight: 86.2, wPrime: 20000, phenotype: "allrounder", cpTests: [{ secs: 0, watts: 0 }, { secs: 0, watts: 0 }, { secs: 0, watts: 0 }], cpTestedAt: null }); setShowModal(true); }}>+ Add</button>
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
                {" · W' "}{Math.round(deriveWPrime(a) / 100) / 10}kJ
                {a.phenotype && ` · ${RIDER_PHENOTYPES.find(p => p.id === a.phenotype)?.label || ""}`}
              </div>
            </div>
            {a.id === activeAthleteId && (
              <span style={{ fontSize: 11, fontFamily: "Barlow Condensed", fontWeight: 700, color: T.blue, letterSpacing: "0.08em" }}>ACTIVE</span>
            )}
            <button className="btn-secondary" onClick={e => { e.stopPropagation(); setEditing(a); setShowModal(true); }}>Edit</button>
          </div>
        ))}
      </div>
      {showModal && (
        <AthleteModal athlete={editing} onSave={saveAthlete} onClose={() => { setShowModal(false); setEditing(null); }} imperial={imperial} />
      )}
    </div>
  );
}

// ─── LIBRARY TAB ──────────────────────────────────────────────────────────────
// ─── BIKES TAB ────────────────────────────────────────────────────────────────
function BikesTab({ bikes, setBikes, activeBikeId, setActiveBikeId, imperial }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);

  const saveBike = (form) => {
    if (form.id) setBikes(prev => prev.map(b => b.id === form.id ? form : b));
    else setBikes(prev => [...prev, { ...form, id: Date.now() }]);
  };

  return (
    <div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="card-header" style={{ margin: 0 }}>Bike Garage</div>
          <button className="btn-primary" onClick={() => { setEditing({ id: null, name: "", weight: 8, positionId: "road_casual", drivetrainId: "road_std", tireId: "road_28_32" }); setShowModal(true); }}>+ Add</button>
        </div>
        {bikes.map(b => {
          const { CdA, eta, tireMult } = bikePhysics(b);
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
              <button className="btn-secondary" onClick={e => { e.stopPropagation(); setEditing(b); setShowModal(true); }}>Edit</button>
            </div>
          );
        })}
      </div>
      {showModal && <BikeModal bike={editing} onSave={saveBike} onClose={() => { setShowModal(false); setEditing(null); }} imperial={imperial} />}
    </div>
  );
}

function LibraryTab({ products, setProducts }) {
  const [form, setForm] = useState({ name: "", carbs: 0, sodium: 0 });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="card">
        <div className="card-header">Nutrition Products</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 80px 80px 80px", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input type="text" placeholder="Product name" value={form.name} onChange={e => set("name", e.target.value)} />
          <input type="number" placeholder="Carbs g" value={form.carbs || ""} onChange={e => set("carbs", Number(e.target.value))} />
          <input type="number" placeholder="Na mg" value={form.sodium || ""} onChange={e => set("sodium", Number(e.target.value))} />
          <button className="btn-primary" onClick={() => {
            if (!form.name) return;
            setProducts(prev => [...prev, { id: Date.now(), ...form }]);
            setForm({ name: "", carbs: 0, sodium: 0 });
          }}>Add</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 80px 80px 40px", gap: 0 }}>
          {[["Name", "2fr"], ["Carbs", ""], ["Na (mg)", ""], ["", ""]].map(([h]) => (
            <div key={h} style={{ padding: "6px 10px", fontSize: 10, fontFamily: "Barlow Condensed", fontWeight: 700, letterSpacing: "0.1em", color: T.textMuted, textTransform: "uppercase", borderBottom: `1px solid ${T.border}` }}>{h}</div>
          ))}
          {products.map(p => (
            <>
              <div key={`n${p.id}`} style={{ padding: "8px 10px", fontSize: 13, borderBottom: `1px solid ${T.border}` }}>{p.name}</div>
              <div key={`c${p.id}`} style={{ padding: "8px 10px", fontSize: 13, color: T.gold, fontFamily: "Barlow Condensed", borderBottom: `1px solid ${T.border}` }}>{p.carbs}g</div>
              <div key={`s${p.id}`} style={{ padding: "8px 10px", fontSize: 13, color: T.textMuted, fontFamily: "Barlow Condensed", borderBottom: `1px solid ${T.border}` }}>{p.sodium}</div>
              <div key={`x${p.id}`} style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}>
                <button onClick={() => setProducts(prev => prev.filter(x => x.id !== p.id))} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 14 }}>×</button>
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

        {/* Content */}
        <div style={{ maxWidth: 800, margin: "0 auto", padding: "20px 16px" }}>
          {tab === "MODEL"   && <PlanTab athlete={athlete} athletes={athletes} setActiveAthleteId={setActiveAthleteId} products={products} races={races} setRaces={setRaces} imperial={imperial} bikes={bikes} setBikes={setBikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} />}
          {tab === "ANALYZE" && <AnalyzeTab athlete={athlete} products={products} races={races} setRaces={setRaces} imperial={imperial} bikes={bikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} />}
          {tab === "PERFORM" && (
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
          )}
          {tab === "ATHLETES" && <AthletesTab athletes={athletes} setAthletes={setAthletes} activeAthleteId={activeAthleteId} setActiveAthleteId={setActiveAthleteId} imperial={imperial} bikes={bikes} setBikes={setBikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} />}
          {tab === "GEAR"    && <BikesTab bikes={bikes} setBikes={setBikes} activeBikeId={activeBikeId} setActiveBikeId={setActiveBikeId} imperial={imperial} />}
          {tab === "LIBRARY" && <LibraryTab products={products} setProducts={setProducts} />}
        </div>
      </div>
    </>
  );
}
