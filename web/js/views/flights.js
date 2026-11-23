// Flights · Live radar: every aircraft in view on a dark map, drawn as its own type silhouette, coloured by
// altitude and dead-reckoned between updates. Pick one for its route, flown track, delay prediction and route
// safety, or switch to 3D and ride along behind a model of it.
import { api } from "../core/api.js";
import { $, $$, esc, fmtNum, fmtIST, toast, makeChart, PAL, gradeColor } from "../core/util.js";
import { classify, CLASSES, CLASS_ORDER, sprite, spriteURL, iconHTML, altColor, ALT_STOPS, COLOR, modelURL, modelLength } from "../core/aircraft.js";
import { loadAirports, airportsLoaded, findAirport, gcPoints, havKm } from "../core/airports.js";

const C = () => window.Cesium;
const FLAG_GND = 1, FLAG_MIL = 2, FLAG_EMERG = 4;
const CELL_DLAT = 5, CELL_DLON = 6, MAX_CELLS = 40;
const FT = 0.3048;
const JUMP = { DEL: [28.56, 77.1, 9], BOM: [19.09, 72.87, 9], BLR: [13.2, 77.7, 9], MAA: [12.99, 80.17, 9], CCU: [22.65, 88.45, 9], HYD: [17.24, 78.43, 9], IXL: [34.14, 77.55, 9], DXB: [25.25, 55.36, 9] };

const ac = new Map();               // hex -> aircraft
let map, canvas, ctx, dpr = 1, drawn = [], lastDraw = 0, raf = 0, dirty = true, zooming = false;
let active = false, gen = 0, wideTimer = 0, uiTimer = 0;
let selected = null, selSeq = 0, info = null, assess = null, follow = false;
let hidden = new Set(), showGround = false, showLabels = true, showRoutes = false;
let selLayer, routesLayer, routeCache = new Map(), routesBusy = false;
let dim = "2d", camMode = "chase";
let lastCellFetch = new Map();
let pendingHex = null;
let feedNote = "";

// ---------------------------------------------------------------------------------------------------------------
export async function init() {
  map = L.map("fl-map", { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 3, maxZoom: 13, preferCanvas: true })
    .setView([22.5, 80], innerWidth < 760 ? 4 : 5);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16, attribution: "Esri · ADS-B: adsb.fi, OpenSky · routes: adsbdb" }).addTo(map);
  map.createPane("labels"); map.getPane("labels").style.zIndex = 390; map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16, pane: "labels", opacity: 0.75 }).addTo(map);
  routesLayer = L.layerGroup().addTo(map);
  selLayer = L.layerGroup().addTo(map);

  // Aircraft are drawn on one canvas above the tiles (thousands of rotated sprites, cheap to redraw)
  canvas = document.createElement("canvas");
  canvas.className = "fl-canvas";
  map.getContainer().appendChild(canvas);
  ctx = canvas.getContext("2d");
  map.on("move resize", () => { dirty = true; });
  map.on("zoomstart", () => { zooming = true; canvas.style.opacity = 0; });
  map.on("zoomend", () => { zooming = false; canvas.style.opacity = 1; dirty = true; });
  map.on("moveend", () => { if (showRoutes) loadRoutes(); });
  map.on("click", (e) => {
    const a = hit(e.containerPoint);
    if (a) select(a.hex);
    else if (selected) deselect();
  });
  map.on("mousemove", (e) => hover(e.containerPoint, e.originalEvent));
  map.on("mouseout", () => { $("#fl-hover").hidden = true; });
  map.on("dragstart", () => { if (follow) setFollow(false); });

  buildFilters();
  buildLegend();
  $("#fl-search").addEventListener("input", search);
  $("#fl-results").addEventListener("click", (e) => { const li = e.target.closest("li[data-hex]"); if (li) select(li.dataset.hex, { fly: true }); });
  $("#fl-jump").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-ap]");
    if (!b) return;
    const [la, lo, z] = JUMP[b.dataset.ap];
    if (dim === "3d") setDim("2d");
    map.flyTo([la, lo], z, { duration: 1.1 });
  });
  $("#fl-ground").onchange = (e) => { showGround = e.target.checked; dirty = true; };
  $("#fl-labels").onchange = (e) => { showLabels = e.target.checked; dirty = true; };
  $("#fl-routes").onchange = (e) => { showRoutes = e.target.checked; showRoutes ? loadRoutes() : clearRoutes(); };
  $("#fl-routes-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-from]");
    if (li) location.hash = `#routes?from=${li.dataset.from}&to=${li.dataset.to}`;
  });
  $$("#fl-dim button").forEach(b => b.onclick = () => setDim(b.dataset.dim));
  $$("#fl-cam button").forEach(b => b.onclick = () => setCam(b.dataset.cam));
  $("#fl-panels").onclick = togglePanels;
  document.addEventListener("keydown", (e) => {
    if (!active || e.target.closest("input, select, textarea")) return;
    if (e.key === "p" || e.key === "P") togglePanels();
    if (e.key === "Escape" && selected) deselect();
  });
  $("#fl-panel").addEventListener("click", onPanelClick);
  loadAirports().then(() => { dirty = true; });
}

export function show(params = {}) {
  active = true;
  gen++;
  setTimeout(() => { map.invalidateSize(); dirty = true; }, 60);
  if (params.hex) pendingHex = String(params.hex).toLowerCase();
  if (params.lat && params.lon) map.setView([+params.lat, +params.lon], +params.z || 8);
  loop();
  pollWide();
  clearInterval(wideTimer); wideTimer = setInterval(pollWide, 120_000);
  cellLoop(gen);
  clearInterval(uiTimer); uiTimer = setInterval(tickUI, 1000);
  if (dim === "3d" && viewer3) viewer3.useDefaultRenderLoop = true;
}

export function hide() {
  active = false;
  gen++;
  cancelAnimationFrame(raf);
  clearInterval(wideTimer); clearInterval(uiTimer);
  if (viewer3) viewer3.useDefaultRenderLoop = false;   // stop the 3D renderer while away
}

