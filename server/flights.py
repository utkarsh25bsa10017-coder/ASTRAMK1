"""
ASTRA Flights: live ADS-B aircraft, flight routes, track history, and a route safety + delay model.

Sources (all free, no key):
  adsb.fi open data      live aircraft within 250 NM of a point, with ICAO type codes (1 request/s)
  OpenSky Network        wide-area state vectors (fallback/overview) and the track flown so far
  adsbdb                 callsign -> origin/destination airports, aircraft registry and photo
  OurAirports            airport positions and runway headings (data/snapshots/airports.json)
  Open-Meteo             weather along the route: CAPE, rain, visibility, surface and jet-level winds
  ASTRA feeds            GDACS/EONET/SACHET alerts (cyclones, volcanic ash), NCS/USGS quakes, NOAA Kp
"""
from __future__ import annotations

import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import gateway
from gateway import CACHE_DIR, SNAP_DIR, SourceUnavailable, _safe, cached_result, fetch_raw, worst

MIN, HOUR, DAY = 60, 3600, 86400
NM = 1.852            # km per nautical mile
FT = 0.3048           # m per foot

# ---------------------------------------------------------------------------
# Airports
# ---------------------------------------------------------------------------
_AIRPORTS = None
_AP_INDEX: dict[str, list] = {}


def _airports():
    global _AIRPORTS
    if _AIRPORTS is None:
        d = json.loads((SNAP_DIR / "airports.json").read_text())
        _AIRPORTS = d
        for a in d["airports"]:
            _AP_INDEX.setdefault(a[0].upper(), a)
            _AP_INDEX.setdefault(a[1].upper(), a)
    return _AIRPORTS


def airports():
    return _airports(), "cache"


def airport(code):
    _airports()
    a = _AP_INDEX.get((code or "").strip().upper())
    if not a:
        return None
    return {"icao": a[0], "iata": a[1], "name": a[2], "city": a[3], "country": a[4], "lat": a[5], "lon": a[6],
            "elev_ft": a[7], "size": a[8], "runways": a[9]}


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def hav_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1, math.sqrt(a)))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def gc_point(lat1, lon1, lat2, lon2, f):
    """Point a fraction f along the great circle."""
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = 2 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2))
    if d < 1e-9:
        return lat1, lon1
    a, b = math.sin((1 - f) * d) / math.sin(d), math.sin(f * d) / math.sin(d)
    x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
    y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
    z = a * math.sin(p1) + b * math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def _seg_dist_km(lat, lon, path):
    """Shortest distance from a point to a polyline of (lat, lon) samples (sampled densely enough)."""
    return min(hav_km(lat, lon, p[0], p[1]) for p in path)


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------
# Live aircraft
# ---------------------------------------------------------------------------
# Fixed grid of query cells: 5° of latitude x 6° of longitude. A 250 NM (463 km) circle at each cell centre covers the
# whole cell up to about 40° latitude, so the browser can ask for exactly the cells in view and share the cache.
CELL_DLAT, CELL_DLON, CELL_R_NM = 5.0, 6.0, 250


def snap_cell(lat, lon):
    la = math.floor(float(lat) / CELL_DLAT) * CELL_DLAT + CELL_DLAT / 2
    lo = math.floor(float(lon) / CELL_DLON) * CELL_DLON + CELL_DLON / 2
    return round(la, 2), round(((lo + 180) % 360) - 180, 2)


# adsb.fi allows one request per second from an address; space our calls out so several cells in a row never 429.
_rate_lock = threading.Lock()
_rate_last = {"fi": 0.0}


def _wait_turn(host, spacing=1.1, max_wait=8.0):
    with _rate_lock:
        now = time.time()
        slot = max(now, _rate_last[host] + spacing)
        if slot - now > max_wait:
            return False
        _rate_last[host] = slot
    time.sleep(max(0.0, slot - time.time()))
    return True


def _fresh(key, ttl):
    p = CACHE_DIR / ("raw_" + _safe(key))
    return p.exists() and time.time() - p.stat().st_mtime < ttl


FLAG_GND, FLAG_MIL, FLAG_EMERG, FLAG_MLAT = 1, 2, 4, 8
FIELDS = ["hex", "flight", "reg", "type", "cat", "lat", "lon", "alt_ft", "gs_kt", "track", "vrate_fpm", "squawk",
          "flags", "seen_s", "desc", "alt_geom_ft"]


def _slim_readsb(a, now):
    if a.get("lat") is None or a.get("lon") is None:
        return None
    alt = a.get("alt_baro")
    gnd = alt == "ground"
    flags = (FLAG_GND if gnd else 0) | (FLAG_MIL if (a.get("dbFlags") or 0) & 1 else 0)
    if a.get("emergency") not in (None, "none") or a.get("squawk") in ("7500", "7600", "7700"):
        flags |= FLAG_EMERG
    if a.get("mlat") or a.get("tisb") or str(a.get("type", "")).startswith(("mlat", "tisb")):
        flags |= FLAG_MLAT
    track = a.get("track", a.get("true_heading", a.get("mag_heading")))
    return [a.get("hex", "").lower(), (a.get("flight") or "").strip(), a.get("r") or "", a.get("t") or "",
            a.get("category") or "", round(a["lat"], 5), round(a["lon"], 5),
            0 if gnd else (alt if isinstance(alt, (int, float)) else None),
            round(a["gs"], 1) if isinstance(a.get("gs"), (int, float)) else None,
            round(track, 1) if isinstance(track, (int, float)) else None,
            a.get("baro_rate", a.get("geom_rate")), a.get("squawk") or "", flags,
            round(a.get("seen_pos", a.get("seen", 0)) or 0, 1), a.get("desc") or "",
            a.get("alt_geom") if isinstance(a.get("alt_geom"), (int, float)) else None]


