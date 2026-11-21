// Loading card with real progress and a rotating fact (bundled, no network).
const FACTS = [
  "Satellites in low orbit travel at about 7.8 km/s, around 28,000 km/h.",
  "The International Space Station circles Earth roughly every 90 minutes.",
  "China's 2007 Fengyun-1C anti-satellite test created the largest debris cloud on record, over 3,000 tracked pieces.",
  "In February 2009, Iridium 33 and Cosmos 2251 collided over Siberia: the first accidental collision of two intact satellites.",
  "NavIC is India's own navigation system, covering India and about 1,500 km around it.",
  "Some NavIC satellites trace a figure-of-eight over India from about 36,000 km up.",
  "INSAT-3DS, launched in February 2024, watches India's weather from geostationary orbit.",
  "Radar satellites such as Sentinel-1 can map floods through cloud and at night.",
  "India's 2019 Mission Shakti test was done at low altitude so most debris would re-enter quickly.",
  "Objects about 10 cm and larger are tracked in low orbit; millions of smaller fragments are not.",
  "Chandrayaan-3 landed near the Moon's south pole on 23 August 2023, now India's National Space Day.",
];
let factIdx = Math.floor(Math.random() * FACTS.length);
const nextFact = () => FACTS[factIdx++ % FACTS.length];

function card(cls, inner) {
  const el = document.createElement("div");
  el.className = `loader ${cls}`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = inner + `<p class="fact"><b>Did you know?</b> <span></span></p>`;
  const f = el.querySelector(".fact span");
  f.textContent = nextFact();
  el._timer = setInterval(() => {
    f.classList.add("out");
    setTimeout(() => { f.textContent = nextFact(); f.classList.remove("out"); }, 250);
  }, 4200);
  return el;
}

/** Overlay card with a real percentage. set(pct, step) / done(). */
export function progressLoader(host, title) {
  const el = card("overlay glass", `<div class="ld-h"><span class="ld-t">${title}</span><b class="ld-p">0%</b></div>
    <div class="progress"><i></i></div><p class="ld-s">Starting…</p>`);
  host.appendChild(el);
  let last = 0;
  return {
    set(pct, step) {
      pct = Math.max(last, Math.min(100, pct));   // never goes backwards
      last = pct;
      el.querySelector(".ld-p").textContent = `${Math.floor(pct)}%`;
      el.querySelector(".progress i").style.width = `${pct}%`;
      if (step) el.querySelector(".ld-s").textContent = step;
    },
    done() {
      clearInterval(el._timer);
      el.classList.add("gone");
      setTimeout(() => el.remove(), 450);
    },
  };
}

/** Inline card for a single slow request: shows what is happening and the seconds elapsed (no fake percent). */
export function waitCard(host, text) {
  const el = card("inline", `<div class="ld-h"><span class="ld-t">${text}</span><b class="ld-p">0 s</b></div><div class="progress indet"><i></i></div>`);
  host.innerHTML = "";
  host.appendChild(el);
  const t0 = Date.now();
  const tick = setInterval(() => { el.querySelector(".ld-p").textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
  return () => { clearInterval(tick); clearInterval(el._timer); el.remove(); };
}
