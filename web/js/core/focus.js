// One shared "focus place". Pick a place once (search, alert or map click) and every workspace uses it:
// Ground shows its hazards, Space shows satellites passing over it, Signal shows NavIC quality there.
const KEY = "astra.focus";
const subs = new Set();
let focus = null;
try { focus = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { focus = null; }

export const getFocus = () => focus;
export const onFocus = (fn) => { subs.add(fn); return () => subs.delete(fn); };

export function setFocus(p) {
  if (!p || p.lat == null || p.lon == null || Number.isNaN(+p.lat) || Number.isNaN(+p.lon)) return;
  const next = { lat: +(+p.lat).toFixed(4), lon: +(+p.lon).toFixed(4), name: (p.name || "").trim() || `${(+p.lat).toFixed(2)}, ${(+p.lon).toFixed(2)}` };
  if (focus && focus.lat === next.lat && focus.lon === next.lon && focus.name === next.name) return;
  focus = next;
  try { sessionStorage.setItem(KEY, JSON.stringify(focus)); } catch {}
  subs.forEach(f => f(focus));
}

export function clearFocus() {
  focus = null;
  try { sessionStorage.removeItem(KEY); } catch {}
  subs.forEach(f => f(null));
}

export function focusQuery(p = focus) {
  if (!p) return "";
  return "?" + new URLSearchParams({ lat: p.lat, lon: p.lon, name: p.name || "" });
}