OPENSKY_CAT = {2: "A1", 3: "A2", 4: "A3", 5: "A4", 6: "A5", 7: "A6", 8: "A7", 9: "B1", 10: "B2", 11: "B3",
               12: "B4", 14: "B6", 15: "B7", 16: "C1", 17: "C2", 18: "C3"}


def _slim_opensky(s, now):
    if s[5] is None or s[6] is None:
        return None
    gnd = bool(s[8])
    alt = 0 if gnd else (round(s[7] / FT) if s[7] is not None else None)
    flags = (FLAG_GND if gnd else 0) | (FLAG_EMERG if s[14] in ("7500", "7600", "7700") else 0)
    if len(s) > 16 and s[16] == 2:
        flags |= FLAG_MLAT
    cat = OPENSKY_CAT.get(s[17], "") if len(s) > 17 else ""
    return [s[0], (s[1] or "").strip(), "", "", cat, round(s[6], 5), round(s[5], 5), alt,
            round(s[9] * 3600 / 1852, 1) if s[9] is not None else None,
            round(s[10], 1) if s[10] is not None else None,
            round(s[11] / FT * 60) if s[11] is not None else None, s[14] or "", flags,
            round(max(0, now - (s[3] or s[4] or now)), 1), "",
            round(s[13] / FT) if s[13] is not None else None]


def _cell_build(lat, lon):
    key = f"flt_fi_{lat}_{lon}"
    now = time.time()
    if not _fresh(key, 10):
        _wait_turn("fi")
    try:
        raw, prov = fetch_raw("adsbfi", key, f"https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{CELL_R_NM}",
                              ttl=10, timeout=12)
        d = json.loads(raw)
        rows = d.get("aircraft") or d.get("ac") or []
        src = "adsb.fi"
        t = d.get("now") or now
        t = t / 1000 if t > 1e11 else t
    except (SourceUnavailable, ValueError):
        # Fallback: OpenSky for the cell's box (costs 2 of the 400 daily anonymous credits).
        s, n, w, e = lat - CELL_DLAT / 2, lat + CELL_DLAT / 2, lon - CELL_DLON / 2, lon + CELL_DLON / 2
        raw, prov = fetch_raw("opensky", f"flt_os_{lat}_{lon}",
                              f"https://opensky-network.org/api/states/all?lamin={s}&lomin={w}&lamax={n}&lomax={e}&extended=1",
                              ttl=60, timeout=15)
        d = json.loads(raw)
        return {"cell": [lat, lon], "time": d.get("time") or now, "source": "OpenSky",
                "fields": FIELDS, "ac": [r for r in (_slim_opensky(x, now) for x in d.get("states") or []) if r]}, prov
    return {"cell": [lat, lon], "time": t, "source": src, "fields": FIELDS,
            "ac": [r for r in (_slim_readsb(a, now) for a in rows) if r]}, prov


def cell(lat, lon):
    if lat is None or lon is None:
        raise ValueError("lat and lon are required")
    la, lo = snap_cell(lat, lon)
    if not (-75 <= la <= 80):
        raise ValueError("cell out of range")
    return cached_result(f"flights_cell_{la}_{lo}", 9, lambda: _cell_build(la, lo))


# Wide-area overview for the first paint: one OpenSky call over India and its neighbourhood (4 credits), 4 min cache.
WIDE = (4.0, 64.0, 40.0, 100.0)


def _wide_build():
    s, w, n, e = WIDE
    raw, prov = fetch_raw("opensky", "flt_os_wide",
                          f"https://opensky-network.org/api/states/all?lamin={s}&lomin={w}&lamax={n}&lomax={e}&extended=1",
                          ttl=4 * MIN, timeout=20)
    d = json.loads(raw)
    now = time.time()
    return {"box": [s, w, n, e], "time": d.get("time") or now, "source": "OpenSky", "fields": FIELDS,
            "ac": [r for r in (_slim_opensky(x, now) for x in d.get("states") or []) if r]}, prov


def wide():
    return cached_result("flights_wide", 4 * MIN, _wide_build)


# ---------------------------------------------------------------------------
# Routes, registry, track
# ---------------------------------------------------------------------------
def _json_or_none(source, key, url, ttl, timeout=12):
    """fetch_raw that remembers 404 answers as None, so unknown callsigns are not asked for again for a while."""
    neg = CACHE_DIR / ("raw_" + _safe(key) + ".404")
    if neg.exists() and time.time() - neg.stat().st_mtime < ttl:
        return None, "cache"
    try:
        raw, prov = fetch_raw(source, key, url, ttl=ttl, timeout=timeout)
        return json.loads(raw), prov
    except SourceUnavailable as e:
        if "404" in str(e):
            neg.write_text("")
            return None, "live"
        raise


