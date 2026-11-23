// Aircraft classes, map silhouettes and a procedural low-poly 3D model for the Flights workspace.
// Each ICAO type designator (A20N, B77W, AT76 …) maps to a class with its own outline, so a glance at the map
// tells an A380 from an ATR from a helicopter. Without a type (OpenSky overview) the ADS-B emitter category,
// then speed and altitude, pick the class.

export const CLASSES = {
  heavy4: { label: "Four-engine jumbo", hint: "B747, A380, A340", scale: 1.42 },
  wide: { label: "Twin-aisle jet", hint: "B777, B787, A330, A350", scale: 1.3 },
  narrow: { label: "Single-aisle jet", hint: "A320 family, B737", scale: 1.0 },
  regional: { label: "Regional jet", hint: "E-Jets, CRJ", scale: 0.86 },
  prop: { label: "Turboprop", hint: "ATR 72, Q400, Dornier 228", scale: 0.9 },
  biz: { label: "Business jet", hint: "Citation, Gulfstream, Falcon", scale: 0.74 },
  light: { label: "Light aircraft", hint: "Cessna, Piper, trainers", scale: 0.64 },
  heli: { label: "Helicopter", hint: "Dhruv, AW139, Bell 412", scale: 0.78 },
  mil: { label: "Military transport", hint: "C-17, C-130J, Il-76", scale: 1.3 },
  fighter: { label: "Fighter / trainer", hint: "Su-30, Rafale, Hawk", scale: 0.8 },
  other: { label: "Glider, drone, other", hint: "", scale: 0.66 },
};
export const CLASS_ORDER = Object.keys(CLASSES);

const MIL = new Set(["C17", "C130", "C30J", "C5", "C5M", "IL76", "IL78", "AN12", "AN26", "AN32", "A124", "A400", "K35R", "KC35", "KC46",
  "K46", "C2", "E3TF", "E3CF", "A50", "C390", "AN22", "P8", "P3", "C295", "CN35", "E6", "E8", "KC10", "MRTT", "A332M", "IL38", "TU95", "B52", "B1", "B2"]);
const FIGHTER = /^(SU2[57]|SU30|SU3\d|MG2\d|MIG\d*|F1[4-8]|FA18|F18[A-Z]?|F35|F22|F5|EUFI|RFAL|M200|MIR2|MIRA|JAGR|JAG|LCA|TEJ|HAWK|HAW|T38|T6|K8|PC7|PC9|PC21|HJT|L39|L159|JF17|J10|J11|TOR|A10|AJET|ALJT|MB33|G4|SB39|GRIF)/;
const RX = [
  ["heli", /^(H\d{2,}|EC\d|AS\d|AS3|AS5|B06|B05|B407|B412|B427|B429|B430|B47|R22|R44|R66|A109|A119|A139|A149|A169|A189|AW\d|S76|S92|S61|MI8|MI17|MI24|MI26|MI35|MI38|KA\d|ALH|DHRU|LCH|LUH|CH47|H47|UH1|H60|EH10|NH90|BK17|EXPL|LYNX|PUMA|SA\d|G2CA|EN28|EN48)/],
  ["heavy4", /^(B74|A38|A34|IL96|B703|DC8|A3ST)/],
  ["wide", /^(B77|B78|A33|A35|B76|A30|A310|MD11|DC10|L101|IL86|B2XX)/],
  ["biz", /^(C25|C50|C51|C52|C55|C56|C68|C700|C750|C650|GLF|GL5T|GL6T|GL7T|GL8T|GLEX|G150|G200|G280|CL30|CL35|CL60|CL64|F2TH|F900|FA[5-9]X|FA10|FA20|FA50|LJ\d|H25|E55P|E50P|E545|E550|PC24|HDJT|SF50|PRM1|BE40|ASTR|GALX|E135L|BE4W)/],
  ["regional", /^(CRJ|E135|E145|E170|E75|E190|E195|E290|E295|E17\d|E19\d|SU95|AJ27|BA46|RJ\d|F70|F100|E45X|MRJ|J328)/],
  ["prop", /^(AT4|AT5|AT7|ATR|DH8|DHC6|DHC7|DH7|B190|B350|BE20|BE30|BE9|SF34|D228|D328|L410|JS3|JS4|SW4|C208|PC12|AN28|AN38|Y12|MA60|SB20|F27|F50|SH36|C212|B200|P180|DO28|TBM\d|KODI|SAAB|S340|E120|D28D|C441|C425|C340|C414|PAY\d|P68|BN2|DHC2|DHC3|G18|M28|AN2|IL18|AN24)/],
  ["narrow", /^(A3[12]|A19N|A20N|A21N|A22\d|BCS\d|B73|B38|B39|B3X|B75|B71|B72|C919|MD8|MD9|DC9|T204|T154|TU\d|YK42|Y42)/],
  ["light", /^(C1\d\d|C2[0-46-9]\d|P28|PA\d|DA[24]\d|DA62|SR2\d|BE3[3-6]|BE5|BE76|M20|TB\d|Z42|Z43|ZLIN|CH7|G115|TECN|RV\d|AA5|C77R|GA8|TAMP|EV97|PIVI|SIRA|FDCT|DV20|C42|SHRK|VIRU|ECHO|NG5|HR20|PA46|C82|SAVG|S22T|EUPA)/],
  ["other", /^(GLID|BALL|SHIP|ULAC|GYRO|UAV|DRON|PARA|ASK\d|DG\d|LS\d|DISC|NIMB|VENT|ARCP|QUAD)/],
];
const CAT = { A1: "light", A2: "biz", A3: "narrow", A4: "narrow", A5: "wide", A6: "fighter", A7: "heli", B1: "other", B2: "other", B3: "other", B4: "light", B6: "other", B7: "other" };

