/* Propagation worker: holds SGP4 records for the whole catalogue and returns
   Earth-fixed positions (metres, Float32) for a requested time. Classic worker. */
importScripts("../../vendor/satellite/satellite.min.js");

let recs = [];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load" || msg.type === "add") {
    const parsed = msg.tles.map(([l1, l2]) => {
      try { const r = satellite.twoline2satrec(l1, l2); return r.error ? null : r; } catch { return null; }
    });
    recs = msg.type === "load" ? parsed : recs.concat(parsed);
    self.postMessage({ type: "loaded", count: recs.length, bad: parsed.filter(r => !r).length });
  } else if (msg.type === "propagate") {
    const date = new Date(msg.time);
    const gmst = satellite.gstime(date);
    const out = new Float32Array(recs.length * 3);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      let ok = false;
      if (r) {
        const pv = satellite.propagate(r, date);
        if (pv && pv.position && !Number.isNaN(pv.position.x)) {
          const f = satellite.eciToEcf(pv.position, gmst);
          out[i * 3] = f.x * 1000; out[i * 3 + 1] = f.y * 1000; out[i * 3 + 2] = f.z * 1000;
          ok = true;
        }
      }
      if (!ok) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = NaN;
    }
    self.postMessage({ type: "positions", time: msg.time, buf: out }, [out.buffer]);
  }
};
