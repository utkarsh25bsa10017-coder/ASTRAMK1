import { $, $$, chartDefaults } from "./core/util.js";
import { onProvenance, provenance } from "./core/api.js";

chartDefaults();

const modules = {
  overview: () => import("./views/overview.js"),
  disaster: () => import("./views/disaster.js"),
  orbital: () => import("./views/orbital.js"),
  navic: () => import("./views/navic.js"),
  gateway: () => import("./views/gateway.js"),
};
const loaded = {};

async function show(name) {
  if (!modules[name]) name = "overview";
  $$(".view").forEach(v => v.classList.toggle("active", v.dataset.view === name));
  $$(".tabs a").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  try {
    if (!loaded[name]) {
      const mod = await modules[name]();
      loaded[name] = mod;
      await mod.init?.();
    }
    loaded[name].show?.();
  } catch (e) {
    console.error(`[astra] view ${name} failed`, e);
  }
  // Leave other views' resources alone but tell them they're hidden
  Object.entries(loaded).forEach(([k, m]) => k !== name && m.hide?.());
}

window.addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1) || "overview");

// Clock
setInterval(() => { $("#utc-clock").textContent = new Date().toISOString().slice(11, 19) + " UTC"; }, 1000);

// Feed status pill: summarise provenance of everything fetched so far
onProvenance(() => {
  const vals = Object.values(provenance);
  const bad = vals.filter(v => v === "error" || v === "snapshot" || v === "stale").length;
  const pill = $("#feed-pill");
  pill.textContent = bad ? `${vals.length - bad}/${vals.length} feeds live` : `${vals.length} feeds live`;
  pill.className = "pill " + (bad ? "warn" : "ok");
  pill.title = Object.entries(provenance).map(([k, v]) => `${v.padEnd(8)} ${k}`).join("\n");
});
