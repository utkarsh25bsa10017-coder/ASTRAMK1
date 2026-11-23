"""
ASTRA hazard engine.

1. Earthquakes: NCS (India's National Center for Seismology, official), EMSC and USGS, merged.
2. Geocoding: Open-Meteo geocoding (place search) + Nominatim reverse lookup.
3. Location assessment: a transparent, physically motivated screening model that combines
   terrain (Copernicus DEM via Open-Meteo), river discharge climatology and forecast (GloFAS),
   rainfall forecast, soil moisture and historical seismicity into hazard scores and a safety rating.

This is a screening model for awareness and planning, not an official warning.
"""
from __future__ import annotations

import html
import json
import math
import re
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from gateway import SourceUnavailable, cached_result, fetch_raw, worst

MIN, HOUR, DAY = 60, 3600, 86400
IST = timezone(timedelta(hours=5, minutes=30))


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _hav(lat1, lon1, lat2, lon2):
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(a)))


def _clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------
# Earthquakes
# ---------------------------------------------------------------------------
NCS_ROW = re.compile(
    r'<tr>\s*<td>(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) IST</td>\s*<td>([-\d.]+)</td>\s*<td>([-\d.]+)</td>\s*'
    r'<td>([-\d.]+)</td>\s*<td>([\d.]+)\s*</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td><a href="([^"]+)"')


def _ncs_events():
    raw, prov = fetch_raw("ncs", "ncs_recent", "https://riseq.seismo.gov.in/riseq/earthquake/recent_earthquake",
                          ttl=10 * MIN, timeout=40)
    s = raw.decode("utf-8", "replace")
    out = []
    for t, la, lo, dep, mag, region, loc, link in NCS_ROW.findall(s):
        dt = datetime.strptime(t, "%Y-%m-%d %H:%M:%S").replace(tzinfo=IST)
        out.append({"source": "ncs", "time": _iso(dt), "lat": float(la), "lon": float(lo), "depth": float(dep),
                    "mag": float(mag), "place": html.unescape(loc.strip()) or html.unescape(region.strip()),
                    "region": html.unescape(region.strip()), "url": link})
    if not out:
        raise SourceUnavailable("NCS page format changed or empty")
    return out, prov