/** Aircraft object {type, cat, flags, alt, gs} -> class key. Ground service vehicles (category C*) -> null. */
export function classify(a) {
  const t = (a.type || "").toUpperCase();
  if (/^C\d/.test(a.cat || "") && !t) return null;
  if (t) {
    if (MIL.has(t)) return "mil";
    if (FIGHTER.test(t)) return "fighter";
    for (const [k, rx] of RX) if (rx.test(t)) return k;
  }
  if (CAT[a.cat]) return CAT[a.cat];
  if ((a.alt ?? 0) >= 20000 || (a.gs ?? 0) >= 300) return "narrow";
  if ((a.gs ?? 0) && a.gs < 110 && (a.alt ?? 0) < 6000) return "light";
  if ((a.alt ?? 0) > 0 && (a.alt ?? 0) < 18000 && (a.gs ?? 0) < 280) return "prop";
  return "narrow";
}

// ---------------------------------------------------------------------------------------------------------------
// Altitude colour ramp (cool low, warm high; red is kept for emergencies)
const RAMP = [[0, [79, 209, 197]], [5000, [108, 197, 154]], [12000, [179, 199, 110]], [22000, [227, 184, 90]], [32000, [238, 138, 79]], [42000, [244, 168, 120]]];
const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");
const altCache = new Map();
export function altColor(ft, ground) {
  if (ground) return "#9a9a9a";
  if (ft == null) return "#cfcfcf";
  const q = Math.max(0, Math.min(44000, Math.round(ft / 2000) * 2000));   // 2,000 ft buckets keep the sprite cache small
  if (altCache.has(q)) return altCache.get(q);
  let i = 1;
  while (i < RAMP.length - 1 && q > RAMP[i][0]) i++;
  const [a0, c0] = RAMP[i - 1], [a1, c1] = RAMP[i];
  const f = Math.max(0, Math.min(1, (q - a0) / (a1 - a0)));
  const c = "#" + c0.map((v, k) => hex2(v + (c1[k] - v) * f)).join("");
  altCache.set(q, c);
  return c;
}
export const ALT_STOPS = RAMP.map(([ft, c]) => [ft, `rgb(${c.join(",")})`]);
export const COLOR = { emerg: "#ef6a5e", mil: "#a998e8", sel: "#ffffff" };