// ---------------------------------------------------------------------------------------------------------------
// Data
function ingest(d, wide) {
  const tData = d.time || Date.now() / 1000, now = Date.now();
  for (const r of d.ac || []) {
    const hex = r[0];
    if (!hex) continue;
    const tFix = (tData - (r[13] || 0)) * 1000;
    let a = ac.get(hex);
    if (a) {
      a.lastSeen = now;
      if (!a.type && r[3]) { a.type = r[3]; a.desc = r[14] || a.desc; a.cls = classify(a); }
      if (a.tFix >= tFix) continue;
      if (wide && !a.wide && now - a.tFix < 60_000) continue;   // keep fresher typed data from the cells
    } else {
      a = { hex, lastSeen: now };
    }
    a.cs = r[1] || a.cs || ""; a.reg = r[2] || a.reg || ""; a.type = r[3] || a.type || ""; a.cat = r[4] || a.cat || "";
    a.lat = r[5]; a.lon = r[6]; a.alt = r[7] ?? a.alt; a.gs = r[8]; a.trk = r[9] ?? a.trk; a.vr = r[10];
    a.sq = r[11]; a.flags = r[12]; a.desc = r[14] || a.desc || ""; a.altg = r[15]; a.tFix = tFix; a.wide = wide; a.src = d.source;
    a.cls = classify(a);
    if (!a.cls) continue;
    ac.set(hex, a);
  }
  // Forget aircraft not reported for a while (wide overview refreshes every few minutes)
  for (const [hex, a] of ac) if (a !== selected && now - a.lastSeen > (a.wide ? 420_000 : 90_000)) ac.delete(hex);
  dirty = true;
  if (pendingHex && ac.has(pendingHex)) { const h = pendingHex; pendingHex = null; select(h, { fly: true }); }
}

async function pollWide() {
  try { ingest(await api("/api/flights/wide", { ttl: 60_000 }), true); }
  catch (e) { feedNote = "Overview feed unavailable: " + e.message; }
}

