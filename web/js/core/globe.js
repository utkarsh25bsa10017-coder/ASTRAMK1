// One shared CesiumJS viewer, moved between the Orbital Safety and NavIC views.
let viewer = null;
let container = null;

export function getGlobe() {
  if (viewer) return viewer;
  const C = window.Cesium;
  container = document.createElement("div");
  container.className = "astra-globe";
  document.body.appendChild(container);

  viewer = new C.Viewer(container, {
    baseLayer: C.ImageryLayer.fromProviderAsync(
      C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII"))),
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false, shouldAnimate: true,
    requestRenderMode: false, msaaSamples: 2,
  });
  // Online imagery on top (falls back to the bundled Natural Earth layer offline)
  try {
    const esri = new C.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 8, credit: "Imagery © Esri, Maxar, Earthstar Geographics",
    });
    const layer = viewer.imageryLayers.addImageryProvider(esri);
    layer.brightness = 0.66;   // muted, neutral imagery so data reads on top
    layer.saturation = 0.5;
    layer.contrast = 1.08;
  } catch (e) { console.warn("Esri imagery unavailable", e); }

  const scene = viewer.scene;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.hueShift = -0.05;
  scene.skyAtmosphere.saturationShift = -0.4;
  scene.backgroundColor = C.Color.fromCssColorString("#141414");
  scene.fog.enabled = false;
  const ssc = scene.screenSpaceCameraController;
  ssc.minimumZoomDistance = 1_000_000;
  ssc.maximumZoomDistance = 250_000_000;
  ssc.inertiaZoom = 0.86;      // wheel steps glide instead of jumping
  ssc.inertiaSpin = 0.93;
  // Trackpad pinch arrives as ctrl+wheel, which Cesium ignores and the browser turns into page zoom.
  // Catch it first (capture phase) and zoom the camera in proportion to the pinch instead.
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    zoomBy(Math.max(-0.35, Math.min(0.35, -e.deltaY * 0.01)));
  }, { capture: true, passive: false });
  viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(80, 15, 28_000_000) });
  viewer.cesiumWidget.creditContainer.style.display = "none";
  // Low-end devices: skip the sky atmosphere shader
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4) scene.skyAtmosphere.show = false;
  return viewer;
}

export function mountGlobe(slot) {
  const v = getGlobe();
  if (container.parentElement !== slot) slot.prepend(container);
  container.style.display = "";
  requestAnimationFrame(() => v.resize());
  return v;
}

/** Zoom by a fraction of the current height (positive = in), clamped to the controller limits. */
function zoomBy(f) {
  const cam = viewer.camera, ssc = viewer.scene.screenSpaceCameraController;
  const h = cam.positionCartographic.height;
  if (f > 0) cam.zoomIn(Math.min(h * f, Math.max(0, h - ssc.minimumZoomDistance)));
  else cam.zoomOut(Math.min(-h * f, Math.max(0, ssc.maximumZoomDistance - h)));
}

/** Eased zoom for the + / − buttons (about 450 ms). */
let zoomAnim = 0;
export function smoothZoom(f) {
  cancelAnimationFrame(zoomAnim);
  const t0 = performance.now(), D = 450;
  const total = Math.log(f > 0 ? 1 - f : 1 / (1 + f));   // spread the change evenly in log-height
  let done = 0;
  const step = (now) => {
    // rAF timestamps can precede t0 (frame start vs. click time), so clamp at 0
    const k = Math.max(0, Math.min(1, (now - t0) / D)), e = 1 - Math.pow(1 - k, 3);
    const want = total * e, d = want - done;
    done = want;
    zoomBy(1 - Math.exp(d));
    if (k < 1) zoomAnim = requestAnimationFrame(step);
  };
  zoomAnim = requestAnimationFrame(step);
}

export function simDate() {
  return viewer ? window.Cesium.JulianDate.toDate(viewer.clock.currentTime) : new Date();
}

/** Imagery tile progress, 0..1, for loaders. Calls fn(fraction) until the queue first empties. */
export function onTiles(fn) {
  const v = getGlobe();
  let max = 0, finished = false;
  const off = v.scene.globe.tileLoadProgressEvent.addEventListener((q) => {
    if (finished) return;
    max = Math.max(max, q);
    fn(max ? 1 - q / max : 0);
    if (q === 0 && max > 0) { finished = true; fn(1); off(); }
  });
  return () => { finished = true; off(); };
}