def _ap_from_adsbdb(a):
    if not a:
        return None
    local = airport(a.get("icao_code")) or airport(a.get("iata_code")) or {}
    return {"icao": a.get("icao_code"), "iata": a.get("iata_code"), "name": a.get("name"),
            "city": a.get("municipality"), "country": a.get("country_iso_name"),
            "lat": a.get("latitude"), "lon": a.get("longitude"), "elev_ft": a.get("elevation"),
            "runways": local.get("runways", [])}


def route_for(callsign):
    cs = "".join(c for c in (callsign or "").upper() if c.isalnum())
    if len(cs) < 3:
        return None, "live"
    d, prov = _json_or_none("adsbdb", f"adsbdb_cs_{cs}", f"https://api.adsbdb.com/v0/callsign/{cs}", ttl=3 * DAY)
    fr = ((d or {}).get("response") or {}).get("flightroute") if isinstance((d or {}).get("response"), dict) else None
    if not fr:
        return None, prov
    al = fr.get("airline") or {}
    o, dst = _ap_from_adsbdb(fr.get("origin")), _ap_from_adsbdb(fr.get("destination"))
    out = {"callsign": cs, "iata": fr.get("callsign_iata"), "airline": al.get("name"), "airline_icao": al.get("icao"),
           "airline_iata": al.get("iata"), "airline_country": al.get("country"), "origin": o, "destination": dst,
           "midpoint": _ap_from_adsbdb(fr.get("midpoint"))}
    if o and dst and o.get("lat") is not None and dst.get("lat") is not None:
        out["distance_km"] = round(hav_km(o["lat"], o["lon"], dst["lat"], dst["lon"]))
    return out, prov


def routes(callsigns):
    cs = [c for c in dict.fromkeys((callsigns or "").upper().split(",")) if c.strip()][:40]
    out, provs = {}, []

    def one(c):
        try:
            r, p = route_for(c)
            return c, r, p
        except SourceUnavailable:
            return c, None, "stale"
    with ThreadPoolExecutor(max_workers=4) as ex:
        for c, r, p in ex.map(one, cs):
            out[c] = r
            provs.append(p)
    return {"routes": out}, worst(*provs)


def aircraft_info(hexid):
    h = "".join(c for c in (hexid or "").lower() if c in "0123456789abcdef")[:6]
    if len(h) != 6:
        return None, "live"
    d, prov = _json_or_none("adsbdb", f"adsbdb_ac_{h}", f"https://api.adsbdb.com/v0/aircraft/{h}", ttl=30 * DAY)
    ac = ((d or {}).get("response") or {}).get("aircraft") if isinstance((d or {}).get("response"), dict) else None
    if not ac:
        return None, prov
    return {"type": ac.get("type"), "icao_type": ac.get("icao_type"), "manufacturer": ac.get("manufacturer"),
            "registration": ac.get("registration"), "owner": ac.get("registered_owner"),
            "owner_country": ac.get("registered_owner_country_name"),
            "photo": ac.get("url_photo_thumbnail") or ac.get("url_photo"), "photo_full": ac.get("url_photo")}, prov


def track(hexid):
    h = "".join(c for c in (hexid or "").lower() if c in "0123456789abcdef")[:6]
    if len(h) != 6:
        return None, "live"
    d, prov = _json_or_none("opensky", f"os_track_{h}", f"https://opensky-network.org/api/tracks/all?icao24={h}&time=0",
                            ttl=90, timeout=15)
    if not d or not d.get("path"):
        return None, prov
    # [t, lat, lon, alt_ft, track, on_ground]
    path = [[int(p[0]), round(p[1], 5), round(p[2], 5), round(p[3] / FT) if p[3] is not None else None,
             p[4], bool(p[5])] for p in d["path"] if p[1] is not None]
    return {"start": d.get("startTime"), "end": d.get("endTime"), "callsign": (d.get("callsign") or "").strip(),
            "path": path}, prov


def info(hexid, callsign):
    jobs = {"route": lambda: route_for(callsign), "aircraft": lambda: aircraft_info(hexid), "track": lambda: track(hexid)}
    out, provs = {}, []
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {k: ex.submit(f) for k, f in jobs.items()}
        for k, f in futs.items():
            try:
                out[k], p = f.result()
                provs.append(p)
            except SourceUnavailable as e:
                out[k] = None
                out.setdefault("errors", {})[k] = str(e)[:160]
    return out, worst(*provs) if provs else "stale"


# ---------------------------------------------------------------------------
# Route safety and delay model
# ---------------------------------------------------------------------------
GRADES = [(85, "A", "Low risk"), (70, "B", "Minor risk"), (50, "C", "Caution"), (30, "D", "High risk"), (0, "E", "Severe")]
# Congestion priors: share of departures delayed by airport tier (DGCA/airport on-time statistics are in this range;
# these are coarse priors, refined below by live traffic and weather).
HUB_BASE = {"VIDP": 9, "VABB": 9, "VOBL": 6, "VOHS": 5, "VOMM": 5, "VECC": 5, "VAAH": 4, "VOCI": 3, "VAPO": 4, "VOGO": 3,
            "VOGA": 3, "VILK": 3, "VAJJ": 3, "VEGT": 3, "VIJP": 3, "VOTV": 2, "OMDB": 8, "OTHH": 5, "WSSS": 5, "VTBS": 7,
            "EGLL": 10, "KJFK": 11, "LFPG": 9, "EDDF": 8, "OMAA": 5, "OEJN": 5, "VHHH": 6, "RJTT": 5}
