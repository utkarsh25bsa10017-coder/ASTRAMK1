import { $, $$, chartDefaults } from "./core/util.js";
import { onProvenance, provenance } from "./core/api.js";

chartDefaults();

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
  $$(".tabs a").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  try {
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
