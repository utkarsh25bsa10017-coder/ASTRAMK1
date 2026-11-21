// One-click guided demo: Cyclone Dana (Odisha, Oct 2024) as the running story.
import { api } from "./api.js";

const KENDRAPARA = { lat: 20.5017, lon: 86.4223, name: "Kendrapara" };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const click = async (sel, tries = 30) => { for (let i = 0; i < tries; i++) { const el = document.querySelector(sel); if (el) { el.click(); return true; } await wait(300); } return false; };

const STEPS = [
  { title: "The live picture", text: "Official alerts from NDMA SACHET and NCS, close approaches for Indian satellites and NavIC health, all from free public feeds, updated as you watch.",
    go: async () => { location.hash = "#overview"; } },
  { title: "Detect: live alerts on the map", text: "Every alert from IMD, CWC, state authorities, NCS, GDACS, USGS and NASA EONET, with its official warning area. Click any alert or any spot for local rain and river forecasts.",
    go: async () => { location.hash = "#disaster"; await wait(900); await click("#alert-list li[data-id]"); } },
  { title: "Assess: radar sees through the cyclone", text: "Cyclone Dana hit Odisha on 25 Oct 2024. Sentinel-1 radar before and after, with newly flooded land detected in orange. Drag the slider to compare.",
    go: async () => { location.hash = "#disaster"; await wait(600); await click("#btn-case"); } },
  { title: "Assess: how safe is Kendrapara?", text: "Terrain, 40 years of river flow, rain and soil moisture give a flood rating for the next 72 hours and for a heavy-monsoon storm. Earthquake exposure is shown separately.",
    go: async () => { location.hash = `#safety?lat=${KENDRAPARA.lat}&lon=${KENDRAPARA.lon}&name=${KENDRAPARA.name}`; } },
  { title: "Protect: who can help, and are they safe?", text: "Indian radar, optical, weather and relay satellites passing over Kendrapara in the next 24 hours, each checked against this week's close approaches with debris.",
    go: async () => { location.hash = `#fleet?lat=${KENDRAPARA.lat}&lon=${KENDRAPARA.lon}&name=${KENDRAPARA.name}`; } },
  { title: "Reach: a NavIC message where towers are down", text: "The alert is packed into a short frame and checked against the NavIC satellites above the area. The frame layout is our own demonstration design.",
    go: async () => { location.hash = "#navic"; await wait(1500); await click("#bc-send"); } },
  { title: "Protect the protectors", text: "An Indian satellite's closest predicted approach this week, shown on the 3D globe at the moment it happens. Public orbit data is good to about 1 km, so this is an early-warning screen.",
    go: async () => {
      try {
        const c = await api("/api/conjunctions", { ttl: 600_000 });
        const r = (c.india || []).filter(x => x.rangeKm < 5).sort((a, b) => a.rangeKm - b.rangeKm)[0];
        if (r) window.__astraPendingConj = { a: r.id1, b: r.id2, t: r.tca };
      } catch {}
      location.hash = "#orbital";
    } },
];

let box = null, idx = 0;

function render() {
  const s = STEPS[idx];
  box.innerHTML = `<div class="step">Guided demo · step ${idx + 1} of ${STEPS.length}</div>
    <h4>${s.title}</h4><p>${s.text}</p>
    <div class="row"><div class="dots">${STEPS.map((_, i) => `<i class="${i === idx ? "on" : ""}"></i>`).join("")}</div>
      <div style="display:flex;gap:6px">
        <button class="btn ghost small" data-a="exit">Exit</button>
        ${idx > 0 ? `<button class="btn ghost small" data-a="back">Back</button>` : ""}
        <button class="btn small" data-a="next">${idx === STEPS.length - 1 ? "Finish" : "Next →"}</button>
      </div></div>`;
}

async function go(i) {
  idx = Math.max(0, Math.min(STEPS.length - 1, i));
  render();
  try { await STEPS[idx].go(); } catch (e) { console.warn("tour step", e); }
}

export function startTour() {
  if (!box) {
    box = document.createElement("div");
    box.className = "tour";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Guided demo");
    document.body.appendChild(box);
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "exit" || (a === "next" && idx === STEPS.length - 1)) { box.remove(); box = null; return; }
      if (a === "next") go(idx + 1);
      if (a === "back") go(idx - 1);
    });
    document.addEventListener("keydown", (e) => {
      if (!box) return;
      if (e.key === "ArrowRight") go(idx + 1);
      if (e.key === "ArrowLeft") go(idx - 1);
      if (e.key === "Escape") { box.remove(); box = null; }
    });
  }
  go(0);
}