// ---------------------------------------------------------------------------------------------------------------
// Silhouettes, drawn in a 64 x 64 box, nose up (north), centre (32, 32)
function jet({ L, W, span, wy, chord, sweep, tip, tspan, tchord, tsweep, eng = [], engW = 3.2, engL = 7, rear = false, props = false, noseProp = false, highWing = false }) {
  const cx = 32, y0 = 32 - L / 2, y1 = 32 + L / 2, hw = W / 2, p = [];
  p.push(`M${cx} ${y0} C${cx + hw} ${y0} ${cx + hw} ${y0 + W * 1.2} ${cx + hw} ${y0 + W * 2} L${cx + hw} ${y1 - W * 2.2} L${cx + hw * 0.35} ${y1} ` +
    `L${cx - hw * 0.35} ${y1} L${cx - hw} ${y1 - W * 2.2} L${cx - hw} ${y0 + W * 2} C${cx - hw} ${y0 + W * 1.2} ${cx - hw} ${y0} ${cx} ${y0} Z`);
  const ly = y0 + wy * L, sx = span / 2;
  for (const s of [1, -1]) p.push(`M${cx + s * hw * 0.9} ${ly} L${cx + s * sx} ${ly + sweep} L${cx + s * sx} ${ly + sweep + tip} L${cx + s * hw * 0.9} ${ly + chord} Z`);
  const ty = y1 - tchord - W * 0.5;
  for (const s of [1, -1]) p.push(`M${cx + s * hw * 0.7} ${ty} L${cx + s * tspan / 2} ${ty + tsweep} L${cx + s * tspan / 2} ${ty + tsweep + tchord * 0.5} L${cx + s * hw * 0.5} ${ty + tchord} Z`);
  for (const e of eng) {
    const f = (e - hw) / (sx - hw), ey = ly + sweep * f - engL * (highWing ? 0.25 : 0.45);
    for (const s of [1, -1]) {
      const x = cx + s * e;
      p.push(`M${x - engW / 2} ${ey} h${engW} v${engL} h${-engW} Z`);
      if (props) p.push(`M${x - 5.5} ${ey - 1.3} h11 v1.3 h-11 Z`);
    }
  }
  if (rear) for (const s of [1, -1]) {
    const x = cx + s * (hw + engW / 2 + 0.2);
    p.push(`M${x - engW / 2} ${y1 - W * 2.2 - engL - 2.5} h${engW} v${engL} h${-engW} Z`);
  }
  if (noseProp) p.push(`M${cx - 6} ${y0 - 1.6} h12 v1.4 h-12 Z`);
  return p.join(" ");
}
const SHAPES = {
  narrow: jet({ L: 50, W: 5, span: 50, wy: 0.38, chord: 10, sweep: 10, tip: 3, tspan: 20, tchord: 6, tsweep: 4, eng: [11], engW: 3.4, engL: 7 }),
  wide: jet({ L: 58, W: 6.6, span: 60, wy: 0.36, chord: 13, sweep: 13, tip: 3.5, tspan: 24, tchord: 7, tsweep: 5, eng: [14], engW: 4.6, engL: 8.5 }),
  heavy4: jet({ L: 60, W: 7, span: 61, wy: 0.34, chord: 13.5, sweep: 13, tip: 3.5, tspan: 25, tchord: 7, tsweep: 5, eng: [11.5, 20.5], engW: 3.9, engL: 7.5 }),
  regional: jet({ L: 46, W: 4.4, span: 40, wy: 0.42, chord: 8, sweep: 6, tip: 2.6, tspan: 15, tchord: 5, tsweep: 3.5, rear: true, engW: 3, engL: 6.5 }),
  prop: jet({ L: 42, W: 4.4, span: 50, wy: 0.32, chord: 6.5, sweep: 0.4, tip: 5.6, tspan: 16, tchord: 5, tsweep: 0.8, eng: [9], engW: 3, engL: 7, props: true, highWing: true }),
  biz: jet({ L: 36, W: 3.8, span: 31, wy: 0.45, chord: 7, sweep: 6, tip: 2.2, tspan: 13, tchord: 4.5, tsweep: 3.5, rear: true, engW: 2.8, engL: 5.5 }),
  light: jet({ L: 30, W: 3.6, span: 38, wy: 0.28, chord: 5, sweep: 0, tip: 5, tspan: 12, tchord: 4.2, tsweep: 0, noseProp: true }),
  mil: jet({ L: 54, W: 7, span: 60, wy: 0.34, chord: 10, sweep: 5, tip: 4, tspan: 24, tchord: 6.5, tsweep: 4, eng: [11, 19.5], engW: 3.4, engL: 7, highWing: true }),
  other: jet({ L: 26, W: 2.6, span: 60, wy: 0.35, chord: 4, sweep: 0, tip: 3, tspan: 11, tchord: 3, tsweep: 0 }),
  fighter: "M32 3 L35 14 L35.6 30 L56 47 L56 51 L36.5 47 L36 52 L43 58 L43 61 L33 59 L32 62 L31 59 L21 61 L21 58 L28 52 L27.5 47 L8 51 L8 47 L28.4 30 L29 14 Z",
  heli: "M30 12 C30 9 34 9 34 12 L36 15 C38 18 38 27 36 31 L34 33 L33.4 52 L38 53 L38 55.5 L26 55.5 L26 53 L30.6 52 L30 33 L28 31 C26 27 26 18 28 15 Z " +
    "M7.5 15.3 L56 26.5 L56.5 28.6 L8 17.4 Z M7.5 28.6 L8 26.5 L56.5 15.3 L56 17.4 Z",
};
const PATHS = {};
const path = (cls) => PATHS[cls] || (PATHS[cls] = new Path2D(SHAPES[cls] || SHAPES.narrow));

