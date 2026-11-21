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
    layer.brightness = 0.62;   // muted, warm imagery so data reads on top
    layer.saturation = 0.55;
    layer.contrast = 1.1;
    layer.hue = 0.04;
  } catch (e) { console.warn("Esri imagery unavailable", e); }

  const scene = viewer.scene;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.hueShift = -0.05;
  scene.skyAtmosphere.saturationShift = -0.4;
  scene.backgroundColor = C.Color.fromCssColorString("#0b0a08");
  scene.fog.enabled = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 1_000_000;
  scene.screenSpaceCameraController.maximumZoomDistance = 250_000_000;
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
