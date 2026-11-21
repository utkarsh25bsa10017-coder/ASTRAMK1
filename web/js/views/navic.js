import { api, on } from "../core/api.js";
import { mountGlobe, simDate } from "../core/globe.js";
import { satrec, ecfAt, geodeticAt, observer, look, dop, dopQuality, groundTrack, orbitInfo } from "../core/orbitmath.js";
import { $, $$, esc, fmtNum, fmtUTC, timeAgo, toast, TYPE_ICON } from "../core/util.js";

const C = () => window.Cesium;
const MASK = 10; // elevation mask, degrees

// Operational status from CelesTrak SATCAT (snapshot 2026-11-21), used only if the live catalogue is unreachable
const STATUS_FALLBACK = { 39199: "P", 39635: "+", 40269: "P", 40547: "-", 41241: "P", 41384: "P", 41469: "P", 43286: "+", 56759: "+", 62850: "-", 101228: "+" };
const STATUS_TXT = { "+": ["Operational", "op"], P: ["Partial", "part"], "-": ["Failed", "off"], D: ["Re-entered", "off"] };

let viewer, navic = [], gps = [], statusSrc = "live catalogue";
let obsLat = 28.6139, obsLon = 77.209, obsName = "New Delhi (default)";
let entities = [], timer = null, pdopMap = null, pdopLayer = null, pdopMode = "navic", active = false;
let alerts = [];

// ---------------------------------------------------------------------------
export async function init() {
  viewer = mountGlobe($("#navic-globe-slot"));
  $("#btn-locate").onclick = locate;
  $("#navic-partial").onchange = () => { refresh(); drawPdop(); };
  $$("#pdop-seg button").forEach(b => b.onclick = () => {
    $$("#pdop-seg button").forEach(x => x.classList.toggle("active", x === b));
    pdopMode = b.dataset.mode; drawPdop();
  });
  $("#bc-send").onclick = compose;
  on("broadcast", (a) => preselect(a));

  pdopMap = L.map("pdop-map", { center: [15, 82], zoom: 2, zoomControl: false, attributionControl: false, worldCopyJump: true });
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 10 }).addTo(pdopMap);
  L.rectangle([[-30, 30], [50, 130]], { color: "#ff9f1c", weight: 1.5, fill: false, dashArray: "5 4" }).bindTooltip("NavIC extended service area (30°S–50°N, 30°E–130°E)").addTo(pdopMap);

  await loadOrbits();
  loadAlerts();
}

export function show() {
  active = true;
  viewer = mountGlobe($("#navic-globe-slot"));
  entities.forEach(e => e.show = true);
  setTimeout(() => pdopMap.invalidateSize(), 60);
  viewer.camera.flyTo({ destination: C().Cartesian3.fromDegrees(82, 12, 95_000_000), duration: 1.2 });
  viewer.clock.currentTime = C().JulianDate.now();
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = true;
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 5000);
  if (window.__astraBroadcast) { preselect(window.__astraBroadcast); window.__astraBroadcast = null; }
}

export function hide() {
  active = false;
  entities.forEach(e => e.show = false);
  clearInterval(timer); timer = null;
}

