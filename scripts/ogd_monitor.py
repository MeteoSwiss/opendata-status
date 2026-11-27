#!/usr/bin/env python3
"""OGD monitor: checks how up to date the MeteoSwiss OGD products are on the FSDI STAC API.

Usage:
    python3 scripts/ogd_monitor.py --config config.json --data <data-dir>

Two kinds of checks, set per item in the configuration:
  metric "age"      minutes since the collection's most recently updated item was updated
  metric "latency"  publication latency: time from the data's reference time to its availability
                    - source "asset_name":      reference time from the asset file name, availability = asset creation on STAC
                    - source "station_now_csv": newest reference_timestamp in <station>_*_now.csv, availability = "updated" of that
                      asset on the STAC API (the file's Last-Modified only as fallback: some files are
                      rewritten without new data). source.coverage: also count the stations whose file is current
                    A latency item also counts as down when its newest reference time is older than
                    interval_min + warn_max_min (no new data arriving).

Reads the existing history files from <data-dir> (if present) and writes:
    status.json         latest check, one row per item
    api-status.json     public JSON endpoint (published as api/v1/status.json), see README
    incidents.json      incidents of the last 30 days (published as api/v1/incidents.json)
    history.json        one row per check: how many real-time / monitored items were up to date
    history_items.json  one row per check and monitored item: status and measured minutes
History is kept for RETENTION_DAYS. Only the Python standard library is used.
"""
import argparse
import datetime as dt
import email.utils
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

RETENTION_DAYS = 30
TIMEOUT_S = 60
FILES = "https://data.geo.admin.ch"
UA = {"User-Agent": "MeteoSwiss-OGD-monitor"}
UTC = dt.timezone.utc


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def minutes(a, b):
    return round((a - b).total_seconds() / 60, 1)


def newest_items(api, collection, n=1):
    body = json.dumps({"collections": [collection], "limit": n,
                       "sortby": [{"field": "properties.updated", "direction": "desc"}]}).encode()
    req = urllib.request.Request(api.rstrip("/") + "/search", data=body,
                                 headers={**UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r).get("features", [])


def dated_items(api, collection, n=1):
    """Newest non-empty items of a collection with one item per day ("YYYYMMDD-ch"), newest first.

    The last update alone does not name the newest data: early in the morning an empty item for the
    next day appears, and items from about a week ago are touched again. Both made radar data look
    stalled. So: take the recently updated items, drop empty ones and order them by id (= date)."""
    feats = [f for f in newest_items(api, collection, 6) if f.get("assets")]
    return sorted(feats, key=lambda f: f["id"], reverse=True)[:n]


def newest_filled_item(api, collection):
    """Most recently updated item that holds files (empty placeholder items, e.g. for the next
    month, are created ahead of time and would make the data look fresh)."""
    return next((f for f in newest_items(api, collection, 6) if f.get("assets")), None)


def newest_asset_time(api, collection):
    """Creation time of the newest file in the newest dated item (age of e.g. radar hail)."""
    times = [parse_iso(a.get("created") or a.get("updated"))
             for f in dated_items(api, collection, 1) for a in f["assets"].values()
             if a.get("created") or a.get("updated")]
    return max(times) if times else None


def newest_item(api, collection):
    features = newest_items(api, collection)
    return features[0] if features else None


def ref_time_from_name(name, src):
    """Reference time (UTC) encoded in an asset file name, or None."""
    if not name.startswith(src["prefix"]):
        return None
    rest = name[len(src["prefix"]):]
    if src["time"] == "yyjjjhhmm":  # e.g. rzc263141550vl.001.h5 -> 2026, day 314, 15:50
        m = re.match(r"(\d{2})(\d{3})(\d{2})(\d{2})", rest)
        if not m:
            return None
        y, j, hh, mm = (int(g) for g in m.groups())
        # 2400 = midnight at the end of that day
        return dt.datetime(2000 + y, 1, 1, tzinfo=UTC) + dt.timedelta(days=j - 1, hours=hh, minutes=mm)
    if src["time"] == "yyyymmddhhmm":  # e.g. vnut12.lssw.202611101500.tre200h0.csv
        m = re.search(r"(\d{12})", rest)
        return dt.datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=UTC) if m else None
    raise ValueError(f"unknown time format {src['time']}")


