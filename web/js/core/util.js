export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtNum(n, d = 0) {
  if (n == null || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const f = Math.abs(s);
  const v = f < 60 ? [Math.round(f), "s"] : f < 3600 ? [Math.round(f / 60), "min"] : f < 86400 ? [Math.round(f / 3600), "h"] : [Math.round(f / 86400), "d"];
  return s >= 0 ? `${v[0]} ${v[1]} ago` : `in ${v[0]} ${v[1]}`;
}

export function fmtUTC(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

export const SEV_LABEL = ["Info / minor", "Moderate", "Severe", "Extreme / red"];
export const SEV_COLOR = ["#8b8b8b", "#e3b85a", "#ee8a4f", "#ef6a5e"];

// Brand palette for charts and canvas drawing (mirrors css/astra.css tokens)
export const PAL = {
  ink: "#212121", bone: "#ececec", bone2: "rgba(236,236,236,.68)", bone3: "rgba(236,236,236,.42)",
  rule: "rgba(255,255,255,.08)", sand: "#ee8a4f", sand2: "#f4a878", brass: "#e3b85a", brass2: "#e3b85a",
  sage: "#6cc59a", olive: "#b3c76e", amber: "#e3b85a", crimson: "#ef6a5e", water: "#82b1e0", saffron: "#ee8a4f",
};
export const riskColor = (score) => score >= 75 ? PAL.crimson : score >= 55 ? PAL.sand : score >= 35 ? PAL.amber : score >= 15 ? PAL.olive : PAL.sage;
export const gradeColor = (g) => ({ A: PAL.sage, B: PAL.olive, C: PAL.amber, D: PAL.sand, E: PAL.crimson })[g] || PAL.bone;
export function fmtIST(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " IST";
}
const TYPE_TAG = {
  cyclone: ["CYC", "#ff4dd2"], flood: ["FLD", "#4ea8ff"], rain: ["RAIN", "#63d2ff"], earthquake: ["EQ", "#c792ea"],
  tsunami: ["TSU", "#3ee9ff"], landslide: ["SLIDE", "#d4a373"], wildfire: ["FIRE", "#ff8a3d"], volcano: ["VOLC", "#ff4d6d"],
  drought: ["DRY", "#ffc94d"], heat: ["HEAT", "#ff8a3d"], wind: ["WIND", "#9be15d"], other: ["EVT", "#8d9bb5"],
};
// Small coloured type tags (no emoji, so they render on every system font)
export const TYPE_ICON = Object.fromEntries(Object.entries(TYPE_TAG).map(([k, [t, c]]) =>
  [k, `<span class="ty" style="--tc:${c}">${t}</span>`]));
export const SRC_LABEL = { sachet: "SACHET · NDMA", ncs: "NCS · MoES", gdacs: "GDACS", usgs: "USGS", eonet: "NASA EONET" };

// India + surrounding seas (rough box, kept for map framing)
export const INDIA_BOX = { s: 5, n: 38, w: 66, e: 99 };
export const inIndiaBox = (lat, lon) => lat >= INDIA_BOX.s && lat <= INDIA_BOX.n && lon >= INDIA_BOX.w && lon <= INDIA_BOX.e;

// Coarse outline of India (official boundary, ~0.3° accuracy) as [lon, lat]. A box also catches Kabul,
// Lahore, Kathmandu, Dhaka and western China, so "India only" filters use this instead.
const INDIA_POLY = [
  [68.1, 23.6], [68.7, 24.3], [70.6, 24.3], [71.1, 24.7], [70.3, 25.7], [70.1, 26.6], [70.7, 27.8], [71.9, 27.9],
  [73.0, 29.2], [73.6, 30.2], [74.5, 30.9], [74.6, 31.9], [74.6, 32.7], [73.7, 32.9], [73.4, 33.6], [73.6, 34.5],
  [72.6, 35.6], [73.5, 36.6], [74.8, 37.0], [75.9, 36.7], [77.0, 35.7], [78.0, 35.5], [79.5, 35.6], [80.3, 35.3],
  [79.3, 34.3], [79.5, 32.7], [78.8, 31.9], [79.0, 31.1], [80.2, 30.6], [80.9, 30.2], [80.1, 28.8], [81.5, 27.9],
  [83.3, 27.3], [84.6, 27.0], [85.9, 26.6], [87.1, 26.4], [88.1, 26.4], [88.0, 27.2], [88.2, 28.0], [88.9, 27.3],
  [89.8, 26.7], [92.1, 26.8], [91.6, 27.8], [92.5, 27.9], [94.0, 28.9], [95.4, 29.3], [96.2, 29.0], [97.4, 28.3],
  [96.6, 27.3], [95.2, 26.6], [94.6, 25.6], [94.3, 24.4], [93.5, 23.5], [93.2, 22.2], [92.7, 21.95], [92.3, 23.3],
  [91.8, 22.95], [91.15, 23.5], [91.15, 23.95], [91.4, 24.15], [92.2, 24.3], [92.4, 24.9], [91.0, 25.2], [89.9, 25.3], [89.85, 26.0],
  [89.0, 26.2], [88.5, 26.35], [88.2, 25.8], [88.5, 25.2], [88.1, 24.6], [88.7, 24.2], [88.6, 23.6], [88.9, 23.2],
  [88.9, 22.0], [89.1, 21.6], [88.0, 21.6], [86.9, 21.4], [86.5, 20.4], [85.2, 19.5], [84.1, 18.3], [82.3, 16.6],
  [81.2, 15.8], [80.3, 15.3], [80.1, 13.4], [80.3, 13.0], [79.8, 11.0], [79.3, 10.3], [78.2, 8.9], [77.5, 8.1],
  [76.6, 8.9], [76.0, 10.3], [75.4, 12.0], [74.6, 14.5], [73.4, 16.4], [72.8, 19.0], [72.6, 21.0], [70.8, 20.7],
  [69.0, 22.3],
];
const INDIA_ISLANDS = [[92.2, 6.5, 94.1, 14.0], [71.6, 8.0, 74.0, 12.4]];   // Andaman & Nicobar, Lakshadweep (w, s, e, n)
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// The coast runs from the Sundarbans (index of [89.1, 21.6]) round the peninsula back to Kutch.
const INDIA_COAST = [...INDIA_POLY.slice(INDIA_POLY.findIndex(([x, y]) => x === 89.1 && y === 21.6)), INDIA_POLY[0]];
function nearLine(x, y, line, deg) {   // within `deg` of a polyline (lon scaled by cos lat)
  const k = Math.cos(y * Math.PI / 180);
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0] * k, ay = line[i - 1][1], bx = line[i][0] * k, by = line[i][1], px = x * k;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    if (Math.hypot(px - ax - t * dx, y - ay - t * dy) < deg) return true;
  }
  return false;
}
/** On Indian land or its coastal waters (≈30 km). */
export function inIndia(lat, lon) {
  if (lat < 5 || lat > 38 || lon < 67 || lon > 98.5) return false;
  if (INDIA_ISLANDS.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n)) return true;
  return inPoly(lon, lat, INDIA_POLY) || nearLine(lon, lat, INDIA_COAST, 0.3);
}
/** Alert concerns India: SACHET is India-only; GDACS lists affected countries; everything else by location. */
export function alertInIndia(a) {
  if (a.source === "sachet") return true;
  if (a.source === "gdacs" && /\bIndia\b/i.test(a.country || "")) return true;
  return inIndia(a.lat, a.lon);
}

