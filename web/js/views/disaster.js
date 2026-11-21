import { api, emit } from "../core/api.js";
import { $, $$, esc, fmtNum, timeAgo, fmtUTC, toast, makeChart, SEV_COLOR, SEV_LABEL, TYPE_ICON, SRC_LABEL, inIndiaBox } from "../core/util.js";

let map, alertsLayer, focusLayer, caseLayers = [], cycLayer;
let alerts = [];
let selectedId = null;
const filt = { sources: new Set(["sachet", "gdacs", "usgs", "eonet"]), types: null, q: "", india: false };

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
export async function init() {
  map = L.map("dmap", { center: [21, 82], zoom: 5, worldCopyJump: true, preferCanvas: true, zoomControl: true });

  const bases = {
    "Dark": L.layerGroup([
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors" }),
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "overlayPane" }),
    ]),
    "Satellite (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "Imagery © Esri, Maxar" }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
  };
  bases["Dark"].addTo(map);

  const gibs = (layer, date, ext, lvl, opts = {}) => L.tileLayer(
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level${lvl}/{z}/{y}/{x}.${ext}`,
    { maxNativeZoom: lvl, maxZoom: 18, attribution: "NASA GIBS", ...opts });
  const bhuvan = (layer) => L.tileLayer.wms("https://bhuvan-ras2.nrsc.gov.in/mapcache", {
    layers: layer, format: "image/png", transparent: true, version: "1.1.1", crs: L.CRS.EPSG4326, opacity: 0.85, attribution: "Bhuvan / NRSC-ISRO" });
  const vedas = (layer, opacity = 0.8) => L.tileLayer.wms("https://vedas.sac.gov.in/geoserver/vedas/wms", {
    layers: layer, format: "image/png", transparent: true, version: "1.1.1", opacity, attribution: "VEDAS / SAC-ISRO" });

  alertsLayer = L.layerGroup().addTo(map);
  focusLayer = L.layerGroup().addTo(map);
  cycLayer = L.layerGroup().addTo(map);

  const overlays = {
    "<b>Live alerts</b>": alertsLayer,
    [`NASA VIIRS true colour (${yesterday})`]: gibs("VIIRS_NOAA20_CorrectedReflectance_TrueColor", yesterday, "jpg", 9),
    [`NASA MODIS Terra true colour (${twoDaysAgo})`]: gibs("MODIS_Terra_CorrectedReflectance_TrueColor", twoDaysAgo, "jpg", 9),
    [`NASA GPM IMERG rainfall (${yesterday})`]: gibs("IMERG_Precipitation_Rate", yesterday, "png", 6, { opacity: 0.75 }),
    "Bhuvan · Odisha floods 2021 (cumulative)": bhuvan("fld_cuml_2021_od"),
    "Bhuvan · Assam floods 2021 (cumulative)": bhuvan("fld_cuml_2021_as"),
    "Bhuvan · Bihar floods 2021 (Jun–Oct)": bhuvan("fld_cuml_2021_bh_jun_oct"),
    "Bhuvan · Cyclone Phailin floods, Odisha (Oct 2013)": bhuvan("or_151013_flood"),
    "Bhuvan · Cyclone Hudhud floods, AP (Oct 2014)": bhuvan("ap_121014_flood"),
    "Bhuvan · Kosi flood, Bihar (2008)": bhuvan("kosi_flood"),
    "Bhuvan · Uttarakhand floods (Jun 2013)": bhuvan("uk_180613_flood"),
    "VEDAS · Brahmaputra max inundation": vedas("Brahmputra_Max_Inundation"),
    "VEDAS · Shoreline 2004–06": vedas("INDIA_25KSHORELINE2004_06", 1),
    "VEDAS · High/low tide lines": vedas("INDIA_LINE25CZIS2006", 1),
    "VEDAS · Rivers & streams": vedas("INDIA_RIVERS_STREAMS", 0.9),
    "VEDAS · District boundaries": vedas("INDIA_DISTRICT_BOUNDARY", 0.7),
  };
  L.control.layers(bases, overlays, { collapsed: true, position: "topright" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  map.on("click", (e) => { if (!e.originalEvent._astraHandled) pointAnalysis(e.latlng.lat, e.latlng.lng); });

  $("#alert-search").addEventListener("input", (e) => { filt.q = e.target.value.toLowerCase(); renderList(); });
  $("#india-only").addEventListener("change", (e) => { filt.india = e.target.checked; renderList(); });
  $("#btn-case").addEventListener("click", openCasePicker);
  $("#btn-cyclones").addEventListener("click", openCyclonePicker);
  $("#swipe-range").addEventListener("input", updateSwipe);
  map.on("move zoom resize", updateSwipe);

  await loadAlerts();
}

export function show() {
  setTimeout(() => map.invalidateSize(), 50);
  if (window.__astraPendingAlert) {
    const id = window.__astraPendingAlert;
    window.__astraPendingAlert = null;
    const a = alerts.find(x => x.id === id);
    if (a) selectAlert(a, true);
  }
}

// ---------------------------------------------------------------------------
async function loadAlerts() {
  try {
    const d = await api("/api/alerts", { ttl: 120_000 });
    alerts = d.alerts.filter(a => a.lat != null && a.lon != null);
    const types = [...new Set(alerts.map(a => a.type))];
    filt.types = new Set(types);
    renderChips(d.sources);
    renderList();
    drawAlerts();
    show();
  } catch (e) {
    $("#alert-list").innerHTML = `<li class="skeleton">Could not load alerts: ${esc(e.message)}</li>`;
  }
}

function renderChips(sources) {
  const cnt = (k, v) => alerts.filter(a => a[k] === v).length;
  $("#src-chips").innerHTML = Object.keys(SRC_LABEL).map(s => {
    const st = sources?.[s];
    const ok = st?.status === "ok";
    return `<button class="chip ${filt.sources.has(s) ? "on" : ""}" data-src="${s}" title="${ok ? "provenance: " + st.provenance : "unavailable"}">${SRC_LABEL[s]}<span class="n">${cnt("source", s)}</span></button>`;
  }).join("");
  const types = [...filt.types].sort((a, b) => cnt("type", b) - cnt("type", a));
  $("#type-chips").innerHTML = types.map(t => `<button class="chip on" data-type="${t}">${t}<span class="n">${cnt("type", t)}</span></button>`).join("");
  $("#src-chips").onclick = (e) => {
    const b = e.target.closest("[data-src]"); if (!b) return;
    const s = b.dataset.src;
    filt.sources.has(s) ? filt.sources.delete(s) : filt.sources.add(s);
    b.classList.toggle("on"); renderList(); drawAlerts();
  };
  $("#type-chips").onclick = (e) => {
    const b = e.target.closest("[data-type]"); if (!b) return;
    const t = b.dataset.type;
    filt.types.has(t) ? filt.types.delete(t) : filt.types.add(t);
    b.classList.toggle("on"); renderList(); drawAlerts();
  };
}

function visibleAlerts() {
  return alerts.filter(a => filt.sources.has(a.source) && filt.types.has(a.type)
    && (!filt.india || inIndiaBox(a.lat, a.lon))
    && (!filt.q || `${a.title} ${a.area} ${a.agency} ${a.event} ${a.country}`.toLowerCase().includes(filt.q)));
}

function renderList() {
  const list = visibleAlerts().sort((a, b) => (b.severity - a.severity) || (new Date(b.time) - new Date(a.time)));
  $("#alert-count").textContent = `${list.length} of ${alerts.length}`;
  $("#alert-list").innerHTML = list.slice(0, 300).map(a => `
    <li class="sev-${a.severity} ${a.id === selectedId ? "sel" : ""}" data-id="${esc(a.id)}">
      <div class="t">${TYPE_ICON[a.type] || "•"} ${esc(a.title)}</div>
      <div class="m"><span class="badge src-${a.source}">${SRC_LABEL[a.source]}</span><span>${esc(a.severityText || "")}</span><span>${esc(a.agency || "")}</span><span>${timeAgo(a.time)}</span></div>
    </li>`).join("") || `<li class="skeleton">No alerts match these filters.</li>`;
  $("#alert-list").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) selectAlert(alerts.find(a => a.id === li.dataset.id), true);
  };
}

function drawAlerts() {
  alertsLayer.clearLayers();
  for (const a of visibleAlerts()) {
    const color = SEV_COLOR[a.severity];
    const radius = a.source === "usgs" ? Math.max(4, (a.mag - 3) * 3) : 4 + a.severity * 2;
    const m = L.circleMarker([a.lat, a.lon], { radius, color, weight: 1.5, fillColor: color, fillOpacity: 0.55 });
    m.bindTooltip(`${TYPE_ICON[a.type] || ""} ${esc(a.title)}<br><span style="opacity:.7">${SRC_LABEL[a.source]} · ${timeAgo(a.time)}</span>`, { direction: "top" });
    m.on("click", (e) => { e.originalEvent._astraHandled = true; selectAlert(a, false); });
    alertsLayer.addLayer(m);
  }
}

// ---------------------------------------------------------------------------
async function selectAlert(a, fly) {
  if (!a) return;
  selectedId = a.id;
  $$("#alert-list li").forEach(li => li.classList.toggle("sel", li.dataset.id === a.id));
  focusLayer.clearLayers();
  let bounds = null;
  if (a.rings?.length) {
    const poly = L.polygon(a.rings.map(r => r.map(([lo, la]) => [la, lo])), { color: SEV_COLOR[a.severity], weight: 2, fillOpacity: 0.18 });
    focusLayer.addLayer(poly);
    bounds = poly.getBounds();
  }
  focusLayer.addLayer(L.circleMarker([a.lat, a.lon], { radius: 10, color: "#fff", weight: 2, fill: false }));
  if (a.source === "gdacs" && a.gdacs) drawGdacsGeometry(a);
  if (fly) bounds ? map.flyToBounds(bounds.pad(0.4), { maxZoom: 9, duration: 0.8 }) : map.flyTo([a.lat, a.lon], Math.max(map.getZoom(), 6), { duration: 0.8 });

  const det = $("#detail");
  $("#detail-empty").hidden = true;
  det.hidden = false;
  det.innerHTML = `
    <span class="badge src-${a.source}">${SRC_LABEL[a.source]}</span>
    <span class="badge" style="color:${SEV_COLOR[a.severity]}">${SEV_LABEL[a.severity]}</span>
    <div class="detail-title">${TYPE_ICON[a.type] || ""} ${esc(a.title)}</div>
    <dl class="kv">
      ${a.event ? `<dt>Event</dt><dd>${esc(a.event)}</dd>` : ""}
      ${a.agency ? `<dt>Issued by</dt><dd>${esc(a.agency)}</dd>` : ""}
      ${a.area ? `<dt>Area</dt><dd>${esc(a.area)}</dd>` : ""}
      <dt>Time</dt><dd>${a.time ? fmtUTC(a.time) : "–"} (${timeAgo(a.time)})</dd>
      ${a.expires ? `<dt>Expires</dt><dd>${fmtUTC(a.expires)}</dd>` : ""}
      ${a.urgency ? `<dt>Urgency</dt><dd>${esc(a.urgency)}</dd>` : ""}
      <dt>Location</dt><dd class="mono">${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}</dd>
    </dl>
    ${a.description && a.description !== a.title ? `<div class="desc">${esc(a.description)}</div>` : ""}
    ${a.instruction ? `<div class="desc"><b>Advice:</b> ${esc(a.instruction)}</div>` : ""}
    <div style="display:flex;gap:6px;margin:10px 0">
      <button class="btn warn" id="btn-bcast">Broadcast via NavIC</button>
      ${a.url ? `<a class="btn ghost" href="${esc(a.url)}" target="_blank" rel="noopener">Source ↗</a>` : ""}
    </div>
    <div id="wx-block"><p class="muted small">Loading local conditions…</p></div>`;
  $("#btn-bcast").onclick = () => { window.__astraBroadcast = a; emit("broadcast", a); location.hash = "#navic"; };
  renderWeather(a.lat, a.lon, $("#wx-block"));
}

async function drawGdacsGeometry(a) {
  try {
    const g = await api(`/api/gdacs/geometry?type=${a.gdacs.type}&id=${a.gdacs.id}&episode=${a.gdacs.episode}`, { ttl: 900_000 });
    const colorOf = (cls) => /red/i.test(cls) ? "#ff4d6d" : /orange/i.test(cls) ? "#ff8a3d" : /green/i.test(cls) ? "#3ddc97" : "#63d2ff";
    L.geoJSON(g, {
      filter: f => f.geometry.type !== "Point",
      style: f => {
        const cls = f.properties.Class || f.properties.polygonlabel || "";
        return f.geometry.type.includes("Polygon")
          ? { color: colorOf(cls), weight: 1, fillOpacity: 0.12 }
          : { color: "#ffffff", weight: 2, dashArray: "4 4" };
      },
    }).addTo(focusLayer);
  } catch (e) { console.warn("gdacs geometry", e); }
}

function pointAnalysis(lat, lon) {
  selectedId = null;
  $$("#alert-list li.sel").forEach(li => li.classList.remove("sel"));
  focusLayer.clearLayers();
  focusLayer.addLayer(L.circleMarker([lat, lon], { radius: 8, color: "#63d2ff", weight: 2, fill: false }));
  $("#detail-empty").hidden = true;
  const det = $("#detail");
  det.hidden = false;
  const near = alerts.filter(a => Math.hypot(a.lat - lat, a.lon - lon) < 1.5).length;
  det.innerHTML = `<div class="detail-title">Point analysis</div>
    <dl class="kv"><dt>Location</dt><dd class="mono">${lat.toFixed(3)}, ${lon.toFixed(3)}</dd><dt>Alerts within ~150 km</dt><dd>${near}</dd></dl>
    <div id="wx-block"><p class="muted small">Loading local conditions…</p></div>`;
  renderWeather(lat, lon, $("#wx-block"));
}

// ---------------------------------------------------------------------------
async function renderWeather(lat, lon, el) {
  try {
    const w = await api(`/api/weather?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, { ttl: 900_000 });
    const parts = [];
    const fc = w.forecast?.daily;
    const today = new Date().toISOString().slice(0, 10);
    let rain3 = 0, rainNext = 0, gust = 0;
    if (fc) {
      fc.time.forEach((t, i) => {
        if (t >= today && i < fc.time.length) { rainNext += fc.precipitation_sum[i] || 0; gust = Math.max(gust, fc.wind_gusts_10m_max[i] || 0); }
        else rain3 += fc.precipitation_sum[i] || 0;
      });
    }
    const fl = w.flood?.daily;
    let qNow = null, qMax = null, ratio = null;
    if (fl) {
      const i = fl.time.indexOf(today);
      qNow = fl.river_discharge[i >= 0 ? i : 30];
      const fut = fl.river_discharge.slice(i >= 0 ? i : 30, (i >= 0 ? i : 30) + 10).filter(v => v != null);
      qMax = fut.length ? Math.max(...fut) : null;
      const mean = fl.river_discharge_mean?.filter(v => v != null);
      const m = mean?.length ? mean.reduce((s, v) => s + v, 0) / mean.length : null;
      ratio = m && qMax ? qMax / m : null;
    }
    const wav = w.marine?.daily;
    const wmax = wav ? Math.max(...wav.wave_height_max.filter(v => v != null)) : null;
    el.innerHTML = `
      <h3>Local conditions</h3>
      <div class="stat-row">
        <div class="stat"><div class="v">${fmtNum(rainNext, 0)} mm</div><div class="l">Rain next 7 days</div></div>
        <div class="stat"><div class="v">${fmtNum(gust, 0)} km/h</div><div class="l">Max gust ahead</div></div>
      </div>
      <div class="stat-row">
        <div class="stat"><div class="v">${qNow != null ? fmtNum(qNow, 0) : "–"}</div><div class="l">River discharge m³/s (GloFAS)</div></div>
        <div class="stat"><div class="v" style="color:${ratio > 2 ? "var(--danger)" : ratio > 1.3 ? "var(--warn)" : "inherit"}">${ratio ? "×" + ratio.toFixed(1) : wmax != null ? fmtNum(wmax, 1) + " m" : "–"}</div><div class="l">${ratio ? "10-day peak vs normal" : "Max wave height"}</div></div>
      </div>
      ${fc ? `<div class="chart-box short"><canvas id="ch-rain"></canvas></div>` : ""}
      ${fl ? `<div class="chart-box short"><canvas id="ch-river"></canvas></div>` : ""}
      ${wav ? `<div class="chart-box short"><canvas id="ch-wave"></canvas></div>` : ""}
      <p class="note">Open-Meteo: ECMWF/GFS blend forecast, GloFAS v4 river discharge (nearest river cell), marine waves.</p>`;
    if (fc) makeChart($("#ch-rain"), {
      type: "bar",
      data: { labels: fc.time.map(t => t.slice(5)), datasets: [{ label: "Daily rain (mm)", data: fc.precipitation_sum, backgroundColor: fc.time.map(t => t >= today ? "#4ea8ff" : "#2c4a73"), borderRadius: 2 }] },
      options: { plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true } } },
    });
    if (fl) makeChart($("#ch-river"), {
      type: "line",
      data: { labels: fl.time.map(t => t.slice(5)), datasets: [
        { label: "Discharge (m³/s)", data: fl.river_discharge, borderColor: "#63d2ff", pointRadius: 0, borderWidth: 1.5, tension: .3 },
        { label: "Ensemble max", data: fl.river_discharge_max, borderColor: "#ff8a3d", borderDash: [3, 3], pointRadius: 0, borderWidth: 1 },
        { label: "Ensemble mean", data: fl.river_discharge_mean, borderColor: "#8d9bb5", pointRadius: 0, borderWidth: 1 },
      ] },
      options: { scales: { x: { ticks: { maxTicksLimit: 6 } } } },
    });
    if (wav) makeChart($("#ch-wave"), {
      type: "line",
      data: { labels: wav.time.map(t => t.slice(5)), datasets: [{ label: "Max wave height (m)", data: wav.wave_height_max, borderColor: "#5ee1a8", backgroundColor: "rgba(94,225,168,.15)", fill: true, pointRadius: 0, tension: .3 }] },
      options: { scales: { y: { beginAtZero: true } } },
    });
  } catch (e) {
    el.innerHTML = `<p class="muted small">Local conditions unavailable: ${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Cyclone tracks (IBTrACS + IMD grades)
const IMD = [[120, "SuCS", "#b04dff"], [90, "ESCS", "#ff4dd2"], [64, "VSCS", "#ff4d6d"], [48, "SCS", "#ff8a3d"], [34, "CS", "#ffc94d"], [17, "D/DD", "#63d2ff"], [0, "Low", "#8d9bb5"]];
const imdOf = (kt) => IMD.find(([t]) => (kt || 0) >= t);

async function openCyclonePicker() {
  clearCase();
  const det = $("#detail");
  $("#detail-empty").hidden = true;
  det.hidden = false;
  det.innerHTML = `<div class="detail-title">Cyclone tracks · North Indian Ocean</div><p class="muted small">Loading IBTrACS best tracks…</p>`;
  try {
    const storms = await api("/api/cyclones", { ttl: 86_400_000 });
    det.innerHTML = `<div class="detail-title">Cyclone tracks · North Indian Ocean</div>
      <p class="muted small">Best tracks from IBTrACS (includes IMD New Delhi data). Colours follow IMD intensity classes.</p>
      <select id="cyc-season" aria-label="Season">${[...new Set(storms.map(s => s.season))].map(y => `<option>${y}</option>`).join("")}</select>
      <table class="table" id="cyc-table"></table>
      <div class="legend" style="position:static;margin-top:10px">${IMD.slice(0, 6).map(([t, n, c]) => `<div class="row"><span class="sw" style="background:${c}"></span>${n} ≥ ${t} kt</div>`).join("")}</div>`;
    const fill = (season) => {
      const list = storms.filter(s => s.season == season);
      $("#cyc-table").innerHTML = `<thead><tr><th>Storm</th><th>Basin</th><th class="num">Peak</th></tr></thead><tbody>` + list.map(s =>
        `<tr class="click" data-sid="${s.sid}"><td>${esc(s.name)}</td><td>${s.basin === "BB" ? "Bay of Bengal" : s.basin === "AS" ? "Arabian Sea" : esc(s.basin)}</td><td class="num"><span style="color:${imdOf(s.maxWind)[2]}">${s.maxWind} kt · ${imdOf(s.maxWind)[1]}</span></td></tr>`).join("") + "</tbody>";
      cycLayer.clearLayers();
      list.forEach(s => drawTrack(s, false));
    };
    $("#cyc-season").onchange = (e) => fill(e.target.value);
    $("#cyc-table").onclick = (e) => {
      const tr = e.target.closest("tr[data-sid]"); if (!tr) return;
      const s = storms.find(x => x.sid === tr.dataset.sid);
      cycLayer.clearLayers();
      const b = drawTrack(s, true);
      map.flyToBounds(b.pad(0.3), { duration: 0.8 });
    };
    fill(storms[0].season);
  } catch (e) {
    det.innerHTML += `<p class="muted">IBTrACS unavailable: ${esc(e.message)}</p>`;
  }
}

function drawTrack(s, detailed) {
  const pts = s.track.filter(p => p[1] != null && p[2] != null);
  const latlngs = [];
  for (let i = 1; i < pts.length; i++) {
    const [, la0, lo0, w0] = pts[i - 1];
    const [, la1, lo1] = pts[i];
    latlngs.push([la0, lo0]);
    L.polyline([[la0, lo0], [la1, lo1]], { color: imdOf(w0)[2], weight: detailed ? 4 : 2, opacity: detailed ? 1 : 0.7 }).addTo(cycLayer);
  }
  if (detailed) pts.forEach(([t, la, lo, w, g]) => L.circleMarker([la, lo], { radius: 3, color: imdOf(w)[2], fillOpacity: 1 }).bindTooltip(`${esc(s.name)} · ${t} UTC<br>${w ?? "?"} kt ${g || ""}`).addTo(cycLayer));
  const first = pts[0];
  if (first) L.marker([pts.at(-1)[1], pts.at(-1)[2]], { icon: L.divIcon({ className: "", html: `<span style="color:#fff;font-size:11px;text-shadow:0 0 3px #000">${esc(s.name)}</span>` }) }).addTo(cycLayer);
  return L.latLngBounds(pts.map(p => [p[1], p[2]]));
}

// ---------------------------------------------------------------------------
// Sentinel-1 flood case study with before/after swipe and change detection
const WATER_DB = 0.025; // linear backscatter threshold (~ -16 dB) for open water in VV

function s1Url(base, item, params) {
  return base + "?collection=sentinel-1-rtc&item=" + encodeURIComponent(item) + "&" + params;
}

async function openCasePicker() {
  cycLayer.clearLayers();
  const det = $("#detail");
  $("#detail-empty").hidden = true;
  det.hidden = false;
  det.innerHTML = `<div class="detail-title">Flood mapping from radar</div><p class="muted small">Loading case studies…</p>`;
  const cases = await api("/api/flood/cases", { ttl: 86_400_000 });
  det.innerHTML = `<div class="detail-title">Flood mapping from radar</div>
    <p class="muted small">Sentinel-1 radar sees through cloud. ASTRA compares a pre-event and post-event scene from the same orbit track. Pixels that turn dark (smooth water) after the event are flagged as <b style="color:#ff3df2">new inundation</b>.</p>
    <select id="case-sel" aria-label="Case study">${cases.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join("")}</select>
    <div id="case-body"></div>`;
  $("#case-sel").onchange = (e) => loadCase(e.target.value);
  loadCase(cases[0].id);
}

async function loadCase(id) {
  const body = $("#case-body");
  body.innerHTML = `<p class="muted small">Searching Sentinel-1 archive…</p>`;
  try {
    const c = await api(`/api/flood/case/${id}`, { ttl: 86_400_000 });
    if (!c.pairs.length) { body.innerHTML = `<p class="muted">No matching before/after radar pair found for this event.</p>`; return; }
    body.innerHTML = `
      <label class="small muted">Scene pair</label>
      <select id="pair-sel">${c.pairs.map((p, i) => `<option value="${i}">${p.beforeDate.slice(0, 10)} → ${p.afterDate.slice(0, 10)} (${p.orbit})</option>`).join("")}</select>
      <div class="stat-row"><div class="stat"><div class="v" id="flood-area">–</div><div class="l">New water in view (km²)</div></div>
      <div class="stat"><div class="v" id="flood-pct">–</div><div class="l">of valid radar area</div></div></div>
      <label class="toggle"><input type="checkbox" id="show-diff" checked> Show detected new inundation</label>
      <p class="note">Drag the slider on the map to compare. Zoom in to see more detail. Threshold: VV backscatter &lt; ${WATER_DB} (≈ −16 dB). Speckle and wet fields can cause false positives; ground truth with official maps.</p>
      <div class="chart-box short"><canvas id="ch-case-rain"></canvas></div>`;
    const apply = (i) => showPair(c, c.pairs[i]);
    $("#pair-sel").onchange = (e) => apply(+e.target.value);
    $("#show-diff").onchange = (e) => caseLayers.forEach(l => l._isDiff && (e.target.checked ? l.addTo(map) : map.removeLayer(l)));
    apply(0);
    // Rainfall around the event (Open-Meteo archive, ERA5)
    const ld = new Date(c.landfall);
    const s = new Date(ld - 10 * 86400000).toISOString().slice(0, 10), e = new Date(+ld + 10 * 86400000).toISOString().slice(0, 10);
    api(`/api/weather/archive?lat=${c.center[0]}&lon=${c.center[1]}&start=${s}&end=${e}`, { ttl: 86_400_000 }).then(w => {
      makeChart($("#ch-case-rain"), { type: "bar", data: { labels: w.daily.time.map(t => t.slice(5)), datasets: [{ label: "Daily rain at case centre (mm, ERA5)", data: w.daily.precipitation_sum, backgroundColor: "#4ea8ff", borderRadius: 2 }] }, options: { scales: { y: { beginAtZero: true } } } });
    }).catch(() => {});
  } catch (e) {
    body.innerHTML = `<p class="muted">Case unavailable: ${esc(e.message)}</p>`;
  }
}

function clearCase() {
  caseLayers.forEach(l => map.removeLayer(l));
  caseLayers = [];
  $("#swipe").hidden = true;
  $("#dmap-legend").innerHTML = "";
}

function ensurePane(name, z) {
  if (!map.getPane(name)) { map.createPane(name); map.getPane(name).style.zIndex = z; }
  return map.getPane(name);
}

function showPair(c, p) {
  clearCase();
  ensurePane("s1before", 380);
  ensurePane("s1after", 390);
  ensurePane("s1diff", 395);
  const vv = "assets=vv&rescale=0,0.3&colormap_name=gray&format=png";
  const opts = { maxNativeZoom: 14, maxZoom: 16, minZoom: 7, attribution: "Copernicus Sentinel-1 via Microsoft Planetary Computer", bounds: L.latLngBounds([[p.bbox[1], p.bbox[0]], [p.bbox[3], p.bbox[2]]]) };
  const before = L.tileLayer(s1Url(c.tileBase, p.before, vv), { ...opts, pane: "s1before" }).addTo(map);
  const after = L.tileLayer(s1Url(c.tileBase, p.after, vv), { ...opts, pane: "s1after" }).addTo(map);
  const diff = floodDiffLayer(c.tileBase, p.before, p.after, { ...opts, pane: "s1diff" }).addTo(map);
  diff._isDiff = true;
  caseLayers = [before, after, diff];
  $("#swipe").hidden = false;
  $("#swipe-before").textContent = `◀ Before ${p.beforeDate.slice(0, 10)}`;
  $("#swipe-after").textContent = `After ${p.afterDate.slice(0, 10)} ▶`;
  $("#dmap-legend").innerHTML = `<div class="row"><span class="sw" style="background:#ff3df2"></span>New inundation (water after, land before)</div><div class="row"><span class="sw" style="background:#2f7bff"></span>Permanent water (both dates)</div><div class="row muted">Radar © ESA Copernicus</div>`;
  map.flyTo(c.center, 10, { duration: 1 });
  updateSwipe();
}

function updateSwipe() {
  const pane = map?.getPane("s1after");
  if (!pane || $("#swipe").hidden) { if (pane) pane.style.clip = ""; return; }
  const ratio = $("#swipe-range").value / 100;
  const size = map.getSize();
  const nw = map.containerPointToLayerPoint([0, 0]);
  const se = map.containerPointToLayerPoint(size);
  const x = nw.x + size.x * ratio;
  pane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
  const dp = map.getPane("s1diff");
  if (dp) dp.style.clip = pane.style.clip;
}

// Change-detection tile layer: loads 3-class masks (nodata / land / water) for both dates and diffs them client-side.
function floodDiffLayer(base, beforeId, afterId, opts) {
  const cm = encodeURIComponent(JSON.stringify({ 0: [0, 0, 0, 0], 1: [0, 0, 0, 255], 2: [255, 255, 255, 255] }));
  const ex = encodeURIComponent(`where(vv<=0,0,where(vv<${WATER_DB},2,1))`);
  const params = `expression=${ex}&asset_as_band=true&colormap=${cm}&format=png`;
  const stats = new Map();
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 256;
      const url = (id) => s1Url(base, id, params).replace("{z}", coords.z).replace("{x}", coords.x).replace("{y}", coords.y);
      const load = (src) => new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = rej; im.src = src; });
      Promise.all([load(url(beforeId)), load(url(afterId))]).then(([b, a]) => {
        const ctx = tile.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(b, 0, 0); const B = ctx.getImageData(0, 0, 256, 256).data;
        ctx.clearRect(0, 0, 256, 256);
        ctx.drawImage(a, 0, 0); const A = ctx.getImageData(0, 0, 256, 256).data;
        const out = ctx.createImageData(256, 256);
        const O = out.data;
        const neu = new Uint8Array(256 * 256);
        let valid = 0;
        for (let i = 0, p = 0; p < 65536; p++, i += 4) {
          const bv = B[i + 3] > 0, av = A[i + 3] > 0;
          if (!bv || !av) continue;
          valid++;
          const bw = B[i] > 128, aw = A[i] > 128;
          if (aw && !bw) neu[p] = 1;
          else if (aw && bw) { O[i] = 47; O[i + 1] = 123; O[i + 2] = 255; O[i + 3] = 150; }
        }
        // 3x3 majority filter to suppress radar speckle
        let count = 0;
        for (let y = 1; y < 255; y++) for (let x = 1; x < 255; x++) {
          const p = y * 256 + x;
          if (!neu[p]) continue;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += neu[p + dy * 256 + dx];
          if (n >= 5) { const i = p * 4; O[i] = 255; O[i + 1] = 61; O[i + 2] = 242; O[i + 3] = 220; count++; }
        }
        ctx.putImageData(out, 0, 0);
        const lat = tile2lat(coords.y + 0.5, coords.z);
        const pxM = (40075016.686 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, coords.z + 8);
        stats.set(`${coords.z}/${coords.x}/${coords.y}`, { z: coords.z, x: coords.x, y: coords.y, km2: count * pxM * pxM / 1e6, validKm2: valid * pxM * pxM / 1e6 });
        done(null, tile);
        refreshArea();
      }).catch((err) => done(err, tile));
      return tile;
    },
  });
  const layer = new Layer({ ...opts, tileSize: 256 });
  const refreshArea = () => {
    if (!map.hasLayer(layer)) return;
    const z = Math.round(map.getZoom());
    const b = map.getPixelBounds();
    let km2 = 0, valid = 0;
    for (const s of stats.values()) {
      if (s.z !== Math.min(z, 14)) continue;
      const tx = s.x * 256, ty = s.y * 256;
      if (tx + 256 < b.min.x || tx > b.max.x || ty + 256 < b.min.y || ty > b.max.y) continue;
      km2 += s.km2; valid += s.validKm2;
    }
    const a = $("#flood-area"), pc = $("#flood-pct");
    if (a) a.textContent = fmtNum(km2, km2 < 10 ? 1 : 0);
    if (pc) pc.textContent = valid ? (100 * km2 / valid).toFixed(1) + "%" : "–";
  };
  map.on("moveend", refreshArea);
  return layer;
}

function tile2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
