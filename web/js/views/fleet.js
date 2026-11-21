// Fleet readiness: for one place (usually a live alert), which Indian satellites pass over it
// in the next 24 h, are any of them facing a close approach this week, and how good is NavIC there.
import { api } from "../core/api.js";
import { satrec, ecfAt, observer, look, orbitInfo, dop, dopQuality } from "../core/orbitmath.js";
import { $, esc, fmtNum, fmtIST, timeAgo, toast, PAL, TYPE_ICON, SRC_LABEL } from "../core/util.js";
import { getFocus, setFocus } from "../core/focus.js";

const ROLES = [
  { key: "radar", label: "Radar imaging", why: "sees through cloud, day or night", re: /EOS-4\b|EOS-04|RISAT|NISAR|DRISHTI/, color: PAL.saffron, minEl: 40 },
  { key: "optical", label: "Optical imaging", why: "damage and flood extent in clear weather", re: /CARTOSAT|RESOURCESAT|EOS-08|HYSIS|FIREFLY|FFLY|IRS-P5|TSAT/, color: PAL.water, minEl: 45 },
  { key: "weather", label: "Weather & ocean", why: "rain, cyclone and sea-state monitoring", re: /INSAT-3D|OCEANSAT|EOS-6\b|EOS-06|SCATSAT|SARAL/, color: PAL.sage, minEl: 20 },
  { key: "comms", label: "Communications", why: "relay links when towers are down", re: /GSAT|CMS-/, color: PAL.amber, minEl: 10 },
  { key: "nav", label: "Navigation (NavIC)", why: "position fixes for rescue teams", re: /IRNSS|NVS-0/, color: PAL.saffron, minEl: 10 },
];
const roleOf = (name) => ROLES.find(r => r.re.test(name));

let alerts = [], fleet = null, conj = null, gnss = null, navicStatus = {};

export async function init() {
  $("#fl-go").onclick = () => {
    const a = alerts.find(x => x.id === $("#fl-alert").value);
    if (a) location.hash = `#fleet?lat=${a.lat.toFixed(4)}&lon=${a.lon.toFixed(4)}&name=${encodeURIComponent(a.area || a.title.slice(0, 60))}&alert=${encodeURIComponent(a.id)}`;
  };
  try {
    const d = await api("/api/alerts", { ttl: 120_000 });
    alerts = d.alerts.filter(a => a.lat != null && (a.source === "sachet" || a.source === "ncs" || a.severity >= 2) && a.lat > 0 && a.lat < 40 && a.lon > 60 && a.lon < 100)
      .sort((a, b) => (b.severity - a.severity) || (new Date(b.time) - new Date(a.time))).slice(0, 80);
    $("#fl-alert").innerHTML = alerts.map(a => `<option value="${esc(a.id)}">[${(SRC_LABEL[a.source] || a.source)} · ${a.type}] ${esc(a.title.slice(0, 95))}</option>`).join("");
  } catch {
    $("#fl-alert").innerHTML = `<option>Alerts unavailable</option>`;
  }
}

export function show(params = {}) {
  if (params.lat && params.lon) run(+params.lat, +params.lon, params.name || "", params.alert);
  else if (!$("#fl-result").innerHTML.trim() && getFocus()) {   // a place picked elsewhere (e.g. Safety check)
    const f = getFocus();
    run(f.lat, f.lon, f.name);
  } else if (!$("#fl-result").innerHTML.trim() && alerts.length) {
    const a = alerts[0];
    run(a.lat, a.lon, a.area || a.title.slice(0, 60), a.id);
  }
}

async function loadData() {
  if (!fleet) {
    const d = await api("/api/catalog/orbits?part=payloads", { ttl: 3_600_000 });
    fleet = d.sats.filter(r => (r[6] & 1) && r[4] === 0 && r[8] !== "-" && r[8] !== "D")
      .map(r => ({ norad: r[0], name: r[1], rec: satrec(r[2], r[3]), status: r[8], role: roleOf(r[1]) }))
      .filter(s => s.rec && s.role && !/IRNSS|NVS-0/.test(s.name));   // NavIC is reported separately below
  }
  if (!conj) { try { conj = await api("/api/conjunctions", { ttl: 600_000 }); } catch { conj = { india: [] }; } }
  if (!gnss) {
    try {
      const g = await api("/api/orbits/gnss", { ttl: 3_600_000 });
      gnss = g.sats.filter(s => /IRNSS|NVS-0/.test(s[1])).map(([norad, name, l1, l2]) => ({ norad, name, rec: satrec(l1, l2) })).filter(s => s.rec && orbitInfo(s.rec).periodMin > 1300);
      try { const st = await api("/api/catalog/stats", { ttl: 3_600_000 }); st.navic.forEach(n => navicStatus[n.norad] = n.status); } catch {}
    } catch { gnss = []; }
  }
}

