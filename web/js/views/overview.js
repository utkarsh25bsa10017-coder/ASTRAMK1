import { api } from "../core/api.js";
import { attachSearch, goSafety } from "../core/search.js";
import { mountEarthHero } from "../core/earth-hero.js";
import { $, esc, fmtNum, timeAgo, fmtIST, makeChart, PAL, TYPE_ICON, SRC_LABEL, inIndia } from "../core/util.js";

const kpiDefs = [
  { id: "india", l: "Official alerts in India", c: "var(--gold)" },
  { id: "quakes", l: "Earthquakes in India, 7 days", c: "var(--saffron)" },
  { id: "close", l: "Indian satellites with a close approach", c: "var(--red)" },
  { id: "objects", l: "Objects tracked in orbit", c: "var(--text)" },
  { id: "debris", l: "Debris fragments", c: "var(--saffron)" },
  { id: "navic", l: "NavIC satellites healthy", c: "var(--saffron)" },
];
const facts = {};

function setKpi(id, v, s = "") {
  const el = document.querySelector(`.kpi[data-id="${id}"]`);
  if (!el) return;
  el.querySelector(".v").textContent = v;
  el.querySelector(".s").textContent = s;
}

function renderLede() {
  const f = facts;
  const parts = [`As of <b>${fmtIST(new Date())}</b>:`];
  if (f.india != null) parts.push(`<b>${fmtNum(f.india)}</b> official alerts across India${f.severe ? `, <span class="hot">${fmtNum(f.severe)} severe or extreme</span>` : ""}.`);
  if (f.quakes != null) parts.push(`<b>${fmtNum(f.quakes)}</b> earthquakes recorded by NCS in the past week${f.maxQuake ? `, strongest <span class="hot">M${f.maxQuake.mag.toFixed(1)}</span> near ${esc(f.maxQuake.place.split(",").slice(-2).join(",").trim())}` : ""}.`);
  if (f.indiaClose != null) parts.push(`<b>${fmtNum(f.indiaClose)}</b> Indian satellites have a close approach this week.`);
  if (f.navicOk != null) parts.push(`<b>${f.navicOk}</b> NavIC satellites at full health.`);
  $("#ov-lede").innerHTML = parts.join(" ");
  renderStory();
}

// Live line on each story chapter
function renderStory() {
  const f = facts, set = (id, html) => { const el = document.getElementById(id); if (el && html) el.innerHTML = html; };
  if (f.india != null) set("st-1", `Right now: <b>${fmtNum(f.india)}</b> official alerts across India${f.severe ? `, <b>${fmtNum(f.severe)}</b> severe or extreme` : ""}${f.quakes != null ? `, and <b>${fmtNum(f.quakes)}</b> earthquakes in the past week` : ""}.`);
  if (f.objects != null) set("st-3", `<b>${fmtNum(f.objects)}</b> objects tracked in orbit, <b>${fmtNum(f.debris)}</b> of them debris${f.indiaClose != null ? `. <b>${fmtNum(f.indiaClose)}</b> Indian satellites have a close approach this week` : ""}.`);
  if (f.navicOk != null) set("st-4", `<b>${f.navicOk}</b> NavIC satellites at full health today.`);
}

// Chapter in the middle of the screen drives the Earth's framing and the progress dots
function initStory() {
  const view = $("#view-overview"), steps = [...view.querySelectorAll(".story .step")], dots = [...view.querySelectorAll("#story-dots i")];
  const activate = (i) => {
    steps.forEach((el, j) => el.classList.toggle("on", j === i));
    dots.forEach((d, j) => d.classList.toggle("on", j === i));
    hero?.setStory?.(i);
  };
  const io = new IntersectionObserver((es) => {
    es.forEach(e => { if (e.isIntersecting) activate(+e.target.dataset.step); });
  }, { root: view, rootMargin: "-45% 0px -45% 0px", threshold: 0 });
  steps.forEach(el => io.observe(el));
  activate(0);
  view.querySelector(".scroll-cue")?.addEventListener("click", (e) => {
    e.preventDefault();
    steps[1].scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

let hero = null;
export async function init() {
  try { hero = mountEarthHero(document.getElementById("hero-stage")); } catch (e) { console.warn("hero", e); }
  initStory();
  $("#kpis").innerHTML = kpiDefs.map(k => `<div class="kpi" data-id="${k.id}" style="--kc:${k.c}"><div class="v">–</div><div class="l">${k.l}</div><div class="s"></div></div>`).join("");
  const s = attachSearch($("#ov-search"), $("#ov-suggest"), goSafety);
  $("#ov-quick").addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) s.lookup(b.dataset.q); });
  loadAlerts();
  loadQuakes();
  loadConj();
  loadStats();
  loadSpaceWeather();
}