WMO_TS = {95, 96, 99}
WMO_FOG = {45, 48}
WMO_HEAVY = {65, 67, 75, 82, 86}
WMO_SNOW = {71, 73, 75, 77, 85, 86}
CRUISE_KT = 450       # typical jet true airspeed at cruise


def _grade(score):
    for lo, g, label in GRADES:
        if score >= lo:
            return g, label
    return "E", "Severe"


def _hour_index(times, t):
    key = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:00")
    for i, s in enumerate(times):
        if s >= key:
            return i
    return len(times) - 1


def _wind_uv(spd, deg):
    """Meteorological wind (direction it blows FROM) to u (east), v (north) components."""
    r = math.radians(deg or 0)
    return -(spd or 0) * math.sin(r), -(spd or 0) * math.cos(r)


def _weather_along(points, dep_t):
    lats = ",".join(f"{p['lat']:.2f}" for p in points)
    lons = ",".join(f"{p['lon']:.2f}" for p in points)
    url = ("https://api.open-meteo.com/v1/forecast?latitude=" + lats + "&longitude=" + lons +
           "&hourly=cape,precipitation,weather_code,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,"
           "cloud_cover_low,temperature_2m,wind_speed_200hPa,wind_direction_200hPa,wind_speed_250hPa,"
           "wind_direction_250hPa,wind_speed_300hPa,wind_direction_300hPa"
           "&wind_speed_unit=kn&forecast_days=3&timezone=GMT")
    raw, prov = fetch_raw("openmeteo", "fl_wx_" + str(abs(hash(lats + lons)) % 10**12), url, ttl=45 * MIN, timeout=25)
    d = json.loads(raw)
    return (d if isinstance(d, list) else [d]), prov


def _airport_wx(h, i, ap):
    """Weather at an airport at hour index i -> metrics + runway crosswind."""
    g = lambda k: (h.get(k) or [None] * (i + 1))[i]
    wspd, wdir, gust = g("wind_speed_10m") or 0, g("wind_direction_10m") or 0, g("wind_gusts_10m") or 0
    vis = g("visibility")
    xw_best, rwy = None, None
    for hdg, length in (ap.get("runways") or []):
        for end in (hdg, (hdg + 180) % 360):
            ang = math.radians(wdir - end)
            head = gust * math.cos(ang)
            cross = abs(gust * math.sin(ang))
            if head > -10 and (xw_best is None or cross < xw_best):   # avoid >10 kt tailwind ends
                xw_best, rwy = cross, int(round(end / 10)) or 36
    return {"vis_m": vis, "wind_kt": wspd, "wind_dir": wdir, "gust_kt": gust, "cape": g("cape") or 0,
            "precip_mm": g("precipitation") or 0, "code": g("weather_code") or 0, "low_cloud": g("cloud_cover_low") or 0,
            "temp_c": g("temperature_2m"), "crosswind_kt": round(xw_best, 1) if xw_best is not None else None,
            "runway": f"{rwy:02d}" if rwy else None}


def _airport_risk(w, ap, phase):
    """0..1 hazard and delay minutes for one airport (phase = dep|arr)."""
    risk, delay, notes = 0.0, 0.0, []
    vis = w["vis_m"] if w["vis_m"] is not None else 10000
    if vis < 200:
        risk, delay = max(risk, 0.75), delay + (75 if phase == "dep" else 55)
        notes.append(f"Dense fog: visibility {vis:.0f} m (CAT III approaches only)")
    elif vis < 550:
        risk, delay = max(risk, 0.5), delay + (35 if phase == "dep" else 30)
        notes.append(f"Fog: visibility {vis:.0f} m, low-visibility procedures likely")
    elif vis < 1500:
        risk, delay = max(risk, 0.25), delay + 10
        notes.append(f"Poor visibility {vis / 1000:.1f} km")
    if w["code"] in WMO_TS or w["cape"] > 1500 and w["precip_mm"] > 1:
        risk, delay = max(risk, 0.65), delay + (30 if phase == "dep" else 25)
        notes.append("Thunderstorm risk at the airport (windshear, ground stop possible)")
    elif w["precip_mm"] > 4 or w["code"] in WMO_HEAVY:
        risk, delay = max(risk, 0.35), delay + 10
        notes.append(f"Heavy rain {w['precip_mm']:.1f} mm/h")
    if w["code"] in WMO_SNOW:
        risk, delay = max(risk, 0.5), delay + 25
        notes.append("Snow: de-icing and runway clearing")
    xw = w["crosswind_kt"]
    if xw is not None and xw > 15:
        risk = max(risk, _clamp((xw - 15) / 20) * 0.8)
        delay += _clamp((xw - 15) / 15) * 15
        notes.append(f"Gusty crosswind {xw:.0f} kt on runway {w['runway']}")
    elif w["gust_kt"] > 35:
        risk, delay = max(risk, 0.4), delay + 8
        notes.append(f"Gusts {w['gust_kt']:.0f} kt")
    elev = ap.get("elev_ft") or 0
    if elev > 5000 and w["temp_c"] is not None:
        isa = 15 - 1.98 * elev / 1000
        da = elev + 120 * (w["temp_c"] - isa)
        if da > 8000:
            risk = max(risk, _clamp((da - 8000) / 6000) * 0.5)
            notes.append(f"High-altitude airport: density altitude about {da:,.0f} ft (payload limits)")
        if elev > 9000:
            risk = max(risk, 0.3)
            notes.append("Mountain airfield: tight terrain, weather-sensitive schedule")
    return risk, delay, notes


