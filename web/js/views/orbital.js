import { api } from "../core/api.js";
import { mountGlobe, simDate, onTiles } from "../core/globe.js";
import { satrec, geodeticAt, orbitInfo, ecfAt } from "../core/orbitmath.js";
import { $, $$, esc, fmtNum, timeAgo, fmtUTC, fmtIST, toast, makeChart } from "../core/util.js";
import { progressLoader } from "../core/loader.js";
import { satIcon } from "../core/sat-icon.js";

const C = () => window.Cesium;
let viewer, points, billboards, labels, hoverLabel, worker, screenWorker, active = false;
let sats = [];            // rows from /api/catalog/orbits?part=…
let catOf = [];           // category per index
let iconOf = new Int32Array(0);   // billboard index per object, -1 = plain dot
let vis = new Uint8Array(0);      // 0 hidden, 1 dot, 2 icon
let visDirty = true, needDraw = true;
const byNorad = new Map();
let selected = -1, selEntity = null, conjEntity = null, focusSet = null, hoverIdx = -1;
let conjData = null, statsData = null;
let screenReady = false;

// Default view: the three layers that tell the story. The rest sit under "More layers".
const CATS = {
  PAY: { label: "Active payloads", color: "#8fb996", size: 2.2, on: true },
  DEB: { label: "Debris fragments", color: "#e2603a", size: 1.8, on: true },
  IND: { label: "Indian objects", color: "#f29a2e", size: 4, on: true },
  RB: { label: "Rocket bodies", color: "#c9a34e", size: 2.4, on: false },
  CL0: { label: "Fengyun-1C ASAT debris (2007)", color: "#f2d16b", size: 2.4, on: false },
  CL1: { label: "Cosmos 2251 collision debris (2009)", color: "#f08a5d", size: 2.4, on: false },
  CL2: { label: "Iridium 33 collision debris (2009)", color: "#7fa8c4", size: 2.4, on: false },
  CL3: { label: "Cosmos 1408 ASAT debris (2021)", color: "#c25b9b", size: 2.6, on: false },
  DEC: { label: "Decaying / re-entry watch", color: "#ede6d8", size: 4, on: false },
  UNK: { label: "Unknown", color: "#7d7566", size: 1.6, on: false },
};
const PRIMARY = ["PAY", "DEB", "IND"];
const MAX_ICONS = 200;
const TYPE_NAMES = ["Payload", "Rocket body", "Debris", "Unknown"];
const STATUS = { "+": "Operational", "-": "Non-operational", P: "Partially operational", B: "Backup", S: "Spare", X: "Extended mission", D: "Decayed", "?": "Unknown", "": "Not in catalogue" };
const ICON_COLOR = (st) => st === "-" ? "#8a8f99" : st === "P" ? "#f4c04e" : "#ff8a2a";

function categorise(s) {
  const [, , , , type, , flags, cloud] = s;
  if (flags & 2) return "DEC";
  if (flags & 1) return "IND";
  if (type === 2 && cloud >= 0) return "CL" + cloud;
  return ["PAY", "RB", "DEB", "UNK"][type] || "UNK";
}

// ---------------------------------------------------------------------------
// Loading progress: real, weighted steps
const W = { engine: 20, dl: { payloads: 14, "rocket-bodies": 4, debris: 12 }, parse: 25, pos: 10, tiles: 15 };
const prog = { engine: 0, dl: { payloads: 0, "rocket-bodies": 0, debris: 0 }, parsed: 0, expect: 28000, pos: 0, tiles: 0 };
let loader = null, loaderStep = "";
function progress(step) {
  if (step) loaderStep = step;
  if (!loader) return;
  const pct = W.engine * prog.engine + Object.entries(W.dl).reduce((s, [k, w]) => s + w * prog.dl[k], 0)
    + W.parse * Math.min(1, prog.parsed / prog.expect) + W.pos * prog.pos + W.tiles * prog.tiles;
  loader.set(pct, loaderStep);
  if (pct >= 99.5) { loader.done(); loader = null; }
}

