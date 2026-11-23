#!/usr/bin/env python3
"""
Build data/snapshots/airports.json from the OurAirports open data (public domain).

    curl -O https://davidmegginson.github.io/ourairports-data/airports.csv
    curl -O https://davidmegginson.github.io/ourairports-data/runways.csv
    python3 scripts/build_airports.py airports.csv runways.csv

Keeps every large or medium airport with an IATA code and scheduled service, plus every Indian airport with an
IATA code. Each row: [icao, iata, name, city, country, lat, lon, elev_ft, size, [[runway_true_heading, length_ft], ...]].
"""
import csv
import json
import math
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "snapshots" / "airports.json"


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def main(ap_csv, rw_csv):
    keep = {}
    with open(ap_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            iata = (r["iata_code"] or "").strip()
            if not iata or r["type"] not in ("large_airport", "medium_airport", "small_airport"):
                continue
            india = r["iso_country"] == "IN"
            big = r["type"] in ("large_airport", "medium_airport") and r["scheduled_service"] == "yes"
            if not (big or (india and r["type"] != "small_airport") or (india and r["scheduled_service"] == "yes")):
                continue
            icao = (r["icao_code"] or r["gps_code"] or r["ident"]).strip()
            keep[r["ident"]] = [icao, iata, r["name"].strip(), (r["municipality"] or "").strip(), r["iso_country"],
                                round(float(r["latitude_deg"]), 4), round(float(r["longitude_deg"]), 4),
                                int(float(r["elevation_ft"] or 0)), {"large_airport": "L", "medium_airport": "M"}.get(r["type"], "S"), []]
    with open(rw_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            a = keep.get(r["airport_ident"])
            if not a or r["closed"] == "1" or not r["length_ft"]:
                continue
            if (r["surface"] or "").upper().startswith(("WATER", "GRASS", "TURF")):
                continue
            hdg = None
            if r["le_heading_degT"]:
                hdg = float(r["le_heading_degT"])
            elif r["le_latitude_deg"] and r["he_latitude_deg"]:
                hdg = bearing(float(r["le_latitude_deg"]), float(r["le_longitude_deg"]), float(r["he_latitude_deg"]), float(r["he_longitude_deg"]))
            else:
                num = "".join(c for c in (r["le_ident"] or "") if c.isdigit())
                hdg = int(num) * 10 if num else None
            if hdg is not None:
                a[9].append([round(hdg % 180), int(float(r["length_ft"]))])
    rows = sorted(keep.values(), key=lambda a: ({"L": 0, "M": 1, "S": 2}[a[8]], a[1]))
    OUT.write_text(json.dumps({"source": "OurAirports (public domain)", "fields": ["icao", "iata", "name", "city", "country", "lat", "lon", "elev_ft", "size", "runways"], "airports": rows}, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(rows)} airports -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
