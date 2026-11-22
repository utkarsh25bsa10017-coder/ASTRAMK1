import { $, $$, chartDefaults } from "./core/util.js";
import { onProvenance, provenance } from "./core/api.js";

// Vendor scripts are deferred and this module is async, so it can run before Cesium/Leaflet/Chart.js exist.
// Every deferred script has executed by DOMContentLoaded. readyState turns "interactive" *before* deferred scripts
// run, so check the globals themselves; on "load" give up waiting (a vendor failed) and let the view report it.
const haveVendor = () => window.Cesium && window.L && window.Chart && window.satellite;
const vendorReady = new Promise(r => {
  if (haveVendor() || document.readyState === "complete") return r();
  document.addEventListener("DOMContentLoaded", () => haveVendor() && r(), { once: true });
  window.addEventListener("load", r, { once: true });
});
vendorReady.then(() => {
  chartDefaults();
  // Every Leaflet map: quarter-step zoom so wheel, trackpad pinch and touch pinch feel continuous
  if (window.L) L.Map.mergeOptions({ zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 110, wheelDebounceTime: 20, touchZoom: true, bounceAtZoomLimits: false });
});
const NEEDS_VENDOR = new Set(["safety", "disaster", "fleet", "orbital", "navic"]);   // the landing only needs Chart.js, later

// Three workspaces. Ground and Space are dropdowns; the button shows the page you are on.
const GROUP = { disaster: "ground", safety: "ground", orbital: "space", fleet: "space", navic: "signal" };
const PAGE = { disaster: "Disaster watch", safety: "Safety check", orbital: "Orbital safety", fleet: "Fleet readiness", navic: "NavIC link" };
function syncNav(name) {
  const g = GROUP[name];
  $$(".tabs .grp").forEach(el => {
    const on = el.dataset.grp === g;
    el.classList.toggle("active", on);
    el.querySelector(".grp-cur").textContent = on ? PAGE[name] : "";
  });
  $$(".tabs a[data-view]").forEach(a => {
    const on = a.dataset.view === name;
    a.classList.toggle("active", on);
    on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  });
  closeMenus();
}
function closeMenus(except) {
  $$(".tabs .grp.open").forEach(g => { if (g !== except) { g.classList.remove("open"); g.querySelector(".grp-b").setAttribute("aria-expanded", "false"); } });
}
$(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button.grp-b");
  if (!b) return;
  const g = b.parentElement, open = !g.classList.contains("open");
  closeMenus(g);
  g.classList.toggle("open", open);
  b.setAttribute("aria-expanded", String(open));
  if (open) g.querySelector(".grp-menu a.active, .grp-menu a")?.focus({ preventScroll: true });
});
document.addEventListener("click", (e) => { if (!e.target.closest(".tabs .grp")) closeMenus(); });
document.addEventListener("keydown", (e) => {
  const g = e.target.closest?.(".tabs .grp.open");
  if (e.key === "Escape") { const o = $(".tabs .grp.open"); closeMenus(); o?.querySelector(".grp-b").focus(); }
  if (g && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    const items = [...g.querySelectorAll(".grp-menu a")], i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    e.preventDefault();
  }
});

const modules = {
  overview: () => import("./views/overview.js"),
  safety: () => import("./views/safety.js"),
  disaster: () => import("./views/disaster.js"),
  fleet: () => import("./views/fleet.js"),
  orbital: () => import("./views/orbital.js"),
  navic: () => import("./views/navic.js"),
  gateway: () => import("./views/gateway.js"),
};
const loaded = {};

function parseHash() {
  const [name, query = ""] = location.hash.slice(1).split("?");
  return { name: name || "overview", params: Object.fromEntries(new URLSearchParams(query)) };
}

async function show(name, params = {}) {
  if (!modules[name]) name = "overview";
  $$(".view").forEach(v => v.classList.toggle("active", v.dataset.view === name));
  syncNav(name);
  try {
    if (NEEDS_VENDOR.has(name)) await vendorReady;
    if (!loaded[name]) {
      const mod = await modules[name]();
      loaded[name] = mod;
      await mod.init?.();
    }
    loaded[name].show?.(params);
  } catch (e) {
    console.error(`[astra] view ${name} failed`, e);
  }
  // Leave other views' resources alone but tell them they're hidden
  Object.entries(loaded).forEach(([k, m]) => k !== name && m.hide?.());
}

window.addEventListener("hashchange", () => { const h = parseHash(); show(h.name, h.params); });
{ const h = parseHash(); show(h.name, h.params); }

// Guided demo
$("#tour-btn").addEventListener("click", async () => { (await import("./core/tour.js")).startTour(); });

// Clock
const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
setInterval(() => { $("#utc-clock").textContent = clockFmt.format(new Date()) + " IST"; }, 1000);

// Feed status pill: summarise provenance of everything fetched so far
onProvenance(() => {
  const vals = Object.values(provenance);
  const bad = vals.filter(v => v === "error" || v === "snapshot" || v === "stale").length;
  const pill = $("#feed-pill");
  pill.textContent = bad ? `${vals.length - bad}/${vals.length} feeds` : `${vals.length} feeds live`;
  pill.className = "pill " + (bad ? "warn" : "ok");
  pill.title = Object.entries(provenance).map(([k, v]) => `${v.padEnd(8)} ${k}`).join("\n");
});

// Illustrations: SMIL motion ignores the CSS reduced-motion rule, so pause it explicitly
if (matchMedia("(prefers-reduced-motion: reduce)").matches) $$(".hero-art svg").forEach(s => s.pauseAnimations?.());
