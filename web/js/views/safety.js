import { api } from "../core/api.js";
import { attachSearch, goSafety } from "../core/search.js";
import { $, esc, fmtNum, fmtIST, timeAgo, toast, makeChart, PAL, riskColor, gradeColor } from "../core/util.js";

let map = null, current = null, search;
const ORDER = ["riverine", "bank", "sediment", "flash"];   // water hazards: these make the rating

export function init() {
  search = attachSearch($("#sc-search"), $("#sc-suggest"), goSafety);
  $("#sc-quick").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.here) return locate();
    search.lookup(b.dataset.q);
  });
}

export function show(params = {}) {
  if (params.lat && params.lon) {
    const key = `${(+params.lat).toFixed(3)},${(+params.lon).toFixed(3)}`;
    if (key !== current) run(+params.lat, +params.lon, params.name);
  }
  setTimeout(() => map?.invalidateSize(), 60);
}

function locate() {
  if (!navigator.geolocation) return toast("Geolocation is not available in this browser.");
  navigator.geolocation.getCurrentPosition(
    (p) => goSafety({ lat: p.coords.latitude, lon: p.coords.longitude, name: "Your location" }),
    () => toast("Location permission denied."), { timeout: 10000 });
}

async function run(lat, lon, name) {
  current = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const out = $("#sc-result");
  out.innerHTML = `<p class="loading-line">Reading terrain, 40 years of river flow, rainfall and seismic history for ${esc(name || current)}</p>`;
  try {
    const d = await api(`/api/assess?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { ttl: 900_000 });
    render(d, name);
  } catch (e) {
    out.innerHTML = `<div class="empty-state" style="padding-left:0"><p class="serif">Couldn't assess this place.</p><p>${esc(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
function dial(safety, grade) {
  const W = 320, H = 232, cx = 160, cy = 160, r = 134;
  const pt = (v, rr) => { const t = Math.PI * (1 - v / 100); return [cx + rr * Math.cos(t), cy - rr * Math.sin(t)]; };
  const arc = (a, b, rr) => { const [x1, y1] = pt(a, rr), [x2, y2] = pt(b, rr); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${rr} ${rr} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const bands = [[0, 30, PAL.crimson], [30, 50, PAL.sand], [50, 70, PAL.amber], [70, 85, PAL.olive], [85, 100, PAL.sage]];
  let ticks = "";
  for (let v = 0; v <= 100; v += 2) {
    const major = v % 10 === 0;
    const [x1, y1] = pt(v, r - (major ? 14 : 7)), [x2, y2] = pt(v, r);
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${major ? PAL.bone2 : PAL.bone3}" stroke-width="${major ? 1.2 : .7}"/>`;
    if (v % 20 === 0) { const [tx, ty] = pt(v, r - 26); ticks += `<text x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" fill="${PAL.bone3}" font-size="9" text-anchor="middle">${v}</text>`; }
  }
  const [nx, ny] = pt(safety, r - 4);
  const col = gradeColor(grade);
  return `<svg class="dial" viewBox="0 0 ${W} ${H}" role="img" aria-label="Safety rating ${safety} of 100, grade ${grade}">
    ${bands.map(([a, b, c]) => `<path d="${arc(a + .4, b - .4, r + 7)}" stroke="${c}" stroke-width="4" fill="none" opacity="${safety >= a && safety < b + (b === 100 ? 1 : 0) ? 1 : .35}"/>`).join("")}
    <path d="${arc(0, 100, r)}" stroke="${PAL.rule}" stroke-width="1" fill="none"/>
    ${ticks}
    <line x1="${cx - r - 8}" y1="${cy}" x2="${cx + r + 8}" y2="${cy}" stroke="${PAL.rule}"/>
    <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="5" fill="${PAL.bone}"/>
    <text x="${cx}" y="${cy + 50}" fill="${PAL.bone}" font-size="44" font-weight="600" text-anchor="middle" font-family="JetBrains Mono, monospace" letter-spacing="-2">${safety}</text>
    <text x="${cx}" y="${cy + 68}" fill="${PAL.bone3}" font-size="10" text-anchor="middle" font-family="Archivo, sans-serif">flood safety / 100</text>
  </svg>`;
}

function scale(now, design, single) {
  const pos = (v) => Math.max(0.5, Math.min(99.5, v));
  if (single) return `<div class="scale"><div class="track"></div><div class="ticks"></div>
    <div class="fill" style="width:${pos(now)}%;--fc:${riskColor(now)}"></div>
    <div class="mk single ${now > 80 ? "flip" : ""}" style="left:${pos(now)}%"><span>long-term ${now}</span></div></div>`;
  return `<div class="scale">
    <div class="track"></div><div class="ticks"></div>
    <div class="fill" style="width:${pos(now)}%;--fc:${riskColor(now)}"></div>
    <div class="mk design ${design > 80 ? "flip" : ""}" style="left:${pos(design)}%"><span>monsoon ${design}</span></div>
    <div class="mk ${now > 80 ? "flip" : ""}" style="left:${pos(now)}%"><span>now ${now}</span></div>
  </div>`;
}

const LEVEL = (s) => s >= 75 ? "Very high" : s >= 55 ? "High" : s >= 35 ? "Moderate" : s >= 15 ? "Low" : "Very low";

function render(d, nameHint) {
  const out = $("#sc-result");
  const t = d.terrain, r = d.river, w = d.weather, s = d.seismic;
  const place = nameHint && !/^-?\d/.test(nameHint) ? nameHint : (d.place.name || `${d.lat}, ${d.lon}`);
  const dom = d.hazards[d.dominant];
  const domNow = dom.now.score, domDesign = dom.design.score;
  const summary = d.safety >= 85
    ? `No hazard stands out, either over the next 72 hours or in a heavy-monsoon event.`
    : `The main concern is <b>${dom.label.toLowerCase()}</b>: ${LEVEL(domNow).toLowerCase()} now (${domNow}/100) and ${LEVEL(domDesign).toLowerCase()} in a 1-in-10-year monsoon storm (${domDesign}/100).`;

  out.innerHTML = `
    <div class="place-h">
      <div><p class="kicker" style="margin:0 0 10px">Safety check · ${d.lat.toFixed(3)}°N, ${d.lon.toFixed(3)}°E</p><h2>${esc(place)}</h2></div>
      <div class="meta">${esc([d.place.admin, d.place.country].filter(Boolean).join(" · "))}<br>Elevation ${fmtNum(t.elevation)} m · assessed ${fmtIST(d.generated)}<br>
        <a class="btn small" style="margin-top:8px" href="#fleet?lat=${d.lat}&lon=${d.lon}&name=${encodeURIComponent(place)}">Which satellites can help here? →</a></div>
    </div>
    <div class="safety-wrap">
      <div>
        <div class="verdict">
          ${dial(d.safety, d.grade)}
          <div class="verdict-text">
            <div class="grade-line" style="color:${gradeColor(d.grade)}">${d.grade} · <em>${esc(d.label)}</em></div>
            <p>${summary}</p>
            <p class="disclaimer">${esc(d.disclaimer || "Screening estimate from public data. Not an official hazard assessment.")}</p>
            <div class="sub-ratings">
              <div><b style="color:${gradeColor(d.gradeNow)}">${d.safetyNow}<span style="font-size:14px;color:var(--text-3)"> ${d.gradeNow}</span></b><span>Next 72 hours</span></div>
              <div><b style="color:${gradeColor(d.gradeDesign)}">${d.safetyDesign}<span style="font-size:14px;color:var(--text-3)"> ${d.gradeDesign}</span></b><span>Heavy-monsoon storm (1 in 10 yr)</span></div>
            </div>
          </div>
        </div>
        <h3 style="margin-top:28px">Flood hazards, 0 to 100 (these make the rating)</h3>
        <div class="hz-legend"><span><i></i>now · next 72 h (live forecast)</span><span><i class="d"></i>design event · ${fmtNum(d.designEvent.rain24h)} mm in 24 h, 20-yr river flood</span></div>
        ${ORDER.map(k => {
          const h = d.hazards[k];
          const peak = Math.max(h.now.score, h.design.score);
          return `<div class="hz">
            <div class="hz-top"><h4>${esc(h.label)}</h4><span class="lv" style="color:${riskColor(peak)}">${LEVEL(h.now.score)} now · ${LEVEL(h.design.score)} in a monsoon storm</span></div>
            ${scale(h.now.score, h.design.score, false)}
            <p><b>Now:</b> ${esc(h.now.why)}</p>
            <p><b>Monsoon event:</b> ${esc(h.design.why)}</p>
          </div>`;
        }).join("")}
        ${d.seismicExposure ? `<div class="seismic-box">
          <div class="hz-top"><h4>Long-term seismic exposure</h4><span class="lv" style="color:${riskColor(d.seismicExposure.score)}">${LEVEL(d.seismicExposure.score)}</span></div>
          ${scale(d.seismicExposure.score, 0, true)}
          <p class="note" style="margin-top:2px">${esc(d.seismicExposure.why)} This does not change day to day, so it is kept out of the rating above.</p>
        </div>` : ""}
        <h3 style="margin-top:30px">What to do</h3>
        <ol class="advice">${d.advice.map(a => `<li><span>${esc(a)}</span></li>`).join("")}</ol>
        <details class="method"><summary>How this rating is made</summary>
          <p>${esc(d.method.summary)}</p>
          <ul>${d.method.inputs.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
          <ul>${Object.entries(d.method.hazards).map(([k, v]) => `<li><b>${esc(d.hazards[k].label)}:</b> ${esc(v)}</li>`).join("")}</ul>
          <p>${esc(d.method.scenarios)}</p><p>${esc(d.method.rating)}</p>
          ${Object.keys(d.errors || {}).length ? `<p class="note">Missing inputs: ${esc(Object.keys(d.errors).join(", "))}.</p>` : ""}
        </details>
      </div>

      <div>
        <div id="sc-map" class="small-map" style="height:330px"></div>
        <div class="facts">
          <div><b>${fmtNum(t.elevation)} m</b><span>Elevation</span></div>
          <div><b>${t.slope.toFixed(1)}°</b><span>Local slope</span></div>
          <div><b>${fmtNum(t.relMin)} m</b><span>Above low ground</span></div>
          <div><b>${w ? fmtNum(w.next72h) : "–"} mm</b><span>Rain next 72 h</span></div>
        </div>
        <h3>Terrain cross-section · ±9 km</h3>
        <div class="chart-box short"><canvas id="ch-profile"></canvas></div>
        ${r ? `<h3>River discharge vs flood levels · GloFAS (${r.years} yrs)</h3><div class="chart-box"><canvas id="ch-q"></canvas></div>` : ""}
        ${w ? `<h3>Rain, next 72 hours · soil ${Math.round(w.saturation * 100)}% saturated</h3><div class="chart-box short"><canvas id="ch-rain72"></canvas></div>` : ""}
        <h3>Earthquakes within 300 km</h3>
        <ul class="quake-list" id="sc-quakes"><li class="skeleton">Loading…</li></ul>
        ${s ? `<p class="note">${s.count5} M5+ and ${s.count45} M4.5+ since 1975 (USGS). Strongest: ${s.notable[0] ? `M${s.notable[0].mag.toFixed(1)}, ${esc(s.notable[0].place)} (${s.notable[0].year})` : "–"}.</p>` : ""}
      </div>
    </div>`;

  drawMap(d);
  drawCharts(d);
  loadQuakes(d);
}

function drawMap(d) {
  if (map) { map.remove(); map = null; }
  map = L.map("sc-map", { center: [d.lat, d.lon], zoom: 11, zoomControl: true, attributionControl: true });
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 17, attribution: "Imagery © Esri, Maxar" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16 }).addTo(map);
  const box = 0.08;
  L.rectangle([[d.lat - box, d.lon - box], [d.lat + box, d.lon + box]], { color: PAL.brass, weight: 1, dashArray: "4 4", fill: false, interactive: false }).addTo(map);
  L.polyline([[d.lat, d.lon - box], [d.lat, d.lon + box]], { color: PAL.bone, weight: 1, opacity: .6 }).addTo(map);
  L.circleMarker([d.lat, d.lon], { radius: 7, color: PAL.bone, weight: 2, fillColor: gradeColor(d.grade), fillOpacity: 1 }).addTo(map);
  map.on("click", (e) => goSafety({ lat: e.latlng.lat, lon: e.latlng.lng, name: "" }));
}

function drawCharts(d) {
  const t = d.terrain;
  const km = t.profileWE.map((_, i) => ((i - 4) * t.spacingKm).toFixed(1));
  makeChart($("#ch-profile"), {
    type: "line",
    data: { labels: km, datasets: [
      { label: "West → East", data: t.profileWE, borderColor: PAL.brass, backgroundColor: "rgba(201,163,78,.12)", fill: "start", pointRadius: (c) => c.dataIndex === 4 ? 4 : 0, pointBackgroundColor: PAL.sand, borderWidth: 1.5, tension: .35 },
      { label: "South → North", data: [...t.profileNS].reverse(), borderColor: PAL.water, borderDash: [4, 3], pointRadius: 0, borderWidth: 1.2, tension: .35 },
    ] },
    options: { scales: { x: { title: { display: true, text: "km from site" }, grid: { display: false } }, y: { title: { display: true, text: "m" } } } },
  });
  const r = d.river;
  if (r) {
    const th = r.thresholds;
    const lab = r.series.time.map(x => x.slice(5));
    const line = (v) => lab.map(() => v);
    makeChart($("#ch-q"), {
      type: "line",
      data: { labels: lab, datasets: [
        { label: "Forecast", data: r.series.q, borderColor: PAL.water, backgroundColor: "rgba(127,168,196,.12)", fill: "start", pointRadius: 0, borderWidth: 1.8, tension: .3 },
        { label: "Ensemble max", data: r.series.qmax, borderColor: PAL.water, borderDash: [2, 3], pointRadius: 0, borderWidth: 1 },
        { label: `2-yr ${fmtNum(th.Q2)}`, data: line(th.Q2), borderColor: PAL.amber, pointRadius: 0, borderWidth: 1 },
        { label: `5-yr ${fmtNum(th.Q5)}`, data: line(th.Q5), borderColor: PAL.sand, pointRadius: 0, borderWidth: 1 },
        { label: `20-yr ${fmtNum(th.Q20)}`, data: line(th.Q20), borderColor: PAL.crimson, pointRadius: 0, borderWidth: 1 },
      ] },
      options: { scales: { x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } }, y: { title: { display: true, text: "m³/s" }, beginAtZero: true } } },
    });
  }
  const w = d.weather;
  if (w) {
    makeChart($("#ch-rain72"), {
      type: "bar",
      data: { labels: w.hourly.time.map(x => x.slice(8, 13).replace("T", " ") + "h"), datasets: [{ label: "mm / hour", data: w.hourly.p, backgroundColor: w.hourly.p.map(v => v >= 20 ? PAL.crimson : v >= 7.5 ? PAL.sand : PAL.water), barPercentage: 1, categoryPercentage: .9 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 7 }, grid: { display: false } }, y: { beginAtZero: true, suggestedMax: 5 } } },
    });
  }
}

