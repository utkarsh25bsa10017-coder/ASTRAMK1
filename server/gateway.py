"""
ASTRA data gateway: fetches free public data sources, caches them on disk,
and falls back to stale cache or committed snapshots when a source is down.

Standard library only.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))
# Serverless platforms have a read-only code directory; only /tmp is writable.
CACHE_DIR = Path("/tmp/astra-cache") if SERVERLESS else ROOT / "data" / "cache"
SNAP_DIR = ROOT / "data" / "snapshots"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
try:
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass

USER_AGENT = "ASTRA-hackathon-dashboard/1.0 (educational, non-commercial)"

# Per-source health log, shown on the Data Gateway page.
_health: dict[str, dict] = {}
_health_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}
_down_until: dict[str, float] = {}
COOLDOWN = 600  # seconds to skip a source after a network failure
_key_locks_guard = threading.Lock()


class SourceUnavailable(Exception):
    pass


def _safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:180]


def _lock_for(key: str) -> threading.Lock:
    with _key_locks_guard:
        if key not in _key_locks:
            _key_locks[key] = threading.Lock()
        return _key_locks[key]


def _record(source: str, ok: bool, ms: float | None, detail: str = "", nbytes: int = 0):
    with _health_lock:
        h = _health.setdefault(source, {"ok": 0, "fail": 0})
        h["ok" if ok else "fail"] += 1
        h["last_status"] = "ok" if ok else "error"
        h["last_time"] = time.time()
        h["last_ms"] = round(ms) if ms is not None else None
        h["last_detail"] = detail[:200]
        if ok:
            h["last_bytes"] = nbytes


def health() -> dict:
    with _health_lock:
        out = json.loads(json.dumps(_health))
    now = time.time()
    for src, until in _down_until.items():
        if until > now and src in out:
            out[src]["cooldown_s"] = round(until - now)
    return out


def http_get(url: str, timeout: float = 30, headers: dict | None = None,
             data: bytes | None = None, method: str | None = None) -> bytes:
    h = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, data=data, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body


def fetch_raw(source: str, key: str, url: str, ttl: float, timeout: float = 30,
              headers: dict | None = None, data: bytes | None = None,
              method: str | None = None) -> tuple[bytes, str]:
    """Return (bytes, provenance). provenance is live | cache | stale."""
    path = CACHE_DIR / ("raw_" + _safe(key))
    if path.exists() and time.time() - path.stat().st_mtime < ttl:
        with _health_lock:
            if source not in _health:
                _health[source] = {"ok": 0, "fail": 0, "last_status": "cache", "last_time": path.stat().st_mtime,
                                   "last_ms": None, "last_detail": "", "last_bytes": path.stat().st_size}
        return path.read_bytes(), "cache"
    # Circuit breaker: after a failure, don't hammer a down/rate-limiting source.
    if _down_until.get(source, 0) > time.time():
        if path.exists():
            return path.read_bytes(), "stale"
        raise SourceUnavailable(f"{source}: temporarily unreachable (retrying after cool-down)")
    with _lock_for(key):
        if path.exists() and time.time() - path.stat().st_mtime < ttl:
            return path.read_bytes(), "cache"
        t0 = time.time()
        try:
            body = http_get(url, timeout=timeout, headers=headers, data=data, method=method)
            ms = (time.time() - t0) * 1000
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, path)
            _record(source, True, ms, nbytes=len(body))
            return body, "live"
        except Exception as e:  # network error, HTTP error, timeout
            _record(source, False, (time.time() - t0) * 1000, f"{type(e).__name__}: {e}")
            if not (isinstance(e, urllib.error.HTTPError) and e.code in (400, 404)):
                _down_until[source] = time.time() + COOLDOWN
            if path.exists():
                return path.read_bytes(), "stale"
            raise SourceUnavailable(f"{source}: {e}") from e


# ---------------------------------------------------------------------------
# Derived API results: memory + disk cache + committed snapshot fallback.
# ---------------------------------------------------------------------------
_mem: dict[str, tuple[float, object, str]] = {}
_mem_lock = threading.Lock()


def cached_result(name: str, ttl: float, builder) -> tuple[object, str]:
    """builder() -> (obj, provenance_of_inputs). Returns (obj, provenance)."""
    now = time.time()
    with _mem_lock:
        hit = _mem.get(name)
    if hit and now - hit[0] < ttl:
        return hit[1], hit[2] if hit[2] != "live" else "cache"

    disk = CACHE_DIR / ("api_" + _safe(name) + ".json")
    if disk.exists() and now - disk.stat().st_mtime < ttl:
        obj = json.loads(disk.read_text())
        with _mem_lock:
            _mem[name] = (disk.stat().st_mtime, obj, "cache")
        return obj, "cache"

    with _lock_for("api:" + name):
        with _mem_lock:
            hit = _mem.get(name)
        if hit and time.time() - hit[0] < ttl:
            return hit[1], "cache"
        try:
            obj, prov = builder()
            tmp = disk.with_suffix(".tmp")
            tmp.write_text(json.dumps(obj, separators=(",", ":")))
            os.replace(tmp, disk)
            with _mem_lock:
                _mem[name] = (time.time(), obj, prov)
            return obj, prov
        except Exception as e:
            print(f"[gateway] build failed for {name}: {type(e).__name__}: {e}")
            if disk.exists():
                return json.loads(disk.read_text()), "stale"
            snap = SNAP_DIR / (_safe(name) + ".json")
            if snap.exists():
                return json.loads(snap.read_text()), "snapshot"
            raise SourceUnavailable(str(e)) from e


def worst(*provs: str) -> str:
    order = ["live", "cache", "stale", "snapshot"]
    provs = [p for p in provs if p in order] or ["live"]
    return max(provs, key=order.index)