// ---------------------------------------------------------------------------
async function loadOrbits() {
  try {
    const [g, p] = await Promise.all([api("/api/orbits/gnss", { ttl: 3_600_000 }), api("/api/orbits/gps", { ttl: 3_600_000 }).catch(() => ({ sats: [] }))]);
    let status = {};
    try {
      const st = await api("/api/catalog/stats", { ttl: 3_600_000 });
      st.navic.forEach(n => status[n.norad] = n.status);
    } catch { status = STATUS_FALLBACK; statusSrc = "CelesTrak SATCAT snapshot 2026-11-21"; }
    const now = new Date();
    navic = g.sats.filter(s => /IRNSS|NVS-0/.test(s[1])).map(([norad, name, l1, l2]) => ({ norad, name: name.replace(/\s*\(IRNSS-1\w\)/, ""), full: name, rec: satrec(l1, l2), status: status[norad] ?? STATUS_FALLBACK[norad] ?? "?" }))
      .filter(s => s.rec && orbitInfo(s.rec).periodMin > 1300);   // drop NVS-02 stuck in transfer orbit from geometry (kept in table below)
    const stuck = g.sats.filter(s => /NVS-02/.test(s[1]));
    stuck.forEach(([norad, name, l1, l2]) => navic.push({ norad, name: name.replace(/\s*\(IRNSS-1\w\)/, ""), full: name, rec: satrec(l1, l2), status: status[norad] ?? "-", stuck: true }));
    gps = p.sats.map(([norad, name, l1, l2]) => ({ norad, name, rec: satrec(l1, l2) }))
      .filter(s => s.rec && Math.abs(orbitInfo(s.rec).periodMin - 718) < 20 && (now - orbitInfo(s.rec).epoch) < 30 * 86400000);
    const seen = new Set(); gps = gps.filter(s => !seen.has(s.norad) && seen.add(s.norad));
    buildGlobe();
    refresh();
    drawPdop();
  } catch (e) {
    $("#navic-table").innerHTML = `<tbody><tr><td class="muted">NavIC orbits unavailable: ${esc(e.message)}</td></tr></tbody>`;
  }
}

function usable(s) {
  if (s.stuck) return false;
  return s.status === "+" || (s.status === "P" && $("#navic-partial").checked);
}

function buildGlobe() {
  entities.forEach(e => viewer.entities.remove(e));
  entities = [];
  const now = new Date();
  for (const s of navic) {
    const col = C().Color.fromCssColorString(s.stuck || s.status === "-" ? "#6b7690" : s.status === "+" ? "#ff9f1c" : "#ffc94d");
    const track = groundTrack(s.rec, now, 24, 15);
    if (!s.stuck) entities.push(viewer.entities.add({
      polyline: { positions: track.map(p => C().Cartesian3.fromDegrees(p.lon, p.lat, 0)), width: 1.5, material: col.withAlpha(0.6), arcType: C().ArcType.GEODESIC },
    }));
    const ent = viewer.entities.add({
      position: new (C().CallbackProperty)(() => {
        const f = ecfAt(s.rec, simDate());
        return f ? new (C().Cartesian3)(f.x * 1000, f.y * 1000, f.z * 1000) : undefined;
      }, false),
      point: { pixelSize: 9, color: col, outlineColor: C().Color.WHITE, outlineWidth: 1 },
      label: { text: s.name, font: "12px sans-serif", fillColor: C().Color.WHITE, pixelOffset: new (C().Cartesian2)(0, -16), showBackground: true, backgroundColor: C().Color.fromCssColorString("rgba(12,19,34,.75)"), scale: 0.9 },
    });
    s.entity = ent;
    entities.push(ent);
  }
  // Extended service area outline
  entities.push(viewer.entities.add({
    rectangle: { coordinates: C().Rectangle.fromDegrees(30, -30, 130, 50), material: C().Color.fromCssColorString("#ff9f1c").withAlpha(0.06), outline: true, outlineColor: C().Color.fromCssColorString("#ff9f1c"), height: 0 },
  }));
  const obsEnt = viewer.entities.add({
    position: new (C().CallbackProperty)(() => C().Cartesian3.fromDegrees(obsLon, obsLat), false),
    point: { pixelSize: 8, color: C().Color.fromCssColorString("#63d2ff"), outlineColor: C().Color.WHITE, outlineWidth: 2 },
  });
  entities.push(obsEnt);
  if (!active) entities.forEach(e => e.show = false);
}

// ---------------------------------------------------------------------------
function looksFor(list, lat, lon, t) {
  const obs = observer(lat, lon, 0);
  return list.map(s => { const f = ecfAt(s.rec, t); return f ? { s, ...look(obs, f) } : null; }).filter(Boolean);
}

