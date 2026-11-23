// Flights · Route safety: rate any airport pair for weather, turbulence, terrain, disasters and space weather along
// the great-circle route at the time the aircraft would pass, and predict the departure/arrival delay.
import { api } from "../core/api.js";
import { $, $$, esc, fmtNum, fmtIST, makeChart, PAL, gradeColor, riskColor, TYPE_ICON } from "../core/util.js";
import { loadAirports, findAirport, airportField, gcPoints } from "../core/airports.js";

const POPULAR = [
  ["DEL", "BOM", "India's busiest"], ["BOM", "BLR", ""], ["DEL", "BLR", ""], ["DEL", "CCU", ""], ["DEL", "HYD", ""],
  ["CCU", "GAU", "monsoon storms"], ["DEL", "IXL", "Himalaya, mountain airfield"], ["DEL", "SXR", "Kashmir valley"],
  ["MAA", "IXZ", "cyclone belt"], ["BOM", "GOI", "monsoon coast"], ["DEL", "DXB", "Gulf"], ["BOM", "LHR", "long haul"],
];
const FACTOR = { convection: "Thunderstorms en route", turbulence: "Clear-air turbulence", terrain: "High terrain", alerts: "Cyclones, ash, warnings",
  space_weather: "Space weather (Kp)", departure: "Departure airport", arrival: "Arrival airport" };

let map, layer, from, to, seq = 0, cur = null;

export async function init() {
  map = L.map("rmap", { zoomControl: false, worldCopyJump: true, minZoom: 2 }).setView([22, 80], 5);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri · weather Open-Meteo" }).addTo(map);
  map.createPane("labels"); map.getPane("labels").style.zIndex = 390; map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.7 }).addTo(map);
  layer = L.layerGroup().addTo(map);
  from = airportField($("#rt-from"), $("#rt-from-s"));
  to = airportField($("#rt-to"), $("#rt-to-s"));
  $("#rt-swap").onclick = () => {
    const a = findAirport(from.code()), b = findAirport(to.code());
    if (a && b) { from.set(b); to.set(a); }
  };
  $("#rt-form").addEventListener("submit", (e) => { e.preventDefault(); go(from.code(), to.code(), +$("#rt-dep").value); });
  $("#rt-pop").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-from]");
    if (li) go(li.dataset.from, li.dataset.to, +$("#rt-dep").value);
  });
  $("#rt-legend").innerHTML = `<div class="key-h">Route risk</div>${[["Low", 5], ["Minor", 25], ["Moderate", 45], ["High", 65], ["Severe", 85]].map(([l, v]) => `<div class="row"><span class="sw" style="background:${riskColor(v)}"></span>${l}</div>`).join("")}`;
  await loadAirports();
  $("#rt-pop").innerHTML = POPULAR.map(([a, b, note]) => {
    const A = findAirport(a), B = findAirport(b);
    return A && B ? `<li data-from="${A.icao}" data-to="${B.icao}"><b>${a} → ${b}</b><span>${esc(A.city)} – ${esc(B.city)}</span><i>${esc(note)}</i></li>` : "";
  }).join("");
}

export function show(params = {}) {
  setTimeout(() => map.invalidateSize(), 60);
  if (params.from && params.to) go(params.from, params.to, params.dep ? Math.max(0, Math.round((+params.dep * 1000 - Date.now()) / 3_600_000)) : +$("#rt-dep").value, true);
  else if (!cur) go("DEL", "BOM", 0, true);
}