// ---------------------------------------------------------------------------
export async function init() {
  viewer = mountGlobe($("#orbital-globe-slot"));
  loader = progressLoader($("#orbital-globe-slot"), "Loading orbits");
  prog.engine = 1; progress("3D engine ready");
  onTiles((f) => { prog.tiles = f; progress(); });
  setTimeout(() => { prog.tiles = 1; progress(); }, 10000);   // offline: don't wait for imagery forever

  points = viewer.scene.primitives.add(new (C().PointPrimitiveCollection)());
  billboards = viewer.scene.primitives.add(new (C().BillboardCollection)());
  labels = viewer.scene.primitives.add(new (C().LabelCollection)());
  hoverLabel = labels.add({ show: false, text: "", font: "12px JetBrains Mono, monospace", fillColor: C().Color.WHITE, showBackground: true,
    backgroundColor: C().Color.fromCssColorString("rgba(14,16,20,.88)"), pixelOffset: new (C().Cartesian2)(0, -20), position: C().Cartesian3.ZERO });

  initTimebar();
  $$("#view-orbital .tabs-inner button[data-pane]").forEach(b => b.onclick = () => showPane(b.dataset.pane));
  $("#btn-stats").onclick = () => toggleStats(true);
  $("#stats-close").onclick = () => toggleStats(false);
  $("#conj-sort").onchange = renderConj;
  $("#conj-all").onchange = renderConj;

  const handler = new (C().ScreenSpaceEventHandler)(viewer.scene.canvas);
  const pickIdx = (pos) => {
    const pick = viewer.scene.pick(pos);
    return pick && (pick.collection === points || pick.collection === billboards) && typeof pick.id === "number" ? pick.id : -1;
  };
  handler.setInputAction((e) => { if (!active) return; const i = pickIdx(e.position); if (i >= 0) select(i, false); }, C().ScreenSpaceEventType.LEFT_CLICK);
  let lastMove = 0;
  handler.setInputAction((e) => {
    if (!active || performance.now() - lastMove < 140) return;
    lastMove = performance.now();
    const i = pickIdx(e.endPosition);
    if (i !== hoverIdx) {
      hoverIdx = i;
      hoverLabel.show = i >= 0;
      if (i >= 0) hoverLabel.text = sats[i][1];
      viewer.scene.canvas.style.cursor = i >= 0 ? "pointer" : "";
      needDraw = true;
    }
  }, C().ScreenSpaceEventType.MOUSE_MOVE);

  viewer.scene.preRender.addEventListener(frame);
  $("#sat-search").addEventListener("input", onSearch);
  document.addEventListener("keydown", onKey);

  loadConjunctions();
  loadStats();
  await loadCatalog();
}

export function show() {
  active = true;
  viewer = mountGlobe($("#orbital-globe-slot"));
  points.show = billboards.show = labels.show = true;
  if (selEntity) selEntity.show = true;
  if (conjEntity) conjEntity.show = true;
  needDraw = true;
  syncTimebar(true);
  if (window.__astraPendingConj && sats.length) {
    const p = window.__astraPendingConj; window.__astraPendingConj = null;
    jumpToConj(p.a, p.b, p.t);
  }
}

export function hide() {
  active = false;
  if (points) points.show = billboards.show = labels.show = false;
  if (selEntity) selEntity.show = false;
  if (conjEntity) conjEntity.show = false;
}

// ---------------------------------------------------------------------------
// Time bar: slider from now − 6 h to now + 7 d, ±10 min steps (Shift = 1 h), speeds, zoom.
const BACK = 6 * 3600e3, FWD = 7 * 86400e3;
let t0 = Date.now() - BACK, dragging = false;

function initTimebar() {
  const r = $("#t-range");
  r.min = 0; r.max = (BACK + FWD) / 60000; r.step = 1;
  r.addEventListener("input", () => { dragging = true; setSim(t0 + +r.value * 60000); });
  r.addEventListener("change", () => { dragging = false; });
  $("#t-minus").onclick = (e) => stepSim(e.shiftKey ? -60 : -10);
  $("#t-plus").onclick = (e) => stepSim(e.shiftKey ? 60 : 10);
  $("#btn-now").onclick = () => { t0 = Date.now() - BACK; clearConjFocus(); setSim(Date.now()); setSpeed(1); };
  $$("#timebar [data-speed]").forEach(b => b.onclick = () => { clearConjFocus(); setSpeed(+b.dataset.speed); });
  $("#z-in").onclick = () => viewer.camera.zoomIn(viewer.camera.positionCartographic.height * 0.3);
  $("#z-out").onclick = () => viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.3);
  setSpeed(1);
}

function onKey(e) {
  if (!active || document.querySelector(".tour") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    stepSim((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 60 : 10));
    e.preventDefault();
  }
}

function setSpeed(x) {
  viewer.clock.multiplier = x;
  viewer.clock.shouldAnimate = true;
  $$("#timebar [data-speed]").forEach(b => b.classList.toggle("active", +b.dataset.speed === x));
}

function setSim(ms) {
  viewer.clock.currentTime = C().JulianDate.fromDate(new Date(ms));
  needDraw = true;
  syncTimebar(true);
  updateObjectLive();
}
const stepSim = (min) => setSim(simDate().getTime() + min * 60000);

function syncTimebar(force) {
  const r = $("#t-range");
  if (!r) return;
  const t = simDate().getTime();
  if (!dragging || force) r.value = Math.round((t - t0) / 60000);
  const pct = (+r.value - +r.min) / (+r.max - +r.min);
  const lab = $("#t-label");
  const d = Math.round((t - Date.now()) / 60000);
  const rel = Math.abs(d) < 2 ? "now" : `${d > 0 ? "+" : "−"}${Math.abs(d) >= 1440 ? (Math.abs(d) / 1440).toFixed(1) + " d" : Math.abs(d) >= 60 ? Math.floor(Math.abs(d) / 60) + " h " + (Math.abs(d) % 60) + " m" : Math.abs(d) + " min"}`;
  lab.textContent = `${fmtIST(new Date(t))} · ${rel}`;
  // Centre on the thumb, but keep the whole label inside the track
  const tw = lab.parentElement.clientWidth, lw = lab.offsetWidth;
  const x = pct * (tw - 14) + 7;
  lab.style.left = `${Math.max(lw / 2, Math.min(tw - lw / 2, x)).toFixed(1)}px`;
}