def _emsc_events():
    start = (_now() - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    url = ("https://www.seismicportal.eu/fdsnws/event/1/query?format=json&minlat=-5&maxlat=45&minlon=55&maxlon=105"
           f"&minmag=2.5&start={start}&limit=500&orderby=time")
    raw, prov = fetch_raw("emsc", "emsc_region", url, ttl=10 * MIN, timeout=30)
    out = []
    for f in json.loads(raw).get("features", []):
        p = f["properties"]
        out.append({"source": "emsc", "time": p["time"][:19] + "Z", "lat": p["lat"], "lon": p["lon"],
                    "depth": p.get("depth"), "mag": p.get("mag"), "place": (p.get("flynn_region") or "").title(),
                    "region": p.get("flynn_region"), "url": f"https://www.seismicportal.eu/eventdetails.html?unid={p.get('unid')}"})
    return out, prov


def _usgs_events():
    raw, prov = fetch_raw("usgs", "usgs_45month", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson",
                          ttl=10 * MIN, timeout=30)
    out = []
    for f in json.loads(raw)["features"]:
        p = f["properties"]
        lon, lat, dep = f["geometry"]["coordinates"]
        out.append({"source": "usgs", "time": _iso(datetime.fromtimestamp(p["time"] / 1000, timezone.utc)), "lat": lat, "lon": lon,
                    "depth": dep, "mag": p.get("mag"), "place": p.get("place") or "", "region": "", "url": p.get("url"),
                    "tsunami": bool(p.get("tsunami")), "felt": p.get("felt"), "pager": p.get("alert")})
    return out, prov


def _build_earthquakes():
    provs, events, status = [], [], {}
    for name, fn in (("ncs", _ncs_events), ("emsc", _emsc_events), ("usgs", _usgs_events)):
        try:
            ev, p = fn()
            events.append(ev)
            provs.append(p)
            status[name] = {"status": "ok", "count": len(ev), "provenance": p}
        except SourceUnavailable as e:
            events.append([])
            status[name] = {"status": "error", "error": str(e)[:160]}
    if not any(events):
        raise SourceUnavailable("no earthquake source reachable")
    # Merge: NCS is authoritative for India; drop EMSC/USGS duplicates within 60 s and 50 km.
    merged = list(events[0])
    for ev in events[1] + events[2]:
        t = datetime.fromisoformat(ev["time"].replace("Z", "+00:00"))
        dup = False
        for m in merged:
            if abs((datetime.fromisoformat(m["time"].replace("Z", "+00:00")) - t).total_seconds()) < 60 and _hav(m["lat"], m["lon"], ev["lat"], ev["lon"]) < 50:
                m.setdefault("also", []).append(ev["source"])
                if ev.get("tsunami"):
                    m["tsunami"] = True
                dup = True
                break
        if not dup:
            merged.append(ev)
    cutoff = _now() - timedelta(days=30)
    merged = [e for e in merged if datetime.fromisoformat(e["time"].replace("Z", "+00:00")) >= cutoff]
    merged.sort(key=lambda e: e["time"], reverse=True)
    for e in merged:
        m = e["mag"] or 0
        e["severity"] = 3 if m >= 7 else 2 if m >= 6 else 1 if m >= 5 else 0
        e["india"] = 5 <= e["lat"] <= 38 and 66 <= e["lon"] <= 99
    return {"generated": _iso(_now()), "events": merged, "sources": status}, worst(*provs)


def earthquakes():
    data, prov = cached_result("earthquakes", 10 * MIN, _build_earthquakes)
    return _slim_quakes(data), prov


def _slim_quakes(d):
    """Drop empty fields and round numbers: about half the bytes, same information."""
    def slim(e):
        out = {}
        for k, v in e.items():
            if v is None or v == "" or v is False:
                continue
            if k in ("lat", "lon") and isinstance(v, float):
                v = round(v, 3)
            elif k == "depth" and isinstance(v, float):
                v = round(v, 1)
            out[k] = v
        out.setdefault("india", False)
        return out
    return {**d, "events": [slim(e) for e in d.get("events", [])]}


# ---------------------------------------------------------------------------
# Geocoding
# ---------------------------------------------------------------------------
def geocode(q):
    q = (q or "").strip()
    if not (2 <= len(q) <= 80):
        raise ValueError("query must be 2-80 characters")
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$", q)
    if m:
        la, lo = float(m.group(1)), float(m.group(2))
        if -90 <= la <= 90 and -180 <= lo <= 180:
            return [{"name": f"{la:.4f}, {lo:.4f}", "lat": la, "lon": lo, "admin": "Coordinates", "country": ""}], "live"

    def build():
        url = f"https://geocoding-api.open-meteo.com/v1/search?name={urllib.parse.quote(q)}&count=8&language=en&format=json"
        raw, prov = fetch_raw("geocode", f"geo_{q.lower()}", url, ttl=30 * DAY, timeout=15)
        res = json.loads(raw).get("results") or []
        res.sort(key=lambda r: (r.get("country_code") != "IN", -(r.get("population") or 0)))
        return [{"name": r["name"], "lat": r["latitude"], "lon": r["longitude"],
                 "admin": ", ".join(x for x in (r.get("admin2"), r.get("admin1")) if x), "country": r.get("country", ""),
                 "population": r.get("population")} for r in res], prov
    return cached_result(f"geocode_{q.lower()}", 30 * DAY, build)


def _reverse(lat, lon):
    url = f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json&zoom=10&accept-language=en"
    try:
        raw, _ = fetch_raw("geocode", f"rev_{lat}_{lon}", url, ttl=30 * DAY, timeout=10)
        d = json.loads(raw)
        a = d.get("address", {})
        name = a.get("city") or a.get("town") or a.get("village") or a.get("county") or a.get("state_district") or d.get("name")
        admin = ", ".join(x for x in (a.get("state_district"), a.get("state")) if x and x != name)
        return name or f"{lat:.3f}, {lon:.3f}", admin, a.get("country", "")
    except Exception:
        return f"{lat:.3f}, {lon:.3f}", "", ""


# ---------------------------------------------------------------------------
# Inputs for the assessment
# ---------------------------------------------------------------------------
def _elevations(points, key):
    lats = ",".join(f"{p[0]:.5f}" for p in points)
    lons = ",".join(f"{p[1]:.5f}" for p in points)
    raw, prov = fetch_raw("openmeteo", key, f"https://api.open-meteo.com/v1/elevation?latitude={lats}&longitude={lons}",
                          ttl=365 * DAY, timeout=20)
    return json.loads(raw)["elevation"], prov


def _terrain(lat, lon):
    # Fine 5x5 grid (~200 m) for slope; coarse 9x9 grid (~2.2 km, ±8.9 km) for valley position and relief.
    fd, cd = 0.0018, 0.02
    fine = [(lat + (2 - i) * fd, lon + (j - 2) * fd) for i in range(5) for j in range(5)]
    coarse = [(lat + (4 - i) * cd, lon + (j - 4) * cd) for i in range(9) for j in range(9)]
    ef, p1 = _elevations(fine, f"elev_f_{lat}_{lon}")
    ec, p2 = _elevations(coarse, f"elev_c_{lat}_{lon}")
    z = lambda i, j: ef[i * 5 + j]
    dx = fd * 111320 * math.cos(math.radians(lat))
    dy = fd * 110540
    # Horn's method on the inner 3x3 around the centre
    dzdx = ((z(1, 3) + 2 * z(2, 3) + z(3, 3)) - (z(1, 1) + 2 * z(2, 1) + z(3, 1))) / (8 * dx)
    dzdy = ((z(1, 1) + 2 * z(1, 2) + z(1, 3)) - (z(3, 1) + 2 * z(3, 2) + z(3, 3))) / (8 * dy)
    slope = math.degrees(math.atan(math.hypot(dzdx, dzdy)))
    fine_relief = max(ef) - min(ef)
    centre = ec[40]
    valid = [e for e in ec if e is not None]
    lower_frac = sum(1 for e in valid if e < centre - 1) / len(valid)
    rel_min = centre - min(valid)          # height above the lowest point within ~9 km (HAND proxy)
    tpi = centre - sum(valid) / len(valid)  # topographic position: negative = valley / depression
    tpi_n = tpi / max(15.0, (max(valid) - min(valid)) / 2)  # normalised by local relief (-1 valley floor .. +1 ridge)
    relief_up = max(valid) - centre         # how much higher the surrounding terrain is (catchment steepness)
    profile = ec[36:45]                     # W-E cross-section through the point
    profile_ns = [ec[i * 9 + 4] for i in range(9)]
    coastal = sum(1 for e in valid if e <= 0) / len(valid)
    return {"elevation": centre, "slope": slope, "fineRelief": fine_relief, "relMin": rel_min, "tpi": tpi,
            "reliefUp": relief_up, "lowerFrac": lower_frac, "tpiN": tpi_n, "profileWE": profile, "profileNS": profile_ns,
            "seaFrac": coastal, "spacingKm": cd * 111}, worst(p1, p2)


def _gumbel(annual_max):
    n = len(annual_max)
    mean = sum(annual_max) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in annual_max) / max(1, n - 1))
    beta = max(1e-6, sd * math.sqrt(6) / math.pi)
    mu = mean - 0.5772 * beta
    q = lambda T: mu - beta * math.log(-math.log(1 - 1 / T))
    rp = lambda Q: 1 / max(1e-9, 1 - math.exp(-math.exp(-(Q - mu) / beta)))
    return {"mu": mu, "beta": beta, "Q2": q(2), "Q5": q(5), "Q10": q(10), "Q20": q(20), "Q50": q(50), "Q100": q(100)}, rp


