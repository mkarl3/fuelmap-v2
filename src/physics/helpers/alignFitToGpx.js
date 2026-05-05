// Per-second GPS alignment between FIT recording and GPX route.
//
// Replaces the legacy single-point `gpxOffsetM` model (which assumed a
// constant offset between FIT-distance and GPX-distance and broke whenever
// the rider went off-route mid-ride). Per CC#8, this helper produces a
// per-second alignment that downstream code (per-climb stats, terrain
// bucketing, plan-vs-actual comparison) consumes to handle off-route
// segments correctly.
//
// Algorithm: for each FIT second, scan all GPX points and find the nearest
// by great-circle (haversine) distance. If the nearest is within
// OFF_ROUTE_THRESHOLD_M, mark the second as on-route at that GPX position;
// otherwise mark off-route.
//
// Performance: linear scan, O(N × M) where N = FIT seconds, M = GPX points.
// Typical: 10–15k FIT seconds × ~200–1000 GPX bucket points ≈ 2–15M haversines.
// Sub-second in modern JS — profile and add a spatial index (grid bucketing
// or kd-tree) if measured slow on real-world routes.

import { fitWarn } from './fitWarn.js';

const OFF_ROUTE_THRESHOLD_M = 50;
const EARTH_RADIUS_M = 6371000;
const RAD = Math.PI / 180;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD)
          * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Align a per-second FIT GPS path to a GPX route.
 *
 * @param {Array<{lat: number, lon: number, distM: number, timestamp?: number}>} fullGPSPath
 *   Per-second FIT GPS points. `lat`/`lon` in degrees, `distM` is cumulative
 *   FIT distance in meters at that second. `timestamp` is optional (passed
 *   through by parser, unused here).
 * @param {Array<{lat: number, lon: number, distM: number}>} gpxRoute
 *   GPX route points with cumulative distance from the route start in meters.
 * @returns {Array<{onRoute: boolean, gpxDistM: number | null, fitDistM: number}>}
 *   One entry per element of `fullGPSPath`. Length matches input length.
 *   `gpxDistM` is null when off-route. `fitDistM` is the input's cumulative
 *   FIT distance, passed through unchanged so downstream code can pair the
 *   alignment with FIT-based metrics without an extra index.
 *
 * Edge cases:
 *  - Empty fullGPSPath → []
 *  - Empty gpxRoute → every entry off-route (gpxDistM: null), fires fitWarn
 *  - FIT point with non-finite lat/lon → off-route for that second
 */
export function alignFitToGpx(fullGPSPath, gpxRoute) {
  if (!fullGPSPath || fullGPSPath.length === 0) return [];

  if (!gpxRoute || gpxRoute.length === 0) {
    fitWarn('gpx_route_empty',
      'alignFitToGpx called with no GPX points — every FIT second will be off-route',
      { fitPoints: fullGPSPath.length });
    return fullGPSPath.map(p => ({
      onRoute: false,
      gpxDistM: null,
      fitDistM: typeof p?.distM === 'number' ? p.distM : 0,
    }));
  }

  const out = new Array(fullGPSPath.length);

  for (let i = 0; i < fullGPSPath.length; i++) {
    const p = fullGPSPath[i];
    const fitDistM = typeof p?.distM === 'number' ? p.distM : 0;

    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      out[i] = { onRoute: false, gpxDistM: null, fitDistM };
      continue;
    }

    let bestD = Infinity;
    let bestDistM = null;
    for (let j = 0; j < gpxRoute.length; j++) {
      const g = gpxRoute[j];
      if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
      const d = haversineMeters(p.lat, p.lon, g.lat, g.lon);
      if (d < bestD) {
        bestD = d;
        bestDistM = typeof g.distM === 'number' ? g.distM : null;
      }
    }

    const onRoute = bestD <= OFF_ROUTE_THRESHOLD_M;
    out[i] = {
      onRoute,
      gpxDistM: onRoute ? bestDistM : null,
      fitDistM,
    };
  }
  return out;
}

/** Threshold at which a FIT second is classified as off-route. Exported
 *  for testing / display ("rider was off-route by 87 m" type narratives). */
export { OFF_ROUTE_THRESHOLD_M };

// ─── Sanity checks ───────────────────────────────────────────────────────
//
// Synthetic case — 3 FIT points, 2 on-route, 1 off-route:
//   const gpx = [
//     { lat: 44.95,  lon: -85.66, distM: 0 },
//     { lat: 44.951, lon: -85.66, distM: 111 },   // ~111m north
//     { lat: 44.952, lon: -85.66, distM: 222 },
//   ];
//   const fit = [
//     { lat: 44.9501, lon: -85.66,    distM: 10  }, // ~11m off lat 44.95 → on-route
//     { lat: 44.9519, lon: -85.66,    distM: 220 }, // ~10m off lat 44.952 → on-route
//     { lat: 44.95,   lon: -85.6700,  distM: 500 }, // see below — depends on 50m threshold
//     { lat: 44.96,   lon: -85.66,    distM: 999 }, // ~1.1km away → off-route
//   ];
//   alignFitToGpx(fit, gpx)
//   // → [
//   //     { onRoute: true,  gpxDistM: 0,    fitDistM: 10 },
//   //     { onRoute: true,  gpxDistM: 222,  fitDistM: 220 },
//   //     ...,
//   //     { onRoute: false, gpxDistM: null, fitDistM: 999 },
//   //   ]
//
// Empty FIT path:
//   alignFitToGpx([], [])              → []
//
// Empty GPX route (logs fitWarn, all off-route):
//   alignFitToGpx([{ lat: 44, lon: -85, distM: 0 }], [])
//   // → [{ onRoute: false, gpxDistM: null, fitDistM: 0 }]
//
// Non-finite lat (defensive):
//   alignFitToGpx([{ lat: NaN, lon: -85, distM: 0 }], gpx)
//   // → [{ onRoute: false, gpxDistM: null, fitDistM: 0 }]

export default alignFitToGpx;
