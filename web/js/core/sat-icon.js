// Small satellite sprite (body + two solar panels) as an SVG data URI, tinted per status.
const cache = new Map();
export function satIcon(color) {
  if (cache.has(color)) return cache.get(color);
  const shape = (stroke, sw, fill) => `<g stroke='${stroke}' stroke-width='${sw}' stroke-linejoin='round'>
    <rect x='12.5' y='12.5' width='7' height='7' rx='1.4' fill='${fill ? color : "none"}'/>
    <rect x='2.5' y='13' width='8' height='6' fill='${fill ? color : "none"}' fill-opacity='.45'/>
    <rect x='21.5' y='13' width='8' height='6' fill='${fill ? color : "none"}' fill-opacity='.45'/>
    <path d='M10.5 16h2M19.5 16h2M16 12.5V9M13.5 8.5h5' fill='none'/></g>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>${shape("rgba(0,0,0,.75)", 3.4, false)}${shape(color, 1.5, true)}</svg>`;
  const uri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  cache.set(color, uri);
  return uri;
}
export const STATUS_COLOR = { "+": "#5fd3a0", P: "#f4c04e", "-": "#ff5b4f", D: "#767b85" };