const cellKey = (la, lo) => `${la},${lo}`;
function cellOf(lat, lon) {
  const la = Math.floor(lat / CELL_DLAT) * CELL_DLAT + CELL_DLAT / 2;
  let lo = Math.floor(lon / CELL_DLON) * CELL_DLON + CELL_DLON / 2;
  lo = ((lo + 180) % 360 + 360) % 360 - 180;
  return [la, lo];
}
function visibleCells() {
  let s, w, n, e, clat, clon;
  if (dim === "3d" && viewer3) {
    const c = view3Center();
    if (!c) return [];
    [clat, clon] = c;
    s = clat - 4; n = clat + 4; w = clon - 5; e = clon + 5;
  } else {
    const b = map.getBounds(), cc = map.getCenter();
    s = Math.max(-72, b.getSouth()); n = Math.min(78, b.getNorth()); w = b.getWest(); e = b.getEast();
    clat = cc.lat; clon = cc.lng;
    if (e - w > 200) { w = clon - 100; e = clon + 100; }
  }
  const out = [];
  for (let la = Math.floor(s / CELL_DLAT) * CELL_DLAT; la < n; la += CELL_DLAT)
    for (let lo = Math.floor(w / CELL_DLON) * CELL_DLON; lo < e; lo += CELL_DLON) {
      const c = cellOf(la + 0.01, lo + 0.01);
      out.push({ c, d: Math.hypot(c[0] - clat, (c[1] - clon) * Math.cos(clat * Math.PI / 180)) });
    }
  out.sort((x, y) => x.d - y.d);
  return out.slice(0, MAX_CELLS).map(x => x.c);
}
// One cell at a time, always the one refreshed longest ago (the server spaces adsb.fi calls to its 1/s limit).
async function cellLoop(g) {
  while (active && g === gen) {
    let pick = null;
    if (selected) { const c = cellOf(selected.lat, selected.lon); if (Date.now() - (lastCellFetch.get(cellKey(...c)) || 0) > 10_000) pick = c; }
    if (!pick) {
      let best = Infinity;
      for (const c of visibleCells()) {
        const t = lastCellFetch.get(cellKey(...c)) || 0;
        if (t < best) { best = t; pick = c; }
      }
      if (pick && Date.now() - best < 10_000) pick = null;
    }
    if (!pick) { await sleep(800); continue; }
    lastCellFetch.set(cellKey(...pick), Date.now());
    try {
      const d = await api(`/api/flights/cell?lat=${pick[0]}&lon=${pick[1]}`, { ttl: 8000 });
      ingest(d, false);
      feedNote = "";
    } catch (e) { feedNote = "Live feed busy, retrying… (" + e.message + ")"; await sleep(2500); }
    await sleep(250);
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Dead reckoning from the last fix: great-circle step at ground speed along the track
function posAt(a, tms) {
  let dt = (tms - a.tFix) / 1000;
  dt = Math.max(0, Math.min(a.wide ? 300 : 120, dt));
  let alt = a.alt;
  if (alt != null && a.vr && !(a.flags & FLAG_GND)) alt = Math.max(0, alt + Math.max(-3000, Math.min(3000, a.vr * dt / 60)));
  if (!a.gs || a.gs < 30 || a.trk == null || (a.flags & FLAG_GND)) return [a.lat, a.lon, alt];
  const R = Math.PI / 180, d = a.gs * 1.852 * dt / 3600 / 6371, br = a.trk * R, p1 = a.lat * R, l1 = a.lon * R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / R, ((l2 / R + 540) % 360) - 180, alt];
}
const shown = (a) => !hidden.has(a.cls) && (showGround || !(a.flags & FLAG_GND) || a === selected);
const colorOf = (a, alt) => a === selected ? COLOR.sel : (a.flags & FLAG_EMERG) ? COLOR.emerg : (a.flags & FLAG_MIL) ? COLOR.mil : altColor(alt, a.flags & FLAG_GND);

// ---------------------------------------------------------------------------------------------------------------
// 2D drawing
function loop() {
  cancelAnimationFrame(raf);
  const step = (t) => {
    if (!active) return;
    raf = requestAnimationFrame(step);
    if (dim !== "2d" || zooming) return;
    const z = map.getZoom(), every = z >= 10 ? 50 : z >= 8 ? 90 : 160;   // planes move more pixels per second when zoomed in
    if (!dirty && t - lastDraw < every) return;
    lastDraw = t; dirty = false;
    draw();
  };
  raf = requestAnimationFrame(step);
}

function draw() {
  const size = map.getSize();
  const ratio = Math.min(2, devicePixelRatio || 1);
  if (canvas.width !== Math.round(size.x * ratio) || canvas.height !== Math.round(size.y * ratio)) {
    dpr = ratio;
    canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
    canvas.style.width = size.x + "px"; canvas.style.height = size.y + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.x, size.y);
  const z = map.getZoom(), now = Date.now(), b = map.getBounds().pad(0.08);
  drawAirports(z, b);
  const k = z <= 4 ? 0.56 : z <= 5 ? 0.66 : z <= 6.5 ? 0.8 : z <= 8.5 ? 0.95 : 1.1;
  const list = [];
  let airborne = 0;
  for (const a of ac.values()) {
    if (!shown(a)) continue;
    const p = posAt(a, now);
    a._p = p;
    if (!b.contains([p[0], p[1]])) continue;
    const pt = map.latLngToContainerPoint([p[0], p[1]]);
    list.push([a, pt, p[2] ?? 0]);
    if (!(a.flags & FLAG_GND)) airborne++;
  }
  list.sort((x, y) => (x[0] === selected) - (y[0] === selected) || x[2] - y[2]);   // high planes on top, selection last
  drawn = [];
  for (const [a, pt, alt] of list) {
    const isSel = a === selected;
    const s = 26 * CLASSES[a.cls].scale * k * ((a.flags & FLAG_GND) ? 0.8 : 1) * (isSel ? 1.3 : 1);
    if (isSel) {
      ctx.beginPath(); ctx.arc(pt.x, pt.y, s * 0.78, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 1.2; ctx.stroke();
    }
    if (a.flags & FLAG_EMERG) {
      const r = s * (0.7 + 0.25 * ((now / 600) % 1));
      ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = COLOR.emerg; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate((a.trk || 0) * Math.PI / 180);
    ctx.drawImage(sprite(a.cls, colorOf(a, alt), 64), -s / 2, -s / 2, s, s);
    ctx.restore();
    drawn.push([pt.x, pt.y, a, s]);
  }
  if ((showLabels && z >= 7 && list.length < 260) || selected) {
    ctx.font = "500 10.5px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (const [x, y, a, s] of drawn) {
      if (!(showLabels && z >= 7 && list.length < 260) && a !== selected) continue;
      const t = a.cs || a.reg || a.hex;
      const lx = x + s * 0.48 + 3;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(16,16,16,.85)"; ctx.strokeText(t, lx, y);
      ctx.fillStyle = a === selected ? "#fff" : "rgba(236,236,236,.82)"; ctx.fillText(t, lx, y);
    }
  }
  $("#fl-count").textContent = `${fmtNum(airborne)} airborne in view`;
  const st = $("#fl-status");
  const msg = feedNote || (ac.size === 0 ? "Loading live aircraft…" : z < 4.5 && list.length < 5 ? "Zoom in to load live aircraft for this area" : "");
  if (st.textContent !== msg) st.textContent = msg;
}

function drawAirports(z, b) {
  const aps = airportsLoaded();
  if (!aps.length || z < 4.5) return;
  ctx.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
  ctx.textBaseline = "top";
  for (const a of aps) {
    if (a.size !== "L" && z < 7.5) continue;
    if (a.size === "L" && z < 5.5 && a.country !== "IN") continue;
    if (!b.contains([a.lat, a.lon])) continue;
    const p = map.latLngToContainerPoint([a.lat, a.lon]);
    ctx.fillStyle = "rgba(236,236,236,.55)";
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    if (z >= 6) {
      ctx.fillStyle = "rgba(236,236,236,.5)";
      ctx.fillText(a.iata || a.icao, p.x + 4, p.y + 2);
    }
  }
}

function hit(pt) {
  let best = null, bd = Infinity;
  for (const [x, y, a, s] of drawn) {
    const d = Math.hypot(x - pt.x, y - pt.y);
    if (d < Math.max(11, s * 0.55) && d < bd) { bd = d; best = a; }
  }
  return best;
}
function hover(pt, ev) {
  const a = hit(pt), tip = $("#fl-hover");
  map.getContainer().style.cursor = a ? "pointer" : "";
  if (!a) { tip.hidden = true; return; }
  const alt = a._p?.[2];
  tip.innerHTML = `${iconHTML(a.cls, colorOf(a, alt), 16, a.trk || 0)}<b>${esc(a.cs || a.reg || a.hex.toUpperCase())}</b>
    <span>${esc(a.type || CLASSES[a.cls].label)}</span><span>${(a.flags & FLAG_GND) ? "on ground" : alt != null ? fmtNum(alt) + " ft" : ""}${a.gs ? " · " + fmtNum(a.gs) + " kt" : ""}</span>`;
  tip.hidden = false;
  const r = map.getContainer().getBoundingClientRect();
  tip.style.left = (ev.clientX - r.left + 14) + "px";
  tip.style.top = (ev.clientY - r.top + 14) + "px";
}

// ---------------------------------------------------------------------------------------------------------------
// Panel: filters, search, legend
function buildFilters() {
  $("#fl-types").innerHTML = CLASS_ORDER.map(k => `<button class="chip on ac-chip" data-cls="${k}" title="${esc(CLASSES[k].hint)}">${iconHTML(k, "#ececec", 18)}${esc(CLASSES[k].label)}<span class="n" data-n="${k}"></span></button>`).join("");
  $("#fl-types").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cls]");
    if (!b) return;
    const k = b.dataset.cls;
    // First click shows only that type; further clicks add/remove types; clicking the last one shown resets
    if (hidden.size === 0) CLASS_ORDER.forEach(c => c !== k && hidden.add(c));
    else if (hidden.size === CLASS_ORDER.length - 1 && !hidden.has(k)) hidden.clear();
    else hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    $$("#fl-types .chip").forEach(c => c.classList.toggle("on", !hidden.has(c.dataset.cls)));
    dirty = true;
  });
}
function buildLegend() {
  const grad = ALT_STOPS.map(([ft, c]) => `${c} ${ft / 420}%`).join(",");
  $("#fl-legend").innerHTML = `<div class="key-h">Altitude</div>
    <div class="alt-bar" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="alt-ticks"><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>40k ft</span></div>
    <div class="row sub"><span class="dotk" style="background:${COLOR.mil}"></span>military <span class="dotk" style="background:${COLOR.emerg};margin-left:8px"></span>emergency</div>`;
}
function tickUI() {
  if (!active) return;
  // counts per class in view
  const counts = {};
  const b = dim === "2d" ? map.getBounds() : null;
  for (const a of ac.values()) {
    if (!showGround && (a.flags & FLAG_GND)) continue;
    const p = a._p || [a.lat, a.lon];
    if (b && !b.contains([p[0], p[1]])) continue;
    counts[a.cls] = (counts[a.cls] || 0) + 1;
  }
  $$("#fl-types [data-n]").forEach(el => { el.textContent = counts[el.dataset.n] || ""; });
  if (selected) updateTele();
  if (follow && selected && dim === "2d" && selected._p) map.panTo([selected._p[0], selected._p[1]], { animate: true, duration: 0.9, easeLinearity: 1 });
  if (dim === "3d") sync3D();
}
function search() {
  const q = $("#fl-search").value.trim().toUpperCase();
  const ul = $("#fl-results");
  if (q.length < 2) { ul.innerHTML = ""; return; }
  const hits = [];
  for (const a of ac.values()) {
    const keys = [a.cs, a.reg, a.hex.toUpperCase(), a.type, (a.desc || "").toUpperCase()];
    const sc = keys[0]?.startsWith(q) ? 3 : keys[1]?.replace("-", "").startsWith(q.replace("-", "")) ? 3 : keys[2].startsWith(q) ? 2 : keys[3] === q ? 2 : keys.some(k => k && k.includes(q)) ? 1 : 0;
    if (sc) hits.push([sc, a]);
  }
  hits.sort((x, y) => y[0] - x[0] || (y[1].alt ?? 0) - (x[1].alt ?? 0));
  ul.innerHTML = hits.slice(0, 12).map(([, a]) => `<li data-hex="${a.hex}">${iconHTML(a.cls, colorOf(a, a.alt), 18, 0)}<span class="nm"><b>${esc(a.cs || a.reg || a.hex)}</b> <span class="muted">${esc(a.type || "")}</span></span><span class="mono small muted">${(a.flags & FLAG_GND) ? "ground" : a.alt != null ? fmtNum(a.alt) + " ft" : ""}</span></li>`).join("")
    || `<li class="muted small">Not in the loaded area. Zoom out or jump to an airport.</li>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Usual routes of the flights in view (airline schedule per callsign), grouped by city pair
async function loadRoutes() {
  if (!showRoutes || routesBusy || dim !== "2d") return;
  routesBusy = true;
  try {
    const b = map.getBounds(), c = map.getCenter();
    const cand = [...ac.values()].filter(a => a.cs && !(a.flags & FLAG_GND) && a._p && b.contains([a._p[0], a._p[1]]))
      .sort((x, y) => havKm(c.lat, c.lng, x._p[0], x._p[1]) - havKm(c.lat, c.lng, y._p[0], y._p[1])).slice(0, 80);
    const need = cand.map(a => a.cs).filter(cs => !routeCache.has(cs)).slice(0, 40);
    if (need.length) {
      $("#fl-routes-list").innerHTML = `<p class="muted small">Looking up ${need.length} routes…</p>`;
      const d = await api(`/api/flights/routes?cs=${encodeURIComponent(need.join(","))}`, { ttl: 600_000 });
      for (const cs of need) routeCache.set(cs, d.routes[cs] || null);
    }
    if (showRoutes) drawRoutes(cand);
  } catch (e) {
    $("#fl-routes-list").innerHTML = `<p class="muted small">Routes unavailable: ${esc(e.message)}</p>`;
  } finally { routesBusy = false; }
}
function drawRoutes(cand) {
  routesLayer.clearLayers();
  const pairs = new Map();
  let known = 0;
  for (const a of cand) {
    const r = routeCache.get(a.cs);
    if (r?.origin?.lat == null || r?.destination?.lat == null) continue;
    known++;
    const key = r.origin.icao + ">" + r.destination.icao;
    let p = pairs.get(key);
    if (!p) pairs.set(key, p = { r, cs: [] });
    p.cs.push(a.cs);
  }
  const list = [...pairs.values()].sort((x, y) => y.cs.length - x.cs.length);
  for (const { r, cs } of list) {
    const o = r.origin.iata || r.origin.icao, d = r.destination.iata || r.destination.icao;
    L.polyline(gcPoints(r.origin.lat, r.origin.lon, r.destination.lat, r.destination.lon, 64),
      { color: PAL.water, weight: 1.1 + Math.min(3, cs.length * 0.7), opacity: 0.42 })
      .bindTooltip(`<b>${esc(o)} → ${esc(d)}</b> · ${esc(r.origin.city || "")} to ${esc(r.destination.city || "")}<br>${cs.length} in the air now: ${esc(cs.slice(0, 6).join(", "))}`, { sticky: true })
      .on("click", () => { const a = [...ac.values()].find(x => x.cs === cs[0]); if (a) select(a.hex); })
      .addTo(routesLayer);
  }
  $("#fl-routes-list").innerHTML = list.length ? `<h3>Usual routes in view <span class="muted small">· ${known} of ${cand.length} flights matched</span></h3>
    <ul class="rt-pop">${list.slice(0, 14).map(({ r, cs }) => `<li data-from="${esc(r.origin.icao)}" data-to="${esc(r.destination.icao)}" title="Open the route safety report">
      <b>${esc(r.origin.iata || r.origin.icao)} → ${esc(r.destination.iata || r.destination.icao)}</b><span>${esc(r.origin.city || "")} – ${esc(r.destination.city || "")}</span><i>${cs.length}×</i></li>`).join("")}</ul>`
    : `<p class="muted small">No published routes for the flights in view.</p>`;
}
function clearRoutes() { routesLayer.clearLayers(); $("#fl-routes-list").innerHTML = ""; }

// ---------------------------------------------------------------------------------------------------------------
// Selection
async function select(hex, { fly = false } = {}) {
  const a = ac.get(hex);
  if (!a) return;
  selected = a; info = null; assess = null;
  const seq = ++selSeq;
  history.replaceState(null, "", `#flights?hex=${hex}`);
  $("#fl-results").innerHTML = "";
  dirty = true;
  if (fly && dim === "2d") map.flyTo([a.lat, a.lon], Math.max(map.getZoom(), 7.5), { duration: 1 });
  renderDetail();
  drawSelected();
  if (dim === "3d") enter3DSelection();
  try { info = await api(`/api/flights/info?hex=${hex}&cs=${encodeURIComponent(a.cs || "")}`, { ttl: 30_000 }); }
  catch (e) { info = { error: e.message }; }
  if (seq !== selSeq) return;
  renderDetail(); drawSelected();
  if (dim === "3d") draw3DSelected();
  const r = info?.route;
  if (r?.origin?.icao && r?.destination?.icao && findAirport(r.origin.icao) && findAirport(r.destination.icao) && routeTrusted(routeOK(), a)) {
    const p = a._p || [a.lat, a.lon, a.alt];
    const q = new URLSearchParams({ from: r.origin.icao, to: r.destination.icao, hex, lat: p[0].toFixed(4), lon: p[1].toFixed(4) });
    if (p[2] != null) q.set("alt", Math.round(p[2]));
    if (a.gs) q.set("gs", a.gs);
    if (info.track?.start) q.set("start", info.track.start);
    try { assess = await api(`/api/flights/assess?${q}`, { ttl: 120_000 }); }
    catch (e) { assess = { error: e.message }; }
    if (seq !== selSeq) return;
    renderDetail();
  }
}
function deselect() {
  selected = null; info = null; assess = null; selSeq++;
  setFollow(false);
  history.replaceState(null, "", "#flights");
  selLayer.clearLayers();
  $("#fl-detail").hidden = true; $("#fl-empty").hidden = false;
  dirty = true;
  if (dim === "3d") clear3DSelected();
}

