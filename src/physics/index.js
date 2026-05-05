// Single import surface for the physics module.
// See ./README.md for module overview, structure, and usage.

// ── Constants ───────────────────────────────────────────────────────────
export { PHYSICS_CONSTANTS } from './constants/physicsConstants.js';
export { DEFAULTS }          from './constants/defaults.js';
export {
  POSITIONS,
  DRIVETRAINS,
  TIRE_MULTIPLIERS,
  SURFACES,
  COGGAN_ZONES,
  RIDER_PHENOTYPES,
  CLIMB_CATEGORIES,
} from './constants/referenceData.js';

// ── Helpers ─────────────────────────────────────────────────────────────
export { computeNP }                       from './helpers/computeNP.js';
export { computeBlockNP }                  from './helpers/computeBlockNP.js';
export { fitCPModel }                      from './helpers/fitCPModel.js';
export { simulateWbal }                    from './helpers/simulateWbal.js';
export { fitWarn,
         enableFitWarnBuffer,
         drainFitWarnBuffer }              from './helpers/fitWarn.js';
export { alignFitToGpx,
         OFF_ROUTE_THRESHOLD_M }           from './helpers/alignFitToGpx.js';