const spriteCache = new Map();
/** Canvas sprite (64 px drawing scaled to `px`) of a class in a colour. Cached. */
export function sprite(cls, color, px = 64) {
  const k = cls + color + px;
  let c = spriteCache.get(k);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d");
  g.scale(px / 64, px / 64);
  g.lineJoin = "round";
  g.strokeStyle = "rgba(10,10,10,.82)";
  g.lineWidth = 3.2;
  g.stroke(path(cls));
  g.fillStyle = color;
  g.fill(path(cls));
  if (cls === "heli") { g.strokeStyle = color; g.globalAlpha = 0.35; g.lineWidth = 1.2; g.beginPath(); g.arc(32, 22, 24, 0, Math.PI * 2); g.stroke(); }
  spriteCache.set(k, c);
  return c;
}
const urlCache = new Map();
export function spriteURL(cls, color) {
  const k = cls + color;
  if (!urlCache.has(k)) urlCache.set(k, sprite(cls, color, 64).toDataURL());
  return urlCache.get(k);
}
/** Inline <img> of a silhouette for lists and chips. */
export const iconHTML = (cls, color = "#ececec", size = 20, rot = 0) =>
  `<img class="ac-ic" src="${spriteURL(cls, color)}" width="${size}" height="${size}" alt="" style="transform:rotate(${rot}deg)">`;

// ---------------------------------------------------------------------------------------------------------------
// Procedural glTF: a faceted low-poly aircraft per class (glTF axes: +Z nose, +Y up, ±X wings; metres)
const WHITE = [0.93, 0.93, 0.95], GREY = [0.74, 0.75, 0.78], DARK = [0.16, 0.17, 0.19], ENG = [0.55, 0.56, 0.6], ACCENT = [0.93, 0.54, 0.31];
const OLIVE = [0.43, 0.47, 0.43], OLIVE2 = [0.36, 0.4, 0.37], FGREY = [0.55, 0.58, 0.62];

function meshBuilder() {
  const pos = [], nor = [], col = [];
  const tri = (a, b, c, k) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); nor.push(nx, ny, nz); col.push(k[0], k[1], k[2]); }
  };
  const quad = (a, b, c, d, k) => { tri(a, b, c, k); tri(a, c, d, k); };
  // Loft a tube along z through stations [z, r, yc]; colour(i, j) picks a colour per facet
  const loft = (st, n, colour, sx = 0, ry = 1.06) => {
    const ring = ([z, r, yc]) => Array.from({ length: n }, (_, j) => {
      const t = (j / n) * Math.PI * 2;
      return [sx + r * Math.cos(t), yc + r * ry * Math.sin(t), z];
    });
    const rings = st.map(ring);
    for (let i = 0; i < rings.length - 1; i++)
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        quad(rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j], colour(i, j));
      }
    const capEnd = (ri, k) => { const c = [sx, st[ri][2], st[ri][0]]; for (let j = 0; j < n; j++) tri(c, rings[ri][j], rings[ri][(j + 1) % n], k); };
    return capEnd;
  };
  // Flat plate with thickness: outline points [x, y, z] (top surface), extruded down by th (y) or sideways (x)
  const slab = (pts, th, k, axis = 1) => {
    const off = (p) => axis === 1 ? [p[0], p[1] - th, p[2]] : [p[0] - th, p[1], p[2]];
    const bot = pts.map(off);
    for (let i = 1; i < pts.length - 1; i++) { tri(pts[0], pts[i], pts[i + 1], k); tri(bot[0], bot[i + 1], bot[i], k); }
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; quad(pts[i], pts[j], bot[j], bot[i], k); }
  };
  const nacelle = (x, y, z0, len, r, k = ENG) => {
    const cap = loft([[z0 - len, r * 0.75, y], [z0 - len * 0.25, r, y], [z0, r * 0.95, y]], 8, () => k, x, 1);
    cap(2, DARK); cap(0, DARK);
  };
  return { tri, quad, loft, slab, nacelle, out: { pos, nor, col } };
}