function drawTimeTicks() {
  const el = $("#t-ticks");
  if (!el) return;
  const span = BACK + FWD;
  const at = (ms) => (100 * (ms - t0) / span).toFixed(2);
  let html = `<i class="now" style="left:${at(Date.now())}%"></i>`;
  for (let d = 1; d <= 7; d++) html += `<i class="day" style="left:${at(Date.now() + d * 86400e3)}%"></i>`;
  (conjData?.india || []).filter(r => r.rangeKm < 5).forEach(r => {
    const t = new Date(r.tca).getTime();
    if (t > t0 && t < t0 + span) html += `<i class="tca" style="left:${at(t)}%"></i>`;
  });
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Smooth motion. The worker returns position + velocity keyframes (inertial frame) every 10–60 s of SIM time;
// every frame we interpolate (cubic Hermite) and rotate to Earth-fixed. 600× → about 10 keyframes per second.
const KF = { list: [], want: new Set(), inflight: 0, gen: 0 };
let lastDraw = -Infinity, lastUi = 0, lastLive = 0;

const spacing = () => viewer.clock.shouldAnimate ? Math.min(60000, Math.max(10000, Math.abs(viewer.clock.multiplier) * 250)) : 10000;

function requestKf(t) {
  if (!worker || KF.inflight >= 2 || KF.want.has(t) || KF.list.some(k => k.t === t)) return;
  KF.want.add(t); KF.inflight++;
  worker.postMessage({ type: "kf", time: t, gen: KF.gen });
}

function resetKf() { KF.gen++; KF.list = []; KF.want.clear(); needDraw = true; }

function onKeyframe(m) {
  KF.inflight = Math.max(0, KF.inflight - 1);
  if (m.gen !== KF.gen) return;
  KF.want.delete(m.time);
  KF.list.push({ t: m.time, n: m.n, pos: m.pos, vel: m.vel });
  KF.list.sort((a, b) => a.t - b.t);
  const t = simDate().getTime(), dt = spacing();
  KF.list = KF.list.filter(k => k.t >= t - 3 * dt && k.t <= t + 6 * dt);
  while (KF.list.length > 6) KF.list.splice(Math.abs(KF.list[0].t - t) > Math.abs(KF.list.at(-1).t - t) ? 0 : KF.list.length - 1, 1);
  needDraw = true;
  if (!prog.pos) { prog.pos = 1; progress("Orbits ready"); }
}

function frame() {
  if (!active || !worker || !sats.length) return;
  const t = simDate().getTime();
  const dt = spacing(), base = Math.floor(t / dt) * dt;
  requestKf(base); requestKf(base + dt);
  if (viewer.clock.shouldAnimate && viewer.clock.multiplier > 1) requestKf(base + 2 * dt);
  if (needDraw || visDirty || Math.abs(t - lastDraw) >= 250) draw(t);
  const now = performance.now();
  if (now - lastUi > 200) { lastUi = now; syncTimebar(false); }
  if (now - lastLive > 1000) { lastLive = now; updateObjectLive(); }
}

function applyVis() {
  const n = points.length;
  if (vis.length !== n) vis = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const on = CATS[catOf[i]].on && (!focusSet || focusSet.has(i) || i === selected);
    const v = !on ? 0 : iconOf[i] >= 0 ? 2 : 1;
    vis[i] = v;
    if (v !== 1) points.get(i).show = false;
    if (iconOf[i] >= 0 && v !== 2) billboards.get(iconOf[i]).show = false;
  }
  visDirty = false;
}