function refresh() {
  if (!navic.length) return;
  const t = simDate();
  const nl = looksFor(navic, obsLat, obsLon, t);
  const gl = looksFor(gps, obsLat, obsLon, t);
  $("#obs-label").textContent = `${obsName} · ${obsLat.toFixed(2)}, ${obsLon.toFixed(2)}`;

  $("#navic-table").innerHTML = `<thead><tr><th>Satellite</th><th>Status</th><th class="num">Elev</th><th class="num">Lon</th></tr></thead><tbody>` +
    nl.map(({ s, el }) => {
      const g = geodeticAt(s.rec, t);
      const [txt, cls] = STATUS_TXT[s.status] || [s.status, "off"];
      return `<tr title="${esc(s.full)} · NORAD ${s.norad}${s.stuck ? " · stranded in transfer orbit" : ""}"><td>${esc(s.name)}</td><td><span class="st ${cls}">${txt}</span></td>
        <td class="num" style="color:${el >= MASK ? "var(--text)" : "var(--muted)"}">${el.toFixed(0)}°</td><td class="num">${s.stuck ? "GTO" : g ? g.lon.toFixed(1) + "°" : "–"}</td></tr>`;
    }).join("") + `</tbody>`;
  $("#navic-table").insertAdjacentHTML("beforeend", `<caption class="note" style="caption-side:bottom;text-align:left">Status: ${esc(statusSrc)}. Elevation mask ${MASK}°.</caption>`);

  const nUse = nl.filter(x => x.el >= MASK && usable(x.s));
  const gUse = gl.filter(x => x.el >= MASK);
  const cards = [
    ["NavIC only", dop(nUse), nUse.length, "var(--navic)"],
    ["GPS only", dop(gUse), gUse.length, "var(--gps)"],
    ["NavIC + GPS", dop([...nUse, ...gUse]), nUse.length + gUse.length, "var(--accent)"],
  ];
  $("#dop-cards").innerHTML = cards.map(([h, d, n, c]) => {
    const [q, qc] = dopQuality(d?.pdop);
    return `<div class="dop-card" style="border-top:2px solid ${c}"><div class="h">${h}</div>
      <div class="v" style="color:${qc}">${d ? d.pdop.toFixed(1) : "–"}</div>
      <div class="s">PDOP · ${q} · ${n} satellites used${d ? ` · HDOP ${d.hdop.toFixed(1)} · VDOP ${d.vdop.toFixed(1)}` : n < 4 ? " (need ≥ 4)" : ""}</div></div>`;
  }).join("");
  drawSky(nl, gl);
}

