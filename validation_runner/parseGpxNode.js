// Node-compatible port of App.jsx parseGPX. Identical algorithm; swaps the
// browser DOMParser for @xmldom/xmldom. Used only by validation_runner — does
// not modify the in-app implementation.

import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';

export function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  if (trkpts.length < 2) return null;

  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const pts = [];
  let totalDist = 0;
  for (let i = 0; i < trkpts.length; i++) {
    const pt = trkpts[i];
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleNode = pt.getElementsByTagName('ele')[0];
    const ele = parseFloat(eleNode?.textContent || 0);
    if (i > 0) {
      const prev = pts[pts.length - 1];
      totalDist += haversine(prev.lat, prev.lon, lat, lon);
    }
    pts.push({ lat, lon, ele, cumDistM: totalDist, distM: totalDist });
  }

  const smoothedEle = pts.map((_, i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(pts.length - 1, i + 2);
    let sum = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += pts[j].ele; n++; }
    return sum / n;
  });
  let elevGain = 0, elevLoss = 0;
  for (let i = 1; i < smoothedEle.length; i++) {
    const dEle = smoothedEle[i] - smoothedEle[i - 1];
    if (dEle > 0) elevGain += dEle;
    else elevLoss += Math.abs(dEle);
  }

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
    const clampedGrade = Math.max(-0.20, Math.min(0.20, grade));
    segmentGrades.push({ distM: bucketDistM, gradeDecimal: clampedGrade });
    elevProfile.push({ dist: Math.round(startM / 100) / 10, ele: Math.round(eleStart) });
  }

  const bearingBetween = (lat1, lon1, lat2, lon2) => {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1r = lat1 * Math.PI / 180, lat2r = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2r);
    const x = Math.cos(lat1r) * Math.sin(lat2r)
            - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };
  const samplePt = (distM) => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      pts[m].cumDistM <= distM ? lo = m : hi = m;
    }
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
    _gpxPts: pts,
  };
}

export function parseGpxFile(filePath) {
  const xml = readFileSync(filePath, 'utf8');
  return parseGPX(xml);
}
