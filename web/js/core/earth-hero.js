// Cinematic orbital sunrise over India, rendered with a single WebGL fragment shader.
// Ray-traced sphere with day/night textures, limb atmosphere, sun rising over the edge,
// lens streak, procedural clouds and a twinkling starfield. No libraries.

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uRise;      // 0..1 sunrise progress
uniform vec2 uMouse;      // -1..1 parallax
uniform vec2 uCenter;     // planet centre in screen units
uniform float uRadius;
uniform float uRot;       // Earth rotation (radians), driven from JS
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform float uHasTex;

#define PI 3.14159265

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  float n = i.x + i.y*57.0 + i.z*113.0;
  #define H(o) fract(sin(n + o) * 43758.5453)
  return mix(mix(mix(H(0.0),H(1.0),f.x), mix(H(57.0),H(58.0),f.x), f.y),
             mix(mix(H(113.0),H(114.0),f.x), mix(H(170.0),H(171.0),f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }

vec3 stars(vec2 uv){
  vec3 col = vec3(0.0);
  for (int l = 0; l < 3; l++){
    float sc = 90.0 + float(l) * 110.0;
    vec2 g = uv * sc + float(l) * 17.0;
    vec2 id = floor(g), f = fract(g) - 0.5;
    float h = hash(id + float(l) * 3.1);
    if (h > 0.965){
      vec2 o = vec2(hash(id + 1.7), hash(id + 9.2)) - 0.5;
      float d = length(f - o * 0.7);
      float tw = 0.65 + 0.35 * sin(uTime * (0.6 + h * 2.5) + h * 40.0);
      float b = smoothstep(0.08, 0.0, d) * tw * (0.35 + (h - 0.965) * 18.0);
      vec3 tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash(id + 4.4));
      col += tint * b;
    }
  }
  // faint Milky Way band
  float band = exp(-pow((uv.y + uv.x * 0.55 - 0.15) * 2.4, 2.0));
  col += vec3(0.55, 0.5, 0.62) * band * fbm(vec3(uv * 3.0, 1.0)) * 0.07;
  return col;
}

vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 par = uMouse * 0.012;
  vec3 ro = vec3(0.0);
  vec3 rd = normalize(vec3(uv + par * 0.3, -1.55));

  // planet placement: centre below-right so the limb arcs across the frame
  vec3 C = vec3(uCenter + par, -3.0);
  float R = uRadius;

  // sun just behind the limb, rising with uRise
  float rise = uRise;
  vec3 limbDir = normalize(vec3(uCenter.x - 0.18, uCenter.y + R * 0.995, -3.0));
  vec3 L = normalize(limbDir + vec3(0.06, mix(-0.07, -0.004, rise), -0.32));

  vec3 col = stars(uv + par * 0.5) * (1.0 - 0.6 * rise);

  // ray-sphere
  vec3 oc = ro - C;
  float b = dot(oc, rd), c = dot(oc, oc) - R * R, disc = b*b - c;
  float tHit = -1.0;
  if (disc > 0.0) tHit = -b - sqrt(disc);

  // closest approach altitude for atmosphere
  float tc = -b;
  vec3 pc = ro + rd * max(tc, 0.0);
  float alt = length(pc - C) - R;
  float sunDot = max(dot(rd, L), 0.0);
  vec3 atmBlue = vec3(0.30, 0.55, 1.0);
  vec3 atmGold = vec3(1.0, 0.55, 0.22);

  if (tHit > 0.0){
    vec3 P = ro + rd * tHit;
    vec3 n = normalize(P - C);
    // Earth frame: tilt + slow rotation; offset so India sits near the dawn limb
    float rot = uRot;
    float tilt = 0.41;
    vec3 q = n;
    q = vec3(q.x, q.y * cos(tilt) - q.z * sin(tilt), q.y * sin(tilt) + q.z * cos(tilt));
    q = vec3(q.x * cos(rot) + q.z * sin(rot), q.y, -q.x * sin(rot) + q.z * cos(rot));
    float lon = atan(q.x, q.z);
    float lat = asin(clamp(q.y, -1.0, 1.0));
    vec2 tuv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

    vec3 day = uHasTex > 0.5 ? texture2D(uDay, tuv).rgb : mix(vec3(0.05,0.12,0.25), vec3(0.2,0.3,0.15), step(0.55, fbm(q*3.0)));
    vec3 night = uHasTex > 0.5 ? texture2D(uNight, tuv).rgb : vec3(0.0);
    day = pow(day, vec3(1.15));

    float ndl = dot(n, L);
    float dayMix = smoothstep(-0.06, 0.28, ndl);
    float clouds = smoothstep(0.52, 0.78, fbm(q * 4.2 + vec3(0.0, 0.0, uTime * 0.004)));
    vec3 lit = day * vec3(1.15, 1.05, 0.95) * (0.25 + 1.4 * max(ndl, 0.0));
    lit = mix(lit, vec3(1.0, 0.98, 0.95) * max(ndl, 0.0) * 1.3, clouds * 0.85);
    vec3 lights = night * vec3(1.0, 0.72, 0.38) * 1.6 * (1.0 - clouds * 0.7);
    vec3 surf = mix(lights, lit, dayMix);

    // twilight band (terminator glow)
    float twi = exp(-pow((ndl - 0.02) / 0.09, 2.0));
    surf += atmGold * twi * 0.35;

    // ocean glint near the sun
    float ocean = uHasTex > 0.5 ? smoothstep(0.08, 0.0, day.r - day.b * 0.55) : 0.5;
    vec3 h = normalize(L - rd);
    surf += vec3(1.0, 0.8, 0.55) * pow(max(dot(n, h), 0.0), 120.0) * ocean * 2.5 * dayMix;

    // atmospheric haze toward the limb
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 haze = mix(atmBlue, atmGold, pow(sunDot, 6.0)) * fres * (0.25 + 1.6 * smoothstep(-0.25, 0.35, ndl));
    col = surf + haze * 0.9;
  } else {
    // limb glow outside the planet
    float g = exp(-max(alt, 0.0) / (R * 0.022));
    float g2 = exp(-max(alt, 0.0) / (R * 0.08));
    vec3 atm = mix(atmBlue, atmGold, pow(sunDot, 3.0));
    float lightSide = smoothstep(-0.2, 0.6, dot(normalize(pc - C), L));
    col += atm * (g * 1.4 + g2 * 0.25) * (0.15 + 1.8 * lightSide) * (0.4 + rise);

    // sun disc, corona and glare (only when not occluded by the planet)
    float sd = acos(clamp(dot(rd, L), -1.0, 1.0));
    col += vec3(1.0, 0.86, 0.64) * exp(-sd * 70.0) * 5.0 * rise;
    col += vec3(1.0, 0.72, 0.42) * exp(-sd * 22.0) * 2.0 * rise;
    col += vec3(1.0, 0.6, 0.3) * exp(-sd * 5.0) * 0.35 * rise;
  }

  // anamorphic streak + soft ghosts through the sun's screen position
  vec3 sv = L / -L.z * 1.55;
  vec2 sp = sv.xy - par * 0.3;
  float streak = exp(-abs(uv.y - sp.y) * 220.0) * exp(-abs(uv.x - sp.x) * 1.2);
  col += vec3(1.0, 0.62, 0.32) * streak * 0.9 * rise;
  for (int i = 1; i <= 3; i++){
    vec2 gp = sp * (1.0 - float(i) * 0.62);
    col += vec3(1.0, 0.55, 0.25) * 0.018 * smoothstep(0.05, 0.0, length(uv - gp) - 0.015 * float(i)) * rise;
  }
  // glow hugging the limb around the sunrise point
  // (distance of this pixel's ray from the true silhouette, so it stays on the limb at any framing)
  float tca = dot(C, rd);
  float limbD = abs(length(C - rd * tca) - R) / length(C) * 1.55;
  col += vec3(1.0, 0.6, 0.3) * exp(-limbD * 90.0) * exp(-length(uv - sp) * 2.2) * 0.9 * rise;

  // vignette, tone map, dither
  col *= 1.0 - 0.35 * dot(uv * 0.9, uv * 0.9);
  col = aces(col * 1.05);
  col = pow(col, vec3(0.92));
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export function mountEarthHero(container) {
  const canvas = document.createElement("canvas");
  canvas.className = "earth-canvas";
  canvas.setAttribute("aria-hidden", "true");
  container.prepend(canvas);
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) { container.classList.add("no-webgl"); return { stop() {} }; }

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u = { res: U("uRes"), time: U("uTime"), rise: U("uRise"), mouse: U("uMouse"), center: U("uCenter"), radius: U("uRadius"), rot: U("uRot"), day: U("uDay"), night: U("uNight"), has: U("uHasTex") };

  let loaded = 0;
  const tex = (unit, src) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([10, 20, 40]));
    const img = new Image();
    img.onload = () => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      loaded++;
    };
    img.src = src;
  };
  tex(0, "vendor/earth/earth_day_4096.jpg");
  tex(1, "vendor/earth/earth_night_4096.jpg");
  gl.uniform1i(u.day, 0);
  gl.uniform1i(u.night, 1);

  const mouse = [0, 0], target = [0, 0];
  window.addEventListener("pointermove", (e) => { target[0] = (e.clientX / innerWidth) * 2 - 1; target[1] = -((e.clientY / innerHeight) * 2 - 1); }, { passive: true });

  // Scroll story: each chapter moves the planet from a dawn horizon up to a full disc.
  // [x as a fraction of the aspect ratio, y, radius, sun glare]; wide screens put the planet on the right.
  const KEYS_WIDE = [[0.18, -2.05, 1.9, 1], [0.27, -1.2, 1.3, 0.85], [0.32, -0.42, 0.98, 0.7], [0.32, -0.12, 0.82, 0.6], [0.32, -0.02, 0.74, 0.55]];
  const KEYS_TALL = [[0, -2.25, 1.75, 1], [0, -1.95, 1.55, 0.9], [0, -1.75, 1.45, 0.8], [0, -1.65, 1.4, 0.7], [0, -1.6, 1.38, 0.65]];
  let story = 0, cur = null;
  // Rotation: free slow spin on the opening screen; in the chapters, turn India (≈80°E) toward the camera
  const INDIA_ROT = 1.45;
  let rot = 40 * 0.012 + 3.65, lastT = null;
  const wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0, running = true, t0 = performance.now(), visible = true;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = container.clientWidth, h = container.clientHeight;
    const scale = Math.min(1, 2_400_000 / (w * h * dpr * dpr));   // cap pixel count for smoothness
    canvas.width = Math.max(2, Math.floor(w * dpr * Math.sqrt(scale)));
    canvas.height = Math.max(2, Math.floor(h * dpr * Math.sqrt(scale)));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  new ResizeObserver(resize).observe(container);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible && running) loop(); }, { threshold: 0 }).observe(container);

  const frame = (now) => {
    const t = (now - t0) / 1000;
    const aspect = canvas.width / canvas.height;
    mouse[0] += (target[0] - mouse[0]) * 0.03; mouse[1] += (target[1] - mouse[1]) * 0.03;
    // planet: large, low and to the right on wide screens; centred lower on tall screens
    const wide = aspect > 1.2;
    const k = (wide ? KEYS_WIDE : KEYS_TALL)[story];
    const want = [k[0] * (wide ? aspect : 1), k[1], k[2], k[3]];
    if (!cur || reduced) cur = want.slice();
    else for (let i = 0; i < 4; i++) cur[i] += (want[i] - cur[i]) * 0.055;   // ease toward the chapter's framing
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, reduced ? 40 : t + 40);
    const rise = reduced ? 1 : 1 - Math.pow(1 - Math.min(1, t / 7), 3);
    gl.uniform1f(u.rise, (0.25 + 0.75 * rise) * cur[3]);
    gl.uniform2f(u.mouse, mouse[0], mouse[1]);
    gl.uniform2f(u.center, cur[0], cur[1]);
    gl.uniform1f(u.radius, cur[2]);
    const dt = lastT == null ? 0 : Math.min(0.1, t - lastT);
    lastT = t;
    if (reduced) rot = story ? INDIA_ROT : 40 * 0.012 + 3.65;
    else if (story === 0) rot += dt * 0.012;
    else rot += wrapPi(INDIA_ROT + t * 0.003 - rot) * Math.min(1, dt * 1.6);
    gl.uniform1f(u.rot, rot);
    gl.uniform1f(u.has, loaded >= 2 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const loop = () => {
    cancelAnimationFrame(raf);
    const step = (now) => {
      if (!running || !visible || document.hidden) return;
      frame(now);
      if (!reduced) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running) loop(); });
  loop();
  return {
    stop() { running = false; cancelAnimationFrame(raf); },
    start() { if (!running) { running = true; loop(); } },
    setStory(i) { story = Math.max(0, Math.min(KEYS_WIDE.length - 1, i | 0)); if (reduced) frame(performance.now()); },
  };
}