async function go(a, b, depH = 0, fromHash = false) {
  await loadAirports();
  const A = findAirport(a), B = findAirport(b);
  if (!A || !B) { $("#rt-out").innerHTML = `<div class="empty-state"><h3>Route safety</h3><p class="serif">Pick two airports.</p><p>Type a city or a code (DEL, VIDP) in both boxes.</p></div>`; return; }
  from.set(A); to.set(B);
  [...$("#rt-dep").options].forEach(o => { o.selected = +o.value === depH; });
  if (!fromHash) history.replaceState(null, "", `#routes?from=${A.icao}&to=${B.icao}`);
  $$("#rt-pop li").forEach(li => li.classList.toggle("sel", li.dataset.from === A.icao && li.dataset.to === B.icao));
  const s = ++seq;
  $("#rt-out").innerHTML = `<div class="rt-loading"><div class="progress indet"><i></i></div><p>Sampling the weather every ~160 km along ${esc(A.iata || A.icao)} → ${esc(B.iata || B.icao)} at the time a flight would pass, and checking alerts, terrain and space weather…</p></div>`;
  drawPreview(A, B);
  const dep = depH ? Math.round(Date.now() / 1000 + depH * 3600) : "";
  try {
    const d = await api(`/api/flights/assess?from=${A.icao}&to=${B.icao}${dep ? "&dep=" + Math.floor(dep / 3600) * 3600 : ""}`, { ttl: 300_000 });
    if (s !== seq) return;
    cur = d;
    render(d);
    drawRoute(d);
  } catch (e) {
    if (s !== seq) return;
    $("#rt-out").innerHTML = `<div class="empty-state"><h3>Route safety</h3><p class="serif">Could not rate this route.</p><p>${esc(e.message)}</p></div>`;
  }
}

function drawPreview(A, B) {
  layer.clearLayers();
  const pts = gcPoints(A.lat, A.lon, B.lat, B.lon, 80);
  L.polyline(pts, { color: "#fff", weight: 2, opacity: 0.35, dashArray: "5 6" }).addTo(layer);
  map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 7 });
}

function drawRoute(d) {
  layer.clearLayers();
  const seg = d.segments;
  // continuous longitudes for routes that cross the antimeridian
  const lons = [];
  seg.forEach((p, i) => { let lo = p.lon; if (i) { while (lo - lons[i - 1] > 180) lo -= 360; while (lo - lons[i - 1] < -180) lo += 360; } lons.push(lo); });
  const all = [];
  for (let i = 0; i < seg.length - 1; i++) {
    const a = seg[i], b = seg[i + 1], risk = Math.max(a.risk, b.risk);
    const pts = gcPoints(a.lat, lons[i], b.lat, lons[i + 1], 8);
    all.push(...pts);
    L.polyline(pts, { color: "#111", weight: 9, opacity: 0.7, interactive: false }).addTo(layer);
    L.polyline(pts, { color: riskColor(risk * 100), weight: 5, opacity: 0.95 })
      .bindTooltip(segTip(a.risk >= b.risk ? a : b, d), { sticky: true }).addTo(layer);
  }
  for (const s of seg) {
    L.circleMarker([s.lat, lons[seg.indexOf(s)]], { radius: 3, color: "#111", weight: 1, fillColor: riskColor(s.risk * 100), fillOpacity: 1 })
      .bindTooltip(segTip(s, d), { sticky: true }).addTo(layer);
  }
  for (const [ap, w] of [[d.origin, d.weather.departure], [d.destination, d.weather.arrival]]) {
    const lo = ap === d.origin ? lons[0] : lons[lons.length - 1];
    L.circleMarker([ap.lat, lo], { radius: 7, color: "#fff", weight: 2, fillColor: gradeColor(d.safety.grade), fillOpacity: 1 })
      .bindTooltip(`<b>${esc(ap.iata || ap.icao)}</b> · ${esc(ap.city)}`, { permanent: true, direction: "top", offset: [0, -8], className: "ap-tip" })
      .bindPopup(`<b>${esc(ap.name)}</b><br>${wxLine(w)}`).addTo(layer);
  }
  for (const a of d.alerts) {
    L.circleMarker([a.lat, a.lon], { radius: 6 + a.severity * 2, color: "#ef6a5e", weight: 1.5, fillColor: "#ef6a5e", fillOpacity: 0.25 })
      .bindTooltip(`${TYPE_ICON[a.type] || ""} ${esc(a.title)}<br><span class="muted">${a.km} km from the route · ${esc(a.source)}</span>`).addTo(layer);
  }
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [50, 50], maxZoom: 7 });
}
function segTip(s, d) {
  const pct = (v) => Math.round(v * 100) + "%";
  return `<b>km ${fmtNum(s.km)}</b> · over here ${fmtIST(s.eta * 1000)}<br>
    Risk <b style="color:${riskColor(s.risk * 100)}">${pct(s.risk)}</b> · storms ${pct(s.conv)} · turbulence ${pct(s.turb)} · terrain ${pct(s.terr)}${s.alert ? " · alerts " + pct(s.alert) : ""}<br>
    <span class="muted">CAPE ${fmtNum(s.cape)} J/kg · jet ${s.jet_kt} kt (${s.wind_along_kt >= 0 ? "tailwind " + s.wind_along_kt : "headwind " + -s.wind_along_kt} kt) · ground ${fmtNum(s.terrain_m)} m</span>`;
}
const wxLine = (w) => `Visibility ${w.vis_m != null ? (w.vis_m >= 10000 ? "10+ km" : fmtNum(w.vis_m / 1000, 1) + " km") : "–"} · wind ${fmtNum(w.wind_kt)} kt gust ${fmtNum(w.gust_kt)}${w.crosswind_kt != null ? ` · crosswind ${fmtNum(w.crosswind_kt)} kt on rwy ${w.runway}` : ""}${w.temp_c != null ? ` · ${fmtNum(w.temp_c)} °C` : ""}`;

