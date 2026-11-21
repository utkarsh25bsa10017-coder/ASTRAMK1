// Data access for the ASTRA gateway. Tracks provenance (live/cache/stale/snapshot) per endpoint.
const inflight = new Map();
const memo = new Map();
export const provenance = {};
const listeners = new Set();

export function onProvenance(fn) { listeners.add(fn); }

export async function api(path, { ttl = 60_000, force = false } = {}) {
  const hit = memo.get(path);
  if (!force && hit && Date.now() - hit.t < ttl) return hit.data;
  if (inflight.has(path)) return inflight.get(path);
  const p = (async () => {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    const prov = res.headers.get("X-Astra-Provenance") || "live";
    let body;
    try { body = await res.json(); }
    catch { body = null; }
    if (res.ok && (body === null || typeof body !== "object")) {
      provenance[path] = "error";
      listeners.forEach(f => f(path, "error"));
      throw new Error("incomplete or unreadable response (network interrupted?)");
    }
    body = body || {};
    if (!res.ok) {
      provenance[path] = "error";
      listeners.forEach(f => f(path, "error"));
      throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    }
    provenance[path] = prov;
    listeners.forEach(f => f(path, prov));
    memo.set(path, { t: Date.now(), data: body });
    return body;
  })();
  inflight.set(path, p);
  try { return await p; } finally { inflight.delete(path); }
}

// Tiny pub/sub shared between modules (e.g. "send this alert to NavIC").
const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));
