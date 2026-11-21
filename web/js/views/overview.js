import { api } from "../core/api.js";
import { $, esc, fmtNum, timeAgo, makeChart, SEV_COLOR, TYPE_ICON, SRC_LABEL } from "../core/util.js";

const kpiDefs = [
  { id: "india", l: "Active Indian alerts", c: "var(--accent-warm)" },
  { id: "severe", l: "Severe / red events worldwide", c: "var(--danger)" },
  { id: "objects", l: "Objects in Earth orbit", c: "var(--accent)" },
  { id: "debris", l: "Tracked debris fragments", c: "var(--debris)" },
  { id: "close", l: "Approaches < 1 km (7 days)", c: "var(--orange)" },
  { id: "navic", l: "NavIC satellites healthy", c: "var(--navic)" },
];

function setKpi(id, v, s = "") {
  const el = document.querySelector(`.kpi[data-id="${id}"]`);
  if (!el) return;
  el.querySelector(".v").textContent = v;
  el.querySelector(".s").textContent = s;
}

export async function init() {
  $("#kpis").innerHTML = kpiDefs.map(k => `<div class="kpi" data-id="${k.id}" style="--kc:${k.c}"><div class="v">…</div><div class="l">${k.l}</div><div class="s"></div></div>`).join("");
  loadAlerts();
  loadConj();
  loadStats();
  loadSpaceWeather();
}

async function loadAlerts() {
  try {
    const d = await api("/api/alerts", { ttl: 120_000 });
    const al = d.alerts;
    const india = al.filter(a => a.source === "sachet");
    setKpi("india", fmtNum(india.length), `${india.filter(a => a.severity >= 2).length} severe or extreme · SACHET/NDMA`);
    const sev = al.filter(a => a.severity >= 2 && a.source !== "sachet");
    setKpi("severe", fmtNum(sev.length), "GDACS orange/red + strong earthquakes");
    const top = [...al].sort((a, b) => (b.severity - a.severity) || (new Date(b.time) - new Date(a.time))).slice(0, 8);
    $("#ov-alerts").innerHTML = top.map(a => `
      <li class="sev-${a.severity}" data-id="${esc(a.id)}">
        <div class="t">${TYPE_ICON[a.type] || "•"} ${esc(a.title)}</div>
        <div class="m"><span class="badge src-${a.source}">${SRC_LABEL[a.source]}</span><span>${esc(a.severityText || "")}</span><span>${esc(a.area || a.country || "")}</span><span>${timeAgo(a.time)}</span></div>
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

async function loadConj() {
  try {
    const c = await api("/api/conjunctions", { ttl: 600_000 });
    setKpi("close", fmtNum(c.under1km), `${fmtNum(c.under5km)} under 5 km · ${fmtNum(c.total)} screened pairs`);
    $("#ov-conj").innerHTML = `<thead><tr><th>Objects</th><th class="num">Miss</th><th class="num">Speed</th><th>When</th></tr></thead><tbody>` +
      c.closest.slice(0, 7).map(r => `<tr class="click" data-a="${r.id1}" data-b="${r.id2}" data-t="${r.tca}">
        <td>${esc(r.name1)} <span class="muted">×</span> ${esc(r.name2)}</td>
        <td class="num">${r.rangeKm < 1 ? fmtNum(r.rangeKm * 1000) + " m" : fmtNum(r.rangeKm, 2) + " km"}</td>
        <td class="num">${fmtNum(r.relSpeedKms, 1)} km/s</td><td class="small muted">${timeAgo(r.tca)}</td></tr>`).join("") + "</tbody>";
    $("#ov-conj").onclick = (e) => {
      const tr = e.target.closest("tr[data-a]");
      if (!tr) return;
      window.__astraPendingConj = { a: +tr.dataset.a, b: +tr.dataset.b, t: tr.dataset.t };
      location.hash = "#orbital";
    };
  } catch (e) {
    setKpi("close", "–", "CelesTrak unreachable right now");
    $("#ov-conj").innerHTML = `<tbody><tr><td class="skeleton">Conjunction data unavailable (${esc(e.message)}). It will appear once CelesTrak responds.</td></tr></tbody>`;
  }
}

async function loadStats() {
  try {
    const s = await api("/api/catalog/stats", { ttl: 3_600_000 });
    setKpi("objects", fmtNum(s.onOrbit), `${fmtNum(s.byType.PAY)} payloads · ${fmtNum(s.byType["R/B"])} rocket bodies`);
    setKpi("debris", fmtNum(s.byType.DEB), `${fmtNum(s.india.byType.DEB || 0)} Indian · biggest: ${s.fragmentations[0]?.name || ""}`);
    const nav = s.navic.filter(n => !n.decay);
    const ok = nav.filter(n => n.status === "+").length, part = nav.filter(n => n.status === "P").length;
    setKpi("navic", `${ok}+${part}`, `${ok} fully, ${part} partially operational of ${nav.length} in orbit`);
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
      data: { labels: rows.map(r => r.t.slice(5, 13).replace("T", " ")), datasets: [{ label: "Kp", data: rows.map(r => r.kp), backgroundColor: rows.map(r => r.kp >= 5 ? "#ff4d6d" : r.kp >= 4 ? "#ffc94d" : "#3ddc97"), borderRadius: 2 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 9, ticks: { stepSize: 3 } }, x: { ticks: { maxTicksLimit: 6 } } } },
    });
    const last = rows.at(-1);
    const f = sw.f107.at(-1);
    $("#ov-sw-note").textContent = `Kp ${last?.kp.toFixed(1)} (${last.kp >= 5 ? "geomagnetic storm: higher drag, faster orbital decay" : "quiet"}) · F10.7 solar flux ${f ? f.flux.toFixed(0) : "–"} sfu. Source: NOAA SWPC.`;
  } catch (e) {
    $("#ov-sw-note").textContent = "Space weather unavailable.";
  }
}

export function show() {}