// Chart.js defaults matching the dark theme
export function chartDefaults() {
  if (!window.Chart) return;
  const C = window.Chart;
  C.defaults.color = "rgba(236,236,236,.5)";
  C.defaults.borderColor = "rgba(255,255,255,.07)";
  C.defaults.font.family = '"JetBrains Mono", ui-monospace, monospace';
  C.defaults.font.size = 10;
  C.defaults.plugins.tooltip.backgroundColor = "#2f2f2f";
  C.defaults.plugins.tooltip.borderColor = "rgba(255,255,255,.2)";
  C.defaults.plugins.tooltip.borderWidth = 1;
  C.defaults.plugins.tooltip.titleColor = "#ececec";
  C.defaults.plugins.tooltip.bodyColor = "rgba(236,236,236,.8)";
  C.defaults.plugins.tooltip.cornerRadius = 10;
  C.defaults.elements.bar.borderRadius = 3;
  C.defaults.plugins.legend.labels.boxWidth = 10;
  C.defaults.plugins.legend.labels.boxHeight = 10;
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation = { duration: 300 };
}

export function makeChart(canvas, config) {
  if (!window.Chart) {   // Chart.js is a deferred script; draw once it has run
    document.addEventListener("DOMContentLoaded", () => makeChart(canvas, config), { once: true });
    return null;
  }
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new window.Chart(canvas, config);
  return canvas._chart;
}