function draw(t) {
  let a = null, b = null;
  for (const k of KF.list) { if (k.t <= t) a = k; else { b = k; break; } }
  let mode = null;
  if (a && b && b.t - a.t <= 130000) mode = "h";
  else if (a && t - a.t <= 130000) mode = "a";
  else if (b && b.t - t <= 130000) mode = "b";
  if (!mode) return;
  if (visDirty) applyVis();
  needDraw = false;
  lastDraw = t;
  const g = satellite.gstime(new Date(t)), cg = Math.cos(g), sg = Math.sin(g);
  const n = Math.min(points.length, mode === "h" ? Math.min(a.n, b.n) : (mode === "a" ? a : b).n);
  const sc = new (C().Cartesian3)();
  let h00, h10, h01, h11;
  if (mode === "h") {
    const s = (t - a.t) / (b.t - a.t), h = (b.t - a.t) / 1000, s2 = s * s, s3 = s2 * s;
    h00 = 2 * s3 - 3 * s2 + 1; h10 = (s3 - 2 * s2 + s) * h; h01 = -2 * s3 + 3 * s2; h11 = (s3 - s2) * h;
  }
  const k = mode === "b" ? b : a, d = (t - k.t) / 1000;
  const pa = (mode === "h" ? a : k).pos, va = (mode === "h" ? a : k).vel, pb = mode === "h" ? b.pos : null, vb = mode === "h" ? b.vel : null;
  for (let i = 0; i < n; i++) {
    const v = vis[i];
    if (!v) continue;
    const j = i * 3;
    let x, y, z;
    if (mode === "h") {
      x = h00 * pa[j] + h10 * va[j] + h01 * pb[j] + h11 * vb[j];
      y = h00 * pa[j + 1] + h10 * va[j + 1] + h01 * pb[j + 1] + h11 * vb[j + 1];
      z = h00 * pa[j + 2] + h10 * va[j + 2] + h01 * pb[j + 2] + h11 * vb[j + 2];
    } else {
      x = pa[j] + va[j] * d; y = pa[j + 1] + va[j + 1] * d; z = pa[j + 2] + va[j + 2] * d;
    }
    const ok = x === x && y === y && z === z;   // NaN check (failed propagation)
    if (v === 1) {
      const p = points.get(i);
      if (!ok) { if (p.show) p.show = false; continue; }
      sc.x = (x * cg + y * sg) * 1000; sc.y = (-x * sg + y * cg) * 1000; sc.z = z * 1000;
      p.position = sc;
      if (!p.show) p.show = true;
    } else {
      const bb = billboards.get(iconOf[i]);
      if (!ok) { if (bb.show) bb.show = false; continue; }
      sc.x = (x * cg + y * sg) * 1000; sc.y = (-x * sg + y * cg) * 1000; sc.z = z * 1000;
      bb.position = sc;
      if (!bb.show) bb.show = true;
    }
    if (i === hoverIdx) hoverLabel.position = sc;
  }
}

// ---------------------------------------------------------------------------
// The catalogue is loaded in three parts, ONE AFTER ANOTHER (never in parallel).
// Each part has its own server-side source chain (CelesTrak → mirrors → saved snapshot).
const PARTS = [["payloads", "Payloads"], ["rocket-bodies", "Rocket bodies"], ["debris", "Debris fragments"]];
const partStatus = {};

function renderChain() {
  const el = $("#chain-status");
  if (!el) return;
  el.innerHTML = PARTS.map(([k, label]) => {
    const st = partStatus[k];
    if (!st) return `<li><span>${label}</span><span class="muted">waiting</span></li>`;
    if (st.loading) return `<li><span>${label}</span><span class="muted">loading…</span></li>`;
    if (st.error) return `<li><span>${label}</span><span style="color:var(--crimson)">unavailable</span></li>`;
    const tried = (st.attempts || []).map(a => `${a.source} ${a.status === "ok" ? "✓" : a.status === "partial" ? `(${a.count})` : "✕"}`).join(" → ");
    return `<li title="${esc(tried)}"><span>${label}</span><span><b>${fmtNum(st.count)}</b> · ${esc(st.source)}</span></li>`;
  }).join("");
}

function addIcons(from) {
  const NF = new (C().NearFarScalar)(1.2e7, 1.15, 9e7, 0.55);
  for (let i = from; i < sats.length && billboards.length < MAX_ICONS; i++) {
    const s = sats[i];
    if (!((s[6] & 1) && s[4] === 0 && s[8] !== "D")) continue;   // Indian payloads still in orbit
    iconOf[i] = billboards.length;
    billboards.add({ id: i, position: C().Cartesian3.ZERO, image: satIcon(ICON_COLOR(s[8])), width: 22, height: 22, scaleByDistance: NF, show: false });
  }
}

async function loadCatalog() {
  const status = $("#globe-status");
  const colorCache = {};
  for (const k in CATS) colorCache[k] = C().Color.fromCssColorString(CATS[k].color);
  let parsedBefore = 0;
  worker = new Worker("js/workers/propagate.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "parse") { prog.parsed = parsedBefore + m.done; progress(`Parsing orbital elements · ${fmtNum(prog.parsed)}`); }
    if (m.type === "loaded") { parsedBefore = m.count; prog.parsed = m.count; progress(); resetKf(); }
    if (m.type === "kf") onKeyframe(m);
  };
  let received = 0;
  for (const [part, label] of PARTS) {
    partStatus[part] = { loading: true };
    renderChain();
    progress(`Downloading ${label.toLowerCase()}`);
    try {
      const d = await api(`/api/catalog/orbits?part=${part}`, { ttl: 3_600_000, onProgress: (f) => { prog.dl[part] = f; progress(); } });
      if (!d || !Array.isArray(d.sats)) throw new Error("malformed catalogue response");
      const fresh = d.sats.filter(row => Array.isArray(row) && row.length >= 5 && !byNorad.has(row[0]));
      const base = sats.length;
      const grown = new Int32Array(base + fresh.length).fill(-1);
      grown.set(iconOf);
      iconOf = grown;
      fresh.forEach((row, j) => {
        const i = base + j;
        sats.push(row);
        catOf.push(categorise(row));
        byNorad.set(row[0], i);
        points.add({ id: i, position: C().Cartesian3.ZERO, color: colorCache[catOf[i]], pixelSize: CATS[catOf[i]].size, show: false });
      });
      addIcons(base);
      received += fresh.length;
      prog.expect = Math.max(prog.expect, received);
      worker.postMessage({ type: "add", tles: fresh.map(r => [r[2], r[3]]) });
      partStatus[part] = { count: d.count, source: d.source, attempts: d.attempts };
    } catch (e) {
      partStatus[part] = { error: e.message };
    }
    prog.dl[part] = 1;
    visDirty = true;
    renderChain();
    renderLayers();
    $("#orb-count").textContent = `${fmtNum(sats.length)} tracked`;
  }
  prog.expect = Math.max(1, received);
  progress();
  const failed = PARTS.filter(([k]) => partStatus[k].error).map(([, l]) => l.toLowerCase());
  status.textContent = !sats.length
    ? "Orbital catalogue unavailable from every source right now. Retrying in 60 s."
    : failed.length ? `Loaded ${fmtNum(sats.length)} objects. Unavailable: ${failed.join(", ")}.` : "";
  if (!sats.length) { loader?.done(); loader = null; setTimeout(() => { if (!sats.length) loadCatalog(); }, 60000); }
  if (status.textContent.startsWith("Loaded")) setTimeout(() => { if (status.textContent.startsWith("Loaded")) status.textContent = ""; }, 12000);
  if (window.__astraPendingConj && active) show();
}

