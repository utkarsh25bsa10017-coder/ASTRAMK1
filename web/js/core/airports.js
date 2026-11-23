// Airport lookup shared by Live radar and Route safety (OurAirports snapshot served by /api/flights/airports).
import { api } from "./api.js";

let list = null, byCode = new Map(), loading = null;

export function loadAirports() {
  if (list) return Promise.resolve(list);
  if (loading) return loading;
  loading = api("/api/flights/airports", { ttl: 86_400_000 }).then(d => {
    list = d.airports.map(([icao, iata, name, city, country, lat, lon, elev, size, runways]) =>
      ({ icao, iata, name, city, country, lat, lon, elev, size, runways }));
    for (const a of list) {
      if (a.iata) byCode.set(a.iata.toUpperCase(), a);
      byCode.set(a.icao.toUpperCase(), a);
    }
    return list;
  }).finally(() => { loading = null; });
  return loading;
}

export const airportsLoaded = () => list || [];
export const findAirport = (code) => byCode.get(String(code || "").trim().toUpperCase()) || null;
export const apCode = (a) => (a && (a.iata || a.icao)) || "";

/** Best matches for a typed query: exact code first, then city/name prefix, Indian and large airports ahead. */
export function searchAirports(q, n = 8) {
  q = String(q || "").trim().toLowerCase();
  if (!q || !list) return [];
  const exact = byCode.get(q.toUpperCase());
  const scored = [];
  for (const a of list) {
    if (a === exact) continue;
    const city = (a.city || "").toLowerCase(), name = a.name.toLowerCase();
    let s = 0;
    if (city.startsWith(q)) s = 60;
    else if (name.startsWith(q)) s = 50;
    else if (city.includes(q) || name.includes(" " + q)) s = 30;
    else if (q.length >= 3 && name.includes(q)) s = 15;
    if (!s) continue;
    s += (a.size === "L" ? 12 : 0) + (a.country === "IN" ? 10 : 0) + (a.iata ? 4 : 0);
    scored.push([s, a]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  const out = scored.slice(0, n).map(x => x[1]);
  if (exact) out.unshift(exact);
  return out.slice(0, n);
}

/** Wire an <input> + <ul class="suggest"> pair; onPick(airport). Returns { set(airport) }. */
export function airportField(input, ul, onPick) {
  let items = [], idx = -1;
  const render = () => {
    ul.innerHTML = items.map((a, i) => `<li data-i="${i}" class="${i === idx ? "on" : ""}"><span class="nm">${a.iata || a.icao} · ${escH(a.city || a.name)}</span><span class="ad">${escH(a.name)}<br>${a.country}</span></li>`).join("");
  };
  const pick = (a) => { input.value = `${a.iata || a.icao} · ${a.city || a.name}`; input.dataset.code = a.icao; items = []; render(); onPick?.(a); };
  input.addEventListener("input", async () => {
    await loadAirports();
    delete input.dataset.code;
    items = searchAirports(input.value); idx = items.length ? 0 : -1; render();
  });
  input.addEventListener("keydown", (e) => {
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; render(); e.preventDefault(); }
    if (e.key === "Enter" && idx >= 0) { pick(items[idx]); e.preventDefault(); }
    if (e.key === "Escape") { items = []; render(); }
  });
  input.addEventListener("blur", () => setTimeout(() => { items = []; render(); }, 180));
  ul.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); pick(items[+li.dataset.i]); } });
  return {
    set(a) { if (a) { input.value = `${a.iata || a.icao} · ${a.city || a.name}`; input.dataset.code = a.icao; } },
    code() { return input.dataset.code || (findAirport(input.value.split("·")[0]) || {}).icao || input.value.trim().split(/\s/)[0]; },
  };
}
const escH = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Great-circle points (lat, lon) between two places, n segments, longitudes kept continuous for Leaflet. */
export function gcPoints(lat1, lon1, lat2, lon2, n = 64) {
  const R = Math.PI / 180, p1 = lat1 * R, l1 = lon1 * R, p2 = lat2 * R, l2 = lon2 * R;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return [[lat1, lon1], [lat2, lon2]];
  const out = [];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / R;
    if (prev != null) while (lon - prev > 180) lon -= 360;
    if (prev != null) while (lon - prev < -180) lon += 360;
    prev = lon;
    out.push([Math.atan2(z, Math.hypot(x, y)) / R, lon]);
  }
  return out;
}

export function havKm(lat1, lon1, lat2, lon2) {
  const R = Math.PI / 180, a = Math.sin((lat2 - lat1) * R / 2) ** 2 + Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.sin((lon2 - lon1) * R / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}
