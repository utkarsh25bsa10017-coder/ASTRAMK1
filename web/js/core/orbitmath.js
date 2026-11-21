// Orbit helpers on top of satellite.js (SGP4). Distances in km, angles in degrees unless noted.
const S = () => window.satellite;
const DEG = Math.PI / 180;
export const RE = 6378.137;

export function satrec(l1, l2) {
  try {
    const r = S().twoline2satrec(l1, l2);
    return r && !r.error ? r : null;
  } catch { return null; }
}

export function eciAt(rec, date) {
  const pv = S().propagate(rec, date);
  return pv && pv.position && !Number.isNaN(pv.position.x) ? pv : null;
}

export function ecfAt(rec, date, gmst = S().gstime(date)) {
  const pv = eciAt(rec, date);
  return pv ? S().eciToEcf(pv.position, gmst) : null;
}

export function geodeticAt(rec, date) {
  const pv = eciAt(rec, date);
  if (!pv) return null;
  const g = S().eciToGeodetic(pv.position, S().gstime(date));
  const v = pv.velocity;
  return { lat: g.latitude / DEG, lon: ((g.longitude / DEG + 540) % 360) - 180, alt: g.height,
           speed: Math.hypot(v.x, v.y, v.z) };
}

export function observer(latDeg, lonDeg, hKm = 0) {
  return { latitude: latDeg * DEG, longitude: lonDeg * DEG, height: hKm };
}

export function look(obs, ecf) {
  const la = S().ecfToLookAngles(obs, ecf);
  return { az: la.azimuth / DEG, el: la.elevation / DEG, range: la.rangeSat };
}

// Orbit summary from the SGP4 record
export function orbitInfo(rec) {
  const a = rec.a * RE; // semi-major axis km
  const periodMin = (2 * Math.PI) / rec.no;
  return {
    perigee: rec.altp * RE, apogee: rec.alta * RE, a, ecc: rec.ecco,
    incl: rec.inclo / DEG, periodMin,
    epoch: epochDate(rec),
    regime: periodMin > 1300 && periodMin < 1600 && rec.ecco < 0.05 ? "GEO/IGSO" : rec.alta * RE < 2000 ? "LEO" : rec.altp * RE > 2000 && rec.alta * RE < 35000 ? "MEO" : "HEO",
  };
}

export function epochDate(rec) {
  const yr = rec.epochyr < 57 ? 2000 + rec.epochyr : 1900 + rec.epochyr;
  return new Date(Date.UTC(yr, 0, 1) + (rec.epochdays - 1) * 86400000);
}

// Dilution of precision from a set of line-of-sight look angles
export function dop(looks) {
  const n = looks.length;
  if (n < 4) return null;
  // G rows: [-cos(el)sin(az), -cos(el)cos(az), -sin(el), 1]  (ENU)
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const { az, el } of looks) {
    const e = el * DEG, a = az * DEG;
    const g = [-Math.cos(e) * Math.sin(a), -Math.cos(e) * Math.cos(a), -Math.sin(e), 1];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) A[i][j] += g[i] * g[j];
  }
  const Q = inv4(A);
  if (!Q) return null;
  const pdop = Math.sqrt(Q[0][0] + Q[1][1] + Q[2][2]);
  return { gdop: Math.sqrt(pdop * pdop + Q[3][3]), pdop, hdop: Math.sqrt(Q[0][0] + Q[1][1]), vdop: Math.sqrt(Q[2][2]), n };
}

function inv4(m) {
  const a = m.map(r => r.slice());
  const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    [I[c], I[p]] = [I[p], I[c]];
    const d = a[c][c];
    for (let j = 0; j < 4; j++) { a[c][j] /= d; I[c][j] /= d; }
    for (let r = 0; r < 4; r++) if (r !== c) {
      const f = a[r][c];
      for (let j = 0; j < 4; j++) { a[r][j] -= f * a[c][j]; I[r][j] -= f * I[c][j]; }
    }
  }
  return I;
}

export function groundTrack(rec, start, hours = 24, stepMin = 10) {
  const pts = [];
  for (let m = 0; m <= hours * 60; m += stepMin) {
    const g = geodeticAt(rec, new Date(start.getTime() + m * 60000));
    if (g) pts.push(g);
  }
  return pts;
}

export const dopQuality = p => p == null ? ["No fix", "#ff4d6d"] : p < 2 ? ["Excellent", "#3ddc97"] : p < 4 ? ["Good", "#9be15d"] : p < 6 ? ["Moderate", "#ffc94d"] : p < 10 ? ["Poor", "#ff8a3d"] : ["Very poor", "#ff4d6d"];