function routeOK() {
  const r = info?.route;
  return r?.origin?.lat != null && r?.destination?.lat != null ? r : null;
}
const liveRoute = () => { const r = routeOK(); return routeTrusted(r) ? r : null; };
// Callsign routes are the airline's usual schedule and are sometimes stale: only trust one the aircraft is actually on
function routeTrusted(r, a = selected) {
  if (!r || !a) return false;
  const p = a._p || [a.lat, a.lon];
  if (havKm(p[0], p[1], r.origin.lat, r.origin.lon) < 150 || havKm(p[0], p[1], r.destination.lat, r.destination.lon) < 150) return true;
  const off = Math.min(...gcPoints(r.origin.lat, r.origin.lon, r.destination.lat, r.destination.lon, 120).map(([la, lo]) => havKm(p[0], p[1], la, lo)));
  return off < 220;
}
// Flown track coloured by altitude + the usual (great-circle) route between the scheduled airports
function drawSelected() {
  selLayer.clearLayers();
  const a = selected;
  if (!a) return;
  const r = routeOK();
  if (r && routeTrusted(r, a)) {
    const pts = gcPoints(r.origin.lat, r.origin.lon, r.destination.lat, r.destination.lon, 96);
    L.polyline(pts, { color: "#ffffff", weight: 1.6, opacity: 0.55, dashArray: "6 7", interactive: false }).addTo(selLayer);
    for (const [ap, lbl] of [[r.origin, "From"], [r.destination, "To"]]) {
      L.circleMarker([ap.lat, ap.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#212121", fillOpacity: 1 })
        .bindTooltip(`<b>${esc(ap.iata || ap.icao)}</b> · ${esc(ap.city || ap.name)}<br><span class="muted">${lbl} · usual route</span>`, { permanent: true, direction: "top", offset: [0, -6], className: "ap-tip" })
        .addTo(selLayer);
    }
  }
  const path = info?.track?.path;
  if (path?.length > 1) {
    let run = [], col = null;
    const flush = () => { if (run.length > 1) L.polyline(run, { color: col, weight: 3, opacity: 0.95, interactive: false }).addTo(selLayer); };
    for (const p of path) {
      const c = altColor(p[3], p[5]);
      if (c !== col && run.length) { run.push([p[1], p[2]]); flush(); run = [run[run.length - 1]]; }
      col = c;
      run.push([p[1], p[2]]);
    }
    flush();
  }
}

function onPanelClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "close") deselect();
  if (act === "3d") setDim(dim === "3d" ? "2d" : "3d");
  if (act === "follow") setFollow(!follow);
  if (act === "link") { navigator.clipboard?.writeText(location.href).then(() => toast("Link to this flight copied")); }
}
function setFollow(on) {
  follow = on;
  const b = $("#fl-panel [data-act=follow]");
  if (b) { b.classList.toggle("active", on); b.textContent = on ? "Following" : "Follow on map"; }
  if (on && selected?._p) map.panTo([selected._p[0], selected._p[1]]);
}