def latency_from_assets(api, item_cfg, now):
    """(reference time, available time, run info) of the newest matching data.

    With source.complete_run, a model run counts as available when its last file is there
    (all parameters). If the newest run is still incomplete within the target, the previous
    complete run is used; if it is incomplete beyond the target, the latency so far
    (now - reference time) is reported and the run is marked incomplete."""
    src = item_cfg["source"]
    if not src.get("complete_run"):
        best = None
        for f in dated_items(api, item_cfg["collection"], 2):  # today and, after midnight, yesterday
            for name, a in f["assets"].items():
                ref = ref_time_from_name(name, src)
                if ref and (best is None or ref > best[0]):
                    best = (ref, parse_iso(a.get("created") or a.get("updated")))
        return (best[0], best[1], None) if best else (None, None, None)

    runs = {}
    for f in dated_items(api, item_cfg["collection"], 2):  # today and, around midnight, the previous day
        for name, a in f["assets"].items():
            ref = ref_time_from_name(name, src)
            if ref:
                runs.setdefault(ref, []).append(parse_iso(a.get("created") or a.get("updated")))
    if not runs:
        return None, None, None
    expected = max(len(v) for v in runs.values())
    order = sorted(runs, reverse=True)
    newest = order[0]
    if len(runs[newest]) >= expected:
        return newest, max(runs[newest]), {"files": len(runs[newest]), "expected": expected, "complete": True}
    if minutes(now, newest) > item_cfg["ok_max_min"]:
        return newest, now, {"files": len(runs[newest]), "expected": expected, "complete": False}
    for ref in order[1:]:
        if len(runs[ref]) >= expected:
            return ref, max(runs[ref]), {"files": len(runs[ref]), "expected": expected, "complete": True}
    return newest, now, {"files": len(runs[newest]), "expected": expected, "complete": False}


def newest_file(api, item_cfg):
    """Download URL of the newest file of an item (None where the measurement already read a file)."""
    src = item_cfg.get("source", {})
    coll = item_cfg["collection"]
    if src.get("kind") == "station_now_csv":
        return None
    if src.get("kind") == "asset_name":
        feats, key = dated_items(api, coll, 2), lambda name, a: (ref_time_from_name(name, src), a.get("created") or "")
    elif src.get("kind") == "newest_asset":
        feats, key = dated_items(api, coll, 1), lambda name, a: (True, a.get("created") or a.get("updated") or "")
    else:
        feats, key = [f for f in [newest_filled_item(api, coll)] if f], lambda name, a: (True, a.get("created") or a.get("updated") or "")
    best = None
    for f in feats:
        for name, a in f.get("assets", {}).items():
            k = key(name, a)
            if k[0] and a.get("href") and (best is None or k > best[0]):
                best = (k, a["href"])
    return best[1] if best else None


def check_access(url, tries=2):
    """Fetch the first kilobyte of a file, as a user would: is it actually downloadable?

    Returns {"ok", "host", "http_status"} (plus "error"); signed URLs are never stored."""
    host = urllib.parse.urlsplit(url).hostname
    result = {}
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-1023"})
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                body = r.read(1024)
                return {"ok": r.status in (200, 206) and len(body) > 0, "host": host, "http_status": r.status}
        except urllib.error.HTTPError as e:
            result = {"ok": False, "host": host, "http_status": e.code, "error": f"HTTP {e.code}"}
        except Exception as e:  # timeout, DNS, TLS, connection refused
            result = {"ok": False, "host": host, "http_status": None, "error": type(e).__name__}
        if attempt + 1 < tries:
            time.sleep(5)
    return result


REASONS = ("no_new_data", "late", "run_incomplete", "download_failed", "no_data", "check_failed")


