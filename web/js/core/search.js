// Place search with suggestions (Open-Meteo geocoding via the ASTRA gateway).
import { api } from "./api.js";
import { esc, toast } from "./util.js";

export function attachSearch(form, list, onPick) {
  const input = form.querySelector("input");
  let results = [], idx = -1, timer;
  const render = () => {
    list.innerHTML = results.map((r, i) => `<li class="${i === idx ? "on" : ""}" data-i="${i}"><span class="nm">${esc(r.name)}</span><span class="ad">${esc([r.admin, r.country].filter(Boolean).join(" · "))}</span></li>`).join("");
  };
  const lookup = async (q) => {
    try { results = await api(`/api/geocode?q=${encodeURIComponent(q)}`, { ttl: 3_600_000 }); }
    catch { results = []; }
    idx = results.length ? 0 : -1;
    render();
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results = []; render(); return; }
    timer = setTimeout(() => lookup(q), 220);
  });
  input.addEventListener("keydown", (e) => {
    if (!results.length) return;
    if (e.key === "ArrowDown") { idx = Math.min(results.length - 1, idx + 1); render(); e.preventDefault(); }
    if (e.key === "ArrowUp") { idx = Math.max(0, idx - 1); render(); e.preventDefault(); }
    if (e.key === "Escape") { results = []; render(); }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) { e.preventDefault(); pick(results[+li.dataset.i]); }
  });
  input.addEventListener("blur", () => setTimeout(() => { list.innerHTML = ""; }, 150));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (!results.length) await lookup(q);
    if (results.length) pick(results[Math.max(0, idx)]);
    else toast(`No place found for “${q}”.`);
  });
  function pick(r) {
    if (!r) return;
    input.value = r.name;
    results = []; render();
    onPick(r);
  }
  return { lookup: async (q) => { input.value = q; await lookup(q); if (results.length) pick(results[0]); } };
}

export function goSafety(r) {
  const p = new URLSearchParams({ lat: (+r.lat).toFixed(4), lon: (+r.lon).toFixed(4), name: r.name || "" });
  location.hash = `#safety?${p}`;
}