function wxCard(label, ap, w, t) {
  const vis = w.vis_m == null ? "–" : w.vis_m >= 10000 ? "10+" : fmtNum(w.vis_m / 1000, 1);
  return `<div class="wx-card">
    <div class="wx-h"><span class="muted small">${label} · ${fmtIST(t * 1000)}</span><b>${esc(ap.iata || ap.icao)} · ${esc(ap.city || "")}</b></div>
    <div class="wx-g">
      <div><b>${vis}</b><span>visibility km</span></div>
      <div><b>${fmtNum(w.wind_kt)}<small>/${fmtNum(w.gust_kt)}</small></b><span>wind / gust kt</span></div>
      <div><b>${w.crosswind_kt != null ? fmtNum(w.crosswind_kt) : "–"}</b><span>crosswind${w.runway ? " rwy " + w.runway : ""}</span></div>
      <div><b>${w.temp_c != null ? fmtNum(w.temp_c) + "°" : "–"}</b><span>temp °C</span></div>
      <div><b>${fmtNum(w.precip_mm, 1)}</b><span>rain mm/h</span></div>
      <div><b>${fmtNum(w.low_cloud)}%</b><span>low cloud</span></div>
    </div></div>`;
}

function render(d) {
  const s = d.safety, dl = d.delay, o = d.origin, t = d.destination;
  const fl = Math.round(d.typical_cruise_ft / 100);
  const hm = (m) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")} min`;
  const maxComp = Math.max(5, ...dl.components.map(c => Math.abs(c[1])));
  $("#rt-out").innerHTML = `
    <div class="rt-head">
      <p class="kicker" style="margin:0 0 6px">Route safety · departing ${fmtIST(d.dep_time * 1000)}</p>
      <div class="rt-pair"><b>${esc(o.iata || o.icao)}</b><svg viewBox="0 0 40 12" width="40" height="12" aria-hidden="true"><path d="M1 6h34m-5-4 5 4-5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><b>${esc(t.iata || t.icao)}</b></div>
      <p class="muted small" style="margin:4px 0 0">${esc(o.city)} to ${esc(t.city)} · ${fmtNum(d.distance_km)} km · about ${hm(d.typical_block_min)} gate to gate · cruise FL${fl}</p>
    </div>
    <div class="rt-verdict">
      <div class="grade-chip big" style="--gc:${gradeColor(s.grade)}"><b>${s.grade}</b><span>${s.score}/100</span></div>
      <div><div class="rt-label" style="color:${gradeColor(s.grade)}">${esc(s.label)}</div>
        <p class="small muted" style="margin:4px 0 0">Safety rating for this route at this time: the worst stretch counts most.</p></div>
    </div>
    <div class="bars">${Object.entries(s.factors).map(([k, v]) => `<div class="bar-row"><span>${FACTOR[k] || k}</span><div class="bar"><i style="width:${Math.max(2, v * 100)}%;background:${riskColor(v * 100)}"></i></div><b>${Math.round(v * 100)}</b></div>`).join("")}</div>
    <ul class="fl-notes">${s.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>

    <h3>Delay prediction</h3>
    <div class="stat-row three">
      <div class="stat"><div class="v">${dl.expected_min}<small> min</small></div><div class="l">expected delay</div></div>
      <div class="stat"><div class="v" style="color:${dl.on_time_pct >= 70 ? PAL.sage : dl.on_time_pct >= 45 ? PAL.amber : PAL.crimson}">${dl.on_time_pct}%</div><div class="l">on time (within 15 min)</div></div>
      <div class="stat"><div class="v">${(dl.p_cancel * 100).toFixed(dl.p_cancel < 0.01 ? 1 : 0)}%</div><div class="l">cancellation risk</div></div>
    </div>
    <div class="bars signed">${dl.components.map(([k, v]) => `<div class="bar-row"><span>${esc(k)}</span><div class="bar"><i style="width:${Math.abs(v) / maxComp * 50}%;${v >= 0 ? "left:50%;background:" + PAL.sand : "right:50%;background:" + PAL.sage}"></i></div><b>${v > 0 ? "+" : ""}${fmtNum(v, Math.abs(v) < 10 && v % 1 ? 1 : 0)}</b></div>`).join("")}</div>
    <p class="note">${dl.traffic.origin != null ? `Live traffic now: ${dl.traffic.origin} aircraft low near ${esc(o.iata || o.icao)}, ${dl.traffic.destination ?? "?"} near ${esc(t.iata || t.icao)}. ` : ""}Jet stream: ${dl.mean_tailwind_kt >= 0 ? "tailwind" : "headwind"} ${Math.abs(dl.mean_tailwind_kt)} kt on average at cruise.</p>

    <h3>Hazards along the route</h3>
    <div class="chart-box"><canvas id="rt-chart"></canvas></div>

    <h3>Airport weather</h3>
    <div class="wx-cards">${wxCard("Departure", o, d.weather.departure, d.dep_time)}${wxCard("Arrival", t, d.weather.arrival, d.arr_time_typical)}</div>
    ${d.alerts.length ? `<h3>Alerts near the route</h3><ul class="alert-list compact">${d.alerts.map(a => `<li class="sev-${a.severity}"><div class="t">${TYPE_ICON[a.type] || ""} ${esc(a.title)}</div><div class="m">${a.km} km from the route · ${esc(a.source)}</div></li>`).join("")}</ul>` : ""}
    <div class="fl-actions" style="margin-top:16px"><a class="btn ghost small" href="#flights?lat=${o.lat}&lon=${o.lon}&z=8">Live flights at ${esc(o.iata || o.icao)}</a><a class="btn ghost small" href="#flights?lat=${t.lat}&lon=${t.lon}&z=8">at ${esc(t.iata || t.icao)}</a></div>
    <details class="method"><summary>How this is calculated</summary>
      <p>${esc(d.method.summary)}</p><p>${esc(d.method.route)}</p>
      <ul>${d.method.hazards.map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join("")}</ul>
      <p>${esc(d.method.rating)}</p><p>${esc(d.method.delay)}</p>
    </details>`;
  const seg = d.segments;
  makeChart($("#rt-chart"), {
    type: "line",
    data: {
      labels: seg.map(x => x.km),
      datasets: [
        { label: "Overall risk", data: seg.map(x => x.risk * 100), borderColor: "#ececec", backgroundColor: "rgba(236,236,236,.08)", fill: true, borderWidth: 2, pointRadius: 2, tension: 0.3 },
        { label: "Storms", data: seg.map(x => x.conv * 100), borderColor: PAL.sand, borderWidth: 1.4, pointRadius: 0, tension: 0.3 },
        { label: "Turbulence", data: seg.map(x => x.turb * 100), borderColor: PAL.water, borderWidth: 1.4, pointRadius: 0, tension: 0.3 },
        { label: "Terrain", data: seg.map(x => x.terr * 100), borderColor: PAL.olive, borderWidth: 1.4, pointRadius: 0, tension: 0.3 },
        { label: "Alerts", data: seg.map(x => x.alert * 100), borderColor: PAL.crimson, borderWidth: 1.4, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: {
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (i) => `km ${fmtNum(+i[0].label)}`, label: (i) => `${i.dataset.label}: ${Math.round(i.parsed.y)}%` } } },
      scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } }, x: { title: { display: true, text: "distance from departure, km" }, ticks: { maxTicksLimit: 7 } } },
    },
  });
}