def _traffic_near(ap):
    """Aircraft within 45 km and below 12,000 ft of an airport, from the live cell cache (or one fresh fetch)."""
    try:
        d, _ = cell(ap["lat"], ap["lon"])
    except Exception:
        return None
    n = 0
    for a in d.get("ac", []):
        alt = a[7]
        if alt is not None and alt < 12000 and hav_km(ap["lat"], ap["lon"], a[5], a[6]) < 45:
            n += 1
    return n


def _alerts_near(path, kinds_radius):
    """Disaster alerts within a radius of the route. kinds_radius: {type: km}."""
    try:
        import sources
        al, prov = sources.alerts()
    except Exception:
        return [], "stale"
    hits = []
    for a in al.get("alerts", []):
        r = kinds_radius.get(a.get("type"))
        if not r or a.get("lat") is None:
            continue
        if a.get("source") == "gdacs" and not (a.get("gdacs") or {}).get("current", True):
            continue
        dmin = _seg_dist_km(a["lat"], a["lon"], path)
        if dmin <= r:
            hits.append({"id": a.get("id"), "type": a["type"], "title": a.get("title"), "severity": a.get("severity") or 0,
                         "lat": a["lat"], "lon": a["lon"], "km": round(dmin), "source": a.get("source")})
    hits.sort(key=lambda x: (-x["severity"], x["km"]))
    return hits[:12], prov


