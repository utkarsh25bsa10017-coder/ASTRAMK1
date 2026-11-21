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
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
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
export const SEV_COLOR = ["#4a5d80", "#ffc94d", "#ff8a3d", "#ff4d6d"];
const TYPE_TAG = {
  cyclone: ["CYC", "#ff4dd2"], flood: ["FLD", "#4ea8ff"], rain: ["RAIN", "#63d2ff"], earthquake: ["EQ", "#c792ea"],
  tsunami: ["TSU", "#3ee9ff"], landslide: ["SLIDE", "#d4a373"], wildfire: ["FIRE", "#ff8a3d"], volcano: ["VOLC", "#ff4d6d"],
  drought: ["DRY", "#ffc94d"], heat: ["HEAT", "#ff8a3d"], wind: ["WIND", "#9be15d"], other: ["EVT", "#8d9bb5"],
};
// Small coloured type tags (no emoji, so they render on every system font)
export const TYPE_ICON = Object.fromEntries(Object.entries(TYPE_TAG).map(([k, [t, c]]) =>
  [k, `<span class="ty" style="--tc:${c}">${t}</span>`]));
export const SRC_LABEL = { sachet: "SACHET · NDMA", gdacs: "GDACS", usgs: "USGS", eonet: "NASA EONET" };

// India + surrounding seas (rough box used for "India region" filters)
export const INDIA_BOX = { s: 5, n: 38, w: 66, e: 99 };
export const inIndiaBox = (lat, lon) => lat >= INDIA_BOX.s && lat <= INDIA_BOX.n && lon >= INDIA_BOX.w && lon <= INDIA_BOX.e;

// Chart.js defaults matching the dark theme
export function chartDefaults() {
  if (!window.Chart) return;
  const C = window.Chart;
  C.defaults.color = "#8d9bb5";
  C.defaults.borderColor = "rgba(141,155,181,.14)";
  C.defaults.font.family = getComputedStyle(document.body).fontFamily;
  C.defaults.font.size = 11;
  C.defaults.plugins.legend.labels.boxWidth = 10;
  C.defaults.plugins.legend.labels.boxHeight = 10;
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation = { duration: 300 };
}

export function makeChart(canvas, config) {
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new window.Chart(canvas, config);
  return canvas._chart;
}
