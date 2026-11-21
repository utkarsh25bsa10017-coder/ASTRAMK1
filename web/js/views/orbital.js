import { api } from "../core/api.js";
import { mountGlobe, simDate } from "../core/globe.js";
import { satrec, geodeticAt, orbitInfo, ecfAt } from "../core/orbitmath.js";
import { $, $$, esc, fmtNum, timeAgo, fmtUTC, toast, makeChart } from "../core/util.js";

const C = () => window.Cesium;
let viewer, points, cat, worker, screenWorker, timer = null, active = false;
let sats = [];            // rows from /api/catalog/orbits?part=…
let catOf = [];           // category per index
const byNorad = new Map();
let selected = -1, selEntity = null, conjEntity = null, focusSet = null;
let conjData = null, statsData = null;
let screenReady = false;

const CATS = {
  PAY: { label: "Active payloads", color: "#8fb996", size: 2.2, on: true },
  RB: { label: "Rocket bodies", color: "#c9a34e", size: 2.4, on: true },
  DEB: { label: "Debris fragments", color: "#e2603a", size: 1.8, on: true },
  CL0: { label: "Fengyun-1C ASAT debris (2007)", color: "#f2d16b", size: 2.4, on: true },
  CL1: { label: "Cosmos 2251 collision debris (2009)", color: "#f08a5d", size: 2.4, on: true },
  CL2: { label: "Iridium 33 collision debris (2009)", color: "#7fa8c4", size: 2.4, on: true },
  CL3: { label: "Cosmos 1408 ASAT debris (2021)", color: "#c25b9b", size: 2.6, on: true },
  IND: { label: "Indian objects", color: "#f29a2e", size: 4, on: true },
  DEC: { label: "Decaying / re-entry watch", color: "#ede6d8", size: 4, on: true },
  UNK: { label: "Unknown", color: "#7d7566", size: 1.6, on: false },
};
const TYPE_NAMES = ["Payload", "Rocket body", "Debris", "Unknown"];
const STATUS = { "+": "Operational", "-": "Non-operational", P: "Partially operational", B: "Backup", S: "Spare", X: "Extended mission", D: "Decayed", "?": "Unknown", "": "Not in catalogue" };

function categorise(s) {
  const [, , , , type, , flags, cloud] = s;
  if (flags & 2) return "DEC";
  if (flags & 1) return "IND";
  if (type === 2 && cloud >= 0) return "CL" + cloud;
  return ["PAY", "RB", "DEB", "UNK"][type] || "UNK";
}

// ---------------------------------------------------------------------------
export async function init() {
  viewer = mountGlobe($("#orbital-globe-slot"));
  points = viewer.scene.primitives.add(new (C().PointPrimitiveCollection)());

  $$(".time-ctl [data-speed]").forEach(b => b.onclick = () => setSpeed(+b.dataset.speed));
  $("#btn-now").onclick = () => { viewer.clock.currentTime = C().JulianDate.now(); setSpeed(1); };
  setSpeed(1);

  $$(".tabs-inner button").forEach(b => b.onclick = () => showPane(b.dataset.pane));
  $$("#conj-seg button").forEach(b => b.onclick = () => {
    $$("#conj-seg button").forEach(x => x.classList.toggle("active", x === b));
    renderConj(b.dataset.list);
  });

  const handler = new (C().ScreenSpaceEventHandler)(viewer.scene.canvas);
  handler.setInputAction((e) => {
    if (!active) return;
    const pick = viewer.scene.pick(e.position);
    if (pick && pick.primitive && pick.collection === points && typeof pick.id === "number") select(pick.id, false);
  }, C().ScreenSpaceEventType.LEFT_CLICK);

  $("#sat-search").addEventListener("input", onSearch);

  loadConjunctions();
  loadStats();
  await loadCatalog();
}

export function show() {
  active = true;
  viewer = mountGlobe($("#orbital-globe-slot"));
  points.show = true;
  if (selEntity) selEntity.show = true;
  if (conjEntity) conjEntity.show = true;
  startTimer();
  if (window.__astraPendingConj && sats.length) {
    const p = window.__astraPendingConj; window.__astraPendingConj = null;
    jumpToConj(p.a, p.b, p.t);
  }
}

export function hide() {
  active = false;
  if (points) points.show = false;
  if (selEntity) selEntity.show = false;
  if (conjEntity) conjEntity.show = false;
  stopTimer();
}

function setSpeed(x) {
  viewer.clock.multiplier = x;
  viewer.clock.shouldAnimate = true;
  $$(".time-ctl [data-speed]").forEach(b => b.classList.toggle("active", +b.dataset.speed === x));
}

function startTimer() {
  if (timer || !worker) return;
  const tick = () => {
    if (!active) return;
    worker.postMessage({ type: "propagate", time: simDate().getTime() });
    $("#sim-time").textContent = fmtUTC(simDate());
    updateObjectLive();
  };
  tick();
  timer = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(timer); timer = null; }

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