function drawSky(nl, gl) {
  const cv = $("#skyplot");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 300;
  cv.width = W * dpr; cv.height = W * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = W / 2, cy = W / 2, R = W / 2 - 18;
  ctx.clearRect(0, 0, W, W);
  ctx.strokeStyle = "rgba(141,155,181,.25)"; ctx.fillStyle = "#8d9bb5"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  for (const e of [0, 30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, R * (90 - e) / 90, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(cx, cy, R * (90 - MASK) / 90, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  for (let a = 0; a < 360; a += 45) { const r = a * Math.PI / 180; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(r), cy - R * Math.cos(r)); ctx.stroke(); }
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([t, a]) => { const r = a * Math.PI / 180; ctx.fillText(t, cx + (R + 10) * Math.sin(r), cy - (R + 10) * Math.cos(r) + 3); });
  const plot = (list, color, labels) => list.forEach(({ s, el, az }) => {
    if (el < 0) return;
    const r = R * (90 - el) / 90, a = az * Math.PI / 180;
    const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
    const on = el >= MASK && (labels ? usable(s) : true);
    ctx.fillStyle = on ? color : "#4a5670";
    ctx.beginPath(); ctx.arc(x, y, labels ? 6 : 4, 0, Math.PI * 2); ctx.fill();
    if (labels) { ctx.fillStyle = "#e6edf7"; ctx.fillText(s.name.replace("IRNSS-", ""), x, y - 9); }
  });
  plot(gl, "#4ea8ff", false);
  plot(nl, "#ff9f1c", true);
}

// ---------------------------------------------------------------------------
function drawPdop() {
  if (!navic.length || !pdopMap) return;
  if (pdopLayer) pdopMap.removeLayer(pdopLayer);
  const renderer = L.canvas({ padding: 0.2 });
  pdopLayer = L.layerGroup().addTo(pdopMap);
  const t = simDate(), step = 3;
  const navUse = navic.filter(usable);
  for (let lat = -45; lat < 60; lat += step) {
    for (let lon = 10; lon < 150; lon += step) {
      const cLat = lat + step / 2, cLon = lon + step / 2;
      let ls = [];
      if (pdopMode !== "gps") ls = ls.concat(looksFor(navUse, cLat, cLon, t).filter(x => x.el >= MASK));
      if (pdopMode !== "navic") ls = ls.concat(looksFor(gps, cLat, cLon, t).filter(x => x.el >= MASK));
      const d = dop(ls);
      const [, color] = dopQuality(d?.pdop);
      L.rectangle([[lat, lon], [lat + step, lon + step]], { renderer, stroke: false, fillColor: color, fillOpacity: d ? 0.45 : 0.25, interactive: false }).addTo(pdopLayer);
    }
  }
  L.circleMarker([obsLat, obsLon], { radius: 4, color: "#fff", weight: 2, fillColor: "#63d2ff", fillOpacity: 1 }).addTo(pdopLayer);
}

function locate() {
  if (!navigator.geolocation) { toast("Geolocation is not available in this browser."); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    obsLat = p.coords.latitude; obsLon = p.coords.longitude; obsName = "Your location";
    refresh(); drawPdop();
  }, () => toast("Location permission denied; keeping New Delhi."), { timeout: 10000 });
}

// ---------------------------------------------------------------------------
// Emergency broadcast simulator
async function loadAlerts() {
  try {
    const d = await api("/api/alerts", { ttl: 120_000 });
    alerts = d.alerts.filter(a => a.lat != null && (a.source === "sachet" || a.severity >= 2))
      .sort((a, b) => (b.severity - a.severity) || (new Date(b.time) - new Date(a.time))).slice(0, 80);
    $("#bc-alert").innerHTML = alerts.map(a => `<option value="${esc(a.id)}">[${a.source.toUpperCase()} · ${a.type}] ${esc(a.title.slice(0, 90))}</option>`).join("");
  } catch (e) {
    $("#bc-alert").innerHTML = `<option>Alerts unavailable</option>`;
  }
}

function preselect(a) {
  if (!a) return;
  if (!alerts.find(x => x.id === a.id)) {
    alerts.unshift(a);
    $("#bc-alert").insertAdjacentHTML("afterbegin", `<option value="${esc(a.id)}">[${a.source.toUpperCase()} · ${a.type}] ${esc(a.title.slice(0, 90))}</option>`);
  }
  $("#bc-alert").value = a.id;
  compose();
}

const HAZ = ["other", "cyclone", "flood", "rain", "earthquake", "tsunami", "landslide", "wildfire", "volcano", "drought", "heat", "wind"];

function crc24q(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  return crc & 0xffffff;
}

class Bits {
  constructor() { this.b = []; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) this.b.push((v >>> i) & 1); }
  bytes() { const out = []; for (let i = 0; i < this.b.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | (this.b[i + j] || 0); out.push(v); } return out; }
}

