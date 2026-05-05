# Physics Module

This folder contains the shared physics helpers and constants for FuelMAP v2's
physics engine. It was created during Step 6 of the physics rebuild specified
in `FuelMAP_Physics_Spec_v0_3_FINAL.md`.

## Structure

- `constants/` — three categories per CC#5:
  - `physicsConstants.js` — universal physics (g, rho reference, troposphere parameters)
  - `defaults.js` — reference values when athlete/bike data is missing
    (default CdA, default Crr, climb cap default coefficients, descent floors, etc.)
  - `referenceData.js` — lookup tables (POSITIONS, DRIVETRAINS, TIRE_MULTIPLIERS,
    SURFACES, COGGAN_ZONES, RIDER_PHENOTYPES, CLIMB_CATEGORIES)
- `helpers/` — shared functions extracted from duplication in App.jsx:
  - `computeNP.js` — canonical 30-sec rolling NP on 1-second data (CC#1)
  - `computeBlockNP.js` — block-level NP approximation (will be retired under CC#7)
  - `fitCPModel.js` — 2-parameter CP fit returning `{cp, wPrime, r2}` (CC#2)
  - `simulateWbal.js` — Skiba W'bal core math (CC#3)
  - `fitWarn.js` — shared structured warning utility (CC#4)
  - `alignFitToGpx.js` — per-second GPS alignment (CC#8)
- `index.js` — single import surface

## Usage

Import from the index:

```js
import { computeNP, DEFAULTS, COGGAN_ZONES } from './physics';
// or
import { computeNP } from './physics/helpers/computeNP';
```

(No `@/physics` alias is configured in this project's `vite.config.js`.
Use a relative path.)

## Status

This module exists but is not yet wired into App.jsx. Subsequent Step 6
prompts migrate App.jsx call sites to use these helpers in place of inline
duplicated implementations. Until then:

- The 6 NP rolling-window sites in App.jsx still use their inline implementations.
- `computeCP` and `deriveWPrime` still duplicate the CP fit math.
- `buildWbal` and `buildWbalFromRawSeries` still duplicate the Skiba math.
- All numeric constants are still scattered throughout App.jsx.

The new helpers are byte-for-byte mathematically equivalent to the existing
inline versions. Migration is a refactor, not a behavior change. Where
behavior IS expected to change (canonical NP everywhere per CC#7, Skiba
helper consolidation per CC#3, COGGAN_ZONES boundary fix), those changes
are documented in the spec and validated in the migration prompts.

## Sanity checks

Each helper has commented sample inputs/outputs at the bottom of its file.
For Step 6 Prompt 1, these were validated by running them via `node` after
file creation. See the prompt's Section 7.2 results in the chat history.

## Conventions

- All exports are named (no default-only patterns) so `import { x } from '...'`
  works everywhere. Each helper also has a default export for convenience.
- Reference-data tables are `Object.freeze`'d. Don't mutate them.
- `fitWarn` is the single console-warning entry point. Don't `console.warn`
  directly from new physics code.
- Tier framework per CC#5 — pick the right home before adding a new constant:
  - Universal physics? → `physicsConstants.js`
  - Fallback when athlete/bike data is missing? → `defaults.js`
  - Catalog the user picks from? → `referenceData.js`
  - Function-specific tuning? → top of that function's file as a named const