async function loadCatalog() {
  const status = $("#globe-status");
  const colorCache = {};
  for (const k in CATS) colorCache[k] = C().Color.fromCssColorString(CATS[k].color);
  worker = new Worker("js/workers/propagate.js");
  worker.onmessage = (e) => {
    if (e.data.type === "loaded") startTimer();
    if (e.data.type === "positions") applyPositions(e.data.buf);
  };
  for (const [part, label] of PARTS) {
    partStatus[part] = { loading: true };
    renderChain();
    status.textContent = `Loading ${label.toLowerCase()}…`;
    try {
      const d = await api(`/api/catalog/orbits?part=${part}`, { ttl: 3_600_000 });
      if (!d || !Array.isArray(d.sats)) throw new Error("malformed catalogue response");
      const fresh = d.sats.filter(row => Array.isArray(row) && row.length >= 5 && !byNorad.has(row[0]));
      const base = sats.length;
      fresh.forEach((row, j) => {
        const i = base + j;
        sats.push(row);
        catOf.push(categorise(row));
        byNorad.set(row[0], i);
        points.add({ id: i, position: C().Cartesian3.ZERO, color: colorCache[catOf[i]], pixelSize: CATS[catOf[i]].size, show: false });
      });
      worker.postMessage({ type: "add", tles: fresh.map(r => [r[2], r[3]]) });
      partStatus[part] = { count: d.count, source: d.source, attempts: d.attempts };
    } catch (e) {
      partStatus[part] = { error: e.message };
    }
    renderChain();
    renderLayers();
    $("#orb-count").textContent = `${fmtNum(sats.length)} tracked`;
  }
  const failed = PARTS.filter(([k]) => partStatus[k].error).map(([, l]) => l.toLowerCase());
  status.textContent = !sats.length
    ? "Orbital catalogue unavailable from every source right now. Retrying in 60 s."
    : failed.length ? `Loaded ${fmtNum(sats.length)} objects. Unavailable: ${failed.join(", ")}.` : "";
  if (!sats.length) setTimeout(() => { if (!sats.length) loadCatalog(); }, 60000);
  if (status.textContent.startsWith("Loaded")) setTimeout(() => { if (status.textContent.startsWith("Loaded")) status.textContent = ""; }, 12000);
  if (window.__astraPendingConj && active) show();
}

function applyPositions(buf) {
  const n = Math.min(points.length, buf.length / 3);
  const scratch = new (C().Cartesian3)();
  for (let i = 0; i < n; i++) {
    const p = points.get(i);
    const x = buf[i * 3];
    const visible = CATS[catOf[i]].on && (!focusSet || focusSet.has(i) || i === selected);
    if (Number.isNaN(x) || !visible) { p.show = false; continue; }
    scratch.x = x; scratch.y = buf[i * 3 + 1]; scratch.z = buf[i * 3 + 2];
    p.position = scratch;
    p.show = true;
  }
  if (selected >= 0 && selected < n) {
    const p = points.get(selected);
    p.pixelSize = 9; p.outlineColor = C().Color.WHITE; p.outlineWidth = 2;
  }
}