const SPECS = {
  narrow: { L: 38, R: 2.0, span: 35, wingZ: 2.5, rootC: 6.5, tipC: 1.6, sweep: 7, wingY: -0.9, eng: [[5.6, 1.05]], tail: 12.5, fin: 6.2, fus: WHITE },
  wide: { L: 64, R: 3.0, span: 62, wingZ: 6, rootC: 11, tipC: 2.6, sweep: 14, wingY: -1.4, eng: [[10, 1.7]], tail: 21, fin: 9.5, fus: WHITE },
  heavy4: { L: 70, R: 3.3, span: 64, wingZ: 7, rootC: 13, tipC: 3, sweep: 15, wingY: -1.5, eng: [[11, 1.35], [20, 1.25]], tail: 22, fin: 10.5, fus: WHITE },
  regional: { L: 32, R: 1.55, span: 28, wingZ: 0.5, rootC: 5, tipC: 1.4, sweep: 4, wingY: -0.7, rear: 1.0, tail: 10, fin: 5.2, tTail: true, fus: WHITE },
  biz: { L: 22, R: 1.1, span: 19, wingZ: -0.5, rootC: 3.6, tipC: 1, sweep: 3, wingY: -0.5, rear: 0.7, tail: 7.5, fin: 3.4, tTail: true, fus: WHITE },
  prop: { L: 27, R: 1.4, span: 27, wingZ: 3, rootC: 2.6, tipC: 1.6, sweep: 0.2, wingY: 1.25, eng: [[4.1, 0.75]], props: true, tail: 9, fin: 5, tTail: true, fus: WHITE },
  light: { L: 8.5, R: 0.6, span: 11, wingZ: 1, rootC: 1.5, tipC: 1.3, sweep: 0, wingY: 0.62, noseProp: true, tail: 3.6, fin: 1.6, fus: WHITE },
  mil: { L: 53, R: 3.1, span: 52, wingZ: 4, rootC: 7.5, tipC: 3, sweep: 5, wingY: 2.9, eng: [[8, 1.15], [15, 1.1]], tail: 18, fin: 9, tTail: true, fus: OLIVE, wing: OLIVE2, accent: OLIVE2 },
  fighter: { L: 22, R: 0.9, fus: FGREY },
  heli: { L: 16, R: 1.3, fus: WHITE },
  other: { L: 8, R: 0.45, span: 18, wingZ: 0.6, rootC: 1, tipC: 0.5, sweep: 0, wingY: 0.4, tail: 3.2, fin: 1.3, fus: WHITE },
};