// ---------------------------------------------------------------------------------------------------------------
// Detail panel
const fmtAlt = (a, alt) => (a.flags & FLAG_GND) ? "Ground" : alt != null ? fmtNum(alt) : "–";
function renderDetail() {
  const a = selected;
  if (!a) return;
  $("#fl-empty").hidden = true;
  const el = $("#fl-detail");
  el.hidden = false;
  const r0 = routeOK(), trusted = routeTrusted(r0, a), r = trusted ? r0 : null, air = info?.aircraft, live = assess?.live;
  const title = a.cs || a.reg || a.hex.toUpperCase();
  const airline = r?.airline ? `${esc(r.airline)}${r.iata && r.iata !== title ? " · " + esc(r.iata) : ""}` : (a.flags & FLAG_MIL) ? "Military" : "";
  const typeName = air?.type ? `${esc(air.manufacturer || "")} ${esc(air.type)}`.trim() : esc(a.desc || a.type || "Unknown type");
  const prog = live ? Math.round(live.progress * 100) : null;
  const delayTxt = live?.vs_typical_min != null
    ? (live.vs_typical_min > 10 ? `<span class="tag late">Running ~${live.vs_typical_min} min late</span>` : live.vs_typical_min < -10 ? `<span class="tag early">~${-live.vs_typical_min} min early</span>` : `<span class="tag ok">On time</span>`)
    : assess?.delay ? `<span class="tag ${assess.delay.p_late15 > 0.5 ? "late" : "ok"}">${assess.delay.on_time_pct}% chance on time</span>` : "";
  el.innerHTML = `
    <div class="fl-top">
      <div><div class="fl-cs">${iconHTML(a.cls, colorOf(a, a._p?.[2]), 26, 45)}<span>${esc(title)}</span></div>
        <div class="muted small">${airline || "&nbsp;"}</div></div>
      <button class="icon-btn" data-act="close" aria-label="Close">×</button>
    </div>
    ${air?.photo ? `<figure class="fl-photo"><img src="${esc(air.photo)}" alt="${esc(typeName)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"><figcaption>${esc(air.registration || a.reg || "")} · ${typeName}</figcaption></figure>` : ""}
    ${r ? `<div class="fl-route">
        <div class="ap"><b>${esc(r.origin.iata || r.origin.icao)}</b><span>${esc(r.origin.city || r.origin.name || "")}</span></div>
        <div class="fl-prog"><i style="width:${prog ?? 0}%"></i>${prog != null ? `<span class="pl" style="left:${prog}%">${iconHTML(a.cls, "#fff", 18, 90)}</span>` : ""}</div>
        <div class="ap r"><b>${esc(r.destination.iata || r.destination.icao)}</b><span>${esc(r.destination.city || r.destination.name || "")}</span></div>
      </div>
      <div class="fl-route-meta">${live ? `${fmtNum(live.flown_km)} km flown · ${fmtNum(live.remaining_km)} km to go · ETA <b>${fmtIST(live.eta * 1000).replace(/^\d+ \w+, /, "")}</b>` : r.distance_km ? `${fmtNum(r.distance_km)} km usual route` : ""} ${delayTxt}</div>
`
      : r0 ? `<p class="note warn-note">The published route for ${esc(a.cs)} is ${esc(r0.origin.iata || r0.origin.icao)} → ${esc(r0.destination.iata || r0.destination.icao)} (${esc(r0.origin.city || "")} to ${esc(r0.destination.city || "")}), but this aircraft is nowhere near it, so today's flight is different. Route, ETA and delay are not shown.</p>`
      : `<p class="note">${info ? info.error ? "Route lookup failed: " + esc(info.error) : "No published route for this callsign (private, military, cargo or charter flights often have none)." : "Looking up the route…"}</p>`}
    <div class="tele" id="fl-tele">
      <div><b id="t-alt">–</b><span>Altitude ft</span></div>
      <div><b id="t-gs">–</b><span>Ground speed kt</span></div>
      <div><b id="t-vr">–</b><span>Vertical ft/min</span></div>
      <div><b id="t-trk">–</b><span>Track</span></div>
      <div><b id="t-sq">–</b><span>Squawk</span></div>
      <div><b id="t-age">–</b><span>Last signal</span></div>
    </div>
    <div class="fl-actions">
      <button class="btn small" data-act="3d">${dim === "3d" ? "Back to 2D map" : "Track in 3D"}</button>
      <button class="btn ghost small ${follow ? "active" : ""}" data-act="follow">${follow ? "Following" : "Follow on map"}</button>
      ${r ? `<a class="btn ghost small" href="#routes?from=${esc(r.origin.icao)}&to=${esc(r.destination.icao)}">Route report</a>` : ""}
      <button class="btn ghost small" data-act="link">Copy link</button>
    </div>
    ${info?.track?.path?.length > 2 ? `<h3>Altitude profile · this flight</h3><div class="chart-box short"><canvas id="fl-alt"></canvas></div>` : ""}
    ${r ? safetyBlock(r) : ""}
    <h3>Aircraft</h3>
    <dl class="kv">
      <dt>Type</dt><dd>${typeName}${a.type ? ` <span class="muted mono small">${esc(a.type)}</span>` : ""}</dd>
      <dt>Marker</dt><dd>${iconHTML(a.cls, "#ececec", 16, 0)} ${esc(CLASSES[a.cls].label)}</dd>
      <dt>Registration</dt><dd>${esc(air?.registration || a.reg || "–")}</dd>
      ${air?.owner ? `<dt>Operator</dt><dd>${esc(air.owner)}${air.owner_country ? ` <span class="muted">· ${esc(air.owner_country)}</span>` : ""}</dd>` : ""}
      <dt>ICAO address</dt><dd class="mono">${a.hex.toUpperCase()}</dd>
      <dt>Data</dt><dd>${esc(a.src || "")}${(a.flags & 8) ? " · MLAT" : ""}</dd>
    </dl>
    <p class="note">Positions from community ADS-B receivers, smoothed between updates. Routes from adsbdb are the airline's usual schedule for this callsign. Delay and safety are screening estimates, not airline information.</p>`;
  updateTele();
  const path = info?.track?.path;
  if (path?.length > 2) {
    const t0 = path[0][0];
    makeChart($("#fl-alt"), {
      type: "line",
      data: { datasets: [{ data: path.map(p => ({ x: (p[0] - t0) / 60, y: p[3] ?? 0 })), borderColor: PAL.sand, backgroundColor: "rgba(238,138,79,.12)", fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.2 }] },
      options: { parsing: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => `${Math.round(i[0].parsed.x)} min after first fix`, label: (i) => `${fmtNum(i.parsed.y)} ft` } } },
        scales: { x: { type: "linear", title: { display: true, text: "minutes" }, ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true, ticks: { callback: (v) => v / 1000 + "k" } } } },
    });
  }
}
function safetyBlock(r) {
  if (!assess) return `<h3>Route safety &amp; delay</h3><p class="muted small">Rating the route…</p>`;
  if (assess.error) return `<h3>Route safety &amp; delay</h3><p class="muted small">Route rating unavailable: ${esc(assess.error)}</p>`;
  const s = assess.safety, d = assess.delay;
  return `<h3>Route safety &amp; delay</h3>
    <div class="fl-safety">
      <div class="grade-chip" style="--gc:${gradeColor(s.grade)}"><b>${s.grade}</b><span>${s.score}</span></div>
      <div><b>${esc(s.label)}</b><div class="small muted">${d.on_time_pct}% chance of arriving within 15 min of schedule · expected delay ${d.expected_min} min${assess.live?.holding_min ? ` · ~${assess.live.holding_min} min holding likely` : ""}</div></div>
    </div>
    <ul class="fl-notes">${s.notes.slice(0, 3).map(n => `<li>${esc(n)}</li>`).join("")}</ul>`;
}
function updateTele() {
  const a = selected;
  if (!a || !$("#t-alt")) return;
  const p = a._p || posAt(a, Date.now());
  $("#t-alt").textContent = fmtAlt(a, p[2]);
  $("#t-gs").textContent = a.gs != null ? fmtNum(a.gs) : "–";
  $("#t-vr").textContent = a.vr ? (a.vr > 0 ? "+" : "") + fmtNum(a.vr) : "0";
  $("#t-trk").textContent = a.trk != null ? Math.round(a.trk) + "°" : "–";
  $("#t-sq").textContent = a.sq || "–";
  const age = Math.max(0, Math.round((Date.now() - a.tFix) / 1000));
  $("#t-age").textContent = age < 90 ? age + " s" : Math.round(age / 60) + " min";
  $("#t-sq").parentElement.classList.toggle("alarm", !!(a.flags & FLAG_EMERG));
}