function renderLayers() {
  const counts = {};
  catOf.forEach(c => counts[c] = (counts[c] || 0) + 1);
  $("#orb-layers").innerHTML = Object.entries(CATS).filter(([k]) => counts[k]).map(([k, c]) =>
    `<label><input type="checkbox" data-cat="${k}" ${c.on ? "checked" : ""}><span class="sw" style="background:${c.color}"></span>${c.label}<span class="n">${fmtNum(counts[k])}</span></label>`).join("");
  $("#orb-layers").onchange = (e) => {
    const k = e.target.dataset.cat;
    if (k) { CATS[k].on = e.target.checked; worker?.postMessage({ type: "propagate", time: simDate().getTime() }); }
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
function select(i, fly) {
  if (selected >= 0 && selected < points.length) {
    const p = points.get(selected);
    p.pixelSize = CATS[catOf[selected]].size; p.outlineWidth = 0;
  }
  selected = i;
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
  worker?.postMessage({ type: "propagate", time: simDate().getTime() });
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
      <dt>Status</dt><dd>${STATUS[status] ?? esc(status)}</dd>
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
      <div class="stat"><div class="v">${fmtNum(conjData.total)}</div><div class="l">pairs < 5 km</div></div>
      <div class="stat"><div class="v" style="color:var(--danger)">${fmtNum(conjData.under1km)}</div><div class="l">under 1 km</div></div>
      <div class="stat"><div class="v" style="color:var(--navic)">${fmtNum(conjData.india.length)}</div><div class="l">involve India</div></div>`;
    renderConj("closest");
  } catch (e) {
    $("#conj-list").innerHTML = `<li class="skeleton">SOCRATES unavailable (${esc(e.message)}).</li>`;
  }
}

function renderConj(which) {
  if (!conjData) return;
  const list = conjData[which] || [];
  $("#conj-list").innerHTML = list.slice(0, 80).map(r => `
    <li data-a="${r.id1}" data-b="${r.id2}" data-t="${r.tca}">
      <div class="pair">${esc(r.name1)}${typeTagStr(r.type1)}<span class="vs">×</span>${esc(r.name2)}${typeTagStr(r.type2)}</div>
      <div class="m"><span class="rng ${r.rangeKm < 1 ? "hot" : ""}">${r.rangeKm < 1 ? fmtNum(r.rangeKm * 1000) + " m" : r.rangeKm.toFixed(2) + " km"}</span>
      <span>${(r.relSpeedKms ?? 0).toFixed(1)} km/s</span><span>P ${r.maxProb ? r.maxProb.toExponential(1) : "–"}</span><span>${timeAgo(r.tca)}</span></div>
    </li>`).join("") || `<li class="skeleton">No entries.</li>`;
  $("#conj-list").onclick = (e) => {
    const li = e.target.closest("li[data-a]");
    if (li) jumpToConj(+li.dataset.a, +li.dataset.b, li.dataset.t);
  };
}

function jumpToConj(a, b, tca) {
  const ia = byNorad.get(a), ib = byNorad.get(b);
  if (ia == null || ib == null) { toast("One of these objects is not in the loaded catalogue."); return; }
  const t = new Date(tca);
  viewer.clock.currentTime = C().JulianDate.fromDate(t);
  viewer.clock.shouldAnimate = false;
  $$(".time-ctl [data-speed]").forEach(x => x.classList.remove("active"));
  focusSet = new Set([ia, ib]);
  select(ia, false);
  const ra = satrec(sats[ia][2], sats[ia][3]), rb = satrec(sats[ib][2], sats[ib][3]);
  const fa = ra && ecfAt(ra, t), fb = rb && ecfAt(rb, t);
  if (conjEntity) viewer.entities.remove(conjEntity);
  if (fa && fb) {
    const pa = new (C().Cartesian3)(fa.x * 1000, fa.y * 1000, fa.z * 1000), pb = new (C().Cartesian3)(fb.x * 1000, fb.y * 1000, fb.z * 1000);
    const missKm = C().Cartesian3.distance(pa, pb) / 1000;
    conjEntity = viewer.entities.add({
      position: pa,
      polyline: { positions: [pa, pb], width: 3, material: C().Color.fromCssColorString("#cf3a4a") },
      label: { text: `${sats[ia][1]} × ${sats[ib][1]}\n${missKm < 1 ? (missKm * 1000).toFixed(0) + " m" : missKm.toFixed(2) + " km"} at TCA`, font: "12px JetBrains Mono, monospace", fillColor: C().Color.WHITE, showBackground: true, backgroundColor: C().Color.fromCssColorString("rgba(17,15,12,.9)"), pixelOffset: new (C().Cartesian2)(0, -28) },
    });
    const g = geodeticAt(ra, t);
    viewer.camera.flyTo({ destination: C().Cartesian3.fromDegrees(g.lon, g.lat, g.alt * 1000 + 2_500_000), duration: 1.4 });
  }
  toast("Clock set to time of closest approach. Press 1× or Now to resume. Showing only these two objects.");
  setTimeout(() => {
    const clear = () => { focusSet = null; if (conjEntity) { viewer.entities.remove(conjEntity); conjEntity = null; } };
    $$(".time-ctl button").forEach(x => x.addEventListener("click", clear, { once: true }));
  }, 0);
  worker?.postMessage({ type: "propagate", time: t.getTime() });
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
      toast(`${fmtNum(set.size)} debris pieces from ${li.querySelector(".nm").textContent} highlighted. Press Now to show all.`);
      $("#btn-now").addEventListener("click", () => { focusSet = null; }, { once: true });
      worker?.postMessage({ type: "propagate", time: simDate().getTime() });
    };
    drawStatsCharts();
  } catch (e) {
    $("#frag-list").innerHTML = `<li class="muted">Catalogue statistics unavailable.</li>`;
  }
  try {
    const sw = await api("/api/spaceweather", { ttl: 600_000 });
    const rows = sw.kp.slice(-40);
    makeChart($("#ch-kp"), { type: "bar", data: { labels: rows.map(r => r.t.slice(5, 13).replace("T", " ")), datasets: [{ label: "Planetary Kp", data: rows.map(r => r.kp), backgroundColor: rows.map(r => r.kp >= 5 ? "#cf3a4a" : r.kp >= 4 ? "#d9a441" : "#c9a34e") }] }, options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 9 }, x: { ticks: { maxTicksLimit: 5 } } } } });
  } catch {}
}

function drawStatsCharts() {
  const s = statsData;
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
}

function showPane(name) {
  $$(".tabs-inner button").forEach(b => b.classList.toggle("active", b.dataset.pane === name));
  $$("#view-orbital .pane").forEach(p => p.hidden = p.dataset.pane !== name);
  if (name === "stats" && statsData) setTimeout(drawStatsCharts, 30);
}
