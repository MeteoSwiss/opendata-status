#!/usr/bin/env python3
"""OGD monitor: checks how up to date the MeteoSwiss OGD products are on the FSDI STAC API.

Usage:
    python3 scripts/ogd_monitor.py --config config.json --data <data-dir>

Two kinds of checks, set per item in the configuration:
  metric "age"      minutes since the collection's most recently updated item was updated
  metric "latency"  publication latency: time from the data's reference time to its availability
                    - source "asset_name":      reference time from the asset file name, availability = asset creation on STAC
                    - source "station_now_csv": newest reference_timestamp in <station>_*_now.csv, availability = HTTP Last-Modified
                    A latency item also counts as down when its newest reference time is older than
                    interval_min + warn_max_min (no new data arriving).

Reads the existing history files from <data-dir> (if present) and writes:
    status.json         latest check, one row per item
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
        return dt.datetime(2000 + y, 1, 1, hh, mm, tzinfo=UTC) + dt.timedelta(days=j - 1)
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
        f = newest_item(api, item_cfg["collection"])
        if not f:
            return None, None, None
        best = None
        for name, a in f["assets"].items():
            ref = ref_time_from_name(name, src)
            if ref and (best is None or ref > best[0]):
                best = (ref, parse_iso(a.get("created") or a.get("updated")))
        return (best[0], best[1], None) if best else (None, None, None)

    runs = {}
    for f in newest_items(api, item_cfg["collection"], 2):  # today and, around midnight, the previous day
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


def parse_ref(s):
    s = s.strip()
    for fmt in ("%d.%m.%Y %H:%M", "%Y-%m-%d %H:%M", "%Y%m%d%H%M"):
        try:
            return dt.datetime.strptime(s[:16], fmt).replace(tzinfo=UTC)
        except ValueError:
            pass
    return None


def latency_from_station_csv(api, item_cfg):
    """(newest reference_timestamp, Last-Modified) of a station's *_now.csv."""
    src = item_cfg["source"]
    coll = item_cfg["collection"]
    short = coll.replace("ch.meteoschweiz.", "")
    station = src["station"]
    if station == "latest":
        f = newest_item(api, coll)
        if not f:
            return None, None
        station = f["id"]
    url = f"{FILES}/{coll}/{station}/{short}_{station}_{src.get('suffix', 't_now')}.csv"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=TIMEOUT_S) as r:
        lm = r.headers.get("Last-Modified")
        text = r.read().decode("utf-8", errors="replace")
    lines = [l for l in text.splitlines() if l.strip()]
    header = lines[0].split(";")
    i = header.index("reference_timestamp")
    refs = [parse_ref(l.split(";")[i]) for l in lines[1:] if len(l.split(";")) > i]
    refs = [r for r in refs if r]
    available = email.utils.parsedate_to_datetime(lm).astimezone(UTC) if lm else None
    return (max(refs) if refs else None), available


def classify(item_cfg, now, updated=None, ref=None, available=None):
    """Return (status, measured minutes). status: ok, warn, bad, static."""
    okm, warnm = item_cfg["ok_max_min"], item_cfg["warn_max_min"]
    if okm is None:
        return "static", None
    if item_cfg["metric"] == "age":
        if not updated:
            return "bad", None
        age = max(0.0, minutes(now, updated))
        return ("ok" if age <= okm else "warn" if age <= warnm else "bad"), age
    if not ref or not available:
        return "bad", None
    lat = max(0.0, minutes(available, ref))
    if minutes(now, ref) > item_cfg["interval_min"] + warnm:
        return "bad", lat  # no new data
    return ("ok" if lat <= okm else "warn" if lat <= warnm else "bad"), lat


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
        updated = ref = available = run = None
        try:
            if c["metric"] == "age":
                f = newest_item(api, c["collection"])
                updated = parse_iso(f["properties"]["updated"]) if f else None
            elif c["source"]["kind"] == "asset_name":
                ref, available, run = latency_from_assets(api, c, now)
            elif c["source"]["kind"] == "station_now_csv":
                ref, available = latency_from_station_csv(api, c)
        except Exception as e:  # network or format error for this item
            print(f"warning: {c['key']}: {e}", file=sys.stderr)
            failures += 1
        status, value = classify(c, now, updated, ref, available)
        rows.append({"key": c["key"], "collection": c["collection"], "group": c["group"], "metric": c["metric"],
                     "updated": iso(updated), "ref_time": iso(ref), "available": iso(available),
                     "value_min": value, "status": status, "checked": checked,
                     **({"run_files": run["files"], "run_files_expected": run["expected"], "run_complete": run["complete"]} if run else {})})
        if status == "static":
            continue
        items.append({"checked": checked, "key": c["key"], "status": status, "value_min": value})
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

    def dump(name, data, compact=False):
        with open(os.path.join(args.data, name), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, **({"separators": (",", ":")} if compact else {"indent": 1}))

    dump("status.json", rows)
    dump("history.json", history)
    dump("history_items.json", history_items, compact=True)
    print(f"{checked}: real-time up to date {counts['realtime_ok']}/{counts['realtime_total']}, "
          f"monitored {counts['monitored_ok']}/{counts['monitored_total']}")
    for r in rows:
        if r["metric"] == "latency":
            print(f"  {r['key']}: latency {r['value_min']} min, ref {r['ref_time']}, {r['status']}")


if __name__ == "__main__":
    main()