async function loadQuakes(d) {
  const el = $("#sc-quakes");
  const hav = (a, b, c, e) => { const R = Math.PI / 180; const x = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((e - b) * R / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  try {
    const q = await api("/api/earthquakes", { ttl: 300_000 });
    const near = q.events.map(e => ({ ...e, dist: hav(d.lat, d.lon, e.lat, e.lon) })).filter(e => e.dist <= 300).slice(0, 6);
    const hist = (d.seismic?.notable || []).slice(0, 3);
    el.innerHTML = near.map(e => `<li><span class="mg" style="color:${e.mag >= 5 ? PAL.crimson : e.mag >= 4 ? PAL.sand : PAL.bone}">${e.mag.toFixed(1)}</span>
        <span class="pl">${esc(e.place)}<span class="src">${e.source}</span><br><span class="muted small">${fmtNum(e.dist)} km away · depth ${fmtNum(e.depth)} km</span></span><span class="tm">${timeAgo(e.time)}</span></li>`).join("")
      + hist.map(e => `<li><span class="mg muted">${e.mag.toFixed(1)}</span><span class="pl">${esc(e.place)}<br><span class="muted small">${fmtNum(e.dist)} km away · historical</span></span><span class="tm">${e.year}</span></li>`).join("")
      || `<li class="skeleton">No recorded earthquakes within 300 km in the past 30 days.</li>`;
    if (map) near.forEach(e => L.circleMarker([e.lat, e.lon], { radius: 3 + e.mag * 1.5, color: PAL.sand, weight: 1, fillOpacity: .3 }).bindTooltip(`M${e.mag.toFixed(1)} · ${esc(e.place)} · ${timeAgo(e.time)}`).addTo(map));
  } catch (e) {
    el.innerHTML = `<li class="skeleton">Earthquake feed unavailable.</li>`;
  }
}