function passes(sat, obs, start) {
  // 60 s sampling over 24 h; a "pass" is a run of samples above the role's minimum elevation.
  const out = [];
  let cur = null, alwaysUp = true, minEl = 90;
  for (let m = 0; m <= 1440; m += 1) {
    const t = new Date(start + m * 60000);
    const f = ecfAt(sat.rec, t);
    if (!f) { alwaysUp = false; continue; }
    const la = look(obs, f);
    minEl = Math.min(minEl, la.el);
    if (la.el < sat.role.minEl) alwaysUp = false;
    if (la.el >= sat.role.minEl) {
      if (!cur) cur = { start: t, max: la.el, tmax: t, end: t };
      if (la.el > cur.max) { cur.max = la.el; cur.tmax = t; }
      cur.end = t;
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return { list: out, alwaysUp, minEl };
}

function closeApproach(norad) {
  const now = Date.now();
  const rows = (conj?.india || []).filter(r => (r.id1 === norad || r.id2 === norad) && r.rangeKm < 5 && new Date(r.tca).getTime() > now)
    .sort((a, b) => a.rangeKm - b.rangeKm);
  if (!rows.length) return { level: "clear", text: "No approach under 5 km this week" };
  const r = rows[0];
  const other = r.id1 === norad ? r.name2 : r.name1;
  const km = r.rangeKm;
  return { level: km < 1 ? "alert" : "watch", text: `${km < 1 ? fmtNum(km * 1000) + " m" : km.toFixed(2) + " km"} from ${other}, ${fmtIST(r.tca)}`, row: r };
}

async function run(lat, lon, name, alertId) {
  setFocus({ lat, lon, name });
  const out = $("#fl-result");
  out.innerHTML = `<p class="loading-line">Propagating the Indian fleet over ${esc(name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`)} for the next 24 hours</p>`;
  try { await loadData(); } catch (e) { out.innerHTML = `<p class="muted">Satellite catalogue unavailable: ${esc(e.message)}</p>`; return; }
  await new Promise(r => setTimeout(r, 20));   // let the loading line paint
  const alert = alerts.find(a => a.id === alertId);
  if (alert) $("#fl-alert").value = alert.id;
  const obs = observer(lat, lon, 0);
  const start = Date.now();
  const rows = fleet.map(s => {
    const p = passes(s, obs, start);
    const info = orbitInfo(s.rec);
    const geo = info.regime === "GEO/IGSO";
    const next = p.list.find(x => x.end.getTime() >= start);
    return { ...s, ...p, geo, next, ca: closeApproach(s.norad) };
  }).filter(r => r.list.length || (r.geo && r.minEl > 0));
  const prio = ROLES.map(r => r.key);
  rows.sort((a, b) => prio.indexOf(a.role.key) - prio.indexOf(b.role.key) || ((a.next?.start ?? 0) - (b.next?.start ?? 0)));

  // NavIC quality now and across the day
  let navNow = null, navWorst = null, navBest = null, navVisible = 0;
  if (gnss.length) {
    const usable = gnss.filter(s => ["+", "P"].includes(navicStatus[s.norad] ?? "+"));
    for (let h = 0; h <= 24; h += 1) {
      const t = new Date(start + h * 3600000);
      const ls = usable.map(s => { const f = ecfAt(s.rec, t); return f ? look(obs, f) : null; }).filter(x => x && x.el >= 10);
      const d = dop(ls);
      if (h === 0) { navNow = d; navVisible = ls.length; }
      if (d) { navBest = !navBest || d.pdop < navBest.pdop ? d : navBest; navWorst = !navWorst || d.pdop > navWorst.pdop ? d : navWorst; }
    }
  }
  const counts = Object.fromEntries(ROLES.map(r => [r.key, rows.filter(x => x.role.key === r.key).length]));
  const watch = rows.filter(r => r.ca.level !== "clear");
  const [navQ, navC] = dopQuality(navNow?.pdop);

  out.innerHTML = `
    <div class="place-h">
      <div><p class="kicker" style="margin:0 0 10px">${alert ? `${TYPE_ICON[alert.type] || ""}${esc(SRC_LABEL[alert.source] || alert.source)} · ${esc(alert.severityText || "")} · ${timeAgo(alert.time)}` : "Selected place"}</p>
        <h2>${esc(name || `${lat.toFixed(2)}, ${lon.toFixed(2)}`)}</h2>
        ${alert ? `<p class="muted" style="margin:10px 0 0;max-width:760px">${esc(alert.title)}</p>` : ""}</div>
      <div class="meta">${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E<br>Window: now to ${fmtIST(new Date(start + 86400000))}<br>
        <a class="btn small" style="margin-top:8px" href="#safety?lat=${lat}&lon=${lon}&name=${encodeURIComponent(name)}">Safety check →</a></div>
    </div>
    <div class="chain-strip">
      <div><b>1 · Disaster</b><span>${alert ? esc(alert.event || alert.type) : "Place of interest"}</span><span class="n" style="color:${alert ? PAL.saffron : PAL.bone}">${alert ? esc(alert.severityText || alert.type) : "—"}</span></div>
      <div><b>2 · Indian satellites overhead, 24 h</b><span>${counts.radar} radar · ${counts.optical} optical · ${counts.weather} weather · ${counts.comms} comms</span><span class="n">${rows.length}</span></div>
      <div><b>3 · Safe to rely on</b><span>${watch.length ? `${watch.length} with a close approach this week` : "none has a close approach under 5 km this week"}</span><span class="n" style="color:${watch.length ? PAL.amber : PAL.sage}">${rows.length - watch.length} / ${rows.length}</span></div>
    </div>
    <div class="fleet-head" style="margin-top:18px">
      <div class="card">
        <div class="card-h"><h2>NavIC on the ground</h2><span class="muted small">${navVisible} NavIC satellites above 10°</span></div>
        <div class="fleet-summary">
          <div class="stat"><div class="v" style="color:${navC}">${navNow ? navNow.pdop.toFixed(1) : "–"}</div><div class="l">PDOP now · ${navQ}</div></div>
          <div class="stat"><div class="v">${navBest ? navBest.pdop.toFixed(1) : "–"}</div><div class="l">best in next 24 h</div></div>
          <div class="stat"><div class="v">${navWorst ? navWorst.pdop.toFixed(1) : "–"}</div><div class="l">worst in next 24 h</div></div>
        </div>
        <p class="note">Rescue teams can get a NavIC-only fix here ${navNow && navNow.pdop < 6 ? "with usable geometry" : "but geometry is weak; combine with GPS"}. Lower is better.</p>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          ${alert ? `<button class="btn" id="fl-bcast">Send NavIC broadcast →</button>` : ""}
          <a class="btn ghost" href="#navic">NavIC details</a>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h2>What each role brings</h2></div>
        <ul class="advice">${ROLES.filter(r => r.key !== "nav").map(r => `<li><span><b style="color:${r.color}">${r.label}</b>: ${r.why}. <span class="muted">${counts[r.key]} overhead.</span></span></li>`).join("")}</ul>
      </div>
    </div>
    <h3 style="margin-top:28px">Indian satellites over this spot · next 24 hours</h3>
    <div style="overflow-x:auto">
    <table class="table fleet-table">
      <thead><tr><th>Satellite</th><th>Role</th><th>Next pass (IST)</th><th>24-hour timeline</th><th>Close approach this week</th></tr></thead>
      <tbody>${rows.map(r => {
        const ticks = r.geo && r.alwaysUp ? `<i class="hi" style="left:0;width:100%;opacity:.35"></i>` : r.list.map(p => `<i class="${p.max >= 70 ? "hi" : ""}" style="left:${((p.start - start) / 864e5 * 100).toFixed(2)}%;width:${Math.max(0.6, (p.end - p.start) / 864e5 * 100).toFixed(2)}%" title="${fmtIST(p.start)} · max elevation ${p.max.toFixed(0)}°"></i>`).join("");
        const nextTxt = r.geo && r.alwaysUp ? "In view all day (geostationary)" : r.next ? `${fmtIST(r.next.tmax)} · ${r.next.max.toFixed(0)}° max` : "–";
        const caCol = r.ca.level === "alert" ? PAL.crimson : r.ca.level === "watch" ? PAL.amber : PAL.sage;
        return `<tr class="click" data-norad="${r.norad}"><td class="mono">${esc(r.name)}</td><td><span class="role" style="--rc:${r.role.color}">${r.role.label}</span></td>
          <td class="mono">${nextTxt}</td><td><div class="bar">${ticks}</div></td>
          <td><span class="safe-chip" style="color:${caCol}">${r.ca.level === "clear" ? "Clear" : r.ca.level === "alert" ? "Alert" : "Watch"}</span> <span class="muted small">${esc(r.ca.text)}</span></td></tr>`;
      }).join("") || `<tr><td colspan="5" class="muted">No Indian imaging or relay satellite passes high enough over this spot in the next 24 hours.</td></tr>`}</tbody>
    </table></div>
    <p class="note">Pass = satellite above the role's minimum elevation from this spot (radar 40°, optical 45°, weather 20°, comms 10°). Whether a sensor is actually pointed here depends on tasking by the operator. Close approaches come from CelesTrak SOCRATES with same-launch pairs removed; public orbit data is accurate to about 1 km, so treat them as an early-warning screen.</p>`;

  $("#fl-bcast")?.addEventListener("click", () => { window.__astraBroadcast = alert; location.hash = "#navic"; });
  out.querySelector("tbody")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-norad]");
    if (!tr) return;
    const r = rows.find(x => x.norad === +tr.dataset.norad);
    if (r?.ca.row) { window.__astraPendingConj = { a: r.ca.row.id1, b: r.ca.row.id2, t: r.ca.row.tca }; location.hash = "#orbital"; }
    else toast(`${r.name}: no close approach this week. Open Orbital Safety and search its name to see it on the globe.`);
  });
}