def _nearest_river(lat, lon):
    """GloFAS cells are ~5 km: a city on a big river often sits in a neighbouring cell. Look at the 5 x 5 cells around
    the point (±11 km) and return the one carrying the most water, if it is a real river and within ~9 km."""
    pts = [(round(lat * 20) / 20 + i * 0.05, round(lon * 20) / 20 + j * 0.05) for i in range(-2, 3) for j in range(-2, 3)]
    url = ("https://flood-api.open-meteo.com/v1/flood?latitude=" + ",".join(f"{a:.3f}" for a, _ in pts) +
           "&longitude=" + ",".join(f"{b:.3f}" for _, b in pts) + "&daily=river_discharge_mean&past_days=60&forecast_days=1")
    raw, _ = fetch_raw("openmeteo", f"glofas_nb_{pts[12][0]:.2f}_{pts[12][1]:.2f}", url, ttl=30 * DAY, timeout=30)
    d = json.loads(raw)
    best = None
    for x in (d if isinstance(d, list) else [d]):
        v = sorted(q for q in x["daily"]["river_discharge_mean"] if q is not None)
        if not v:
            continue
        med, km = v[len(v) // 2], _hav(lat, lon, x["latitude"], x["longitude"])
        if km <= 10 and (best is None or med > best[0]):
            best = (med, x["latitude"], x["longitude"], km)
    return best


def _river(lat, lon):
    # Use the biggest river within ~9 km (if it is clearly bigger than the stream in the point's own cell)
    rkm, qlat, qlon = 0.0, lat, lon
    try:
        nb = _nearest_river(lat, lon)
        if nb and nb[0] >= 3 and nb[3] > 1:
            qlat, qlon, rkm = round(nb[1], 3), round(nb[2], 3), nb[3]
    except (SourceUnavailable, ValueError, KeyError):
        pass
    lat, lon = qlat, qlon
    # GloFAS cells are ~5 km; round so neighbouring searches share the climatology cache.
    glat, glon = round(lat * 20) / 20, round(lon * 20) / 20
    end = (_now() - timedelta(days=60)).strftime("%Y-%m-%d")
    hist_url = (f"https://flood-api.open-meteo.com/v1/flood?latitude={lat}&longitude={lon}&daily=river_discharge"
                f"&start_date=1984-01-01&end_date={end}")
    raw_h, p1 = fetch_raw("openmeteo", f"glofas_hist_{glat}_{glon}", hist_url, ttl=30 * DAY, timeout=40)
    fc_url = (f"https://flood-api.open-meteo.com/v1/flood?latitude={lat}&longitude={lon}"
              "&daily=river_discharge,river_discharge_max,river_discharge_mean&past_days=10&forecast_days=30")
    raw_f, p2 = fetch_raw("openmeteo", f"glofas_fc_{lat}_{lon}", fc_url, ttl=3 * HOUR, timeout=30)
    h = json.loads(raw_h)["daily"]
    f = json.loads(raw_f)["daily"]
    by_year = {}
    vals = []
    for t, v in zip(h["time"], h["river_discharge"]):
        if v is None:
            continue
        vals.append(v)
        y = t[:4]
        by_year[y] = max(by_year.get(y, 0), v)
    if len(by_year) < 10:
        raise SourceUnavailable("not enough discharge history")
    ann = list(by_year.values())
    g, rp = _gumbel(ann)
    vals.sort()
    median = vals[len(vals) // 2]
    today = _now().strftime("%Y-%m-%d")
    i0 = next((i for i, t in enumerate(f["time"]) if t >= today), 0)
    fut = [v for v in f["river_discharge"][i0:] if v is not None]
    fut_max = [v for v in (f.get("river_discharge_max") or [])[i0:] if v is not None]
    peak = max(fut) if fut else 0
    peak_ens = max(fut_max) if fut_max else peak
    peak_day = f["time"][i0 + fut.index(peak)] if fut else None
    now_q = f["river_discharge"][i0] if i0 < len(f["river_discharge"]) else None
    # "Now" means the next 10 days: control run and ensemble mean (one outlier member 4 weeks out is not a forecast)
    near = [v for v in f["river_discharge"][i0:i0 + 10] if v is not None]
    near_mean = [v for v in (f.get("river_discharge_mean") or [])[i0:i0 + 10] if v is not None]
    peak10 = max(near + near_mean, default=0)
    return {"median": median, "annualMaxMean": sum(ann) / len(ann), "years": len(ann), "thresholds": g,
            "riverKm": round(rkm, 1), "riverLat": lat, "riverLon": lon,
            "now": now_q, "peak": peak, "peakEnsMax": peak_ens, "peakDay": peak_day,
            "peakRP": rp(peak), "peakEnsRP": rp(peak_ens), "peak10": peak10, "peak10RP": rp(peak10),
            "series": {"time": f["time"], "q": f["river_discharge"], "qmax": f.get("river_discharge_max"),
                       "qmean": f.get("river_discharge_mean")}}, worst(p1, p2)


def _weather(lat, lon):
    url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
           "&hourly=precipitation,soil_moisture_0_to_1cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm"
           "&daily=precipitation_sum&past_days=3&forecast_days=4&timezone=auto")
    raw, prov = fetch_raw("openmeteo", f"hz_wx_{lat}_{lon}", url, ttl=HOUR, timeout=20)
    d = json.loads(raw)
    hr = d["hourly"]
    now = datetime.now(timezone.utc) + timedelta(seconds=d.get("utc_offset_seconds", 0))
    nowkey = now.strftime("%Y-%m-%dT%H:00")
    i0 = next((i for i, t in enumerate(hr["time"]) if t >= nowkey), 0)
    p = [x or 0 for x in hr["precipitation"]]
    fut = p[i0:i0 + 72]
    past72 = sum(p[max(0, i0 - 72):i0])

    def win(arr, n):
        return max((sum(arr[i:i + n]) for i in range(0, max(1, len(arr) - n + 1))), default=0)
    sm = [x for x in (hr.get("soil_moisture_3_to_9cm") or [])[max(0, i0 - 1):i0 + 1] if x is not None]
    sm_deep = [x for x in (hr.get("soil_moisture_9_to_27cm") or [])[max(0, i0 - 1):i0 + 1] if x is not None]
    soil = (sm[-1] if sm else 0.25)
    soil_deep = (sm_deep[-1] if sm_deep else soil)
    sat = _clamp(max(soil, soil_deep) / 0.45)  # ~0.45 m3/m3 ~ porosity of typical Indian alluvial soils
    return {"max1h": win(fut, 1), "max3h": win(fut, 3), "max24h": win(fut, 24), "next72h": sum(fut), "past72h": past72,
            "soil": soil, "soilDeep": soil_deep, "saturation": sat,
            "hourly": {"time": hr["time"][i0:i0 + 72], "p": fut}, "timezone": d.get("timezone")}, prov


def _seismic(lat, lon):
    url = (f"https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude={lat:.2f}&longitude={lon:.2f}"
           "&maxradiuskm=300&minmagnitude=4.5&starttime=1975-01-01&orderby=magnitude&limit=400")
    raw, prov = fetch_raw("usgs", f"usgs_hist_{lat:.1f}_{lon:.1f}", url, ttl=30 * DAY, timeout=30)
    ev = []
    for f in json.loads(raw)["features"]:
        lo, la, dep = f["geometry"]["coordinates"]
        ev.append({"mag": f["properties"]["mag"] or 0, "dist": _hav(lat, lon, la, lo), "depth": dep,
                   "year": datetime.fromtimestamp(f["properties"]["time"] / 1000, timezone.utc).year,
                   "place": re.sub(r"(?<=[A-Za-z])\?(?=[a-z])", "a", f["properties"]["place"] or ""), "lat": la, "lon": lo})
    years = _now().year - 1975 + 1
    # Distance-attenuated energy proxy: big, close, shallow quakes dominate.
    load = sum(10 ** (0.75 * (e["mag"] - 5)) / (1 + (e["dist"] / 40) ** 2) / (1 + max(0, (e["depth"] or 10) - 30) / 70) for e in ev) / years
    m5 = [e for e in ev if e["mag"] >= 5]
    strongest = max(ev, key=lambda e: e["mag"] - e["dist"] / 100, default=None)
    return {"count45": len(ev), "count5": len(m5), "years": years, "load": load,
            "nearestM5km": min((e["dist"] for e in m5), default=None), "maxMag": max((e["mag"] for e in ev), default=None),
            "notable": sorted(ev, key=lambda e: -e["mag"])[:5], "strongest": strongest}, prov


# ---------------------------------------------------------------------------
# Hazard scoring
# ---------------------------------------------------------------------------
def _rp_factor(T):
    """Return period -> 0..1. RP 1.5 ~ 0.1, 2 ~ 0.3, 5 ~ 0.6, 20 ~ 0.85, 100 ~ 1."""
    if T <= 1.05:
        return 0.0
    return _clamp(1 / (1 + math.exp(-2.1 * (math.log(T) - math.log(4.5)))))


def _exposure(rel):
    """Height above nearby lowest ground (m) -> exposure of the site to river water."""
    return 1.0 if rel < 3 else 0.75 if rel < 8 else 0.45 if rel < 15 else 0.2 if rel < 30 else 0.06


def _level(score):
    return ("Very high" if score >= 75 else "High" if score >= 55 else "Moderate" if score >= 35
            else "Low" if score >= 15 else "Very low")


def _rain_climate(lat, lon):
    """ERA5 (1995-2024) annual-maximum daily rain -> Gumbel design storms."""
    glat, glon = round(lat * 4) / 4, round(lon * 4) / 4
    url = (f"https://archive-api.open-meteo.com/v1/archive?latitude={glat}&longitude={glon}"
           "&start_date=1995-01-01&end_date=2024-12-31&daily=precipitation_sum")
    raw, prov = fetch_raw("openmeteo", f"era5_{glat}_{glon}", url, ttl=365 * DAY, timeout=40)
    d = json.loads(raw)["daily"]
    am, total = {}, 0.0
    for t, v in zip(d["time"], d["precipitation_sum"]):
        if v is None:
            continue
        total += v
        am[t[:4]] = max(am.get(t[:4], 0), v)
    g, _ = _gumbel(list(am.values()))
    return {"P2": g["Q2"], "P10": g["Q10"], "P25": max(g["Q20"], g["Q10"]), "annualMean": total / max(1, len(am)),
            "wettestDay": max(am.values()), "years": len(am)}, prov


def _score(terrain, river, rv, rain, seis):
    """river = climatology (or None); rv = scenario {peak, T}; rain = scenario {max1h, max3h, max24h, past72h, saturation}."""
    out = {}
    s = rain["saturation"]
    rel, slope, tpi, relief_up = terrain["relMin"], terrain["slope"], terrain["tpi"], terrain["reliefUp"]

    # 1. Riverine flood: scenario discharge vs the site's own flood climatology, weighted by exposure.
    if river and rv:
        big = _clamp(math.log10(max(river["median"], 0.01) + 1) / 2.5)  # ~0 for a trickle, 1 for ~300 m3/s median
        T = rv["T"]
        rk = river.get("riverKm") or 0
        dist_w = 1.0 if rk < 3 else 0.75 if rk < 6 else 0.5
        score = 100 * _rp_factor(T) * _exposure(rel) * (0.35 + 0.65 * big) * _river_weight(river) * dist_w
        if not _has_river(river):
            why = (f"No sizeable river here: the nearest modelled stream carries about {river['median']:.1f} m³/s on a typical day, "
                   f"too small to flood. Site is {rel:.0f} m above the lowest ground within 9 km.")
        else:
            why = (f"River peak {rv['peak']:.0f} m³/s (≈{min(T, 500):.0f}-yr level; 2-yr flood ≈ {river['thresholds']['Q2']:.0f} m³/s)"
                   + (f", river about {river['riverKm']:.0f} km away" if (river.get("riverKm") or 0) >= 2 else "")
                   + f". Site is {rel:.0f} m above the lowest ground within 9 km.")
        out["riverine"] = {"score": round(score), "why": why}
    else:
        out["riverine"] = {"score": 0, "why": "No river discharge data for this cell."}

    # 2. Bank overflow & surface runoff: SCS curve-number runoff from the heaviest 24 h of rain,
    #    concentrated by flat, low-lying ground; plus overbank spill above the 2-yr (bankfull) level.
    p24 = rain["max24h"]
    cn = 60 + 20 * s + (4 if slope < 2 else 0)
    S = 25400 / cn - 254
    runoff = (p24 - 0.2 * S) ** 2 / (p24 + 0.8 * S) if p24 > 0.2 * S else 0.0
    # Runoff only floods where it collects: low-lying ground and hollows. Flat ground that sits well above its
    # surroundings (a plateau, a campus on a rise) drains away, so height above local low ground dominates.
    pond = _clamp(_exposure(rel) + 0.35 * max(0.0, -terrain["tpiN"]) + (0.15 if slope < 1.5 and rel < 8 else 0)
                  - (0.1 if slope > 8 else 0), 0.05, 1.4)
    pluvial = _clamp((runoff - 25) / 150) * pond      # street drains and soakaways take roughly the first 25 mm
    overbank = 0.0
    if river and rv and rel < 8 and _has_river(river) and (river.get("riverKm") or 0) < 6:
        t = river["thresholds"]
        overbank = _clamp((rv["peak"] - t["Q2"]) / max(1, t["Q10"] - t["Q2"])) * (1 if rel < 4 else 0.6)
    score = 100 * _clamp(max(pluvial, overbank * 0.9))
    where = ("Low-lying ground: water collects here. " if pond >= 0.75 else
             f"Site is {rel:.0f} m above nearby low ground, so most water drains away. " if pond < 0.35 else
             "Slightly low ground: some ponding in heavy rain. ")
    out["bank"] = {"score": round(score),
                   "why": f"Heaviest 24 h rain {p24:.0f} mm → ≈{runoff:.0f} mm surface runoff (soil {s * 100:.0f}% saturated). " + where
                          + ("River above its bankfull (2-yr) level. " if overbank > 0 else "")}

    # 3. Sediment-laden flood / debris flow: steep ground or steep surroundings + heavy, saturating rain.
    rain_f = _clamp((p24 + 0.3 * rain["past72h"]) / 120)
    steep_f = _clamp(0.55 * _clamp((slope - 5) / 25) + 0.45 * _clamp(relief_up / 600))
    score = 100 * _clamp(rain_f * (0.25 + 0.75 * steep_f) * (0.45 + 0.55 * s) * 1.6) * (0.15 + 0.85 * steep_f)
    out["sediment"] = {"score": round(score),
                       "why": f"Slope {slope:.1f}°, terrain up to {relief_up:.0f} m higher nearby, {p24:.0f} mm in 24 h on "
                              f"{s * 100:.0f}% saturated soil. Steep wet slopes shed mud and debris into channels."}

    # 4. Flash flood: short intense bursts + steep converging catchment + wet soil.
    p1, p3 = rain["max1h"], rain["max3h"]
    inten = _clamp(max(p1 / 70, p3 / 120)) ** 0.7
    valley = _clamp(1 - terrain["lowerFrac"] * 1.4)
    catch = _clamp(relief_up / 400)
    score = 100 * _clamp(inten * (0.15 + 0.6 * catch + 0.25 * valley) * (0.55 + 0.45 * s) * 1.5)
    out["flash"] = {"score": round(score),
                    "why": f"Peak burst {p1:.0f} mm/h ({p3:.0f} mm in 3 h). Catchment relief {relief_up:.0f} m"
                           + ("; valley-floor position." if valley > 0.6 else ".")}

    # 5. Earthquake (long-term, same in both scenarios).
    if seis:
        sc = 100 * _clamp(math.log10(1 + seis["load"] * 40) / 2.3)
        out["earthquake"] = {"score": round(sc),
                             "why": f"{seis['count5']} M5+ and {seis['count45']} M4.5+ quakes within 300 km since 1975"
                                    + (f"; largest M{seis['maxMag']:.1f}." if seis["maxMag"] else ".")}
    else:
        out["earthquake"] = {"score": 0, "why": "Seismic history unavailable."}
    for v in out.values():
        v["level"] = _level(v["score"])
    return out


def _has_river(river):
    return bool(river) and river["median"] >= 3


def _river_weight(river):
    """0 for a trickle, 1 for a real river (typical flow of 3 m³/s or more)."""
    return _clamp(river["median"] / 3) if river else 0.0


def _in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _live_alerts(lat, lon):
    """Official warnings active now within ~40 km (SACHET district alerts, GDACS/EONET events)."""
    try:
        import sources
        al, _ = sources.alerts()
    except Exception:
        return []
    out = []
    for a in al.get("alerts", []):
        if a.get("lat") is None or a.get("type") not in ("flood", "rain", "cyclone", "landslide", "wind", "tsunami"):
            continue
        if a.get("source") == "gdacs" and not (a.get("gdacs") or {}).get("current", True):
            continue
        if a["type"] == "cyclone" and a.get("source") == "eonet":     # EONET lists past track points too
            continue
        rings = a.get("rings") or []
        if rings:   # SACHET gives the warned area itself: inside it, or within 10 km of its edge
            if any(_in_ring(lon, lat, r) for r in rings):
                d = 0
            else:
                d = min((_hav(lat, lon, y, x) for r in rings for x, y in r[::4]), default=9999)
                if d > 10:
                    continue
        else:
            d = _hav(lat, lon, a["lat"], a["lon"])
            if d > (350 if a["type"] == "cyclone" else 40):
                continue
        if True:
            out.append({"type": a["type"], "title": a.get("title"), "severity": a.get("severity") or 0, "km": round(d),
                        "source": a.get("source"), "agency": a.get("agency") or a.get("source"), "inside": d == 0})
    out.sort(key=lambda x: (-x["severity"], x["km"]))
    return out[:6]


LABELS = {"riverine": "River discharge flood", "bank": "Bank overflow & runoff", "sediment": "Sediment & debris flow",
          "flash": "Flash flood", "earthquake": "Long-term seismic exposure"}
WATER = ["riverine", "bank", "sediment", "flash"]
GRADES = [(85, "A", "Safe"), (70, "B", "Low risk"), (50, "C", "Caution"), (30, "D", "High risk"), (0, "E", "Danger")]


def _combine(hz):
    sc = sorted((hz[k]["score"] for k in WATER), reverse=True)   # seismic exposure is reported separately
    return min(100, sc[0] + 0.15 * sum(sc[1:3]))


def _grade(safety):
    return next((g, l) for t, g, l in GRADES if safety >= t)


def assess(lat, lon):
    lat, lon = round(float(lat), 3), round(float(lon), 3)
    if not (-60 <= lat <= 70 and -180 <= lon <= 180):
        raise ValueError("coordinates out of range")

    def build():
        provs, errors, res = [], {}, {}
        jobs = {"terrain": _terrain, "river": _river, "weather": _weather, "seismic": _seismic,
                "climate": _rain_climate, "place": _reverse}
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = {k: ex.submit(fn, lat, lon) for k, fn in jobs.items()}
            for k, f in futs.items():
                try:
                    r = f.result(timeout=45)
                    if k == "place":
                        res[k] = r
                    else:
                        res[k], p = r
                        provs.append(p)
                except Exception as e:
                    res[k] = None
                    errors[k] = f"{type(e).__name__}: {str(e)[:120]}"
        terrain, river, wx, seis, clim = res["terrain"], res["river"], res["weather"], res["seismic"], res["climate"]
        if not terrain:
            raise SourceUnavailable("terrain data unavailable: " + errors.get("terrain", ""))

        rain_now = wx or {"max1h": 0, "max3h": 0, "max24h": 0, "past72h": 0, "saturation": 0.5}
        rv_now = {"peak": river["peak10"], "T": river["peak10RP"]} if river else None
        p10 = clim["P10"] if clim else 120.0
        rain_design = {"max1h": 0.3 * p10, "max3h": 0.5 * p10, "max24h": p10, "past72h": 0.8 * p10, "saturation": 0.75}
        rv_design = {"peak": river["thresholds"]["Q20"], "T": 20} if river else None

        now = _score(terrain, river, rv_now, rain_now, seis)
        design = _score(terrain, river, rv_design, rain_design, seis)
        live = _live_alerts(lat, lon)
        # An official warning in force here sets a floor under the matching hazard right now
        for a in live:
            t = (a["title"] or "").lower()
            heavy = any(w in t for w in ("heavy", "flood", "inundat", "waterlog", "cloudburst", "very heavy", "extremely"))
            if a["severity"] < 2 or "lightning" in t and not heavy:
                continue
            if a["type"] == "rain" and not heavy:
                continue
            floor = 20 + 10 * a["severity"] + (8 if a["inside"] else 0)
            key = {"flood": "riverine" if _has_river(river) else "bank", "rain": "bank", "cyclone": "bank",
                   "landslide": "sediment", "tsunami": "bank"}.get(a["type"])
            if key and now[key]["score"] < floor:
                now[key]["score"] = floor
                now[key]["level"] = _level(floor)
                now[key]["why"] += (" Official warning in force for this area: " if a["inside"] else f" Official warning in force {a['km']} km away: ") + a["title"]
        labels = dict(LABELS)
        if not _has_river(river):
            labels["bank"] = "Waterlogging & runoff"
        hazards = {k: {"label": labels[k], "now": now[k], "design": design[k]} for k in LABELS}
        c_now, c_design = _combine(now), _combine(design)
        s_now, s_design = round(100 - c_now), round(100 - c_design)
        safety = s_now
        grade, label = _grade(safety)
        dominant = max(WATER, key=lambda k: (now[k]["score"], design[k]["score"]))
        seis_score = now["earthquake"]["score"]
        name, admin, country = res["place"] or (f"{lat}, {lon}", "", "")
        return {"lat": lat, "lon": lon, "place": {"name": name, "admin": admin, "country": country},
                "generated": _iso(_now()), "safety": safety, "grade": grade, "label": label,
                "safetyNow": s_now, "gradeNow": _grade(s_now)[0], "safetyDesign": s_design, "gradeDesign": _grade(s_design)[0],
                "dominant": dominant, "hazards": hazards, "liveAlerts": live, "hasRiver": _has_river(river),
                "seismicExposure": {"score": seis_score, "level": _level(seis_score), "why": now["earthquake"]["why"]},
                "disclaimer": "Screening estimate from public data. Not an official hazard assessment; follow IMD, CWC, NDMA and state advisories.", "designEvent": {"rain24h": p10, "riverQ20": rv_design["peak"] if rv_design else None,
                                                                          "rain": clim},
                "terrain": terrain, "river": river, "weather": wx, "seismic": seis, "errors": errors,
                "advice": _advice(now, design), "method": METHOD}, worst(*provs)
    return cached_result(f"assess4_{lat}_{lon}", 30 * MIN, build)


def _advice(now, design):
    tips = []
    hz = {k: {"score": max(now[k]["score"], design[k]["score"] * 0.7)} for k in now}
    if any(now[k]["score"] >= 35 for k in ("riverine", "bank", "flash", "sediment")):
        tips.append("Elevated hazard in the next 72 hours: follow IMD/SACHET alerts closely and keep an evacuation bag ready.")
    if hz["riverine"]["score"] >= 35 or hz["bank"]["score"] >= 35:
        tips.append("Move vehicles, documents and stock above the expected water line; know your route to higher ground.")
    if hz["flash"]["score"] >= 35:
        tips.append("Avoid stream beds, causeways and low crossings during heavy rain; water can rise within minutes.")
    if hz["sediment"]["score"] >= 35:
        tips.append("Stay away from the base of steep slopes and drainage gullies; watch for cracks, tilting trees and muddy water.")
    if hz["earthquake"]["score"] >= 55:
        tips.append("High seismic area: secure heavy furniture and cylinders, and keep an emergency kit ready.")
    if not tips:
        tips.append("No elevated hazard now or in a typical heavy-monsoon event. Keep following IMD and NDMA (SACHET) alerts.")
    return tips


METHOD = {
    "summary": "Screening model combining terrain, river climatology, rainfall forecast, soil moisture and seismic history. Not an official warning.",
    "inputs": [
        "Terrain: Copernicus GLO-90 DEM (via Open-Meteo); 5×5 grid at ~200 m for slope (Horn), 9×9 grid at ~2.2 km for height above local low ground, topographic position and surrounding relief.",
        "River: GloFAS v4 daily discharge 1984–present; Gumbel fit to annual maxima gives 2- to 100-year flood levels; 30-day ensemble forecast compared against them.",
        "Rain & soil: Open-Meteo forecast (ECMWF/GFS blend), hourly precipitation for the next 72 h and soil moisture 3–27 cm.",
        "Seismic: USGS catalogue, M4.5+ within 300 km since 1975, distance- and depth-attenuated.",
        "Design storm: ERA5 reanalysis daily rain 1995–2024 (Open-Meteo archive), Gumbel fit to annual maxima.",
    ],
    "hazards": {
        "riverine": "Forecast return period × site exposure (height above local low ground) × river size.",
        "bank": "SCS curve-number runoff from the heaviest 24 h of rain, less ~25 mm taken by drains, scaled by how low the site sits (water only collects in low ground and hollows); plus overbank spill above the 2-year level where there is a real river (typical flow ≥ 3 m³/s). Shown as 'Waterlogging & runoff' where there is no river.",
        "sediment": "Heavy, saturating rain × slope and surrounding relief (debris and mud flows, sediment-laden floods).",
        "flash": "Peak 1 h / 3 h rain intensity × catchment relief × valley-floor position × soil saturation.",
        "earthquake": "Long-term seismicity load from historical quakes near the site.",
    },
    "scenarios": "Every hazard is scored twice: for the next 72 h (live forecast) and for a design monsoon event (ERA5 1995–2024 10-year 24 h rainfall, GloFAS 20-year river flood, 75% soil saturation).",
    "rating": "The A–E rating is for right now: the four water hazards over the next 72 hours, raised where an official IMD/CWC/SDMA warning is in force within 40 km. Combined = highest + 0.15 × next two; safety = 100 − combined. A ≥ 85, B ≥ 70, C ≥ 50, D ≥ 30, E below. The 1-in-10-year monsoon storm is shown alongside as an outlook, and long-term seismic exposure separately, because neither describes today.",
}