function shortText(a) {
  let t = (a.title || "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/ continues to flow in /i, " ").replace(/ at \d+:\d+ [ap]m today\.?/i, "");
  return t.slice(0, 120).toUpperCase();
}

function compose() {
  const a = alerts.find(x => x.id === $("#bc-alert").value);
  if (!a) return;
  const t = simDate();
  const text = shortText(a);
  const issued = new Date(a.time || t);
  const validH = a.expires ? Math.max(1, Math.min(63, Math.round((new Date(a.expires) - issued) / 3600000))) : 24;
  let radiusKm = 25;
  if (a.rings?.length) {
    const pts = a.rings.flat();
    radiusKm = Math.max(...pts.map(([lo, la]) => Math.hypot((la - a.lat) * 111, (lo - a.lon) * 111 * Math.cos(a.lat * Math.PI / 180))));
  }
  const bits = new Bits();
  bits.put(0b101101, 6);                                   // illustrative message-type id
  bits.put(Math.max(0, HAZ.indexOf(a.type)), 4);           // hazard
  bits.put(a.severity & 3, 2);                             // severity
  bits.put(Math.round((a.lat + 90) * 100) & 0x7fff, 15);   // lat, 0.01°
  bits.put(Math.round((a.lon + 180) * 100) & 0xffff, 16);  // lon, 0.01°
  bits.put(Math.min(255, Math.round(radiusKm / 4)), 8);    // radius, 4 km steps
  bits.put(validH, 6);                                     // validity, hours
  bits.put(Math.floor(issued.getTime() / 60000) & 0xfffff, 20); // issue time, minutes (mod 2^20)
  bits.put(text.length, 7);
  for (const ch of text) bits.put(ch.charCodeAt(0) & 0x7f, 7);
  const crc = crc24q(bits.bytes());
  bits.put(crc, 24);
  const nBits = bits.b.length;
  const hex = bits.bytes().map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const perSubframe = 220;           // assumed spare payload bits per 12 s subframe (illustrative)
  const subframes = Math.ceil(nBits / perSubframe);

  const relay = looksFor(navic.filter(s => !s.stuck && s.status !== "-"), a.lat, a.lon, t).filter(x => x.el >= MASK).sort((x, y) => y.el - x.el);
  const usableRelay = relay.filter(x => x.s.status === "+");
  const inService = a.lat >= -30 && a.lat <= 50 && a.lon >= 30 && a.lon <= 130;
  const sevTxt = ["ADVISORY", "WATCH", "WARNING", "EMERGENCY"][a.severity];

  $("#bc-out").innerHTML = `
    <dl class="kv">
      <dt>Alert</dt><dd>${esc(a.title.slice(0, 110))}</dd>
      <dt>Target area</dt><dd>${a.lat.toFixed(2)}, ${a.lon.toFixed(2)} · radius ≈ ${fmtNum(radiusKm)} km</dd>
      <dt>Service area</dt><dd>${inService ? "Inside NavIC coverage" : "<span style='color:var(--danger)'>Outside NavIC service area</span>"}</dd>
      <dt>Frame size</dt><dd>${nBits} bits (incl. CRC-24Q) → ${subframes} subframe${subframes > 1 ? "s" : ""} ≈ ${subframes * 12} s airtime</dd>
      <dt>Relay satellites</dt><dd>${relay.length ? relay.map(x => `<span class="st ${x.s.status === "+" ? "op" : "part"}">${esc(x.s.name)} ${x.el.toFixed(0)}°</span>`).join(" ") : "<span style='color:var(--danger)'>none above mask</span>"}</dd>
    </dl>
    <div class="frame" title="Encoded frame (hex)">${hex}</div>
    <div class="receiver">
      <div class="hdr"><span>NavIC messaging receiver</span><span>${usableRelay.length ? "SIGNAL ●●●" : relay.length ? "SIGNAL ●●○" : "NO SIGNAL"}</span></div>
      <div class="scr">⚠ ${sevTxt}: ${esc(a.type.toUpperCase())}
${esc(text)}
VALID ${validH} H FROM ${issued.toISOString().slice(11, 16)} UTC
AREA ${a.lat.toFixed(2)}N ${a.lon.toFixed(2)}E R${fmtNum(radiusKm)}KM</div>
    </div>
    <p class="note">Simulation for demonstration: the frame layout is ASTRA's own compact design (not the official NavIC ICD message format). Satellite visibility is computed live from orbital elements; only fully operational satellites give full signal.</p>`;
}
