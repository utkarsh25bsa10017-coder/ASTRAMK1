"""
Builders for every ASTRA API endpoint. Each builder returns (obj, provenance).
All sources are free and need no login.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, wait as _wait
from datetime import datetime, timedelta, timezone

from gateway import SourceUnavailable, cached_result, fetch_raw, worst

MIN, HOUR, DAY = 60, 3600, 86400

# ---------------------------------------------------------------------------
# Source registry (shown on the Data Gateway page)
# ---------------------------------------------------------------------------
REGISTRY = [
    # id, name, provider, domain, used for, sample url, terms
    ("sachet", "SACHET CAP alerts", "NDMA, Govt. of India", "Disaster",
     "Official Indian disaster alerts (IMD, CWC, SDMAs) with alert polygons",
     "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml", "Public domain"),
    ("ncs", "NCS earthquakes", "National Center for Seismology, MoES", "Disaster",
     "Official Indian earthquake bulletin (all magnitudes, past year), parsed from the public RISEQ page",
     "https://riseq.seismo.gov.in/riseq/earthquake/recent_earthquake", "Public bulletin"),
    ("emsc", "EMSC seismic portal", "European-Mediterranean Seismological Centre", "Disaster",
     "Real-time low-magnitude earthquakes for South Asia (FDSN)",
     "https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=10", "Free, attribution"),
    ("geocode", "Place search", "Open-Meteo geocoding (GeoNames) + OSM Nominatim", "Disaster",
     "Location search and reverse lookup for the safety check",
     "https://geocoding-api.open-meteo.com/v1/search?name=Puri", "CC-BY 4.0 / ODbL"),
    ("gdacs", "GDACS events", "EC JRC / UN OCHA", "Disaster",
     "Global cyclones, floods, earthquakes, volcanoes, wildfires, droughts with alert levels",
     "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC", "Free, attribution"),
    ("usgs", "USGS earthquake feed", "U.S. Geological Survey", "Disaster",
     "Live M4.5+ earthquakes (GeoJSON)",
     "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson", "Public domain"),
    ("eonet", "NASA EONET", "NASA", "Disaster",
     "Open natural events: wildfires, storms, volcanoes, floods",
     "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30", "Public domain"),
    ("openmeteo", "Open-Meteo forecast / flood / elevation", "Open-Meteo (ECMWF, GloFAS v4, Copernicus DEM)", "Disaster",
     "Rain & soil-moisture forecast, GloFAS discharge since 1984, DEM terrain for the hydrology model",
     "https://api.open-meteo.com/v1/forecast?latitude=20.3&longitude=85.8&hourly=precipitation", "CC-BY 4.0, non-commercial free"),
    ("ibtracs", "IBTrACS North Indian Ocean", "NOAA NCEI", "Disaster",
     "Historical cyclone best tracks (incl. IMD New Delhi data)",
     "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NI.list.v04r01.csv", "Public domain"),
    ("planetary", "Sentinel-1 RTC radar", "ESA Copernicus via Microsoft Planetary Computer", "Disaster",
     "Before/after radar scenes and water masks for flood mapping",
     "https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-1-rtc", "Copernicus open licence"),
    ("gibs", "NASA GIBS imagery", "NASA EOSDIS", "Disaster",
     "Daily true-colour imagery (VIIRS, MODIS) and GPM IMERG rainfall tiles",
     "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities", "Public domain"),
    ("bhuvan", "Bhuvan WMS (optional)", "NRSC / ISRO", "Disaster",
     "Historical flood inundation layers (Odisha, AP, Assam, Bihar...)",
     "https://bhuvan-ras2.nrsc.gov.in/mapcache?service=WMS&request=GetCapabilities", "Free viewing"),
    ("vedas", "VEDAS GeoServer (optional)", "SAC / ISRO", "Disaster",
     "Brahmaputra inundation, shoreline change, HTL/LTL, districts",
     "https://vedas.sac.gov.in/geoserver/vedas/wms?service=WMS&request=GetCapabilities", "Free viewing"),
    ("celestrak", "CelesTrak GP elements", "CelesTrak (T.S. Kelso)", "Space",
     "Orbital elements for active satellites, all debris, rocket bodies, GNSS, decaying objects",
     "https://celestrak.org/NORAD/elements/gp.php?GROUP=gnss&FORMAT=tle", "Free, max once per 2 h per query"),
    ("satcat", "CelesTrak SATCAT", "CelesTrak", "Space",
     "Full catalogue: owner, type, status, launch/decay, apogee/perigee",
     "https://celestrak.org/pub/satcat.csv", "Free"),
    ("socrates", "CelesTrak SOCRATES", "CelesTrak", "Space",
     "Predicted close approaches (7 days): TCA, miss distance, probability",
     "https://celestrak.org/SOCRATES/sort-minRange.csv", "Free"),
    ("tle-backup", "TLE API (backup)", "tle.ivanstanojevic.me", "Space",
     "Backup orbital elements for NavIC and GPS if CelesTrak is unreachable",
     "https://tle.ivanstanojevic.me/api/tle/?search=IRNSS", "Free"),
    ("satnogs", "SatNOGS DB TLEs (fallback)", "Libre Space Foundation", "Space",
     "Last-resort orbital elements (~3k objects) if CelesTrak is unreachable",
     "https://db.satnogs.org/api/tle/?format=json", "CC-BY-SA"),
    ("swpc", "NOAA SWPC space weather", "NOAA Space Weather Prediction Center", "Space",
     "Planetary Kp index, Kp forecast and F10.7 solar flux (drives atmospheric drag)",
     "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", "Public domain"),
    ("adsbfi", "adsb.fi open data", "adsb.fi community ADS-B network", "Flights",
     "Live aircraft positions with ICAO type codes, 250 NM around each map cell (1 request/s)",
     "https://opendata.adsb.fi/api/v2/lat/28.5/lon/77.1/dist/50", "Free, non-commercial"),
    ("opensky", "OpenSky Network", "OpenSky Network (research network)", "Flights",
     "Wide-area overview of aircraft over South Asia and the track flown so far by a selected aircraft",
     "https://opensky-network.org/api/states/all?lamin=28&lomin=76&lamax=29&lomax=78", "Free for research/non-commercial"),
    ("adsbdb", "adsbdb", "adsbdb.com (open aircraft + route database)", "Flights",
     "Flight number to origin/destination airports, aircraft registry and photos",
     "https://api.adsbdb.com/v0/callsign/IGO2133", "Free"),
    ("ourairports", "OurAirports", "OurAirports (D. Megginson)", "Flights",
     "Airport positions, elevations and runway headings (crosswind model), snapshot in the repo",
     "https://davidmegginson.github.io/ourairports-data/airports.csv", "Public domain"),
]


def registry():
    keys = ["id", "name", "provider", "domain", "use", "url", "terms"]
    return [dict(zip(keys, r)) for r in REGISTRY]


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _parse_dt(s):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%a, %d %b %Y %H:%M:%S %Z",
                "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Disaster alerts
# ---------------------------------------------------------------------------
CAP_NS = {"cap": "urn:oasis:names:tc:emergency:cap:1.2"}
CAP_SEV = {"extreme": 3, "severe": 2, "moderate": 1, "minor": 0, "unknown": 0}


def _parse_cap_polygons(text):
    """'lat,lon lat,lon ...' -> [[lon,lat],...] rings"""
    rings = []
    for poly in text if isinstance(text, list) else [text]:
        pts = []
        for pair in (poly or "").split():
            try:
                la, lo = pair.split(",")[:2]
                pts.append([round(float(lo), 3), round(float(la), 3)])
            except ValueError:
                continue
        if len(pts) >= 3:
            step = max(1, len(pts) // 60)
            ring = pts[::step]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            rings.append(ring)
    return rings


def _ring_centroid(rings):
    pts = [p for r in rings for p in r]
    if not pts:
        return None, None
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def _sachet_detail(guid):
    url = f"https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier={guid}"
    raw, _ = fetch_raw("sachet", f"sachet_cap_{guid}", url, ttl=7 * DAY, timeout=20)
    root = ET.fromstring(raw)
    g = lambda el, tag: (el.findtext(f"cap:{tag}", default="", namespaces=CAP_NS) or "").strip()
    # A CAP file may carry one <info> per language; the site is English-only, so take the English one
    infos = root.findall("cap:info", CAP_NS)
    info = next((i for i in infos if g(i, "language").lower().startswith("en")), None) \
        or next((i for i in infos if _is_english(g(i, "headline") or g(i, "description"))), infos[0])
    out = {
        "event": g(info, "event"), "severity": g(info, "severity"), "urgency": g(info, "urgency"),
        "certainty": g(info, "certainty"), "effective": g(info, "effective"), "expires": g(info, "expires"),
        "headline": g(info, "headline"), "description": g(info, "description"),
        "instruction": g(info, "instruction"), "sender": g(root, "sender"),
    }
    rings, poly_url = [], None
    for p in info.findall("cap:parameter", CAP_NS):
        if "polygon" in g(p, "valueName").lower():
            poly_url = g(p, "value")
    area = info.find("cap:area", CAP_NS)
    lat = lon = None
    if area is not None:
        out["area"] = g(area, "areaDesc")
        polys = [e.text for e in area.findall("cap:polygon", CAP_NS) if e.text]
        rings = _parse_cap_polygons(polys)
        circ = g(area, "circle")
        if not rings and circ:
            try:
                c, _r = circ.split()
                lat, lon = map(float, c.split(","))
            except ValueError:
                pass
        if lat is None:  # some feeds put lat/lon in altitude/ceiling
            try:
                a, c = float(g(area, "altitude")), float(g(area, "ceiling"))
                if 5 < a < 38 and 67 < c < 98:
                    lat, lon = a, c
            except ValueError:
                pass
    if not rings and poly_url:
        try:
            praw, _ = fetch_raw("sachet", f"sachet_poly_{guid}", poly_url, ttl=7 * DAY, timeout=20)
            proot = ET.fromstring(praw)
            polys = [e.text for e in proot.iter() if e.tag.split("}")[-1] == "polygon" and e.text]
            rings = _parse_cap_polygons(polys)
        except Exception:
            pass
    if rings:
        lat, lon = _ring_centroid(rings)
    out["rings"], out["lat"], out["lon"] = rings, lat, lon
    return out


def _build_sachet():
    raw, prov = fetch_raw("sachet", "sachet_rss", "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml",
                          ttl=10 * MIN, timeout=30)
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        guid = (it.findtext("guid") or "").strip()
        author = it.findtext("author") or ""
        m = re.search(r"\(([^)]+)\)", author)
        items.append({"guid": guid, "title": (it.findtext("title") or "").strip(),
                      "agency": m.group(1) if m else author, "category": it.findtext("category") or "",
                      "pub": it.findtext("pubDate") or "", "link": it.findtext("link") or ""})

    def detail(item):
        try:
            return item, _sachet_detail(item["guid"])
        except Exception:
            return item, None

    # Fetch CAP details in parallel, within a time budget (serverless functions have hard limits).
    ex = ThreadPoolExecutor(max_workers=16)
    futs = [ex.submit(detail, it) for it in items]
    _wait(futs, timeout=25)
    ex.shutdown(wait=False, cancel_futures=True)
    results = [f.result() if f.done() and not f.cancelled() else (it, None) for f, it in zip(futs, items)]
    alerts = []
    if True:
        for item, d in results:
            d = d or {}
            sev = CAP_SEV.get((d.get("severity") or "").lower(), 0)
            when = _parse_dt(d.get("effective")) or _parse_dt(item["pub"])
            alerts.append({
                "id": "sachet-" + item["guid"], "source": "sachet", "type": _norm_type(d.get("event") or item["category"], item["title"]),
                "event": d.get("event") or item["category"], "title": d.get("headline") or item["title"],
                "description": d.get("description", ""), "instruction": d.get("instruction", ""),
                "severity": sev, "severityText": d.get("severity") or "Unknown", "urgency": d.get("urgency", ""),
                "agency": item["agency"], "area": d.get("area", ""), "time": _iso(when),
                "expires": _iso(_parse_dt(d.get("expires"))), "lat": d.get("lat"), "lon": d.get("lon"),
                "rings": d.get("rings", []), "url": item["link"], "country": "India",
            })
    return alerts, prov


TYPE_WORDS = [
    ("cyclone", ["cyclone", "depression", "storm surge", "tropical", "tc"]),
    ("flood", ["flood", "inundation", "river", "dam"]),
    ("rain", ["rain", "thunder", "lightning", "cloudburst"]),
    ("earthquake", ["earthquake", "seismic", "eq"]),
    ("tsunami", ["tsunami"]),
    ("landslide", ["landslide", "avalanche"]),
    ("wildfire", ["fire", "wf"]),
    ("volcano", ["volcan", "vo"]),
    ("drought", ["drought", "dr"]),
    ("heat", ["heat", "cold wave", "fog", "temperature"]),
    ("wind", ["wind", "squall", "dust"]),
]


def _norm_type(event, title=""):
    s = f"{event} {title}".lower()
    for t, words in TYPE_WORDS:
        for w in words:
            if (len(w) <= 2 and re.search(rf"\b{w}\b", s)) or (len(w) > 2 and w in s):
                return t
    return "other"


GDACS_TYPES = {"TC": "cyclone", "FL": "flood", "EQ": "earthquake", "VO": "volcano", "WF": "wildfire", "DR": "drought"}
GDACS_SEV = {"red": 3, "orange": 2, "green": 0}


def _build_gdacs():
    end = _now()
    start = end - timedelta(days=30)
    url = ("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC;FL;EQ;VO;WF;DR"
           f"&fromdate={start:%Y-%m-%d}&todate={end:%Y-%m-%d}")
    raw, prov = fetch_raw("gdacs", "gdacs_search", url, ttl=15 * MIN, timeout=40)
    data = json.loads(raw)
    out = []
    for f in data.get("features", []):
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        sd = p.get("severitydata") or {}
        out.append({
            "id": f"gdacs-{p['eventtype']}-{p['eventid']}", "source": "gdacs",
            "type": GDACS_TYPES.get(p["eventtype"], "other"), "event": p.get("eventtype"),
            "title": p.get("name") or p.get("eventname"), "description": (sd.get("severitytext") or ""),
            "severity": GDACS_SEV.get((p.get("alertlevel") or "").lower(), 0), "severityText": p.get("alertlevel"),
            "agency": "GDACS", "area": p.get("country", ""), "country": p.get("country", ""),
            "time": _iso(_parse_dt(p.get("fromdate"))), "updated": _iso(_parse_dt(p.get("todate"))),
            "lat": lat, "lon": lon, "url": (p.get("url") or {}).get("report"),
            "gdacs": {"type": p["eventtype"], "id": p["eventid"], "episode": p.get("episodeid"),
                      "current": p.get("iscurrent") in (True, "true")},
        })
    return out, prov


def _build_usgs():
    raw, prov = fetch_raw("usgs", "usgs_45week",
                          "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson", ttl=5 * MIN)
    out = []
    for f in json.loads(raw)["features"]:
        p = f["properties"]
        lon, lat, depth = f["geometry"]["coordinates"]
        mag = p.get("mag") or 0
        pager = {"red": 3, "orange": 2, "yellow": 1}.get(p.get("alert") or "", None)
        sev = pager if pager is not None else (3 if mag >= 7 else 2 if mag >= 6.3 else 1 if mag >= 5.5 else 0)
        out.append({
            "id": "usgs-" + f["id"], "source": "usgs", "type": "earthquake", "event": "Earthquake",
            "title": p.get("title"), "description": f"Magnitude {mag}, depth {depth:.0f} km" + (" · tsunami flag" if p.get("tsunami") else ""),
            "severity": sev, "severityText": f"M{mag}", "agency": "USGS", "area": p.get("place", ""),
            "time": _iso(datetime.fromtimestamp(p["time"] / 1000, timezone.utc)), "lat": lat, "lon": lon,
            "url": p.get("url"), "mag": mag,
        })
    return out, prov


def _build_eonet():
    raw, prov = fetch_raw("eonet", "eonet_open",
                          "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30", ttl=30 * MIN)
    out = []
    for f in json.loads(raw).get("features", []):
        p, g = f["properties"], f.get("geometry") or {}
        cat = (p.get("categories") or [{}])[0].get("title", "")
        if cat in ("Sea and Lake Ice", "Snow", "Manmade"):
            continue
        if g.get("type") == "Point":
            lon, lat = g["coordinates"][:2]
        elif g.get("type") == "Polygon":
            ring = g["coordinates"][0]
            lon, lat = sum(c[0] for c in ring) / len(ring), sum(c[1] for c in ring) / len(ring)
        else:
            continue
        src = (p.get("sources") or [{}])[0]
        out.append({
            "id": "eonet-" + p["id"], "source": "eonet", "type": _norm_type(cat, p.get("title", "")),
            "event": cat, "title": p.get("title"), "description": p.get("description") or cat,
            "severity": 1 if "storm" in cat.lower() else 0, "severityText": cat, "agency": "NASA EONET",
            "area": "", "time": _iso(_parse_dt(p.get("date"))), "lat": lat, "lon": lon, "url": src.get("url") or p.get("link"),
        })
    return out, prov


def _build_ncs():
    import hazard  # local import avoids a cycle
    ev, prov = hazard._ncs_events()
    cutoff = _now() - timedelta(days=7)
    out = []
    for e in ev:
        t = _parse_dt(e["time"])
        if not t or t < cutoff or e["mag"] < 3.0:
            continue
        m = e["mag"]
        out.append({"id": f"ncs-{e['time']}-{e['lat']}", "source": "ncs", "type": "earthquake", "event": "Earthquake",
                    "title": f"M{m:.1f} earthquake · {e['place']}", "description": f"Magnitude {m}, depth {e['depth']:.0f} km. Region: {e['region']}.",
                    "severity": 3 if m >= 7 else 2 if m >= 6 else 1 if m >= 4.5 else 0, "severityText": f"M{m:.1f}",
                    "agency": "NCS (MoES)", "area": e["region"], "country": "India", "time": e["time"],
                    "lat": e["lat"], "lon": e["lon"], "url": e["url"], "mag": m})
    return out, prov


ALERT_BUILDERS = {"sachet": (_build_sachet, 10 * MIN), "ncs": (_build_ncs, 10 * MIN), "gdacs": (_build_gdacs, 15 * MIN),
                  "usgs": (_build_usgs, 5 * MIN), "eonet": (_build_eonet, 30 * MIN)}


def _simplify(ring, tol=0.006):
    """Douglas-Peucker on a [lon, lat] ring (tolerance in degrees, ~600 m). Keeps map outlines, drops ~90% of points."""
    if len(ring) < 40:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = ring[a][:2], ring[b][:2]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = ring[i][:2]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [[round(p[0], 3), round(p[1], 3)] for p, k in zip(ring, keep) if k]


_SLIM = {}


def _slim_alert(a):
    """Smaller copy for the browser: simplified polygons, rounded coordinates. Cached by id."""
    k = (a.get("id"), a.get("time"))
    if k not in _SLIM:
        b = dict(a)
        if b.get("rings"):
            b["rings"] = [_simplify(r) for r in b["rings"]]
        for f in ("lat", "lon"):
            if isinstance(b.get(f), float):
                b[f] = round(b[f], 4)
        if len(_SLIM) > 5000:
            _SLIM.clear()
        _SLIM[k] = b
    return _SLIM[k]


def _is_english(text):
    """True when most letters are Latin script (SACHET also issues alerts in Hindi, Odia, Bengali and others)."""
    letters = [c for c in text or "" if c.isalpha()]
    if not letters:
        return True
    return sum(c < "\u0250" for c in letters) / len(letters) >= 0.6


def _english_only(a):
    """None for an alert with no English text; otherwise the alert with any non-English fields blanked."""
    if not _is_english(a.get("title")):
        return None
    for k in ("description", "instruction", "area"):
        if a.get(k) and not _is_english(a[k]):
            a = {**a, k: ""}
    return a


def alerts():
    def one(name):
        builder, ttl = ALERT_BUILDERS[name]
        try:
            data, prov = cached_result(f"alerts_{name}", ttl, builder)
            return name, data, {"status": "ok", "provenance": prov, "count": len(data)}
        except SourceUnavailable as e:
            return name, [], {"status": "error", "error": str(e)[:200], "count": 0}

    with ThreadPoolExecutor(max_workers=5) as ex:
        results = list(ex.map(one, ALERT_BUILDERS))
    merged, status = [], {}
    for name, data, st in results:
        merged.extend(_slim_alert(e) for e in map(_english_only, data) if e)
        status[name] = st
    merged.sort(key=lambda a: (-(a["severity"] or 0), a["time"] or ""), reverse=False)
    merged.sort(key=lambda a: a["time"] or "", reverse=True)
    provs = [s.get("provenance", "snapshot") for s in status.values() if s["status"] == "ok"]
    return {"generated": _iso(_now()), "alerts": merged, "sources": status}, worst(*provs)


def gdacs_geometry(etype, eid, episode):
    if etype not in GDACS_TYPES or not str(eid).isdigit() or not str(episode).isdigit():
        raise ValueError("bad gdacs params")

    def build():
        url = f"https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype={etype}&eventid={eid}&episodeid={episode}"
        raw, prov = fetch_raw("gdacs", f"gdacs_geom_{etype}_{eid}_{episode}", url, ttl=30 * MIN, timeout=40)
        return json.loads(raw), prov
    return cached_result(f"gdacs_geom_{etype}_{eid}_{episode}", 30 * MIN, build)


# ---------------------------------------------------------------------------
# Weather / flood / marine for a point (Open-Meteo)
# ---------------------------------------------------------------------------
def weather(lat, lon):
    lat, lon = round(float(lat), 2), round(float(lon), 2)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("bad coords")

    def build():
        out, provs = {"lat": lat, "lon": lon}, []
        q = f"latitude={lat}&longitude={lon}"
        reqs = {
            "forecast": ("https://api.open-meteo.com/v1/forecast?" + q +
                         "&hourly=precipitation,precipitation_probability,wind_gusts_10m"
                         "&daily=precipitation_sum,wind_gusts_10m_max,wind_speed_10m_max"
                         "&past_days=3&forecast_days=7&timezone=auto"),
            "flood": ("https://flood-api.open-meteo.com/v1/flood?" + q +
                      "&daily=river_discharge,river_discharge_mean,river_discharge_max&past_days=30&forecast_days=30"),
            "marine": ("https://marine-api.open-meteo.com/v1/marine?" + q +
                       "&daily=wave_height_max,swell_wave_height_max&past_days=2&forecast_days=7&timezone=auto"),
        }
        for k, url in reqs.items():
            try:
                raw, prov = fetch_raw("openmeteo", f"om_{k}_{lat}_{lon}", url, ttl=30 * MIN, timeout=25)
                d = json.loads(raw)
                if d.get("error"):
                    out[k] = None
                else:
                    out[k] = {kk: d.get(kk) for kk in ("daily", "daily_units", "hourly", "hourly_units", "timezone")}
                    provs.append(prov)
            except SourceUnavailable:
                out[k] = None
        if not provs:
            raise SourceUnavailable("open-meteo unreachable")
        return out, worst(*provs)
    return cached_result(f"weather_{lat}_{lon}", 30 * MIN, build)


def weather_archive(lat, lon, start, end):
    lat, lon = round(float(lat), 2), round(float(lon), 2)
    for d in (start, end):
        datetime.strptime(d, "%Y-%m-%d")

    def build():
        url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}"
               f"&start_date={start}&end_date={end}&daily=precipitation_sum,wind_gusts_10m_max&timezone=auto")
        raw, prov = fetch_raw("openmeteo", f"om_arch_{lat}_{lon}_{start}_{end}", url, ttl=30 * DAY)
        return json.loads(raw), prov
    return cached_result(f"wx_arch_{lat}_{lon}_{start}_{end}", 30 * DAY, build)


# ---------------------------------------------------------------------------
# Cyclone best tracks (IBTrACS North Indian Ocean)
# ---------------------------------------------------------------------------
def _ibtracs_rows():
    raw, prov = fetch_raw("ibtracs", "ibtracs_ni",
                          "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NI.list.v04r01.csv",
                          ttl=7 * DAY, timeout=120)
    rdr = csv.reader(io.StringIO(raw.decode("utf-8", "replace")))
    header = next(rdr)
    next(rdr)  # units row
    idx = {h: i for i, h in enumerate(header)}
    return rdr, idx, prov


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _build_cyclones():
    rdr, idx, prov = _ibtracs_rows()
    storms = {}
    for r in rdr:
        season = int(r[idx["SEASON"]])
        if season < 2000:
            continue
        sid = r[idx["SID"]]
        wind = _num(r[idx["NEWDELHI_WIND"]]) or _num(r[idx["WMO_WIND"]]) or _num(r[idx["USA_WIND"]])
        lat, lon = _num(r[idx["LAT"]]), _num(r[idx["LON"]])
        s = storms.setdefault(sid, {"sid": sid, "name": r[idx["NAME"]].title(), "season": season,
                                    "basin": r[idx["SUBBASIN"]], "maxWind": 0, "grade": "", "track": []})
        if wind and wind > s["maxWind"]:
            s["maxWind"] = wind
            s["grade"] = r[idx["NEWDELHI_GRADE"]].strip()
        s["track"].append([r[idx["ISO_TIME"]][:16], lat, lon, wind, r[idx["NEWDELHI_GRADE"]].strip(),
                           _num(r[idx["DIST2LAND"]])])
    out = [s for s in storms.values() if s["maxWind"] >= 34]  # tropical storm strength and above
    out.sort(key=lambda s: (s["season"], s["track"][0][0]), reverse=True)
    return out, prov


def cyclones():
    data, prov = cached_result("cyclones_ni", 7 * DAY, _build_cyclones)
    return data, prov


# ---------------------------------------------------------------------------
# Sentinel-1 flood case studies (Planetary Computer)
# ---------------------------------------------------------------------------
FLOOD_CASES = {
    "dana-2024": {"title": "Cyclone Dana, Odisha (Oct 2024)", "bbox": [86.0, 20.2, 87.3, 21.6],
                  "before": "2024-10-10/2024-10-20", "after": "2024-10-25/2024-11-03",
                  "center": [20.8, 86.6], "landfall": "2024-10-25"},
    "assam-2024": {"title": "Brahmaputra floods, Assam (Jul 2024)", "bbox": [91.5, 26.0, 93.5, 26.9],
                   "before": "2024-03-01/2024-04-15", "after": "2024-07-01/2024-07-12",
                   "center": [26.4, 92.4], "landfall": "2024-07-03"},
    "wayanad-2024": {"title": "Kerala monsoon floods (Jul 2024)", "bbox": [75.6, 9.8, 76.6, 10.8],
                     "before": "2024-04-01/2024-05-10", "after": "2024-07-25/2024-08-05",
                     "center": [10.3, 76.2], "landfall": "2024-07-30"},
}
PC = "https://planetarycomputer.microsoft.com/api"


def _stac_search(key, bbox, dt):
    body = json.dumps({"collections": ["sentinel-1-rtc"], "bbox": bbox, "datetime": dt, "limit": 60}).encode()
    raw, prov = fetch_raw("planetary", key, PC + "/stac/v1/search", ttl=30 * DAY, timeout=60,
                          headers={"Content-Type": "application/json"}, data=body, method="POST")
    return json.loads(raw)["features"], prov


def _overlap(a, b):
    w = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return w * h


def _build_flood_case(case_id):
    c = FLOOD_CASES[case_id]
    before, p1 = _stac_search(f"s1_{case_id}_before", c["bbox"], c["before"])
    after, p2 = _stac_search(f"s1_{case_id}_after", c["bbox"], c["after"])

    def key(f):  # same relative orbit and frame -> same id suffix pattern & time of day
        p = f["properties"]
        return (p.get("sat:relative_orbit"), p.get("sat:orbit_state"), p["datetime"][11:16])

    pairs = []
    for a in after:
        cands = [b for b in before if key(b)[:2] == key(a)[:2] and _overlap(a["bbox"], b["bbox"]) > 0]
        if not cands:
            continue
        b = max(cands, key=lambda b: (_overlap(a["bbox"], b["bbox"]) > 0.8 * _overlap(a["bbox"], a["bbox"]), b["properties"]["datetime"]))
        cover = _overlap(a["bbox"], c["bbox"])
        pairs.append({"after": a["id"], "before": b["id"], "afterDate": a["properties"]["datetime"][:16],
                      "beforeDate": b["properties"]["datetime"][:16], "orbit": a["properties"].get("sat:orbit_state"),
                      "bbox": a["bbox"], "cover": cover})
    # Prefer the post-event scene closest to the event, then the best coverage of the case area
    ev = c["landfall"]
    pairs.sort(key=lambda p: (abs((datetime.fromisoformat(p["afterDate"][:10]) - datetime.fromisoformat(ev)).days), -p["cover"]))
    out = dict(c, id=case_id, pairs=pairs[:6], tileBase=PC + "/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x")
    return out, worst(p1, p2)


def flood_cases():
    return [{"id": k, **v} for k, v in FLOOD_CASES.items()], "live"


def flood_case(case_id):
    if case_id not in FLOOD_CASES:
        raise ValueError("unknown case")
    return cached_result(f"flood_{case_id}", 30 * DAY, lambda: _build_flood_case(case_id))


# ---------------------------------------------------------------------------
# Satellite catalogue (SATCAT)
# ---------------------------------------------------------------------------
def _satcat_rows():
    raw, prov = fetch_raw("satcat", "satcat_csv", "https://celestrak.org/pub/satcat.csv", ttl=DAY, timeout=30)
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8", "replace")))), prov


def _build_satcat_index():
    """Compact per-object info for on-orbit objects: owner, type, status, intdes."""
    rows, prov = _satcat_rows()
    idx = {}
    for r in rows:
        if r["DECAY_DATE"]:
            continue
        idx[r["NORAD_CAT_ID"]] = [r["OWNER"], r["OBJECT_TYPE"], r["OPS_STATUS_CODE"], r["OBJECT_ID"],
                                  r["LAUNCH_DATE"], _num(r["RCS"])]
    return idx, prov


def satcat_index():
    return cached_result("satcat_index", DAY, _build_satcat_index)


def _build_catalog_stats():
    rows, prov = _satcat_rows()
    year_now = _now().year
    on = [r for r in rows if not r["DECAY_DATE"]]
    by_type = {}
    for r in on:
        by_type[r["OBJECT_TYPE"]] = by_type.get(r["OBJECT_TYPE"], 0) + 1

    # growth of on-orbit population by year and type
    years = list(range(1957, year_now + 1))
    types = ["PAY", "R/B", "DEB", "UNK"]
    delta = {t: [0] * (len(years) + 1) for t in types}
    for r in rows:
        t = r["OBJECT_TYPE"] if r["OBJECT_TYPE"] in types else "UNK"
        try:
            ly = int(r["LAUNCH_DATE"][:4])
        except ValueError:
            continue
        delta[t][max(0, ly - 1957)] += 1
        if r["DECAY_DATE"]:
            try:
                dy = int(r["DECAY_DATE"][:4])
                delta[t][max(0, dy - 1957) + 1] -= 1  # gone after decay year
            except ValueError:
                pass
    growth = {"years": years}
    for t in types:
        acc, series = 0, []
        for i in range(len(years)):
            acc += delta[t][i]
            series.append(acc)
        growth[t] = series

    # altitude distribution (LEO, mean altitude, 25 km bins)
    bins = list(range(150, 2025, 25))
    alt = {t: [0] * len(bins) for t in types}
    regimes = {"LEO": 0, "MEO": 0, "GEO": 0, "HEO/Other": 0}
    for r in on:
        ap, pe, per = _num(r["APOGEE"]), _num(r["PERIGEE"]), _num(r["PERIOD"])
        if ap is None or pe is None or r["ORBIT_CENTER"] != "EA":
            continue
        t = r["OBJECT_TYPE"] if r["OBJECT_TYPE"] in types else "UNK"
        mean = (ap + pe) / 2
        if per and 1400 < per < 1480 and ap - pe < 2000:
            regimes["GEO"] += 1
        elif ap < 2000:
            regimes["LEO"] += 1
        elif pe > 2000 and ap < 35000:
            regimes["MEO"] += 1
        else:
            regimes["HEO/Other"] += 1
        if 150 <= mean < 2025 and ap < 2500:
            alt[t][int((mean - 150) // 25)] += 1

    # owners
    owners = {}
    for r in on:
        o = owners.setdefault(r["OWNER"], {"owner": r["OWNER"], "total": 0, "PAY": 0, "R/B": 0, "DEB": 0})
        o["total"] += 1
        if r["OBJECT_TYPE"] in o:
            o[r["OBJECT_TYPE"]] += 1
    top_owners = sorted(owners.values(), key=lambda o: -o["total"])[:12]

    # fragmentation events: on-orbit debris grouped by launch
    frag = {}
    for r in on:
        if r["OBJECT_TYPE"] == "DEB":
            k = r["OBJECT_ID"][:8]
            frag[k] = frag.get(k, 0) + 1
    parents = {}
    for r in rows:
        k = r["OBJECT_ID"][:8]
        if k in frag and r["OBJECT_TYPE"] in ("PAY", "R/B") and (k not in parents or r["OBJECT_ID"].endswith("A")):
            parents[k] = {"name": r["OBJECT_NAME"], "owner": r["OWNER"], "type": r["OBJECT_TYPE"],
                          "launch": r["LAUNCH_DATE"]}
    top_frag = sorted(frag.items(), key=lambda kv: -kv[1])[:12]
    fragments = [{"intdes": k, "debrisOnOrbit": n, **parents.get(k, {"name": k, "owner": "?", "type": "?", "launch": ""})}
                 for k, n in top_frag]

    # India
    ind = [r for r in on if r["OWNER"] == "IND"]
    india = {"total": len(ind), "byType": {}, "payloads": []}
    for r in ind:
        india["byType"][r["OBJECT_TYPE"]] = india["byType"].get(r["OBJECT_TYPE"], 0) + 1
        if r["OBJECT_TYPE"] == "PAY":
            india["payloads"].append({"name": r["OBJECT_NAME"], "norad": int(r["NORAD_CAT_ID"]),
                                      "status": r["OPS_STATUS_CODE"], "launch": r["LAUNCH_DATE"],
                                      "apogee": _num(r["APOGEE"]), "perigee": _num(r["PERIGEE"]),
                                      "incl": _num(r["INCLINATION"])})

    navic = [{"name": r["OBJECT_NAME"], "norad": int(r["NORAD_CAT_ID"]), "status": r["OPS_STATUS_CODE"],
              "launch": r["LAUNCH_DATE"], "decay": r["DECAY_DATE"], "apogee": _num(r["APOGEE"]),
              "perigee": _num(r["PERIGEE"]), "incl": _num(r["INCLINATION"]), "period": _num(r["PERIOD"])}
             for r in rows if re.search(r"IRNSS|NVS-0", r["OBJECT_NAME"])]

    return {"generated": _iso(_now()), "cataloged": len(rows), "onOrbit": len(on), "byType": by_type,
            "regimes": regimes, "growth": growth, "altitude": {"bins": bins, **alt},
            "owners": top_owners, "fragmentations": fragments, "india": india, "navic": navic}, prov


def catalog_stats():
    return cached_result("catalog_stats", DAY, _build_catalog_stats)


# ---------------------------------------------------------------------------
# Orbital elements (CelesTrak GP, TLE format)
# ---------------------------------------------------------------------------
ORBIT_SETS = {
    "active": "GROUP=active", "debris": "NAME=DEB", "rocket-bodies": "NAME=R/B",
    "gnss": "GROUP=gnss", "gps": "GROUP=gps-ops", "stations": "GROUP=stations",
    "decaying": "SPECIAL=DECAYING", "gpz": "SPECIAL=GPZ",
}


ALPHA5 = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # I and O are skipped


def _norad(field):
    """Decode a TLE catalogue number, including Alpha-5 (e.g. 'A1228' -> 101228)."""
    f = field.strip()
    if f and f[0].isalpha():
        return (ALPHA5.index(f[0].upper()) + 10) * 10000 + int(f[1:])
    return int(f)


def _parse_tle(text):
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    out = []
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            out.append([_norad(l1[2:7]), name.strip(), l1, l2])
            i += 3
        else:
            i += 1
    return out


# Backup TLE source for small constellations (free, no key, mirrors public TLEs)
BACKUP_SEARCH = {"gnss": ["IRNSS", "NVS-0"], "gps": ["GPS B", "NAVSTAR"]}


def _backup_tles(name):
    sats, seen = [], set()
    for term in BACKUP_SEARCH[name]:
        url = f"https://tle.ivanstanojevic.me/api/tle/?search={urllib.parse.quote(term)}&page-size=100"
        raw, _ = fetch_raw("tle-backup", f"tlebak_{term}", url, ttl=2 * HOUR, timeout=30)
        for m in json.loads(raw).get("member", []):
            if m["satelliteId"] not in seen and m["line1"].startswith("1 "):
                seen.add(m["satelliteId"])
                sats.append([m["satelliteId"], m["name"], m["line1"], m["line2"]])
    if not sats:
        raise SourceUnavailable("backup TLE source empty")
    return sats


def orbit_set(name):
    if name not in ORBIT_SETS:
        raise ValueError("unknown orbit set")

    def build():
        url = f"https://celestrak.org/NORAD/elements/gp.php?{ORBIT_SETS[name]}&FORMAT=tle"
        try:
            raw, prov = fetch_raw("celestrak", f"gp_{name}", url, ttl=2 * HOUR, timeout=30)
            text = raw.decode("utf-8", "replace")
            if "Invalid query" in text[:200] or "No GP data" in text[:200]:
                raise SourceUnavailable(text[:120])
            return {"set": name, "source": "CelesTrak", "fetched": _iso(_now()), "sats": _parse_tle(text)}, prov
        except SourceUnavailable:
            if name not in BACKUP_SEARCH:
                raise
            return {"set": name, "source": "tle.ivanstanojevic.me (backup)", "fetched": _iso(_now()),
                    "sats": _backup_tles(name)}, "live"
    return cached_result(f"orbits_{name}", 2 * HOUR, build)


# Notable fragmentation clouds (international designator prefix -> label)
CLOUDS = {"1999-025": "Fengyun-1C ASAT test (2007)", "1993-036": "Cosmos 2251 (2009 collision)",
          "1997-051": "Iridium 33 (2009 collision)", "1982-092": "Cosmos 1408 ASAT test (2021)"}
TYPE_CODE = {"PAY": 0, "R/B": 1, "DEB": 2, "UNK": 3}


def _tle_age_days(l1):
    try:
        yy, doy = int(l1[18:20]), float(l1[20:32])
        epoch = datetime(2000 + yy if yy < 57 else 1900 + yy, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1)
        return (_now() - epoch).total_seconds() / DAY
    except ValueError:
        return 9999


def _intdes_from_l1(l1):
    s = l1[9:17].strip()  # e.g. 99025ABC
    if len(s) < 5:
        return ""
    yy = int(s[:2])
    return f"{1900 + yy if yy >= 57 else 2000 + yy}-{s[2:5]}"


# ---------------------------------------------------------------------------
# Catalogue in parts, each with a source chain tried ONE AT A TIME (never in parallel):
# first source that returns enough objects wins; every attempt is reported to the UI.
# ---------------------------------------------------------------------------
import time as _time

PART_TYPES = {"payloads": 0, "rocket-bodies": 1, "debris": 2}
PART_MIN = {"payloads": 5000, "rocket-bodies": 1000, "debris": 3000}  # below this a source is "partial"


def _src_celestrak(part):
    q = {"payloads": "GROUP=active", "rocket-bodies": "NAME=R/B", "debris": "NAME=DEB"}[part]
    key = {"payloads": "gp_active", "rocket-bodies": "gp_rocket-bodies", "debris": "gp_debris"}[part]
    raw, prov = fetch_raw("celestrak", key, f"https://celestrak.org/NORAD/elements/gp.php?{q}&FORMAT=tle", ttl=2 * HOUR, timeout=20)
    text = raw.decode("utf-8", "replace")
    if "Invalid query" in text[:200] or "No GP data" in text[:200]:
        raise SourceUnavailable(text[:100])
    return _parse_tle(text), prov


def _src_satnogs(part):
    raw, prov = fetch_raw("satnogs", "satnogs_tle", "https://db.satnogs.org/api/tle/?format=json", ttl=2 * HOUR, timeout=25)
    rows = []
    for t in json.loads(raw):
        l1, l2 = t.get("tle1", ""), t.get("tle2", "")
        if not (l1.startswith("1 ") and l2.startswith("2 ")) or _tle_age_days(l1) > 14:
            continue
        nm = (t.get("tle0") or "").removeprefix("0 ").strip()
        kind = "debris" if " DEB" in nm else "rocket-bodies" if "R/B" in nm else "payloads"
        if kind == part:
            rows.append([_norad(l1[2:7]), nm, l1, l2])
    return rows, prov


def _src_tle_mirror(part, budget_s=22.0):
    """tle.ivanstanojevic.me: 100 objects per page, so pages are fetched sequentially within a time budget."""
    search = {"payloads": "", "rocket-bodies": "R/B", "debris": "DEB"}[part]
    rows, seen, t0, page, prov = [], set(), _time.time(), 1, "live"
    while _time.time() - t0 < budget_s and page <= 60:
        url = f"https://tle.ivanstanojevic.me/api/tle/?page-size=100&page={page}" + (f"&search={urllib.parse.quote(search)}" if search else "")
        raw, prov = fetch_raw("tle-backup", f"tlebak_{part}_{page}", url, ttl=2 * HOUR, timeout=12)
        d = json.loads(raw)
        members = d.get("member", [])
        for m in members:
            nm = m.get("name", "")
            if part == "payloads" and (" DEB" in nm or "R/B" in nm):
                continue
            if m["satelliteId"] not in seen and m.get("line1", "").startswith("1 ") and _tle_age_days(m["line1"]) <= 30:
                seen.add(m["satelliteId"])
                rows.append([m["satelliteId"], nm, m["line1"], m["line2"]])
        if not members or page * 100 >= d.get("totalItems", 0):
            break
        page += 1
    return rows, prov


def _src_snapshot(part):
    snap = SNAP_DIR_PATH / f"orbits_part_{part}.json"
    if not snap.exists():
        raise SourceUnavailable("no snapshot")
    d = json.loads(snap.read_text())
    return d["sats"], "snapshot"


from gateway import SNAP_DIR as SNAP_DIR_PATH  # noqa: E402

PART_CHAIN = {
    "payloads": [("CelesTrak", _src_celestrak), ("SatNOGS DB", _src_satnogs), ("TLE API mirror", _src_tle_mirror), ("Saved snapshot", _src_snapshot)],
    "rocket-bodies": [("CelesTrak", _src_celestrak), ("TLE API mirror", _src_tle_mirror), ("Saved snapshot", _src_snapshot)],
    "debris": [("CelesTrak", _src_celestrak), ("TLE API mirror", _src_tle_mirror), ("Saved snapshot", _src_snapshot)],
}


def _enrich(rows, default_type):
    try:
        idx, _ = satcat_index()
    except SourceUnavailable:
        idx = {}
    decaying = set()
    try:
        d, _ = orbit_set("decaying")
        decaying = {x[0] for x in d["sats"]}
    except Exception:
        pass
    cloud_keys = list(CLOUDS)
    out = []
    for row in rows:
        norad, nm, l1, l2 = row[:4]
        info = idx.get(str(norad))
        owner = info[0] if info else ""
        t = TYPE_CODE.get(info[1], default_type) if info else default_type
        intdes = _intdes_from_l1(l1)
        cloud = cloud_keys.index(intdes) if intdes in CLOUDS and t == 2 else -1
        flags = (1 if owner == "IND" else 0) | (2 if norad in decaying else 0) | (4 if re.search(r"IRNSS|NVS-0", nm) else 0)
        out.append([norad, nm, l1, l2, t, owner, flags, cloud, info[2] if info else ""])
    return out


def _build_part(part):
    attempts, best, partials = [], None, []
    for name, fn in PART_CHAIN[part]:
        t0 = _time.time()
        try:
            rows, prov = fn(part)
            ms = round((_time.time() - t0) * 1000)
            ok = len(rows) >= PART_MIN[part] or name == "Saved snapshot"
            attempts.append({"source": name, "status": "ok" if ok else "partial", "count": len(rows), "ms": ms})
            if name != "Saved snapshot":
                partials.append((name, rows))
            if best is None or len(rows) > len(best[1]):
                best = (name, rows, prov)
            if ok and rows:
                break
        except Exception as e:
            attempts.append({"source": name, "status": "failed", "error": str(e)[:120], "ms": round((_time.time() - t0) * 1000)})
    if not best or not best[1]:
        raise SourceUnavailable(f"all sources failed for {part}")
    name, rows, prov = best
    # If we ended on the snapshot, refresh it with any fresher elements a partial live source returned.
    if name == "Saved snapshot":
        live = [x for x in partials if x[1]]
        if live:
            merged = {r[0]: r for r in rows}
            fresh_n = 0
            for src_name, src_rows in live:
                for r in src_rows:
                    merged[r[0]] = r
                    fresh_n += 1
            rows = list(merged.values())
            name = f"Saved snapshot + {', '.join(n for n, _ in live)} ({fresh_n:,} refreshed)"
    return {"part": part, "source": name, "attempts": attempts, "generated": _iso(_now()), "count": len(rows),
            "clouds": [CLOUDS[k] for k in CLOUDS], "fields": ["norad", "name", "l1", "l2", "type", "owner", "flags", "cloud", "status"],
            "flagBits": {"india": 1, "decaying": 2, "navic": 4}, "types": ["PAY", "R/B", "DEB", "UNK"],
            "sats": _enrich(rows, PART_TYPES[part])}, prov


def catalog_part(part):
    if part not in PART_CHAIN:
        raise ValueError("part must be payloads, rocket-bodies or debris")
    return cached_result(f"orbits_part_{part}", 2 * HOUR, lambda: _build_part(part))


def _build_catalog_orbits():
    """Legacy combined catalogue (parts fetched sequentially)."""
    sats, provs, parts = {}, [], []
    for part in PART_CHAIN:
        try:
            d, p = catalog_part(part)
        except SourceUnavailable:
            continue
        provs.append(p)
        parts.append({"part": part, "source": d["source"], "count": d["count"]})
        for row in d["sats"]:
            sats.setdefault(row[0], row)
    if not sats:
        raise SourceUnavailable("no orbit data")
    return {"generated": _iso(_now()), "source": ", ".join(f"{x['part']}: {x['source']}" for x in parts), "parts": parts,
            "count": len(sats), "clouds": [CLOUDS[k] for k in CLOUDS],
            "fields": ["norad", "name", "l1", "l2", "type", "owner", "flags", "cloud", "status"],
            "flagBits": {"india": 1, "decaying": 2, "navic": 4}, "types": ["PAY", "R/B", "DEB", "UNK"],
            "sats": list(sats.values())}, worst(*provs)


def catalog_orbits():
    return cached_result("catalog_orbits", 2 * HOUR, _build_catalog_orbits)


# ---------------------------------------------------------------------------
# Conjunctions (SOCRATES)
# ---------------------------------------------------------------------------
def _build_conjunctions():
    raw, prov = fetch_raw("socrates", "socrates_minrange", "https://celestrak.org/SOCRATES/sort-minRange.csv",
                          ttl=8 * HOUR, timeout=30)
    try:
        idx, _ = satcat_index()
    except SourceUnavailable:
        idx = {}
    rdr = csv.DictReader(io.StringIO(raw.decode("utf-8", "replace")))
    now = _now()
    rows, seen, seen_pairs, india_sats = [], set(), set(), set()
    total = lt1 = lt5 = 0
    india_rows = []
    for r in rdr:
        tca = _parse_dt(r["TCA"])
        if not tca or tca < now - timedelta(hours=6):
            continue
        a, b = r["NORAD_CAT_ID_1"], r["NORAD_CAT_ID_2"]
        k = (a, b, r["TCA"][:16])
        if k in seen:
            continue
        seen.add(k)
        rng = _num(r["TCA_RANGE"]) or 99
        vrel = _num(r["TCA_RELATIVE_SPEED"]) or 0
        if vrel < 0.5:       # co-moving pair (same launch, formation flying, docked): not a real near-miss
            continue
        pair = (a, b)
        if pair in seen_pairs:   # keep only the closest approach per pair
            continue
        seen_pairs.add(pair)
        total += 1
        lt1 += rng < 1
        lt5 += rng < 5
        ia, ib = idx.get(a), idx.get(b)
        rec = {"id1": int(a), "name1": r["OBJECT_NAME_1"].replace(" [+]", "").replace(" [-]", "").replace(" [?]", ""),
               "id2": int(b), "name2": r["OBJECT_NAME_2"].replace(" [+]", "").replace(" [-]", "").replace(" [?]", ""),
               "type1": ia[1] if ia else "", "type2": ib[1] if ib else "",
               "owner1": ia[0] if ia else "", "owner2": ib[0] if ib else "",
               "tca": _iso(tca), "rangeKm": rng, "relSpeedKms": _num(r["TCA_RELATIVE_SPEED"]),
               "maxProb": _num(r["MAX_PROB"]) or 0, "dse1": _num(r["DSE_1"]), "dse2": _num(r["DSE_2"])}
        if len(rows) < 400:
            rows.append(rec)
        if rec["owner1"] == "IND" or rec["owner2"] == "IND":
            if rng < 5:
                if rec["owner1"] == "IND" and rec["type1"] == "PAY":
                    india_sats.add(rec["id1"])
                if rec["owner2"] == "IND" and rec["type2"] == "PAY":
                    india_sats.add(rec["id2"])
            if len(india_rows) < 300:
                india_rows.append(rec)
    by_prob = sorted(rows, key=lambda x: -x["maxProb"])[:100]
    return {"generated": _iso(now), "total": total, "under1km": lt1, "under5km": lt5,
            "indiaSatsUnder5km": len(india_sats), "indiaSatIds": sorted(india_sats),
            "note": "distinct pairs; co-moving pairs (relative speed < 0.5 km/s) excluded",
            "closest": rows[:200], "highestProb": by_prob, "india": india_rows}, prov


def conjunctions():
    return cached_result("conjunctions", 8 * HOUR, _build_conjunctions)


# ---------------------------------------------------------------------------
# Space weather (NOAA SWPC)
# ---------------------------------------------------------------------------
def _build_spaceweather():
    kp, p1 = fetch_raw("swpc", "swpc_kp", "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", ttl=30 * MIN)
    fc, p2 = fetch_raw("swpc", "swpc_kp_fc", "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json", ttl=30 * MIN)
    fx, p3 = fetch_raw("swpc", "swpc_f107", "https://services.swpc.noaa.gov/json/f107_cm_flux.json", ttl=3 * HOUR)

    def rows(raw):
        d = json.loads(raw)
        if d and isinstance(d[0], list):  # older array format with header row
            hdr = [h.lower() for h in d[0]]
            d = [dict(zip(hdr, r)) for r in d[1:]]
        return d

    kp_rows = [{"t": r.get("time_tag"), "kp": float(r.get("Kp", r.get("kp")) or 0)} for r in rows(kp)]
    fc_rows = [{"t": r.get("time_tag"), "kp": float(r.get("kp") or 0), "kind": r.get("observed")} for r in rows(fc)]
    flux = sorted([{"t": r["time_tag"], "flux": float(r["flux"])} for r in rows(fx) if r.get("flux")], key=lambda r: r["t"])
    return {"kp": kp_rows[-56:], "forecast": [r for r in fc_rows if r["kind"] != "observed"],
            "f107": flux[-60:]}, worst(p1, p2, p3)


def spaceweather():
    return cached_result("spaceweather", 30 * MIN, _build_spaceweather)
