/* Conjunction screening worker.
   For one target object, finds close approaches with every other catalogued object
   over a time window using SGP4: altitude-band prefilter -> coarse sampling ->
   golden-section refinement of each local minimum. Classic worker. */
importScripts("../../vendor/satellite/satellite.min.js");

const RE = 6378.137;
let recs = [];

function pos(rec, t) {
  const pv = satellite.propagate(rec, new Date(t));
  return pv && pv.position && !Number.isNaN(pv.position.x) ? pv : null;
}

function dist(a, b, t) {
  const pa = pos(a, t), pb = pos(b, t);
  if (!pa || !pb) return Infinity;
  return Math.hypot(pa.position.x - pb.position.x, pa.position.y - pb.position.y, pa.position.z - pb.position.z);
}

function refine(a, b, t0, t1) {
  const g = 0.6180339887;
  let x1 = t1 - g * (t1 - t0), x2 = t0 + g * (t1 - t0);
  let f1 = dist(a, b, x1), f2 = dist(a, b, x2);
  for (let i = 0; i < 28; i++) {
    if (f1 < f2) { t1 = x2; x2 = x1; f2 = f1; x1 = t1 - g * (t1 - t0); f1 = dist(a, b, x1); }
    else { t0 = x1; x1 = x2; f1 = f2; x2 = t0 + g * (t1 - t0); f2 = dist(a, b, x2); }
  }
  const t = (t0 + t1) / 2;
  const pa = pos(a, t), pb = pos(b, t);
  if (!pa || !pb) return null;
  const dv = Math.hypot(pa.velocity.x - pb.velocity.x, pa.velocity.y - pb.velocity.y, pa.velocity.z - pb.velocity.z);
  return { t, d: dist(a, b, t), v: dv };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "load") {
    recs = m.tles.map(([l1, l2]) => { try { const r = satellite.twoline2satrec(l1, l2); return r.error ? null : r; } catch { return null; } });
    self.postMessage({ type: "loaded" });
    return;
  }
  if (m.type !== "screen") return;
  const { target, start, hours = 24, stepSec = 60, reportKm = 25, bandKm = 30 } = m;
  const tr = recs[target];
  if (!tr) { self.postMessage({ type: "done", results: [], candidates: 0, error: "target has no valid orbit" }); return; }
  const tp = tr.altp * RE - bandKm, ta = tr.alta * RE + bandKm;
  const cand = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r || i === target) continue;
    if (r.alta * RE >= tp && r.altp * RE <= ta) cand.push(i);
  }
  const steps = Math.ceil((hours * 3600) / stepSec);
  const gate = 15 * stepSec * 0.5 + 50; // max relative speed ~15 km/s
  const prev2 = new Float64Array(cand.length).fill(Infinity);
  const prev1 = new Float64Array(cand.length).fill(Infinity);
  const hits = [];
  const t0 = start;
  let lastReport = 0;
  for (let s = 0; s <= steps; s++) {
    const t = t0 + s * stepSec * 1000;
    const p = pos(tr, t);
    for (let k = 0; k < cand.length; k++) {
      let d = Infinity;
      if (p) {
        const q = pos(recs[cand[k]], t);
        if (q) d = Math.hypot(p.position.x - q.position.x, p.position.y - q.position.y, p.position.z - q.position.z);
      }
      // local minimum at previous sample?
      if (prev1[k] < gate && prev1[k] <= prev2[k] && prev1[k] <= d && s >= 1) {
        const tc = t - stepSec * 1000;
        const r = refine(tr, recs[cand[k]], tc - stepSec * 1000, tc + stepSec * 1000);
        if (r && r.d < reportKm) hits.push({ idx: cand[k], tca: r.t, missKm: r.d, relKms: r.v });
      }
      prev2[k] = prev1[k];
      prev1[k] = d;
    }
    const pct = Math.round((s / steps) * 100);
    if (pct >= lastReport + 2) { lastReport = pct; self.postMessage({ type: "progress", pct, candidates: cand.length }); }
  }
  // keep the closest approach per object
  const best = new Map();
  for (const h of hits) if (!best.has(h.idx) || best.get(h.idx).missKm > h.missKm) best.set(h.idx, h);
  const results = [...best.values()].sort((a, b) => a.missKm - b.missKm).slice(0, 50);
  self.postMessage({ type: "done", results, candidates: cand.length, steps });
};