async function loadAlerts() {
  try {
    const d = await api("/api/alerts", { ttl: 120_000 });
    const al = d.alerts;
    const india = al.filter(a => a.source === "sachet");
    facts.india = india.length;
    facts.severe = india.filter(a => a.severity >= 2).length;
    setKpi("india", fmtNum(india.length), `${facts.severe} severe or extreme · IMD, CWC, SDMAs`);
    renderLede();
    const top = [...al].filter(a => a.source !== "eonet")
      .sort((a, b) => (b.severity - a.severity) || (new Date(b.time) - new Date(a.time))).slice(0, 7);
    $("#ov-alerts").innerHTML = top.map(a => `
      <li class="sev-${a.severity}" data-id="${esc(a.id)}">
        <div class="t">${TYPE_ICON[a.type] || ""}${esc(a.title)}</div>
        <div class="m"><span class="badge src-${a.source}">${SRC_LABEL[a.source] || a.source}</span><span>${esc(a.severityText || "")}</span><span>${esc(a.area || a.country || "")}</span><span>${timeAgo(a.time)}</span></div>
      </li>`).join("") || "<li class='skeleton'>No alerts right now.</li>";
    $("#ov-alerts").onclick = (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      window.__astraPendingAlert = li.dataset.id;
      location.hash = "#disaster";
    };
  } catch (e) {
    $("#ov-alerts").innerHTML = `<li class="skeleton">Alerts unavailable: ${esc(e.message)}</li>`;
  }
}

async function loadQuakes() {
  try {
    const d = await api("/api/earthquakes", { ttl: 300_000 });
    const week = Date.now() - 7 * 86400000;
    const recent = d.events.filter(e => inIndia(e.lat, e.lon) && new Date(e.time) >= week);
    const ncs = recent.filter(e => e.source === "ncs");
    facts.quakes = ncs.length || recent.length;
    facts.maxQuake = [...recent].sort((a, b) => b.mag - a.mag)[0];
    setKpi("quakes", fmtNum(facts.quakes), facts.maxQuake ? `strongest M${facts.maxQuake.mag.toFixed(1)} · NCS / EMSC / USGS` : "NCS bulletin");
    renderLede();
    const list = [...recent].sort((a, b) => (b.mag >= 4) - (a.mag >= 4) || new Date(b.time) - new Date(a.time)).slice(0, 8);
    $("#ov-quakes").innerHTML = list.map(e => `
      <li data-lat="${e.lat}" data-lon="${e.lon}" data-name="${esc(e.place)}">
        <span class="mg" style="color:${e.mag >= 5 ? PAL.crimson : e.mag >= 4 ? PAL.sand : PAL.bone}">${e.mag.toFixed(1)}</span>
        <span class="pl">${esc(e.place)}<span class="src">${e.source}</span><br><span class="muted small">depth ${fmtNum(e.depth)} km</span></span>
        <span class="tm">${timeAgo(e.time)}</span>
      </li>`).join("") || `<li class="skeleton">No earthquakes in India this week.</li>`;
    $("#ov-quakes").onclick = (e) => {
      const li = e.target.closest("li[data-lat]");
      if (li) goSafety({ lat: li.dataset.lat, lon: li.dataset.lon, name: li.dataset.name });
    };
  } catch (e) {
    $("#ov-quakes").innerHTML = `<li class="skeleton">Earthquake feeds unavailable: ${esc(e.message)}</li>`;
  }
}