// ---------------------------------------------------------------------------------------------------------------
// Panels and 2D / 3D switching
function togglePanels() {
  const v = $("#view-flights"), bare = !v.classList.contains("bare");
  v.classList.toggle("bare", bare);
  $("#fl-panels").textContent = bare ? "Show panels" : "Hide panels";
  $("#fl-panels").setAttribute("aria-pressed", String(bare));
  setTimeout(() => { map.invalidateSize(); viewer3?.resize(); }, 420);
}
function setDim(d) {
  if (d === dim) return;
  dim = d;
  $$("#fl-dim button").forEach(b => b.classList.toggle("active", b.dataset.dim === d));
  $("#fl-cam").hidden = d !== "3d";
  $("#fl-globe").hidden = d !== "3d";
  $("#fl-map").style.visibility = d === "3d" ? "hidden" : "";
  $("#fl-legend").hidden = false;
  if (d === "3d") {
    try { ensure3D(); } catch (e) { toast("3D view needs WebGL: " + e.message); setDim("2d"); return; }
    viewer3.useDefaultRenderLoop = true;
    viewer3.resize();
    sync3D();
    if (selected) { enter3DSelection(); draw3DSelected(); }
    else flyToMapView();
  } else {
    if (viewer3) { viewer3.useDefaultRenderLoop = false; viewer3.camera.lookAtTransform(C().Matrix4.IDENTITY); }
    setTimeout(() => { map.invalidateSize(); if (selected?._p) map.setView([selected._p[0], selected._p[1]], Math.max(map.getZoom(), 7)); dirty = true; }, 30);
  }
  const b = $("#fl-panel [data-act='3d']");
  if (b) b.textContent = d === "3d" ? "Back to 2D map" : "Track in 3D";
}

// ---------------------------------------------------------------------------------------------------------------
// 3D: its own Cesium viewer (the shared globe is tuned for orbits and will not zoom closer than 1,000 km)
let viewer3 = null, bbs = null, bbOf = new Map(), model3 = null, sel3 = [], camInit = false, lastTrk = null;

