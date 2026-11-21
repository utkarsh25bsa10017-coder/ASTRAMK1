# ASTRA: space for disaster response, orbital safety and NavIC connectivity

ASTRA is an interactive web dashboard that combines **live disaster alerts**, **satellite radar flood mapping**, **space-debris and conjunction monitoring** and the **NavIC constellation** in one place. Every data source is free and needs no login.

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

This freezes every feed into `data/snapshots/`. If a source is unreachable during the demo, the server serves the last good copy and the UI marks it with a `stale` or `snapshot` badge.

## What it does

### Mission Control
Headline numbers (Indian alerts, severe global events, objects in orbit, debris, close approaches, NavIC health), the top alerts, the closest predicted approaches, and space weather.

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

## Honest limitations
- Public TLE/SGP4 accuracy is roughly 1 km in LEO and worse as elements age. Conjunction results are for awareness, not manoeuvre decisions.
- Radar change detection uses a single backscatter threshold; wet soil, shadows and speckle can cause false positives. Validate against official flood maps.
- NavIC status codes come from the public CelesTrak catalogue, not from ISRO's operational bulletins.
- The NavIC broadcast frame is a demonstration design, not the official message format.