def _quakes_near(ap_list):
    try:
        import hazard
        q, _ = hazard.earthquakes()
    except Exception:
        return []
    cutoff = time.time() - 2 * DAY
    out = []
    for e in q.get("events", q if isinstance(q, list) else []):
        try:
            t = datetime.fromisoformat(str(e.get("time")).replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        if t < cutoff or (e.get("mag") or 0) < 5:
            continue
        for ap in ap_list:
            d = hav_km(ap["lat"], ap["lon"], e["lat"], e["lon"])
            if d < 150:
                out.append({"airport": ap["iata"] or ap["icao"], "mag": e["mag"], "km": round(d), "place": e.get("place")})
    return out


def _kp_now():
    try:
        import sources
        sw, _ = sources.spaceweather()
        return max((r["kp"] for r in sw["kp"][-3:]), default=None), max((r["kp"] for r in sw.get("forecast", [])[:8]), default=None)
    except Exception:
        return None, None


def assess(frm, to, dep=None, hexid=None, lat=None, lon=None, alt=None, gs=None, start=None):
    o, d = airport(frm), airport(to)
    if not o or not d:
        raise ValueError("unknown airport code (use ICAO like VIDP or IATA like DEL)")
    if o["icao"] == d["icao"]:
        raise ValueError("origin and destination are the same")
    now = time.time()
    dep_t = float(dep) if dep else now
    dist = hav_km(o["lat"], o["lon"], d["lat"], d["lon"])
    live = lat is not None and lon is not None
    hour = int(dep_t // HOUR)
    key = f"flroute3_{o['icao']}_{d['icao']}_{hour}"
    base, prov = cached_result(key, 30 * MIN, lambda: (_route_core(o, d, dist, dep_t), "live"))
    out = json.loads(json.dumps(base))
    out["provenance"] = prov
    if live:
        out["live"] = _live_eta(out, o, d, dist, float(lat), float(lon), alt, gs, start, now)
    return out, prov


def _route_core(o, d, dist, dep_t):
    n = max(6, min(26, int(dist / 160) + 2))
    pts = []
    for i in range(n):
        f = i / (n - 1)
        la, lo = gc_point(o["lat"], o["lon"], d["lat"], d["lon"], f)
        pts.append({"lat": round(la, 3), "lon": round(lo, 3), "f": round(f, 4), "km": round(dist * f)})
    wx, wprov = _weather_along(pts, dep_t)
    block_min = _typical_block(dist)
    air_min = block_min - 25
    # sample hazards at the time the aircraft would be over each point
    tail = []
    seg = []
    for i, p in enumerate(pts):
        w = wx[i] if i < len(wx) else wx[-1]
        h = w["hourly"]
        t_here = dep_t + 15 * MIN + air_min * 60 * p["f"]
        k = _hour_index(h["time"], t_here)
        g = lambda name: (h.get(name) or [0] * (k + 1))[k] or 0
        cape, pr, code = g("cape"), g("precipitation"), int(g("weather_code"))
        conv = _clamp((cape - 400) / 2600) * 0.55 + (0.45 if code in WMO_TS else 0) + _clamp(pr / 10) * 0.25
        u2, v2 = _wind_uv(g("wind_speed_200hPa"), g("wind_direction_200hPa"))
        u3, v3 = _wind_uv(g("wind_speed_300hPa"), g("wind_direction_300hPa"))
        shear_kt = math.hypot(u2 - u3, v2 - v3)          # over roughly 2.6 km (300 -> 200 hPa)
        vws = shear_kt * 0.5144 / 2.6                    # m/s per km
        jet = g("wind_speed_250hPa")
        turb = _clamp((vws - 4.5) / 8) * 0.85 + _clamp((jet - 110) / 80) * 0.25
        terrain_m = w.get("elevation") or 0
        terr = _clamp((terrain_m - 2500) / 4500) * 0.45
        # along-track wind at cruise (positive = tailwind)
        crs = bearing(p["lat"], p["lon"], d["lat"], d["lon"]) if i < n - 1 else bearing(pts[i - 1]["lat"], pts[i - 1]["lon"], p["lat"], p["lon"])
        u, v = _wind_uv(jet, g("wind_direction_250hPa"))
        along = u * math.sin(math.radians(crs)) + v * math.cos(math.radians(crs))
        tail.append(along)
        seg.append({**p, "conv": round(_clamp(conv), 3), "turb": round(_clamp(turb), 3), "terrain_m": round(terrain_m),
                    "terr": round(terr, 3), "cape": round(cape), "precip": round(pr, 1), "code": code,
                    "jet_kt": round(jet), "shear": round(vws, 1), "wind_along_kt": round(along), "eta": int(t_here)})

    path = [(p["lat"], p["lon"]) for p in pts]
    # densify for proximity checks
    dense = [gc_point(o["lat"], o["lon"], d["lat"], d["lon"], j / 120) for j in range(121)]
    alerts, aprov = _alerts_near(dense, {"cyclone": 350, "volcano": 400, "wildfire": 60, "wind": 120, "rain": 60,
                                         "earthquake": 0})
    volc = [a for a in alerts if a["type"] == "volcano"]
    cyc = [a for a in alerts if a["type"] == "cyclone"]
    for s in seg:
        s["alert"] = 0.0
        for a in alerts:
            dk = hav_km(s["lat"], s["lon"], a["lat"], a["lon"])
            if a["type"] == "volcano" and dk < 400:
                s["alert"] = max(s["alert"], (0.9 if dk < 150 else 0.6) * (0.6 + 0.4 * a["severity"] / 3))
            elif a["type"] == "cyclone" and dk < 350:
                s["alert"] = max(s["alert"], (0.85 if dk < 150 else 0.5) * (0.5 + 0.5 * a["severity"] / 3))
            elif a["type"] in ("wind", "rain") and dk < 120:
                s["alert"] = max(s["alert"], 0.1 + 0.08 * a["severity"])
            elif a["type"] == "wildfire" and dk < 60:
                s["alert"] = max(s["alert"], 0.2)
        s["alert"] = round(min(1.0, s["alert"]), 3)

    kp, kp_fc = _kp_now()
    kp_use = max(kp or 0, kp_fc or 0)
    maxlat = max(abs(p["lat"]) for p in pts)
    sw = _clamp((kp_use - 4) / 4) * (0.35 + 0.65 * _clamp((maxlat - 45) / 25))
    for s in seg:
        s["space"] = round(_clamp((kp_use - 4) / 4) * (0.35 + 0.65 * _clamp((abs(s["lat"]) - 45) / 25)), 3)

    # airports: weather at departure time and at arrival time
    i_dep = _hour_index(wx[0]["hourly"]["time"], dep_t)
    arr_t = dep_t + block_min * 60
    i_arr = _hour_index(wx[-1]["hourly"]["time"], arr_t)
    wdep, warr = _airport_wx(wx[0]["hourly"], i_dep, o), _airport_wx(wx[-1]["hourly"], i_arr, d)
    r_dep, dl_dep, n_dep = _airport_risk(wdep, o, "dep")
    r_arr, dl_arr, n_arr = _airport_risk(warr, d, "arr")
    seg[0]["airport"] = round(r_dep, 3)
    seg[-1]["airport"] = round(r_arr, 3)
    quakes = _quakes_near([o, d])
    for q in quakes:
        idx = 0 if q["airport"] in (o["iata"], o["icao"]) else -1
        seg[idx]["airport"] = max(seg[idx].get("airport", 0), 0.45 if q["mag"] >= 6 else 0.25)

    # per-segment combined risk (top factor plus a share of the next two)
    for s in seg:
        f = sorted([s["conv"], s["turb"], s["terr"], s["alert"], s["space"], s.get("airport", 0)], reverse=True)
        s["risk"] = round(_clamp(f[0] + 0.2 * f[1] + 0.1 * f[2]), 3)
        s["score"] = round(100 * (1 - s["risk"]))

    factors = {
        "convection": max(s["conv"] for s in seg), "turbulence": max(s["turb"] for s in seg),
        "terrain": max(s["terr"] for s in seg), "alerts": max(s["alert"] for s in seg), "space_weather": sw,
        "departure": r_dep, "arrival": r_arr,
    }
    worst_risk = max(s["risk"] for s in seg)
    mean_risk = sum(s["risk"] for s in seg) / len(seg)
    safety = round(100 * (1 - _clamp(0.6 * worst_risk + 0.25 * mean_risk)))
    grade, label = _grade(safety)

    # ----- delay model -----
    dep_local_h = (datetime.fromtimestamp(dep_t, timezone.utc) + timedelta(hours=_tz_guess(o["lon"]))).hour
    arr_local_h = (datetime.fromtimestamp(arr_t, timezone.utc) + timedelta(hours=_tz_guess(d["lon"]))).hour
    peak = lambda h: 1.0 if h in (6, 7, 8, 9, 18, 19, 20, 21) else 0.5 if h in (10, 11, 17, 22) else 0.0
    traffic_o, traffic_d = _traffic_near(o), _traffic_near(d)
    comp = []
    comp.append(("Airport congestion (typical)", HUB_BASE.get(o["icao"], 2) * 0.6 + HUB_BASE.get(d["icao"], 2) * 0.4))
    comp.append(("Time of day (banks)", 3 * peak(dep_local_h) + 2 * peak(arr_local_h)))
    if traffic_o is not None or traffic_d is not None:
        live_c = min(8, _excess_traffic(o, traffic_o)) + min(10, 1.3 * _excess_traffic(d, traffic_d))
        comp.append(("Live traffic near airports", live_c))
    comp.append((f"Departure weather ({o['iata'] or o['icao']})", dl_dep))
    comp.append((f"Arrival weather ({d['iata'] or d['icao']})", dl_arr))
    comp.append(("En-route storms (deviations)", 22 * factors["convection"] ** 1.3))
    if factors["alerts"] > 0.5:
        comp.append(("Cyclone or volcanic-ash rerouting", 30 * factors["alerts"]))
    mean_tail = sum(tail) / len(tail) if tail else 0
    cruise_km = max(0, dist - 250)
    wind_min = (cruise_km / NM) / CRUISE_KT * 60 - (cruise_km / NM) / max(250, CRUISE_KT + mean_tail) * 60
    comp.append(("Jet-stream wind vs schedule", max(-10, min(15, -0.3 * wind_min))))
    exp_delay = max(0.0, sum(c[1] for c in comp))
    # Delays are right-skewed: treat the delay as exponential with this mean, so P(>15) = exp(-15 / mean)
    p15 = math.exp(-15 / exp_delay) if exp_delay > 0.5 else 0.0
    p_cancel = _clamp(0.004 + 0.25 * max(r_dep, r_arr) ** 3 + 0.2 * factors["alerts"] ** 3, 0, 0.6)
    notes = n_dep + n_arr
    if factors["convection"] > 0.45:
        notes.append("Thunderstorms forecast along the route: expect weather deviations and a bumpy ride")
    if factors["turbulence"] > 0.25:
        s = max(seg, key=lambda x: x["turb"])
        notes.append(f"Clear-air turbulence likely near {s['lat']:.1f}, {s['lon']:.1f} (jet {s['jet_kt']} kt, shear {s['shear']} m/s per km)")
    if factors["terrain"] > 0.2:
        notes.append("Route crosses high terrain (Himalaya or similar): depressurisation escape routes needed")
    for a in volc[:2]:
        notes.append(f"Volcanic activity {a['km']} km from the route: {_short(a['title'])}")
    for a in cyc[:2]:
        notes.append(f"Cyclone {a['km']} km from the route: {_short(a['title'])}")
    wx_al = [a for a in alerts if a["type"] in ("wind", "rain") and a["km"] <= 120]
    if wx_al:
        notes.append(f"{len(wx_al)} official wind/rain warning{'s' if len(wx_al) > 1 else ''} near the route, e.g. {_short(wx_al[0]['title'])}")
    if factors["convection"] > 0.2 and factors["convection"] <= 0.45:
        notes.append("Isolated showers or build-ups possible en route")
    if sw > 0.15:
        notes.append(f"Geomagnetic storm (Kp {kp_use:.0f}): HF radio and GNSS (incl. NavIC/GPS) accuracy may degrade")
    for q in quakes:
        notes.append(f"M{q['mag']:.1f} earthquake {q['km']} km from {q['airport']} in the last 48 h: runway inspections possible")
    if not notes:
        notes.append("No significant hazards on this route for the planned time")

    return {
        "origin": o, "destination": d, "distance_km": round(dist), "distance_nm": round(dist / NM),
        "bearing": round(bearing(o["lat"], o["lon"], d["lat"], d["lon"])),
        "typical_block_min": round(block_min), "typical_cruise_ft": _typical_cruise(dist),
        "dep_time": int(dep_t), "arr_time_typical": int(arr_t),
        "safety": {"score": safety, "grade": grade, "label": label,
                   "factors": {k: round(v, 3) for k, v in factors.items()}, "notes": notes},
        "delay": {"expected_min": round(exp_delay), "p_late15": round(p15, 3), "p_cancel": round(p_cancel, 3),
                  "on_time_pct": round(100 * (1 - p15)), "components": [[k, round(v, 1)] for k, v in comp],
                  "traffic": {"origin": traffic_o, "destination": traffic_d},
                  "wind_effect_min": round(-wind_min, 1), "mean_tailwind_kt": round(mean_tail)},
        "weather": {"departure": wdep, "arrival": warr},
        "alerts": alerts, "quakes": quakes, "kp": kp, "kp_forecast_max": kp_fc,
        "segments": seg, "generated": int(time.time()), "wx_provenance": worst(wprov, aprov),
        "method": METHOD,
    }


def _short(t, n=120):
    t = " ".join(str(t or "").split())
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + "…"


def _excess_traffic(ap, n):
    """Low-level aircraft near an airport above what is normal for it (busier hubs have a higher normal)."""
    if n is None:
        return 0.0
    normal = 6 + 2.5 * HUB_BASE.get(ap["icao"], 2)
    return max(0.0, n - normal) * 0.6


def _tz_guess(lon):
    # Good enough for local hour-of-day: India and neighbours use their civil offsets.
    if 68 <= lon <= 97.5:
        return 5.5
    return round(lon / 15)


def _typical_block(dist_km):
    """Gate-to-gate minutes for a jet: taxi 25 min + climb/descent allowance + cruise at ~450 kt."""
    nm = dist_km / NM
    return 25 + 18 + max(0, nm - 120) / CRUISE_KT * 60 + min(nm, 120) / 300 * 60


def _typical_cruise(dist_km):
    if dist_km < 350:
        return 24000
    if dist_km < 700:
        return 33000
    if dist_km < 3000:
        return 37000
    return 39000


def _live_eta(r, o, d, dist, lat, lon, alt, gs, start, now):
    rem = hav_km(lat, lon, d["lat"], d["lon"])
    flown = hav_km(o["lat"], o["lon"], lat, lon)
    gs = float(gs) if gs not in (None, "", "null") else None
    alt = float(alt) if alt not in (None, "", "null") else None
    # remaining air time: cruise leg at current ground speed, then ~ 3 NM per 1000 ft descent at ~280 kt
    descent_nm = max(20, (alt or 30000) / 1000 * 3)
    rem_nm = rem / NM
    if gs and gs > 120:
        cruise_part = max(0, rem_nm - descent_nm) / gs * 60
        desc_part = min(rem_nm, descent_nm) / 280 * 60
    else:
        cruise_part, desc_part = rem_nm / 420 * 60, 0
    arr_wx_delay = next((c[1] for c in r["delay"]["components"] if c[0].startswith("Arrival weather")), 0)
    traffic_d = r["delay"]["traffic"].get("destination") or 0
    holding = arr_wx_delay * 0.8 + min(12, _excess_traffic(d, traffic_d) * 1.5)
    eta = now + (cruise_part + desc_part + holding + 6) * 60     # + taxi-in
    out = {"remaining_km": round(rem), "flown_km": round(flown), "progress": round(_clamp(flown / max(1, flown + rem)), 3),
           "eta": int(eta), "holding_min": round(holding), "descent_nm": round(descent_nm)}
    # off-track distance from the great-circle (usual) route
    dense = [gc_point(o["lat"], o["lon"], d["lat"], d["lon"], j / 200) for j in range(201)]
    out["off_route_km"] = round(_seg_dist_km(lat, lon, dense), 1)
    if start:
        start = float(start)
        if now - start < 20 * HOUR:
            typical_arr = start - 15 * 60 + r["typical_block_min"] * 60   # track starts at take-off, block includes taxi-out
            out["departed"] = int(start)
            out["vs_typical_min"] = round((eta - typical_arr) / 60)
    return out


METHOD = {
    "summary": "Screening model from public data. Not an operational flight-planning or dispatch tool.",
    "route": "Great-circle route sampled every ~160 km. Each sample is checked at the time the aircraft would pass it (departure + taxi + share of typical air time).",
    "hazards": [
        ["Convection", "Open-Meteo CAPE, rain rate and WMO thunderstorm codes: conv = 0.55·clamp((CAPE−400)/2600) + 0.45·[thunderstorm] + 0.25·clamp(rain/10 mm)"],
        ["Clear-air turbulence", "Vertical wind shear between 300 and 200 hPa (≈2.6 km) from ECMWF/GFS winds; turb = 0.85·clamp((VWS−4.5)/8) + 0.25·clamp((jet−110 kt)/80)"],
        ["Terrain", "Copernicus DEM height under the route; drift-down/oxygen planning above ~2.5 km"],
        ["Disaster alerts", "GDACS/EONET cyclones within 350 km, volcanoes (ash) within 400 km, SACHET wind/rain alerts within 120 km"],
        ["Space weather", "NOAA planetary Kp (now + 24 h forecast): HF and GNSS degradation, stronger at high latitude"],
        ["Airports", "Visibility (fog), thunderstorms, heavy rain, snow, gust crosswind on the best runway (OurAirports headings), density altitude, M5+ quakes within 150 km"],
    ],
    "rating": "Segment risk = top factor + 0.2 × second + 0.1 × third. Route safety = 100 × (1 − (0.6 × worst segment + 0.25 × mean)). A ≥85, B ≥70, C ≥50, D ≥30, E below.",
    "delay": "Expected delay = airport congestion prior + time-of-day bank + live ADS-B traffic within 45 km below 12,000 ft above the airport's normal level + departure and arrival weather + en-route storm deviations + 30% of the jet-stream effect (schedules already pad for the season's wind). Delay is treated as exponential with that mean: P(>15 min late) = exp(−15 / mean).",
    "live": "For a flight in the air: ETA = remaining distance at current ground speed, descent at 3 NM per 1,000 ft, predicted holding from arrival weather and traffic, and 6 min taxi-in. Compared with take-off time (OpenSky track) + typical block time.",
}
