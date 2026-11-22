# ASTRA: space for disaster response, orbital safety and NavIC connectivity

ASTRA is  an interactive web dashboard that combines **live disaster alerts**, **satellite radar flood mapping**, **space-debris and conjunction monitoring** and the **NavIC constellation** in one place. Every data source is free and needs no login.

Hackathon domains covered:
- **03 Space-based disaster management**: Disaster Watch
- **04 Satellite navigation and emergency connectivity**: NavIC Link
- **06 Sustainable space and satellite safety**: Orbital Safety

## Run it

Requirements: Python 3.10+ and a modern browser. Nothing to install (the server uses only the standard library; JS libraries are vendored in `web/vendor/`).

```bash
python3 server/app.py          # then open http://127.0.0.1:8000
```

The first load of each feed takes a few seconds while the server fetches and caches it. After that, pages load from the cache.

### Deploy on Vercel
The repo is ready to deploy as is: import it in Vercel, choose framework preset **Other**, and leave the build command, output directory and root directory empty. `vercel.json` serves `web/` as static files and runs the gateway as a Python serverless function (`api/index.py`, standard library only). On Vercel the cache lives in `/tmp` (per instance), and the committed `data/snapshots/` are the fallback. The first request to a feed on a cold instance can take up to about 30 s.

### Offline / demo-day mode
Venue Wi-Fi can block APIs, and providers can rate-limit. Before the demo, open every tab once, then run:

```bash
python3 scripts/snapshot.py --warm
```

This freezes every feed into `data/snapshots/`. If CelesTrak is blocking your laptop, refresh the snapshots from the live site instead (it fetches one endpoint at a time):

```bash
python3 scripts/pull_snapshots.py https://astramk1.vercel.app
``` If a source is unreachable during the demo, the server serves the last good copy and the UI marks it with a `stale` or `snapshot` badge.

## Design: "Flight Ops"

- **Hero:** a live, ray-traced orbital sunrise over India (WebGL shader, no libraries): day and night Earth textures with city lights, limb atmosphere, the sun breaking over the edge, a lens streak, procedural clouds and a twinkling starfield. It pauses when off-screen and respects reduced-motion settings.
- **Type:** Archivo Expanded for headlines (inspired by launch-vehicle livery), Archivo for text, JetBrains Mono for numbers only. All self-hosted (SIL OFL).
- **Colour:** graphite surfaces with a single ISRO-saffron signal colour; mint, gold and red are used only to signal safety levels.
- **Details:** a PSLV-style livery stripe, and a sine-wave ground-track motif.

## What it does

### Fleet readiness (joins domains 03, 04 and 06)
Click any live alert, or open any place, to see:
1. **Indian satellites overhead in the next 24 hours.** Radar (EOS-4, RISAT-2B series, NISAR, Drishti), optical (Cartosat, Resourcesat, EOS-08, HySIS, Firefly), weather (INSAT-3D/3DR/3DS, Oceansat, SCATSAT, SARAL) and communications (GSAT, CMS), each with its next pass and a 24-hour timeline. Passes are computed live with SGP4.
2. **Whether each one is safe to rely on:** its closest approach this week from SOCRATES, marked Clear, Watch (1–5 km) or Alert (under 1 km).
3. **NavIC positioning quality on the ground:** PDOP now and the best and worst values over the next 24 hours, plus a one-click NavIC emergency broadcast.

### Guided demo
The **Guided demo** button walks through the full story using Cyclone Dana (Odisha, Oct 2024): live alerts → Sentinel-1 radar flood map → Kendrapara safety check → Indian satellites over Kendrapara and their debris safety → NavIC broadcast → an Indian satellite's close approach on the 3D globe. Use the arrow keys or Next/Back.

### Safety Check (location hazard model)
Search any place (or click any map) to get a **safety rating (A–E, 0–100)** and five hazard scores, each computed for **the next 72 hours** (live forecast) and for **a 1-in-10-year monsoon storm**:

| Hazard | Physics in the model |
|---|---|
| River discharge flood | GloFAS daily discharge 1984–present → Gumbel fit to annual maxima → 2/5/10/20/50/100-yr flood levels; forecast peak return period × site exposure (height above lowest ground within 9 km, a HAND proxy) × river size |
| Bank overflow & runoff | SCS curve-number runoff from the heaviest 24 h of rain (curve number from soil saturation and slope), amplified on flat, low-lying ground; plus overbank spill when the river is above bankfull (2-yr) level |
| Sediment & debris flow | Heavy, saturating rain × local slope (Horn's method on a 200 m DEM grid) × surrounding relief |
| Flash flood | Peak 1 h / 3 h rain intensity × catchment relief × valley-floor position × soil saturation |
| Long-term seismic exposure (shown separately, not part of the rating) | Distance- and depth-attenuated load from every USGS M4.5+ quake within 300 km since 1975 |

Inputs: Copernicus GLO-90 DEM, GloFAS v4, ECMWF/GFS forecast with soil moisture, ERA5 1995–2024 rainfall (design storm), and USGS (all through Open-Meteo or USGS, free). Rating: combined = top hazard + 0.15 × the next two; safety = 100 − max(combined now, 0.7 × combined design). The page shows a terrain cross-section, the river forecast against its flood levels, hourly rain, nearby earthquakes, plain-language advice, and the full method.

### Earthquakes
**NCS** (National Center for Seismology, India's official bulletin, parsed from its public RISEQ page), **EMSC** and **USGS**, merged with cross-agency duplicates removed. They appear in the alert feed, the Briefing page, a dedicated seismic map mode in Disaster Watch, and every Safety Check.

### Briefing (front page)
A live editorial summary, place search, headline numbers, the top alerts, recent earthquakes, the closest orbital approaches, NavIC health and space weather.

### Disaster Watch
- **Live alerts** from NDMA **SACHET** (official Indian CAP alerts from IMD, CWC and SDMAs, with alert polygons), **GDACS**, **USGS** and **NASA EONET**, with filters by source, hazard type, India region and text search.
- **Point analysis** for any alert or map click: 7-day rainfall forecast, **GloFAS river discharge** (current vs normal, 30-day forecast), and wave height for coastal points.
- **Flood mapping from Sentinel-1 radar**: before/after swipe, plus browser-side **change detection** that flags new inundation (water after the event, land before) and estimates the flooded area in view. Case studies: Cyclone Dana (Odisha, Oct 2024), Assam 2024, Kerala 2024.
- **Cyclone tracks**: every North Indian Ocean storm since 2000 from IBTrACS, coloured by IMD intensity class. Live GDACS cyclone tracks and wind-swath polygons.
- **Layers**: NASA GIBS daily imagery (VIIRS, MODIS), GPM IMERG rainfall, Bhuvan historical flood maps (Phailin, Hudhud, Kosi, 2021 floods), VEDAS layers (Brahmaputra inundation, shoreline, tide lines, rivers, districts).
- **Broadcast via NavIC** button on every alert.

### Orbital Safety
- 3D globe (CesiumJS) with **the full public catalogue** (~30,000 objects: payloads, rocket bodies, debris) propagated live with **SGP4** in a Web Worker. Time controls (1×, 60×, 600×).
- Highlighted debris clouds (Fengyun-1C, Cosmos 2251, Iridium 33, Cosmos 1408), Indian objects, and the re-entry watch list.
- **Conjunctions** from CelesTrak SOCRATES: closest, highest probability, and those involving Indian assets. Click one to jump to the time of closest approach.
- **Close-approach screening** for any object: altitude-band prefilter, then 60 s SGP4 sampling, then golden-section refinement, run in the browser.
- **Statistics**: growth of the orbital population since 1975, LEO crowding by altitude, owners, the largest fragmentation events still in orbit, and the Kp index.

### NavIC Link
- Live positions, ground tracks (figure-of-eight IGSO orbits), and **honest health status** from the public catalogue (operational, partial, failed, stranded NVS-02).
- Sky plot and **PDOP/HDOP/VDOP** for NavIC alone, GPS alone and combined, from your location (browser geolocation).
- **Coverage-quality heatmap** over the NavIC service area.
- **Emergency broadcast simulator**: packs a live alert into a compact bit frame with CRC-24Q, estimates airtime, checks which NavIC satellites are above 10° at the alert location, and shows the receiver display. The frame layout is ASTRA's own illustrative design, not the official ICD format.

### Data Gateway
Every source with its provider, purpose, licence, and live fetch health (latency, size, last error).

## Data sources (all free, no login)

| Source | Provider | Used for |
|---|---|---|
| SACHET CAP feed | NDMA, Govt. of India | Official Indian alerts and polygons |
| NCS RISEQ bulletin | National Center for Seismology, MoES | Official Indian earthquakes |
| EMSC FDSN | European-Mediterranean Seismological Centre | Low-magnitude regional earthquakes |
| Open-Meteo elevation / geocoding, Nominatim | Copernicus DEM, GeoNames, OSM | Terrain for the hydrology model, place search |
| GDACS API | EC JRC / UN OCHA | Global events, cyclone tracks and wind swaths |
| USGS GeoJSON | U.S. Geological Survey | Earthquakes |
| NASA EONET | NASA | Wildfires, storms, volcanoes |
| Open-Meteo (forecast, flood, marine, archive) | Open-Meteo / ECMWF / GloFAS | Rain, river discharge, waves, ERA5 history |
| IBTrACS NI | NOAA NCEI | Cyclone best tracks |
| Sentinel-1 RTC | ESA Copernicus via Microsoft Planetary Computer | Radar flood mapping |
| NASA GIBS | NASA EOSDIS | Daily imagery, IMERG rainfall |
| Bhuvan WMS (optional) | NRSC / ISRO | Historical flood layers |
| VEDAS GeoServer (optional) | SAC / ISRO | Inundation, shoreline, tide lines |
| CelesTrak GP, SATCAT, SOCRATES | CelesTrak | Orbits, catalogue, conjunctions |
| tle.ivanstanojevic.me, SatNOGS DB | Community mirrors | Backup orbital elements |
| NOAA SWPC | NOAA | Kp index, F10.7 solar flux |

**CelesTrak etiquette:** CelesTrak blocks clients that re-download the same data more than once per 2 hours. The server caches every query for at least 2 hours, and its circuit breaker stops retrying a failing source for 10 minutes. Don't remove these limits.

## Architecture

```
browser                                     server/app.py (stdlib HTTP)
───────                                     ───────────────────────────
index.html + css                            /api/*  ──► sources.py   (one builder per feed)
js/app.js         hash router, lazy views                 │
js/views/*.js     overview, disaster, orbital,            ▼
                  navic, gateway                     gateway.py
js/core/          api (provenance), util,              raw HTTP cache (data/cache, TTL per source)
                  orbitmath (SGP4/DOP), globe          circuit breaker per source
js/workers/       propagate.js (catalogue SGP4)        derived-result cache → stale → data/snapshots
                  screen.js (conjunction screening)
```

Every API response carries an `X-Astra-Provenance` header (`live`, `cache`, `stale` or `snapshot`), which the UI shows.

## What is real, what is illustrative
- **Real, live data:** alerts, river discharge, rain forecasts, terrain, satellite orbits, close approaches, radar scenes.
- **Screening estimates:** public orbit data is accurate to about 1 km, so close approaches are an early-warning screen, not a collision call. Collision chances are illustrative. The safety rating is not an official hazard assessment.
- **Illustrative:** the NavIC emergency-message frame is our own design, not the official NavIC format. Satellite status comes from the public catalogue, not official ISRO status.

## Credits
Hero Earth textures: Solar System Scope (CC BY 4.0), based on NASA imagery. Fonts: Archivo and JetBrains Mono (SIL OFL). Maps: Esri, OpenStreetMap contributors, NASA GIBS, Bhuvan (NRSC), VEDAS (SAC).

## Honest limitations
- Public TLE/SGP4 accuracy is roughly 1 km in LEO and worse as elements age. Conjunction results are for awareness, not manoeuvre decisions.
- Radar change detection uses a single backscatter threshold; wet soil, shadows and speckle can cause false positives. Validate against official flood maps.
- NavIC status codes come from the public CelesTrak catalogue, not from ISRO's operational bulletins.
- The NavIC broadcast frame is a demonstration design, not the official message format.
