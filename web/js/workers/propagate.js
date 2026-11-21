/* Propagation worker: holds SGP4 records for the whole catalogue.
   "kf" returns a keyframe at one time: inertial (TEME) position in km and velocity in km/s, Float32.
   The main thread interpolates between keyframes every frame, so objects glide instead of jumping. */
importScripts("../../vendor/satellite/satellite.min.js");

let recs = [];

function parse(tles) {
  const out = new Array(tles.length);
  for (let i = 0; i < tles.length; i++) {
    try { const r = satellite.twoline2satrec(tles[i][0], tles[i][1]); out[i] = r.error ? null : r; } catch { out[i] = null; }
    if (i % 2000 === 1999) self.postMessage({ type: "parse", done: i + 1, total: tles.length });
  }
  return out;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load" || msg.type === "add") {
    const parsed = parse(msg.tles);
    recs = msg.type === "load" ? parsed : recs.concat(parsed);
    self.postMessage({ type: "loaded", count: recs.length, added: parsed.length, bad: parsed.filter(r => !r).length });
  } else if (msg.type === "kf") {
    const date = new Date(msg.time);
    const n = recs.length;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      const j = i * 3;
      let pv = null;
      if (r) { try { pv = satellite.propagate(r, date); } catch { pv = null; } }
      if (pv && pv.position && pv.velocity && !Number.isNaN(pv.position.x)) {
        pos[j] = pv.position.x; pos[j + 1] = pv.position.y; pos[j + 2] = pv.position.z;
        vel[j] = pv.velocity.x; vel[j + 1] = pv.velocity.y; vel[j + 2] = pv.velocity.z;
      } else {
        pos[j] = pos[j + 1] = pos[j + 2] = NaN;
      }
    }
    self.postMessage({ type: "kf", time: msg.time, gen: msg.gen, n, pos, vel }, [pos.buffer, vel.buffer]);
  }
};
