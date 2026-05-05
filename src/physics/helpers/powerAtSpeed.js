// Steady-state power required to maintain a given speed.
//
// Sums gravity, rolling resistance, and aero drag forces; multiplies by
// speed for power at wheel; divides by drivetrain efficiency for power at
// pedals. Returns watts.
//
// Stateless and time-agnostic — the caller decides what time resolution to
// invoke this at (per-second under CC#7, per-block in legacy code).
//
// See FuelMAP_Physics_Spec_v0_3 spec 2.1.

import { PHYSICS_CONSTANTS } from '../constants/physicsConstants.js';
import { DEFAULTS }          from '../constants/defaults.js';

/**
 * @param {number} v       riding speed in m/s (0–25 typical, up to ~35 on descents)
 * @param {number} grade   decimal grade (-0.30 to +0.30 typical; 0.05 = 5% climb)
 * @param {number} massKg  rider + bike + gear mass in kg (50–150 typical)
 * @param {number} [Crr]   rolling resistance coefficient (0.002–0.012 typical)
 * @param {number} [CdA]   aerodynamic drag area in m² (0.18–0.50 typical)
 * @param {number} [eta]   drivetrain efficiency (0.95–1.00 typical)
 * @param {number} [rho]   air density in kg/m³ (0.95–1.30 typical)
 * @param {number} [windMs] headwind component in m/s (-15 to +15 typical)
 * @returns {number}       watts at pedals (≥ 0; floored at 0)
 *
 * Edge cases:
 *  - v = 0 → returns 0
 *  - Steep descent where v is below freewheel speed → mathematically negative,
 *    floored at 0 (caller decides freewheel/coast policy upstream)
 *  - Strong tailwind with v + windMs < 0 → aero term remains positive (squared)
 */
export function powerAtSpeed(
  v, grade, massKg,
  Crr  = DEFAULTS.Crr,
  CdA  = DEFAULTS.bikePhysics.CdA,
  eta  = DEFAULTS.bikePhysics.eta,
  rho  = PHYSICS_CONSTANTS.rhoSeaLevelStandard,
  windMs = 0,
) {
  const g  = PHYSICS_CONSTANTS.g;
  const Fg = massKg * g * Math.sin(Math.atan(grade));
  const Fr = massKg * g * Math.cos(Math.atan(grade)) * Crr;
  const vAir = Math.max(0, v + windMs);
  const Fa = 0.5 * rho * CdA * vAir * vAir;
  return Math.max(0, (Fg + Fr + Fa) * v / eta);
}

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Flat ground, 75 kg, 10 m/s (~22 mph), default Crr/CdA/eta/rho:
//   powerAtSpeed(10, 0, 75)
//   // Fg=0, Fr=75*9.81*1*0.004 ≈ 2.94 N, Fa=0.5*1.225*0.32*100 = 19.6 N
//   // P = (2.94+19.6)*10/0.975 ≈ 231 W
//
// 5% climb, same speed, same mass:
//   powerAtSpeed(10, 0.05, 75)
//   // Fg = 75*9.81*sin(atan(0.05)) ≈ 36.7 N, total ~59 N
//   // P ≈ 605 W
//
// At rest:
//   powerAtSpeed(0, 0, 75)  → 0
//
// Steep descent (-10%, no pedaling needed):
//   powerAtSpeed(15, -0.10, 75)  → ~0 (gravity dominates; floored)

export default powerAtSpeed;