async function loadConj() {
  try {
    const c = await api("/api/conjunctions", { ttl: 600_000 });
    setKpi("close", fmtNum(c.indiaSatsUnder5km ?? 0), "approach under 5 km this week (SOCRATES, same-launch pairs removed)");
    facts.indiaClose = c.indiaSatsUnder5km;
    renderLede();
    $("#ov-conj").innerHTML = `<thead><tr><th>Objects</th><th class="num">Miss</th><th class="num">Speed</th><th class="num">When</th></tr></thead><tbody>` +
      c.closest.slice(0, 8).map(r => `<tr class="click" data-a="${r.id1}" data-b="${r.id2}" data-t="${r.tca}">
        <td class="mono">${esc(r.name1)} <span class="muted">×</span> ${esc(r.name2)}</td>
        <td class="num" style="color:${r.rangeKm < 1 ? PAL.crimson : PAL.amber}">${r.rangeKm < 1 ? fmtNum(r.rangeKm * 1000) + " m" : fmtNum(r.rangeKm, 2) + " km"}</td>
        <td class="num">${fmtNum(r.relSpeedKms, 1)} km/s</td><td class="num muted">${timeAgo(r.tca)}</td></tr>`).join("") + "</tbody>";
    $("#ov-conj").onclick = (e) => {
      const tr = e.target.closest("tr[data-a]");
      if (!tr) return;
      window.__astraPendingConj = { a: +tr.dataset.a, b: +tr.dataset.b, t: tr.dataset.t };
      location.hash = "#orbital";
    };
  } catch (e) {
    setKpi("close", "…", "close-approach data still loading");
    $("#ov-conj").innerHTML = `<tbody><tr><td class="skeleton">Conjunction data will appear once CelesTrak responds (${esc(e.message)}).</td></tr></tbody>`;
  }
}

async function loadStats() {
  try {
    const s = await api("/api/catalog/stats", { ttl: 3_600_000 });
    facts.objects = s.onOrbit; facts.debris = s.byType.DEB;
    setKpi("objects", fmtNum(s.onOrbit), `${fmtNum(s.byType.PAY)} payloads · ${fmtNum(s.india.total)} Indian`);
    setKpi("debris", fmtNum(s.byType.DEB), `largest cloud: ${s.fragmentations[0]?.name || ""}`);
    const nav = s.navic.filter(n => !n.decay);
    const ok = nav.filter(n => n.status === "+").length, part = nav.filter(n => n.status === "P").length;
    facts.navicOk = ok;
    setKpi("navic", `${ok} + ${part}`, `fully + partially operational, of ${nav.length}`);
    renderLede();
    const cls = { "+": "op", P: "part", "-": "off", D: "off" };
    const lbl = { "+": "Operational", P: "Partial", "-": "Failed", D: "Re-entered" };
    $("#ov-navic").innerHTML = s.navic.map(n => `<div class="nc"><b>${esc(n.name.replace(/ \(IRNSS-1\w\)/, "").replace(" & PSLV R/B", ""))}</b><span class="st ${cls[n.status] || "off"}">${lbl[n.status] || n.status}</span></div>`).join("");
  } catch (e) {
    $("#ov-navic").innerHTML = `<span class="muted">Catalogue unavailable: ${esc(e.message)}</span>`;
  }
}

async function loadSpaceWeather() {
  try {
    const sw = await api("/api/spaceweather", { ttl: 600_000 });
    const rows = sw.kp.slice(-24);
    makeChart($("#ov-kp"), {
      type: "bar",
      data: { labels: rows.map(r => r.t.slice(5, 13).replace("T", " ")), datasets: [{ label: "Kp", data: rows.map(r => r.kp), backgroundColor: rows.map(r => r.kp >= 5 ? PAL.crimson : r.kp >= 4 ? PAL.amber : PAL.brass), barPercentage: 0.7 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 9, ticks: { stepSize: 3 } }, x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } } } },
    });
    const last = rows.at(-1);
    const f = sw.f107.at(-1);
    $("#ov-sw-note").textContent = `Kp ${last?.kp.toFixed(1)}: ${last.kp >= 5 ? "geomagnetic storm, raising drag and orbital decay" : "quiet geomagnetic conditions"}. F10.7 solar flux ${f ? f.flux.toFixed(0) : "–"} sfu. NOAA SWPC.`;
  } catch (e) {
    $("#ov-sw-note").textContent = "Space weather unavailable.";
  }
}

export function show() { renderLede(); hero?.start?.(); }
export function hide() { hero?.stop?.(); }