function ensure3D() {
  if (viewer3) return viewer3;
  const Cs = C();
  if (!Cs) throw new Error("Cesium not loaded");
  viewer3 = new Cs.Viewer($("#fl-globe"), {
    baseLayer: Cs.ImageryLayer.fromProviderAsync(Cs.TileMapServiceImageryProvider.fromUrl(Cs.buildModuleUrl("Assets/Textures/NaturalEarthII"))),
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
    shouldAnimate: true, requestRenderMode: false, msaaSamples: 4,
  });
  try {
    const img = viewer3.imageryLayers.addImageryProvider(new Cs.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", maximumLevel: 17, credit: "Esri, Maxar" }));
    img.brightness = 0.85; img.saturation = 0.75;
    const lbl = viewer3.imageryLayers.addImageryProvider(new Cs.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", maximumLevel: 13 }));
    lbl.alpha = 0.8;
  } catch (e) { console.warn("[flights] imagery", e); }
  const sc = viewer3.scene;
  sc.globe.enableLighting = false;
  sc.fog.enabled = true; sc.fog.density = 1.2e-4;
  sc.skyAtmosphere.show = true;
  sc.backgroundColor = Cs.Color.fromCssColorString("#141414");
  sc.globe.maximumScreenSpaceError = 1.6;
  sc.light = new Cs.DirectionalLight({ direction: new Cs.Cartesian3(0.3, -0.4, -0.85), intensity: 2.4 });
  viewer3.clock.clockStep = Cs.ClockStep.SYSTEM_CLOCK;
  viewer3.cesiumWidget.creditContainer.style.display = "none";
  const ssc = sc.screenSpaceCameraController;
  ssc.minimumZoomDistance = 25; ssc.maximumZoomDistance = 40_000_000; ssc.inertiaZoom = 0.85;
  $("#fl-globe").addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    const cam = viewer3.camera, f = Math.max(-0.35, Math.min(0.35, -e.deltaY * 0.01));
    const h = cam.transform.equals(Cs.Matrix4.IDENTITY) ? cam.positionCartographic.height : Cs.Cartesian3.magnitude(cam.position);
    f > 0 ? cam.zoomIn(h * f) : cam.zoomOut(-h * f);
  }, { capture: true, passive: false });
  bbs = sc.primitives.add(new Cs.BillboardCollection({ scene: sc }));
  const handler = new Cs.ScreenSpaceEventHandler(sc.canvas);
  handler.setInputAction((m) => {
    const p = sc.pick(m.position);
    const hex = p?.id?.hex || (p?.id?.id === "fl-sel" ? selected?.hex : null);
    if (hex && hex !== selected?.hex) select(hex);
  }, Cs.ScreenSpaceEventType.LEFT_CLICK);
  sc.preRender.addEventListener(followCam);
  return viewer3;
}

function view3Center() {
  const Cs = C(), sc = viewer3.scene;
  const c = sc.globe.pick(viewer3.camera.getPickRay(new Cs.Cartesian2(sc.canvas.clientWidth / 2, sc.canvas.clientHeight / 2)), sc);
  if (!c) return selected ? [selected.lat, selected.lon] : null;
  const g = Cs.Cartographic.fromCartesian(c);
  return [Cs.Math.toDegrees(g.latitude), Cs.Math.toDegrees(g.longitude)];
}
const altM = (a, ft) => ((a.altg != null && !(a.flags & FLAG_GND) ? a.altg - (a.alt ?? 0) : 0) + (ft ?? 0)) * FT;   // geometric when known
function cartOf(a, tms, result) {
  const p = posAt(a, tms);
  return C().Cartesian3.fromDegrees(p[1], p[0], Math.max(2, altM(a, p[2])), undefined, result);
}

// Billboards for every aircraft, refreshed once a second (the selected one is a 3D model, updated per frame)
function sync3D() {
  if (!viewer3) return;
  const Cs = C(), now = Date.now(), seen = new Set();
  for (const a of ac.values()) {
    if (!shown(a)) continue;
    seen.add(a.hex);
    let b = bbOf.get(a.hex);
    const p = posAt(a, now);
    const col = colorOf(a, p[2]);
    const pos = Cs.Cartesian3.fromDegrees(p[1], p[0], Math.max(2, altM(a, p[2])));
    if (!b) {
      b = bbs.add({ position: pos, image: spriteURL(a.cls, col), width: 30 * CLASSES[a.cls].scale, height: 30 * CLASSES[a.cls].scale,
        alignedAxis: Cs.Cartesian3.UNIT_Z, rotation: -Cs.Math.toRadians(a.trk || 0), id: { hex: a.hex },
        scaleByDistance: new Cs.NearFarScalar(5e3, 1.4, 6e6, 0.45) });
      b._col = col;
      bbOf.set(a.hex, b);
    } else {
      b.position = pos;
      b.rotation = -Cs.Math.toRadians(a.trk || 0);
      if (b._col !== col) { b.image = spriteURL(a.cls, col); b._col = col; }
    }
    b.show = a !== selected;
  }
  for (const [hex, b] of bbOf) if (!seen.has(hex)) { bbs.remove(b); bbOf.delete(hex); }
}

function flyToMapView() {
  const Cs = C(), c = map.getCenter(), z = map.getZoom();
  viewer3.camera.lookAtTransform(Cs.Matrix4.IDENTITY);
  const h = 40_000_000 / Math.pow(2, z);
  viewer3.camera.flyTo({ destination: Cs.Cartesian3.fromDegrees(c.lng, c.lat - h / 250_000, h * 1.1),
    orientation: { heading: 0, pitch: Cs.Math.toRadians(-55), roll: 0 }, duration: 1.4 });
}