def failure_reason(c, now, status, updated, ref, run, access, error):
    """(reason code, short detail) for a check that is not ok, else (None, None)."""
    if status not in ("warn", "bad"):
        return None, None
    if access and not access.get("ok"):
        return "download_failed", f"{access.get('error') or 'HTTP ' + str(access.get('http_status'))}, {access.get('host')}"
    if error:
        return "check_failed", error
    if c["metric"] == "age":
        return ("no_new_data", None) if updated else ("no_data", None)
    if not ref:
        return "no_data", None
    if minutes(now, ref) > c["interval_min"] + c["warn_max_min"]:
        return "no_new_data", None
    if run and not run["complete"]:
        return "run_incomplete", f"{run['files']}/{run['expected']}"
    return "late", None


def assess_backfill(api, c, episode, cache):
    """After an episode has ended: which data of the gap came late, which are still missing.

    Only for datasets whose file names carry their reference time (radar images, local forecast
    runs); config `backfill` names prefix, time format and interval where `source` does not.
    Expected are all reference times after the last one available at the start of the episode
    that should have been available (reference time + target) by its end."""
    spec = c.get("backfill") or (c["source"] if c.get("source", {}).get("kind") == "asset_name" else None)
    if not spec or not episode.get("end"):
        return None
    start, end = parse_iso(episode["start"]), parse_iso(episode["end"])
    step = dt.timedelta(minutes=spec.get("interval_min") or c["interval_min"])
    target = c["ok_max_min"]
    refs = {}  # reference time -> creation times of its files
    day = (start - dt.timedelta(days=1)).date()
    while day <= end.date():
        key = (c["collection"], day)
        if key not in cache:
            try:
                cache[key] = get_item(api, c["collection"], day.strftime("%Y%m%d") + "-ch")
            except Exception:
                cache[key] = None
        for name, a in ((cache[key] or {}).get("assets") or {}).items():
            ref = ref_time_from_name(name, spec)
            created = a.get("created") or a.get("updated")
            if ref and created:
                refs.setdefault(ref, []).append(parse_iso(created))
        day += dt.timedelta(days=1)
    if not refs:  # items of that time no longer on the STAC API
        return None
    full = max(len(cs) for cs in refs.values()) if spec.get("complete_run") else 1
    # last data that were complete before the episode began; the gap starts after them
    before = [r for r, cs in refs.items() if len(cs) >= full and (max(cs) if spec.get("complete_run") else min(cs)) <= start]
    if not before:
        return None
    late, missing, incomplete, on_time, worst = [], [], [], 0, 0.0
    r = max(before) + step
    while r + dt.timedelta(minutes=target) <= end:
        cs = refs.get(r)
        if not cs:
            missing.append(iso(r))
        elif len(cs) < full:
            incomplete.append({"ref": iso(r), "files": len(cs)})
        else:
            # a run is there with its last file; an image with its first copy
            delay = minutes(max(cs) if spec.get("complete_run") else min(cs), r)
            if delay > target:
                late.append(iso(r))
                worst = max(worst, delay)
            else:
                on_time += 1
        r += step
    return {"unit": spec.get("unit") or ("run" if spec.get("complete_run") else "image"), "files_expected": full,
            "interval_min": int(step.total_seconds() // 60), "late": late, "missing": missing,
            "incomplete": incomplete, "on_time": on_time, "max_delay_min": worst, "assessed": iso(dt.datetime.now(UTC))}


def build_incidents(cfg, history_items, now, join_min=60, api=None):
    """Incidents of the history window, newest first.

    An episode is a run of consecutive checks of one dataset that are not ok; it ends with the next
    ok check. Episodes that start within `join_min` minutes of each other, or a failure that starts
    while another failure of the incident still runs, form one incident. Single
    delayed checks are left out as noise. The likely layer follows from what failed and how much:
    only downloads from one storage host, nearly all datasets (STAC API), several datasets (data
    delivery) or a single dataset."""
    rated = {c["key"] for c in cfg["items"] if c.get("ok_max_min") is not None}
    by_key = {}
    for r in sorted(history_items, key=lambda r: r["checked"]):
        if r["key"] in rated:
            by_key.setdefault(r["key"], []).append(r)
    episodes = []
    for key, rs in by_key.items():
        cur = None
        for r in rs:
            if r["status"] in ("warn", "bad"):
                if cur is None:
                    cur = {"key": key, "start": r["checked"], "end": None, "severity": "warn", "checks": 0,
                           "reasons": [], "details": []}
                cur["checks"] += 1
                cur["last_seen"] = r["checked"]
                if r["status"] == "bad":
                    cur["severity"] = "bad"
                if r.get("reason") and r["reason"] not in cur["reasons"]:
                    cur["reasons"].append(r["reason"])
                if r.get("detail") and r["detail"] not in cur["details"]:
                    cur["details"].append(r["detail"])
            elif cur is not None:
                cur["end"] = r["checked"]
                episodes.append(cur)
                cur = None
        if cur is not None:
            episodes.append(cur)
    episodes = [e for e in episodes if e["severity"] == "bad" or e["checks"] >= 2]
    if api:
        cfg_by_key = {c["key"]: c for c in cfg["items"]}
        cache = {}
        for e in episodes:
            try:
                e["backfill"] = assess_backfill(api, cfg_by_key[e["key"]], e, cache)
            except Exception as err:  # the incident list works without it
                print(f"warning: backfill {e['key']}: {err}", file=sys.stderr)

    incidents = []
    for e in sorted(episodes, key=lambda e: e["start"]):
        inc = incidents[-1] if incidents else None
        # same incident: starts close to it, or a failure that starts while one of its failures still runs
        running = inc and e["severity"] == "bad" and any(
            x["severity"] == "bad" and x["start"] <= e["start"] and (x["end"] is None or e["start"] < x["end"])
            for x in inc["datasets"])
        if inc and (running or minutes(parse_iso(e["start"]), parse_iso(inc["start"])) <= join_min):
            inc["datasets"].append(e)
        else:
            incidents.append({"start": e["start"], "datasets": [e]})

    out = []
    for inc in incidents:
        ds = inc["datasets"]
        ongoing = any(e["end"] is None for e in ds)
        end = None if ongoing else max(e["end"] for e in ds)
        reasons = [r for e in ds for r in e["reasons"]]
        hosts = sorted({d.split(", ")[-1] for e in ds for d in e["details"] if ", " in d})
        if reasons and all(r == "download_failed" for r in reasons) and len(hosts) == 1:
            layer = "storage"
        elif len(ds) >= 0.8 * len(rated):
            layer = "catalog"
        elif len(ds) >= 2:
            layer = "delivery"
        else:
            layer = "dataset"
        out.append({
            "id": inc["start"].replace(":", "").replace("-", "") + "-" + ds[0]["key"],
            "start": inc["start"],
            "end": end,
            "ongoing": ongoing,
            "duration_min": round(minutes(parse_iso(end) if end else now, parse_iso(inc["start"])), 1),
            "severity": "bad" if any(e["severity"] == "bad" for e in ds) else "warn",
            "layer": layer,
            **({"hosts": hosts} if layer == "storage" else {}),
            "datasets": [{**{k: e[k] for k in ("key", "start", "end", "severity", "checks", "reasons", "details")},
                          **({"backfill": e["backfill"]} if e.get("backfill") else {})} for e in ds],
        })
    return {"generated": iso(now), "check_interval_min": 30, "incidents": sorted(out, key=lambda i: i["start"], reverse=True)}


def parse_ref(s):
    s = s.strip()
    for fmt in ("%d.%m.%Y %H:%M", "%Y-%m-%d %H:%M", "%Y%m%d%H%M"):
        try:
            return dt.datetime.strptime(s[:16], fmt).replace(tzinfo=UTC)
        except ValueError:
            pass
    return None


def station_items(api, collection):
    """All station items of a collection (one search request)."""
    body = json.dumps({"collections": [collection], "limit": 100}).encode()
    req = urllib.request.Request(api.rstrip("/") + "/search", data=body,
                                 headers={**UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r).get("features", [])


def get_item(api, collection, item_id):
    url = f"{api.rstrip('/')}/collections/{collection}/items/{item_id}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=TIMEOUT_S) as r:
        return json.load(r)


def now_asset(feature, suffix):
    """The station's *_<suffix>.csv asset (dict) or None."""
    for name, a in (feature or {}).get("assets", {}).items():
        if name.endswith(f"_{suffix}.csv"):
            return a
    return None


def asset_updated(a):
    v = a and (a.get("updated") or a.get("created"))
    return parse_iso(v) if v else None


def latency_from_station_csv(api, item_cfg, now):
    """(newest reference_timestamp, availability, station coverage or None) of a station's *_now.csv.

    station "latest": the most recently updated station; with source.aggregate "median" the station
    with the median latency among all current stations.

    Availability is the "updated" time of the asset on the STAC API. The file's Last-Modified is not
    reliable for every collection: pollen files are rewritten between updates without new data, which
    made the latency look up to 50 minutes longer than it was.
    """
    src = item_cfg["source"]
    coll = item_cfg["collection"]
    short = coll.replace("ch.meteoschweiz.", "")
    suffix = src.get("suffix", "t_now")
    station = src["station"]
    feats = station_items(api, coll) if station == "latest" or src.get("coverage") else None

    coverage = None
    if src.get("coverage"):
        limit = item_cfg["interval_min"] + item_cfg["warn_max_min"]
        with_file = [(f, asset_updated(now_asset(f, suffix))) for f in feats if now_asset(f, suffix)]
        stale = sorted((f["properties"].get("title") or f["id"].upper()) for f, u in with_file
                       if not u or minutes(now, u) > limit)
        coverage = {"total": len(with_file), "ok": len(with_file) - len(stale), "stale": stale}

    def measure_station(feature):
        sid = feature["id"]
        url = f"{FILES}/{coll}/{sid}/{short}_{sid}_{suffix}.csv"
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=TIMEOUT_S) as r:
            lm = r.headers.get("Last-Modified")
            text = r.read().decode("utf-8", errors="replace")
        lines = [l for l in text.splitlines() if l.strip()]
        i = lines[0].split(";").index("reference_timestamp")
        refs = [parse_ref(l.split(";")[i]) for l in lines[1:] if len(l.split(";")) > i]
        refs = [r for r in refs if r]
        ref = max(refs) if refs else None
        available = asset_updated(now_asset(feature, suffix))
        modified = email.utils.parsedate_to_datetime(lm).astimezone(UTC) if lm else None
        if not available:
            return ref, modified
        # The CDN keeps some files for up to two hours (pollen: Cache-Control max-age=7200), so the copy
        # we get can be older than the update on the STAC API. Then the newest reference time is not in
        # our copy: estimate it as the start of the interval in which the update happened.
        if modified and (available - modified).total_seconds() > 60:
            step = item_cfg["interval_min"] * 60
            estimate = dt.datetime.fromtimestamp(available.timestamp() // step * step, UTC)
            if not ref or estimate > ref:
                ref = estimate
        return ref, available

    if station != "latest":
        ref, available = measure_station(get_item(api, coll, station))
        return ref, available, coverage

    cands = [f for f in feats if asset_updated(now_asset(f, suffix))]
    if not cands:
        return None, None, coverage
    if src.get("aggregate") != "median":
        ref, available = measure_station(max(cands, key=lambda f: asset_updated(now_asset(f, suffix))))
        return ref, available, coverage

    # median over the current stations: one late station does not make the whole dataset late
    # (it shows up in the station coverage instead)
    limit = item_cfg["interval_min"] + item_cfg["warn_max_min"]
    current = [f for f in cands if minutes(now, asset_updated(now_asset(f, suffix))) <= limit] or cands
    measured = []
    for f in current:
        try:
            ref, available = measure_station(f)
        except Exception as e:  # one unreadable station file does not stop the measurement
            print(f"warning: {item_cfg['key']}/{f['id']}: {e}", file=sys.stderr)
            continue
        if ref and available:
            measured.append((minutes(available, ref), ref, available))
    if not measured:
        return None, None, coverage
    measured.sort(key=lambda m: m[0])
    _, ref, available = measured[(len(measured) - 1) // 2]
    return ref, available, coverage


def pause_end(item_cfg, now):
    """Start of the first month after the most recent seasonal break (None without a break)."""
    months = set(item_cfg.get("season", {}).get("pause_months", []))
    if not months:
        return None
    y, m = now.year, now.month
    for _ in range(12):
        prev = 12 if m == 1 else m - 1
        if m not in months and prev in months:
            return dt.datetime(y, m, 1, tzinfo=UTC)
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return None


def classify(item_cfg, now, updated=None, ref=None, available=None):
    """Return (status, measured minutes). status: ok, warn, bad, pause, static."""
    okm, warnm = item_cfg["ok_max_min"], item_cfg["warn_max_min"]
    if okm is None:
        return "static", None
    if now.month in item_cfg.get("season", {}).get("pause_months", []):
        # seasonal break (e.g. phenology in winter): measured, but not rated and not counted
        return "pause", (max(0.0, minutes(now, updated)) if updated else None)
    if item_cfg["metric"] == "age":
        if not updated:
            return "bad", None
        age = max(0.0, minutes(now, updated))
        # after a seasonal break, the expected interval runs from the end of the break
        start = pause_end(item_cfg, now)
        rated = min(age, minutes(now, start)) if start and updated < start else age
        return ("ok" if rated <= okm else "warn" if rated <= warnm else "bad"), age
    if not ref or not available:
        return "bad", None
    lat = max(0.0, minutes(available, ref))
    if minutes(now, ref) > item_cfg["interval_min"] + warnm:
        return "bad", lat  # no new data
    return ("ok" if lat <= okm else "warn" if lat <= warnm else "bad"), lat


def apply_corrections(cfg, path, history, history_items):
    """Overwrite history entries that were measured wrongly, and recount their checks.

    corrections.json lists entries {key, checked, status, value_min}. Applying them is idempotent,
    so the file can stay in the repository until its entries have left the 30-day history."""
    if not path or not os.path.exists(path):
        return
    data = load(path)
    fixes = {(c["key"], c["checked"]): c for c in (data.get("items", []) if isinstance(data, dict) else [])}
    touched = set()
    for r in history_items:
        fix = fixes.get((r.get("key"), r.get("checked")))
        if fix and (r["status"], r["value_min"]) != (fix["status"], fix.get("value_min")):
            r["status"], r["value_min"] = fix["status"], fix.get("value_min")
            touched.add(r["checked"])
    if not touched:
        return
    realtime = {c["key"] for c in cfg["items"] if c.get("realtime")}
    for h in history:
        if h["checked"] not in touched:
            continue
        rs = [r for r in history_items if r["checked"] == h["checked"] and r["status"] != "pause"]
        h["monitored_total"] = len(rs)
        h["monitored_ok"] = sum(r["status"] == "ok" for r in rs)
        h["realtime_total"] = sum(r["key"] in realtime for r in rs)
        h["realtime_ok"] = sum(r["status"] == "ok" and r["key"] in realtime for r in rs)
    print(f"corrections applied to {len(touched)} checks")


DOCS = "https://opendatadocs.meteoswiss.ch"
API_VERSION = 1


def api_status(cfg, rows, history, history_items, now, checked):
    """Public status document (api/v1/status.json): the latest check with names, links and targets,
    plus the share of checks with status ok per item over the last 24 hours and 30 days."""
    by_key = {c["key"]: c for c in cfg["items"]}
    # absolute links on GitHub Pages (owner.github.io/repo/), relative ones elsewhere
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    base = f"https://{repo.split('/')[0].lower()}.github.io/{repo.split('/')[1]}/" if "/" in repo else "../../"

    def share(key, hours):
        rs = [r for r in history_items if r["key"] == key and r["status"] != "pause"
              and (now - parse_iso(r["checked"])).total_seconds() <= hours * 3600]
        return round(100 * sum(r["status"] == "ok" for r in rs) / len(rs), 1) if rs else None

    def iso(v):
        return v if v is None or isinstance(v, str) else v.strftime("%Y-%m-%dT%H:%M:%SZ")

    items = []
    for r in rows:
        c = by_key[r["key"]]
        rated = r["status"] not in ("static", "pause")
        item = {
            "key": c["key"],
            "name": c["name"],
            "group": c["group"],
            "collection": c["collection"],
            "documentation": (DOCS + c["doc"]) if c.get("doc") else None,
            "realtime": bool(c.get("realtime")),
            "metric": c["metric"],
            "interval": c.get("interval"),
            "status": r["status"],
            "value_min": r["value_min"],
            "target_min": c.get("ok_max_min"),
            "limit_min": c.get("warn_max_min"),
            # latency: reference time of the newest data and when it became available;
            # age: when the newest files were published (not the time the data refer to)
            "reference_time": iso(r["ref_time"]),
            "published": iso(r["available"] if c["metric"] == "latency" else r["updated"]),
            "ok_share_24h_pct": share(c["key"], 24) if rated else None,
            "ok_share_30d_pct": share(c["key"], 24 * 30) if rated else None,
        }
        if r.get("model_run"):
            item["model_run"] = r["model_run"]
        if r.get("access"):
            item["access"] = r["access"]
        if "stations_total" in r:
            item["stations"] = {"total": r["stations_total"], "ok": r["stations_ok"], "not_up_to_date": r["stations_stale"]}
        items.append(item)

    rated = [i for i in items if i["status"] in ("ok", "warn", "bad")]
    worst = lambda xs: "bad" if any(x["status"] == "bad" for x in xs) else "warn" if any(x["status"] == "warn" for x in xs) else "ok"
    groups = []
    for g in sorted({i["group"] for i in items}):
        gi = [i for i in rated if i["group"] == g]
        if gi:
            groups.append({"group": g, "status": worst(gi), "total": len(gi), "ok": sum(i["status"] == "ok" for i in gi)})
    rt = [i for i in rated if i["realtime"]]
    last = history[-1] if history else {}
    month = [h for h in history if (now - parse_iso(h["checked"])).days < 30 and h.get("monitored_total")]
    return {
        "api_version": API_VERSION,
        "checked": checked,
        "status": worst(rated),
        "summary": {
            "monitored": {"total": len(rated), "ok": sum(i["status"] == "ok" for i in rated)},
            "realtime": {"total": len(rt), "ok": sum(i["status"] == "ok" for i in rt)},
            "all_ok_share_30d_pct": round(100 * sum(h["monitored_ok"] == h["monitored_total"] for h in month) / len(month), 1) if month else None,
        },
        "groups": groups,
        "items": items,
        "links": {
            "page": base,
            "history": base + "data/history.json",
            "history_items": base + "data/history_items.json",
            "stac_api": cfg.get("stac_api", "https://data.geo.admin.ch/api/stac/v1"),
        },
    }


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--corrections", help="JSON file with corrected history entries "
                    "(default: corrections.json next to the config, if present)")
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    api = cfg["stac_api"]
    os.makedirs(args.data, exist_ok=True)
    now = dt.datetime.now(UTC).replace(microsecond=0)
    checked = iso(now)

    rows, items, failures = [], [], 0
    counts = {"realtime_total": 0, "realtime_ok": 0, "monitored_total": 0, "monitored_ok": 0}
    for c in cfg["items"]:
        updated = ref = available = run = coverage = model_run = error = None
        try:
            if c["metric"] == "age":
                if c.get("source", {}).get("kind") == "newest_asset":
                    updated = newest_asset_time(api, c["collection"])
                else:
                    f = newest_filled_item(api, c["collection"])
                    updated = parse_iso(f["properties"]["updated"]) if f else None
                    # forecast models: the run the newest files belong to
                    model_run = (f or {}).get("properties", {}).get("forecast:reference_datetime")
            elif c["source"]["kind"] == "asset_name":
                ref, available, run = latency_from_assets(api, c, now)
            elif c["source"]["kind"] == "station_now_csv":
                ref, available, coverage = latency_from_station_csv(api, c, now)
        except Exception as e:  # network or format error for this item
            print(f"warning: {c['key']}: {e}", file=sys.stderr)
            failures += 1
            error = type(e).__name__
        status, value = classify(c, now, updated, ref, available)
        # can users actually download the newest file? (catalog entries alone say nothing about storage)
        access = None
        if status in ("ok", "warn", "pause"):
            try:
                url = newest_file(api, c)
                if url:
                    access = check_access(url)
                elif c.get("source", {}).get("kind") == "station_now_csv" and ref:
                    access = {"ok": True, "host": urllib.parse.urlsplit(FILES).hostname, "http_status": 200}
            except Exception as e:
                print(f"warning: {c['key']}: access check: {e}", file=sys.stderr)
            if access and not access["ok"]:
                print(f"  {c['key']}: newest file not downloadable ({access.get('error')}, {access['host']})")
                if status != "pause":
                    status = "bad"
        reason, detail = failure_reason(c, now, status, updated, ref, run, access, error)
        rows.append({"key": c["key"], "collection": c["collection"], "group": c["group"], "metric": c["metric"],
                     "updated": iso(updated), "ref_time": iso(ref), "available": iso(available),
                     "value_min": value, "status": status, "checked": checked,
                     **({"run_files": run["files"], "run_files_expected": run["expected"], "run_complete": run["complete"]} if run else {}),
                     **({"stations_total": coverage["total"], "stations_ok": coverage["ok"], "stations_stale": coverage["stale"]} if coverage else {}),
                     **({"model_run": model_run} if model_run else {}),
                     **({"access": access} if access else {}),
                     **({"reason": reason, "detail": detail} if reason else {})})
        if status == "static":
            continue
        items.append({"checked": checked, "key": c["key"], "status": status, "value_min": value,
                      **({"reason": reason} if reason else {}), **({"detail": detail} if detail else {})})
        if status == "pause":
            continue
        counts["monitored_total"] += 1
        counts["monitored_ok"] += status == "ok"
        if c["realtime"]:
            counts["realtime_total"] += 1
            counts["realtime_ok"] += status == "ok"

    if failures == len(cfg["items"]):
        sys.exit("STAC API not reachable, nothing written")

    keep = lambda r: (now - parse_iso(r["checked"])).days < RETENTION_DAYS
    history = [r for r in load(os.path.join(args.data, "history.json")) if keep(r)]
    history.append({"checked": checked, **counts})
    history_items = [r for r in load(os.path.join(args.data, "history_items.json")) if keep(r) and "key" in r] + items

    corrections = args.corrections or os.path.join(os.path.dirname(os.path.abspath(args.config)), "corrections.json")
    apply_corrections(cfg, corrections, history, history_items)

    def dump(name, data, compact=False):
        with open(os.path.join(args.data, name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, **({"separators": (",", ":")} if compact else {"indent": 1}))

    dump("status.json", rows)
    dump("api-status.json", api_status(cfg, rows, history, history_items, now, checked))
    dump("incidents.json", build_incidents(cfg, history_items, now, api=api))
    dump("history.json", history)
    dump("history_items.json", history_items, compact=True)
    print(f"{checked}: real-time up to date {counts['realtime_ok']}/{counts['realtime_total']}, "
          f"monitored {counts['monitored_ok']}/{counts['monitored_total']}")
    for r in rows:
        if r["metric"] == "latency":
            print(f"  {r['key']}: latency {r['value_min']} min, ref {r['ref_time']}, {r['status']}")


if __name__ == "__main__":
    main()
