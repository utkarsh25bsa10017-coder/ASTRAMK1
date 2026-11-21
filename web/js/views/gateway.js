import { api, provenance } from "../core/api.js";
import { $, esc, fmtNum, timeAgo } from "../core/util.js";

let timer;

export async function init() { await render(); }
export function show() { render(); clearInterval(timer); timer = setInterval(render, 15000); }
export function hide() { clearInterval(timer); }

async function render() {
  try {
    const d = await api("/api/gateway", { ttl: 5000, force: true });
    const rows = d.sources.map(s => {
      const h = d.health[s.id];
      const direct = ["gibs", "bhuvan", "vedas"].includes(s.id);
      const status = direct ? `<span class="prov cache">map tiles</span>`
        : !h ? `<span class="prov idle">not used yet</span>`
        : h.last_status === "ok" ? `<span class="prov live">ok</span>`
        : h.last_status === "cache" ? `<span class="prov cache">cached</span>` : `<span class="prov error">error</span>`;
      const meta = direct ? "Loaded by the browser as map layers" : h ? `${h.last_ms != null ? h.last_ms + " ms" : ""}${h.last_bytes ? " · " + fmtNum(h.last_bytes / 1024) + " KB" : ""} · ${timeAgo(new Date(h.last_time * 1000))}${h.cooldown_s ? ` · retry in ${Math.ceil(h.cooldown_s / 60)} min` : ""}${h.last_status === "error" ? `<br><span class="small" style="color:var(--danger)">${esc(h.last_detail)}</span>` : ""}` : "";
      return `<tr><td>${esc(s.name)}<div class="small muted">${esc(s.provider)}</div></td>
        <td><span class="badge">${esc(s.domain)}</span></td>
        <td>${esc(s.use)}</td>
        <td>${status}<div class="small muted">${meta}</div></td>
        <td class="small">${esc(s.terms)}</td>
        <td><a href="${esc(s.url)}" target="_blank" rel="noopener" class="small">endpoint ↗</a></td></tr>`;
    }).join("");
    const used = Object.entries(provenance).filter(([k]) => !k.includes("/api/gateway"))
      .map(([k, v]) => `<span class="prov ${v}">${v}</span> <span class="mono small">${esc(k)}</span>`).join("<br>");
    $("#gw-table").innerHTML = `<thead><tr><th>Source</th><th>Domain</th><th>Used for</th><th>Last fetch</th><th>Terms</th><th></th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td colspan="6"><h3>This browser session</h3>${used || "<span class='muted'>No API calls yet.</span>"}</td></tr></tfoot>`;
  } catch (e) {
    $("#gw-table").innerHTML = `<tbody><tr><td>Gateway status unavailable: ${esc(e.message)}</td></tr></tbody>`;
  }
}