function buildAircraft(cls) {
  const s = SPECS[cls] || SPECS.narrow;
  const B = meshBuilder();
  const { L, R } = s, wingCol = s.wing || GREY, accent = s.accent || ACCENT;
  if (cls === "heli") {
    const capB = B.loft([[-2.5, 0.6, 0.6], [-1, 1.2, 0.2], [2.5, 1.35, 0], [4.2, 1.05, -0.15], [5.2, 0.4, -0.3]], 10,
      (i, j) => (i === 3 && j >= 1 && j <= 4 ? DARK : s.fus));
    capB(4, DARK);
    B.loft([[-9.5, 0.18, 0.95], [-2.4, 0.42, 0.55]], 6, () => s.fus);
    B.slab([[0, 3.2, -9.3], [0, 1, -10.2], [0, 1, -8.8]], 0.15, accent, 0);
    B.slab([[-1.6, 0.85, -8.8], [1.6, 0.85, -8.8], [1.6, 0.85, -9.6], [-1.6, 0.85, -9.6]], 0.08, s.fus);
    B.loft([[0.1, 0.25, 1.75], [0.7, 0.25, 1.75]], 6, () => DARK, 0, 1);
    for (const a of [Math.PI / 4, -Math.PI / 4]) {      // two blades crossing (an X), 6.5 m each side
      const c = Math.cos(a), si = Math.sin(a), w = 0.22, len = 6.6;
      const p = (u, v) => [u * c - v * si, 2.25, u * si + v * c];
      B.slab([p(-len, -w), p(len, -w), p(len, w), p(-len, w)], 0.06, DARK);
    }
    B.slab([[-1.2, -0.95, 1.8], [-1.2, -0.95, -1.8], [-1.3, -1.6, -1.8], [-1.3, -1.6, 1.8]], 0.08, DARK, 0);
    B.slab([[1.3, -0.95, 1.8], [1.3, -0.95, -1.8], [1.2, -1.6, -1.8], [1.2, -1.6, 1.8]], 0.08, DARK, 0);
    return B.out;
  }
  if (cls === "fighter") {
    const cap = B.loft([[-11, 0.7, 0], [-8, 0.95, 0], [3, 0.95, 0.05], [7, 0.75, 0], [10, 0.35, -0.05], [11, 0.05, -0.08]], 8,
      (i, j) => (i === 2 && j >= 1 && j <= 3 ? DARK : s.fus));
    cap(0, DARK);
    B.slab([[0.9, 0, 3], [6.5, 0, -6], [6.5, 0, -8], [0.9, 0, -8.5]], 0.18, s.fus);
    B.slab([[-0.9, 0, 3], [-0.9, 0, -8.5], [-6.5, 0, -8], [-6.5, 0, -6]], 0.18, s.fus);
    B.slab([[0, 0.8, -5], [0, 4.1, -9.7], [0, 4.1, -10.9], [0, 0.8, -10.6]], 0.16, s.fus, 0);
    B.slab([[0.9, 0, -8.6], [3.4, 0, -10.4], [3.4, 0, -11.2], [0.9, 0, -11]], 0.12, s.fus);
    B.slab([[-0.9, 0, -8.6], [-0.9, 0, -11], [-3.4, 0, -11.2], [-3.4, 0, -10.4]], 0.12, s.fus);
    return B.out;
  }
  // Fuselage: tail cone rises, nose drops slightly; a dark band for the cockpit windows
  const k = L / 38, r = R;
  const st = [[-19 * k, 0.12 * r, 0.62 * r], [-16 * k, 0.45 * r, 0.42 * r], [-12 * k, 0.8 * r, 0.18 * r], [-8 * k, r, 0], [10 * k, r, 0],
    [14 * k, 0.93 * r, -0.05 * r], [16.6 * k, 0.72 * r, -0.14 * r], [18.3 * k, 0.38 * r, -0.22 * r], [19 * k, 0.07 * r, -0.25 * r]];
  const N = 12;
  const cap = B.loft(st, N, (i, j) => (i === 5 && j >= 2 && j <= 4 ? DARK : (i === 0 ? accent : s.fus)));
  cap(st.length - 1, s.fus);
  cap(0, accent);
  // Wings with dihedral
  const half = s.span / 2, dih = Math.tan((cls === "prop" || cls === "mil" ? 1.5 : 5.5) * Math.PI / 180);
  for (const sg of [1, -1]) {
    const rx = sg * r * 0.7, tx = sg * half, tipY = s.wingY + half * dih;
    const pts = [[rx, s.wingY, s.wingZ], [tx, tipY, s.wingZ - s.sweep], [tx, tipY, s.wingZ - s.sweep - s.tipC], [rx, s.wingY, s.wingZ - s.rootC]];
    B.slab(sg > 0 ? pts : pts.slice().reverse(), Math.max(0.12, r * 0.14), wingCol);
    // winglet
    if (["narrow", "wide", "heavy4", "regional", "biz"].includes(cls))
      B.slab([[tx, tipY, s.wingZ - s.sweep - 0.2], [tx + sg * 0.15, tipY + r * 0.9, s.wingZ - s.sweep - s.tipC * 0.9], [tx + sg * 0.15, tipY + r * 0.9, s.wingZ - s.sweep - s.tipC * 1.2], [tx, tipY, s.wingZ - s.sweep - s.tipC]], 0.08, accent, 0);
    for (const [ex, er] of s.eng || []) {
      const f = (Math.abs(ex) - r * 0.7) / (half - r * 0.7);
      const leZ = s.wingZ - s.sweep * f, wy = s.wingY + Math.abs(ex) * dih;
      const ey = s.wingY > 0 ? wy - er * 0.2 : wy - er * 1.15;
      const len = er * (s.props ? 3.2 : 3.6);
      B.nacelle(sg * ex, ey, leZ + len * 0.45, len, er);
      if (s.props) {   // spinner + prop blades
        B.loft([[leZ + len * 0.45, er * 0.5, ey], [leZ + len * 0.45 + er * 0.9, 0.05, ey]], 6, () => DARK, sg * ex, 1);
        B.slab([[sg * ex - 0.1, ey + er * 2.1, leZ + len * 0.5], [sg * ex - 0.1, ey - er * 2.1, leZ + len * 0.5], [sg * ex - 0.1, ey - er * 2.1, leZ + len * 0.5 + 0.12], [sg * ex - 0.1, ey + er * 2.1, leZ + len * 0.5 + 0.12]], 0.06, DARK, 0);
      }
    }
  }
  if (s.rear) for (const sg of [1, -1]) B.nacelle(sg * (r + s.rear * 0.9), r * 0.35, -13 * k + s.rear * 2.4, s.rear * 4, s.rear);
  if (s.noseProp) B.slab([[0.05, r * 1.9, 19 * k + 0.05], [0.05, -r * 1.9, 19 * k + 0.05], [0.05, -r * 1.9, 19 * k + 0.15], [0.05, r * 1.9, 19 * k + 0.15]], 0.1, DARK, 0);
  // Fin and tailplane (T-tail puts the tailplane on top of the fin)
  const fz0 = -10.5 * k, fz1 = -18.6 * k, finTop = 0.55 * r + s.fin;
  B.slab([[0.1, 0.5 * r, fz0], [0.1, finTop, fz1 + s.fin * 0.25], [0.1, finTop, fz1 - 0.3], [0.1, 0.62 * r, fz1]], 0.2, accent, 0);
  const tY = s.tTail ? finTop - 0.15 : 0.45 * r, tz = s.tTail ? fz1 + s.fin * 0.35 : -14.5 * k, th = s.tail / 2;
  for (const sg of [1, -1]) {
    const pts = [[sg * 0.2, tY, tz + 0.4], [sg * th, tY + 0.3, tz - th * 0.42], [sg * th, tY + 0.3, tz - th * 0.42 - th * 0.22], [sg * 0.2, tY, tz - th * 0.55]];
    B.slab(sg > 0 ? pts : pts.slice().reverse(), 0.14, s.tTail ? accent : wingCol);
  }
  return B.out;
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const modelCache = new Map();
/** Blob URL of a glTF model for a class (nose along +Z in glTF, which Cesium maps to its +X forward axis). */
export function modelURL(cls) {
  if (modelCache.has(cls)) return modelCache.get(cls);
  const { pos, nor, col } = buildAircraft(cls);
  const n = pos.length / 3, P = new Float32Array(pos), Nn = new Float32Array(nor), Cc = new Float32Array(col);
  const buf = new Uint8Array(P.byteLength * 3);
  buf.set(new Uint8Array(P.buffer), 0); buf.set(new Uint8Array(Nn.buffer), P.byteLength); buf.set(new Uint8Array(Cc.buffer), P.byteLength * 2);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  const gltf = {
    asset: { version: "2.0", generator: "ASTRA procedural aircraft" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: cls }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, material: 0, mode: 4 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.25, roughnessFactor: 0.45 }, doubleSided: true }],
    buffers: [{ byteLength: buf.byteLength, uri: "data:application/octet-stream;base64," + b64(buf) }],
    bufferViews: [0, 1, 2].map(i => ({ buffer: 0, byteOffset: i * P.byteLength, byteLength: P.byteLength, target: 34962 })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: n, type: "VEC3" },
    ],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(gltf)], { type: "model/gltf+json" }));
  modelCache.set(cls, url);
  return url;
}
/** Approximate length in metres, for camera distances. */
export const modelLength = (cls) => (SPECS[cls] || SPECS.narrow).L;
