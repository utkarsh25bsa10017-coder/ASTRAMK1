// Data access for the ASTRA gateway. Tracks provenance (live/cache/stale/snapshot) per endpoint.
const inflight = new Map();
const memo = new Map();
export const provenance = {};
const listeners = new Set();

export function onProvenance(fn) { listeners.add(fn); }

// Read a response body while reporting progress (0..1). The server sends X-Uncompressed-Length because the
// browser hands us decompressed bytes while Content-Length (if any) counts compressed ones.
async function readWithProgress(res, onProgress) {
  const total = +res.headers.get("X-Uncompressed-Length") || (!res.headers.get("Content-Encoding") && +res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  onProgress(1);
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function api(path, { ttl = 60_000, force = false, onProgress = null } = {}) {
  const hit = memo.get(path);
  if (!force && hit && Date.now() - hit.t < ttl) return hit.data;
  if (inflight.has(path)) return inflight.get(path);
  const p = (async () => {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    const prov = res.headers.get("X-Astra-Provenance") || "live";
    let body;
    try { body = onProgress && res.ok && res.body ? await readWithProgress(res, onProgress) : await res.json(); }
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