let moreOpen = false;
function renderLayers() {
  const counts = {};
  catOf.forEach(c => counts[c] = (counts[c] || 0) + 1);
  const row = ([k, c]) => `<label><input type="checkbox" data-cat="${k}" ${c.on ? "checked" : ""}><span class="sw" style="background:${c.color}"></span>${c.label}<span class="n">${fmtNum(counts[k])}</span></label>`;
  const ents = Object.entries(CATS).filter(([k]) => counts[k]);
  const more = ents.filter(([k]) => !PRIMARY.includes(k));
  $("#orb-layers").innerHTML = ents.filter(([k]) => PRIMARY.includes(k)).map(row).join("")
    + (more.length ? `<details class="more-layers" ${moreOpen ? "open" : ""}><summary>More layers <span class="n">${more.length}</span></summary>${more.map(row).join("")}</details>` : "");
  $("#orb-layers .more-layers")?.addEventListener("toggle", (e) => { moreOpen = e.target.open; });
  $("#orb-layers").onchange = (e) => {
    const k = e.target.dataset.cat;
    if (k) { CATS[k].on = e.target.checked; visDirty = true; }
  };
}

function onSearch(e) {
  const q = e.target.value.trim().toLowerCase();
  const out = $("#sat-results");
  if (q.length < 2 || !sats.length) { out.innerHTML = ""; return; }
  const res = [];
  for (let i = 0; i < sats.length && res.length < 25; i++) {
    const s = sats[i];
    if (String(s[0]) === q || s[1].toLowerCase().includes(q)) res.push(i);
  }
  out.innerHTML = res.map(i => `<li data-i="${i}"><span>${esc(sats[i][1])}</span><span class="muted mono">${sats[i][0]}</span></li>`).join("") || `<li class="muted">No match</li>`;
  out.onclick = (ev) => { const li = ev.target.closest("[data-i]"); if (li) { select(+li.dataset.i, true); out.innerHTML = ""; } };
}

// ---------------------------------------------------------------------------
function highlight(i, on) {
  if (i < 0 || i >= points.length) return;
  if (iconOf[i] >= 0) { billboards.get(iconOf[i]).scale = on ? 1.5 : 1; return; }
  const p = points.get(i);
  p.pixelSize = on ? 9 : CATS[catOf[i]].size;
  p.outlineColor = C().Color.WHITE;
  p.outlineWidth = on ? 2 : 0;
}

function select(i, fly) {
  highlight(selected, false);
  selected = i;
  highlight(i, true);
  visDirty = true;
  const s = sats[i];
  const rec = satrec(s[2], s[3]);
  if (selEntity) viewer.entities.remove(selEntity);
  selEntity = null;
  if (rec) {
    const info = orbitInfo(rec);
    const now = simDate();
    const pos = [];
    const span = Math.min(info.periodMin, 1440);
    for (let m = -span / 2; m <= span / 2; m += span / 180) {
      const f = ecfAt(rec, new Date(now.getTime() + m * 60000));
      if (f) pos.push(new (C().Cartesian3)(f.x * 1000, f.y * 1000, f.z * 1000));
    }
    selEntity = viewer.entities.add({
      polyline: { positions: pos, width: 1.5, material: C().Color.fromCssColorString(CATS[catOf[i]].color).withAlpha(0.8) },
    });
    if (fly) {
      const g = geodeticAt(rec, now);
      if (g) viewer.camera.flyTo({ destination: C().Cartesian3.fromDegrees(g.lon, g.lat, Math.max(g.alt * 1000 * 3, 6_000_000)), duration: 1.2 });
    }
  }
  renderObject();
  showPane("object");
}