function enter3DSelection() {
  if (!viewer3 || !selected) return;
  const Cs = C(), a = selected;
  if (model3) viewer3.entities.remove(model3);
  model3 = viewer3.entities.add({
    id: "fl-sel",
    position: new Cs.CallbackProperty((t, r) => selected ? cartOf(selected, Date.now(), r) : undefined, false),
    orientation: new Cs.CallbackProperty((t, r) => {
      if (!selected) return undefined;
      const s = selected, pos = cartOf(s, Date.now());
      const pitch = s.gs > 60 && s.vr ? Math.atan2(s.vr * FT / 60, s.gs * 0.5144) : 0;
      // Cesium model forward is +X; heading 0 points east, so subtract 90° from a compass track
      return Cs.Transforms.headingPitchRollQuaternion(pos, new Cs.HeadingPitchRoll(Cs.Math.toRadians((s.trk || 0) - 90), Math.max(-0.25, Math.min(0.3, pitch)), 0), undefined, undefined, r);
    }, false),
    model: { uri: modelURL(a.cls), minimumPixelSize: 64, maximumScale: 4000, silhouetteColor: Cs.Color.WHITE.withAlpha(0.55), silhouetteSize: 1.2,
      color: (a.flags & FLAG_EMERG) ? Cs.Color.fromCssColorString(COLOR.emerg) : Cs.Color.WHITE, colorBlendMode: Cs.ColorBlendMode.MIX, colorBlendAmount: (a.flags & FLAG_EMERG) ? 0.5 : 0 },
    label: { text: a.cs || a.reg || a.hex.toUpperCase(), font: "600 13px Instrument Sans, sans-serif", fillColor: Cs.Color.WHITE, showBackground: true,
      backgroundColor: Cs.Color.fromCssColorString("rgba(20,20,20,.75)"), pixelOffset: new Cs.Cartesian2(0, -46), scale: 0.9,
      distanceDisplayCondition: new Cs.DistanceDisplayCondition(400, 5e6) },
  });
  camInit = false; lastTrk = null;
  if (camMode === "route") setCam("chase");
  else setCam(camMode);
  sync3D();
}
function clear3DSelected() {
  if (!viewer3) return;
  if (model3) viewer3.entities.remove(model3);
  model3 = null;
  sel3.forEach(e => viewer3.entities.remove(e)); sel3 = [];
  viewer3.camera.lookAtTransform(C().Matrix4.IDENTITY);
  sync3D();
}
// Flown track as a ribbon at altitude with a curtain to the ground, plus the remaining usual route with a descent profile
function draw3DSelected() {
  if (!viewer3 || !selected) return;
  const Cs = C(), a = selected;
  sel3.forEach(e => viewer3.entities.remove(e)); sel3 = [];
  const path = info?.track?.path;
  if (path?.length > 1) {
    const flat = [];
    for (const p of path) flat.push(p[2], p[1], Math.max(2, (p[3] ?? 0) * FT));
    const pos = Cs.Cartesian3.fromDegreesArrayHeights(flat);
    sel3.push(viewer3.entities.add({ polyline: { positions: pos, width: 3, material: new Cs.PolylineGlowMaterialProperty({ glowPower: 0.18, color: Cs.Color.fromCssColorString("#ee8a4f") }) } }));
    sel3.push(viewer3.entities.add({ wall: { positions: pos, material: Cs.Color.fromCssColorString("#ee8a4f").withAlpha(0.13), outline: false } }));
    const last = path[path.length - 1];
    sel3.push(viewer3.entities.add({ polyline: { width: 2, material: Cs.Color.fromCssColorString("#ee8a4f").withAlpha(0.8),
      positions: new Cs.CallbackProperty(() => selected ? [Cs.Cartesian3.fromDegrees(last[2], last[1], Math.max(2, (last[3] ?? 0) * FT)), cartOf(selected, Date.now())] : [], false) } }));
  }
  const r = liveRoute();
  if (r) {
    const p = a._p || [a.lat, a.lon, a.alt];
    const remKm = havKm(p[0], p[1], r.destination.lat, r.destination.lon);
    const cruiseM = Math.max(300, altM(a, p[2])), destM = (r.destination.elev_ft || 0) * FT;
    const descentKm = Math.max(40, (p[2] ?? 30000) / 1000 * 3 * 1.852);
    const pts = gcPoints(p[0], p[1], r.destination.lat, r.destination.lon, 80), flat = [];
    pts.forEach(([la, lo], i) => {
      const left = remKm * (1 - i / 80);
      const h = left > descentKm ? cruiseM : destM + (cruiseM - destM) * (left / descentKm);
      flat.push(lo, la, Math.max(destM + 2, h));
    });
    sel3.push(viewer3.entities.add({ polyline: { positions: Cs.Cartesian3.fromDegreesArrayHeights(flat), width: 2,
      material: new Cs.PolylineDashMaterialProperty({ color: Cs.Color.WHITE.withAlpha(0.75), dashLength: 18 }) } }));
    for (const ap of [r.origin, r.destination]) sel3.push(viewer3.entities.add({
      position: Cs.Cartesian3.fromDegrees(ap.lon, ap.lat, (ap.elev_ft || 0) * FT + 5),
      point: { pixelSize: 9, color: Cs.Color.fromCssColorString("#212121"), outlineColor: Cs.Color.WHITE, outlineWidth: 2 },
      label: { text: `${ap.iata || ap.icao} · ${ap.city || ""}`, font: "600 12px Instrument Sans, sans-serif", showBackground: true,
        backgroundColor: Cs.Color.fromCssColorString("rgba(20,20,20,.8)"), pixelOffset: new Cs.Cartesian2(0, -18), scale: 0.95 },
    }));
  }
}

function setCam(m) {
  camMode = m;
  $$("#fl-cam button").forEach(b => b.classList.toggle("active", b.dataset.cam === m));
  if (!viewer3) return;
  const Cs = C();
  if (m === "route" || m === "free" || !selected) {
    viewer3.camera.lookAtTransform(Cs.Matrix4.IDENTITY);
    if (m === "route" && selected) {
      const r = liveRoute(), p = selected._p || [selected.lat, selected.lon];
      const pts = r ? [[r.origin.lat, r.origin.lon], [r.destination.lat, r.destination.lon], [p[0], p[1]]] : [[p[0], p[1]]];
      const bs = Cs.BoundingSphere.fromPoints(pts.map(([la, lo]) => Cs.Cartesian3.fromDegrees(lo, la, 10000)));
      viewer3.camera.flyToBoundingSphere(bs, { offset: new Cs.HeadingPitchRange(Cs.Math.toRadians((selected.trk || 0) + 180), Cs.Math.toRadians(-38), Math.max(bs.radius * 2.8, 60_000)), duration: 1.6 });
    }
    return;
  }
  camInit = false;
}
// Chase / orbit camera: keep the camera's offset in the aircraft's local frame each frame, so the mouse can still
// orbit and zoom; in chase mode the offset also turns with the aircraft.
function followCam() {
  if (!selected || !model3 || (camMode !== "chase" && camMode !== "orbit")) return;
  const Cs = C(), cam = viewer3.camera, a = selected;
  const p = cartOf(a, Date.now());
  const T = Cs.Transforms.eastNorthUpToFixedFrame(p);
  let off;
  const trk = a.trk || 0;
  if (!camInit || cam.transform.equals(Cs.Matrix4.IDENTITY)) {
    const R = Math.max(120, modelLength(a.cls) * 4.2), t = Cs.Math.toRadians(trk);
    off = new Cs.Cartesian3(-Math.sin(t) * R, -Math.cos(t) * R, R * 0.32);
    camInit = true;
  } else {
    off = Cs.Cartesian3.clone(cam.position);
    if (camMode === "chase" && lastTrk != null) {
      let d = trk - lastTrk;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      const r = Cs.Math.toRadians(d), x = off.x, y = off.y;
      off.x = x * Math.cos(r) + y * Math.sin(r);
      off.y = -x * Math.sin(r) + y * Math.cos(r);
    }
  }
  lastTrk = trk;
  cam.lookAtTransform(T, off);
  // light from over the camera's shoulder so the model always reads, day or night
  const up = Cs.Cartesian3.normalize(p, new Cs.Cartesian3());
  const dir = Cs.Cartesian3.add(Cs.Cartesian3.multiplyByScalar(up, -0.9, new Cs.Cartesian3()), cam.directionWC, new Cs.Cartesian3());
  viewer3.scene.light.direction = Cs.Cartesian3.normalize(dir, dir);
}

// Hook for automated browser tests
export const __test = { ac, select: (h, o) => select(h, o), setDim: (d) => setDim(d), setCam: (m) => setCam(m) };