function renderObject() {
  const el = $("#obj-detail");
  if (selected < 0) return;
  const [norad, name, l1, l2, type, owner, flags, cloud, status] = sats[selected];
  const rec = satrec(l1, l2);
  const info = rec ? orbitInfo(rec) : null;
  el.className = "";
  el.innerHTML = `
    <div class="detail-title">${esc(name)}</div>
    <span class="badge" style="color:${CATS[catOf[selected]].color}">${CATS[catOf[selected]].label}</span>
    <dl class="kv">
      <dt>NORAD ID</dt><dd class="mono">${norad}</dd>
      <dt>Type</dt><dd>${TYPE_NAMES[type]}</dd>
      <dt>Owner</dt><dd>${esc(owner || "–")}</dd>
      <dt>Status</dt><dd>${STATUS[status] ?? esc(status)} <span class="muted small">(public catalogue, not official)</span></dd>
      ${info ? `<dt>Orbit</dt><dd>${info.regime} · ${fmtNum(info.perigee)} × ${fmtNum(info.apogee)} km</dd>
      <dt>Inclination</dt><dd>${info.incl.toFixed(2)}°</dd>
      <dt>Period</dt><dd>${info.periodMin.toFixed(1)} min</dd>
      <dt>Elements epoch</dt><dd>${fmtUTC(info.epoch)} (${timeAgo(info.epoch)})</dd>` : ""}
    </dl>
    <div class="stat-row" id="obj-live"></div>
    ${flags & 2 ? `<p class="note" style="color:var(--warn)">On CelesTrak's decaying list: re-entry expected soon. Low perigee objects decay faster when solar activity (F10.7, Kp) is high.</p>` : ""}
    <h3>Close-approach screening</h3>
    <p class="muted small">Screen this object against every other catalogued object for the next 24 h using SGP4 (altitude-band prefilter, 60 s sampling, golden-section refinement).</p>
    <button class="btn" id="btn-screen">Screen next 24 h</button>
    <div class="progress" id="screen-prog" hidden><i></i></div>
    <div id="screen-out"></div>`;
  $("#btn-screen").onclick = runScreen;
  updateObjectLive();
}

function updateObjectLive() {
  const el = $("#obj-live");
  if (!el || selected < 0) return;
  const s = sats[selected];
  const rec = satrec(s[2], s[3]);
  const g = rec && geodeticAt(rec, simDate());
  el.innerHTML = g ? `<div class="stat"><div class="v">${fmtNum(g.alt)} km</div><div class="l">Altitude</div></div>
    <div class="stat"><div class="v">${g.speed.toFixed(2)}</div><div class="l">km/s</div></div>
    <div class="stat"><div class="v mono" style="font-size:13px">${g.lat.toFixed(1)}°, ${g.lon.toFixed(1)}°</div><div class="l">Sub-point</div></div>` : `<p class="muted small">Propagation failed (elements too old or object decayed).</p>`;
}

function runScreen() {
  const btn = $("#btn-screen");
  btn.disabled = true;
  const prog = $("#screen-prog");
  prog.hidden = false;
  const out = $("#screen-out");
  out.innerHTML = `<p class="muted small">Preparing catalogue…</p>`;
  const start = simDate().getTime();
  const target = selected;
  const go = () => screenWorker.postMessage({ type: "screen", target, start, hours: 24, stepSec: 60, reportKm: 25 });
  if (!screenWorker || screenWorker._n !== sats.length) {   // (re)load after new catalogue parts arrive
    screenWorker?.terminate();
    screenWorker = new Worker("js/workers/screen.js");
    screenWorker._n = sats.length;
    screenReady = false;
    screenWorker.postMessage({ type: "load", tles: sats.map(s => [s[2], s[3]]) });
  }
  screenWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "loaded") { screenReady = true; go(); }
    if (m.type === "progress") { prog.firstElementChild.style.width = m.pct + "%"; out.innerHTML = `<p class="muted small">Screening against ${fmtNum(m.candidates)} objects in overlapping altitude band… ${m.pct}%</p>`; }
    if (m.type === "done") {
      btn.disabled = false; prog.hidden = true;
      if (m.error) { out.innerHTML = `<p class="muted">${esc(m.error)}</p>`; return; }
      out.innerHTML = `<p class="small muted">${fmtNum(m.candidates)} candidates screened. ${m.results.length ? `${m.results.length} approaches under 25 km:` : "No approaches under 25 km in the next 24 h."}</p>
        <ul class="conj-list">${m.results.map(r => `<li data-b="${sats[r.idx][0]}" data-t="${new Date(r.tca).toISOString()}">
          <div class="pair">${esc(sats[target][1])}<span class="vs">×</span>${esc(sats[r.idx][1])} ${typeTag(sats[r.idx][4])}</div>
          <div class="m"><span class="rng ${r.missKm < 1 ? "hot" : ""}">${r.missKm < 1 ? fmtNum(r.missKm * 1000) + " m" : r.missKm.toFixed(2) + " km"}</span><span>${r.relKms.toFixed(1)} km/s</span><span>${fmtUTC(new Date(r.tca))}</span></div></li>`).join("")}</ul>`;
      out.querySelector(".conj-list")?.addEventListener("click", (ev) => {
        const li = ev.target.closest("li[data-b]"); if (li) jumpToConj(sats[target][0], +li.dataset.b, li.dataset.t);
      });
    }
  };
  if (screenReady) go();
}

const typeTag = (t) => `<span class="type-tag ${["PAY", "RB", "DEB", "UNK"][t]}">${["PAY", "R/B", "DEB", "UNK"][t]}</span>`;
const typeTagStr = (t) => t ? `<span class="type-tag ${t.replace("/", "")}">${t}</span>` : "";

// ---------------------------------------------------------------------------
async function loadConjunctions() {
  try {
    conjData = await api("/api/conjunctions", { ttl: 600_000 });
    $("#conj-kpis").innerHTML = `
      <div class="stat"><div class="v">${fmtNum(conjData.total)}</div><div class="l">distinct pairs under 5 km</div></div>
      <div class="stat"><div class="v" style="color:var(--danger)">${fmtNum(conjData.under1km)}</div><div class="l">under 1 km</div></div>
      <div class="stat"><div class="v" style="color:var(--saffron)">${fmtNum(conjData.indiaSatsUnder5km ?? 0)}</div><div class="l">Indian sats under 5 km</div></div>`;
    renderConj();
    drawTimeTicks();
  } catch (e) {
    $("#conj-list").innerHTML = `<li class="skeleton">SOCRATES unavailable (${esc(e.message)}).</li>`;
  }
}

function renderConj() {
  if (!conjData) return;
  const all = $("#conj-all").checked, sort = $("#conj-sort").value;
  let list;
  if (all) {
    const seen = new Set();
    list = [...(conjData.closest || []), ...(conjData.highestProb || []), ...(conjData.india || [])]
      .filter(r => { const k = `${r.id1}-${r.id2}-${r.tca}`; return !seen.has(k) && seen.add(k); });
  } else list = [...(conjData.india || [])];
  const now = Date.now();
  if (sort === "prob") list.sort((a, b) => (b.maxProb || 0) - (a.maxProb || 0));
  else if (sort === "time") list = list.filter(r => new Date(r.tca) >= now).sort((a, b) => new Date(a.tca) - new Date(b.tca));
  else list.sort((a, b) => a.rangeKm - b.rangeKm);
  $("#conj-list").innerHTML = list.slice(0, 80).map(r => `
    <li data-a="${r.id1}" data-b="${r.id2}" data-t="${r.tca}">
      <div class="pair">${esc(r.name1)}${typeTagStr(r.type1)}<span class="vs">×</span>${esc(r.name2)}${typeTagStr(r.type2)}</div>
      <div class="m"><span class="rng ${r.rangeKm < 1 ? "hot" : ""}">${r.rangeKm < 1 ? fmtNum(r.rangeKm * 1000) + " m" : r.rangeKm.toFixed(2) + " km"}</span>
      <span>${(r.relSpeedKms ?? 0).toFixed(1)} km/s</span><span>P ${r.maxProb ? r.maxProb.toExponential(1) : "–"}</span><span>${timeAgo(r.tca)}</span></div>
    </li>`).join("") || `<li class="skeleton">${all ? "No entries." : "No Indian satellite has a predicted approach in this list. Tick “All objects” to see every pair."}</li>`;
  $("#conj-list").onclick = (e) => {
    const li = e.target.closest("li[data-a]");
    if (li) jumpToConj(+li.dataset.a, +li.dataset.b, li.dataset.t);
  };
}

function clearConjFocus() {
  if (!focusSet && !conjEntity) return;
  focusSet = null;
  visDirty = true;
  if (conjEntity) { viewer.entities.remove(conjEntity); conjEntity = null; }
}

function jumpToConj(a, b, tca) {
  const ia = byNorad.get(a), ib = byNorad.get(b);
  if (ia == null || ib == null) { toast("One of these objects is not in the loaded catalogue."); return; }
  const t = new Date(tca);
  viewer.clock.shouldAnimate = false;
  $$("#timebar [data-speed]").forEach(x => x.classList.remove("active"));
  if (t.getTime() < t0 || t.getTime() > t0 + BACK + FWD) t0 = t.getTime() - BACK;
  setSim(t.getTime());
  focusSet = new Set([ia, ib]);
  select(ia, false);
  const ra = satrec(sats[ia][2], sats[ia][3]), rb = satrec(sats[ib][2], sats[ib][3]);
  const fa = ra && ecfAt(ra, t), fb = rb && ecfAt(rb, t);
  if (conjEntity) viewer.entities.remove(conjEntity);
  conjEntity = null;
  if (fa && fb) {
    const pa = new (C().Cartesian3)(fa.x * 1000, fa.y * 1000, fa.z * 1000), pb = new (C().Cartesian3)(fb.x * 1000, fb.y * 1000, fb.z * 1000);
    const missKm = C().Cartesian3.distance(pa, pb) / 1000;
    conjEntity = viewer.entities.add({
      position: pa,
      polyline: { positions: [pa, pb], width: 3, material: C().Color.fromCssColorString("#cf3a4a") },
      label: { text: `${sats[ia][1]} × ${sats[ib][1]}\n${missKm < 1 ? (missKm * 1000).toFixed(0) + " m" : missKm.toFixed(2) + " km"} at closest approach`, font: "12px JetBrains Mono, monospace", fillColor: C().Color.WHITE, showBackground: true, backgroundColor: C().Color.fromCssColorString("rgba(17,15,12,.9)"), pixelOffset: new (C().Cartesian2)(0, -28) },
    });
    const g = geodeticAt(ra, t);
    viewer.camera.flyTo({ destination: C().Cartesian3.fromDegrees(g.lon, g.lat, g.alt * 1000 + 2_500_000), duration: 1.4 });
  }
  toast("Clock set to the closest approach. Use − / + to step, or press Now / a speed to resume.");
}

// ---------------------------------------------------------------------------
async function loadStats() {
  try {
    statsData = await api("/api/catalog/stats", { ttl: 3_600_000 });
    const s = statsData;
    const max = s.fragmentations[0]?.debrisOnOrbit || 1;
    $("#frag-list").innerHTML = s.fragmentations.slice(0, 10).map(f => `
      <li data-intdes="${f.intdes}"><span class="nm">${esc(f.name)} <span class="muted">(${f.owner}, ${f.launch?.slice(0, 4) || ""})</span></span><span class="mono">${fmtNum(f.debrisOnOrbit)}</span>
      <span class="bar"><i style="width:${(100 * f.debrisOnOrbit / max).toFixed(1)}%"></i></span></li>`).join("");
    $("#frag-list").onclick = (e) => {
      const li = e.target.closest("[data-intdes]"); if (!li || !sats.length) return;
      const key = li.dataset.intdes;
      const yy = key.slice(2, 4), num = key.slice(5, 8);
      const set = new Set();
      sats.forEach((x, i) => { if (x[2].slice(9, 14) === yy + num && x[4] === 2) set.add(i); });
      focusSet = set.size ? set : null;
      // Make sure the pieces are drawn even if their layer is switched off
      set.forEach(i => { if (!CATS[catOf[i]].on) { CATS[catOf[i]].on = true; } });
      renderLayers();
      visDirty = true;
      toast(`${fmtNum(set.size)} debris pieces from ${li.querySelector(".nm").textContent} highlighted. Press Now to show all.`);
    };
  } catch (e) {
    $("#frag-list").innerHTML = `<li class="muted">Catalogue statistics unavailable.</li>`;
  }
}

async function drawStatsCharts() {
  const s = statsData;
  if (!s) return;
  const yrs = s.growth.years;
  const from = yrs.indexOf(1975);
  const series = [["PAY", "Payloads", "#8fb996"], ["R/B", "Rocket bodies", "#c9a34e"], ["DEB", "Debris", "#e2603a"]];
  makeChart($("#ch-growth"), {
    type: "line",
    data: { labels: yrs.slice(from), datasets: series.map(([k, l, c]) => ({ label: l, data: s.growth[k].slice(from), borderColor: c, backgroundColor: c + "55", fill: true, pointRadius: 0, borderWidth: 1.2 })) },
    options: { scales: { y: { stacked: true }, x: { ticks: { maxTicksLimit: 8 } } }, plugins: { tooltip: { mode: "index", intersect: false } } },
  });
  makeChart($("#ch-alt"), {
    type: "bar",
    data: { labels: s.altitude.bins.map(b => b), datasets: series.map(([k, l, c]) => ({ label: l, data: s.altitude[k], backgroundColor: c, borderWidth: 0 })) },
    options: { scales: { x: { stacked: true, title: { display: true, text: "Mean altitude (km)" }, ticks: { maxTicksLimit: 10 } }, y: { stacked: true } }, plugins: { tooltip: { mode: "index", intersect: false } } },
  });
  const ow = s.owners.slice(0, 10);
  makeChart($("#ch-owners"), {
    type: "bar",
    data: { labels: ow.map(o => o.owner), datasets: series.map(([k, l, c]) => ({ label: l, data: ow.map(o => o[k]), backgroundColor: c })) },
    options: { indexAxis: "y", scales: { x: { stacked: true }, y: { stacked: true } } },
  });
  try {
    const sw = await api("/api/spaceweather", { ttl: 600_000 });
    const rows = sw.kp.slice(-40);
    makeChart($("#ch-kp"), { type: "bar", data: { labels: rows.map(r => r.t.slice(5, 13).replace("T", " ")), datasets: [{ label: "Planetary Kp", data: rows.map(r => r.kp), backgroundColor: rows.map(r => r.kp >= 5 ? "#cf3a4a" : r.kp >= 4 ? "#d9a441" : "#c9a34e") }] }, options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 9 }, x: { ticks: { maxTicksLimit: 5 } } } } });
  } catch {}
}

function toggleStats(open) {
  $("#stats-drawer").hidden = !open;
  $("#btn-stats").classList.toggle("active", open);
  if (open) setTimeout(drawStatsCharts, 30);
}

function showPane(name) {
  if (name === "stats") return toggleStats(true);
  $$("#view-orbital .tabs-inner button[data-pane]").forEach(b => b.classList.toggle("active", b.dataset.pane === name));
  $$("#view-orbital .pane").forEach(p => p.hidden = p.dataset.pane !== name);
}
