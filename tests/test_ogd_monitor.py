"""Tests of the pure functions in scripts/ogd_monitor.py (no network).

Run: python3 -m unittest discover -s tests
"""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import ogd_monitor as m  # noqa: E402

UTC = dt.timezone.utc


def t(s):
    return dt.datetime.fromisoformat(s).replace(tzinfo=UTC)


AGE = {"key": "a", "metric": "age", "ok_max_min": 20, "warn_max_min": 60}
LAT = {"key": "l", "metric": "latency", "interval_min": 10, "ok_max_min": 15, "warn_max_min": 45}
PHENO = {"key": "p", "metric": "age", "ok_max_min": 15840, "warn_max_min": 30240,
         "season": {"pause_months": [12, 1, 2]}}


class Iso(unittest.TestCase):
    def test_formats_and_passes_through(self):
        self.assertEqual(m.iso(t("2026-11-24T01:02:03")), "2026-11-24T01:02:03Z")
        self.assertEqual(m.iso("2026-11-24T01:02:03Z"), "2026-11-24T01:02:03Z")
        self.assertIsNone(m.iso(None))


class RefTimeFromName(unittest.TestCase):
    def test_yyjjjhhmm(self):
        src = {"prefix": "rzc", "time": "yyjjjhhmm"}
        # day 314 of 2026 = 10 November
        self.assertEqual(m.ref_time_from_name("rzc263141550vl.001.h5", src), t("2026-11-10T15:50"))

    def test_yyyymmddhhmm(self):
        src = {"prefix": "vnut12", "time": "yyyymmddhhmm"}
        self.assertEqual(m.ref_time_from_name("vnut12.lssw.202611101500.tre200h0.csv", src), t("2026-11-10T15:00"))

    def test_other_prefix_or_no_time(self):
        src = {"prefix": "rzc", "time": "yyjjjhhmm"}
        self.assertIsNone(m.ref_time_from_name("cpc263141550.h5", src))
        self.assertIsNone(m.ref_time_from_name("rzc_readme.txt", src))

    def test_unknown_format_raises(self):
        with self.assertRaises(ValueError):
            m.ref_time_from_name("rzc1", {"prefix": "rzc", "time": "unix"})


class ParseRef(unittest.TestCase):
    def test_formats(self):
        for s in ("24.11.2026 01:30", "2026-11-24 01:30", "202611240130", " 24.11.2026 01:30:00 "):
            self.assertEqual(m.parse_ref(s), t("2026-11-24T01:30"), s)

    def test_invalid(self):
        self.assertIsNone(m.parse_ref("n/a"))


class PauseEnd(unittest.TestCase):
    def test_after_break(self):
        self.assertEqual(m.pause_end(PHENO, t("2026-03-15T00:00")), t("2026-03-01T00:00"))
        self.assertEqual(m.pause_end(PHENO, t("2026-11-15T00:00")), t("2026-03-01T00:00"))

    def test_without_break(self):
        self.assertIsNone(m.pause_end(AGE, t("2026-03-15T00:00")))


class Classify(unittest.TestCase):
    now = t("2026-11-24T12:00")

    def test_static(self):
        self.assertEqual(m.classify({"ok_max_min": None, "warn_max_min": None}, self.now), ("static", None))

    def test_age_thresholds(self):
        self.assertEqual(m.classify(AGE, self.now, updated=t("2026-11-24T11:45")), ("ok", 15.0))
        self.assertEqual(m.classify(AGE, self.now, updated=t("2026-11-24T11:30")), ("warn", 30.0))
        self.assertEqual(m.classify(AGE, self.now, updated=t("2026-11-24T10:00")), ("bad", 120.0))
        self.assertEqual(m.classify(AGE, self.now), ("bad", None))

    def test_age_never_negative(self):
        self.assertEqual(m.classify(AGE, self.now, updated=t("2026-11-24T12:05")), ("ok", 0.0))

    def test_latency_thresholds(self):
        ref = t("2026-11-24T11:50")
        self.assertEqual(m.classify(LAT, self.now, ref=ref, available=t("2026-11-24T12:00")), ("ok", 10.0))
        self.assertEqual(m.classify(LAT, self.now, ref=ref, available=t("2026-11-24T12:20")), ("warn", 30.0))
        self.assertEqual(m.classify(LAT, self.now, ref=ref, available=t("2026-11-24T13:00")), ("bad", 70.0))
        self.assertEqual(m.classify(LAT, self.now, ref=ref), ("bad", None))

    def test_latency_no_new_data(self):
        # reference time older than interval_min + warn_max_min = 55 min: down, even with a short latency
        ref = t("2026-11-24T10:00")
        self.assertEqual(m.classify(LAT, self.now, ref=ref, available=t("2026-11-24T10:05")), ("bad", 5.0))

    def test_pause(self):
        self.assertEqual(m.classify(PHENO, t("2026-12-15T00:00"), updated=t("2026-11-01T00:00"))[0], "pause")

    def test_after_pause_interval_runs_from_end_of_break(self):
        # last update in November, now 2 March: age about 4 months, but rated from 1 March only
        status, age = m.classify(PHENO, t("2026-03-02T00:00"), updated=t("2025-11-01T00:00"))
        self.assertEqual(status, "ok")
        self.assertGreater(age, 100000)


class FailureReason(unittest.TestCase):
    now = t("2026-11-24T12:00")

    def test_ok_has_no_reason(self):
        self.assertEqual(m.failure_reason(AGE, self.now, "ok", None, None, None, None, None), (None, None))

    def test_order_of_reasons(self):
        access = {"ok": False, "host": "data.geo.admin.ch", "http_status": 503, "error": "HTTP 503"}
        self.assertEqual(m.failure_reason(AGE, self.now, "bad", None, None, None, access, "URLError"),
                         ("download_failed", "HTTP 503, data.geo.admin.ch"))
        self.assertEqual(m.failure_reason(AGE, self.now, "bad", None, None, None, None, "URLError"),
                         ("check_failed", "URLError"))

    def test_age(self):
        self.assertEqual(m.failure_reason(AGE, self.now, "bad", t("2026-11-24T10:00"), None, None, None, None),
                         ("no_new_data", None))
        self.assertEqual(m.failure_reason(AGE, self.now, "bad", None, None, None, None, None), ("no_data", None))

    def test_latency(self):
        self.assertEqual(m.failure_reason(LAT, self.now, "bad", None, None, None, None, None), ("no_data", None))
        self.assertEqual(m.failure_reason(LAT, self.now, "bad", None, t("2026-11-24T10:00"), None, None, None),
                         ("no_new_data", None))
        run = {"files": 3, "expected": 10, "complete": False}
        self.assertEqual(m.failure_reason(LAT, self.now, "bad", None, t("2026-11-24T11:30"), run, None, None),
                         ("run_incomplete", "3/10"))
        self.assertEqual(m.failure_reason(LAT, self.now, "warn", None, t("2026-11-24T11:30"), None, None, None),
                         ("late", None))


def asset(created):
    return {"created": created, "href": "https://example.org/x"}


class LatencyFromAssets(unittest.TestCase):
    """Model runs with source.complete_run: latency until the last file of a run is there."""
    cfg = {"key": "local-forecasting", "collection": "c", "ok_max_min": 15,
           "source": {"prefix": "vnut12", "time": "yyyymmddhhmm", "complete_run": True}}

    def run_with(self, assets, now):
        with mock.patch.object(m, "dated_items", return_value=[{"id": "20261124-ch", "assets": assets}]):
            return m.latency_from_assets("api", self.cfg, now)

    def files(self, run, n, created):
        return {f"vnut12.lssw.{run}.p{i}.csv": asset(created) for i in range(n)}

    def test_complete_newest_run(self):
        assets = {**self.files("202611241000", 3, "2026-11-24T10:05:00Z"),
                  **self.files("202611241100", 3, "2026-11-24T11:08:00Z")}
        ref, available, run = self.run_with(assets, t("2026-11-24T11:20"))
        self.assertEqual((ref, available), (t("2026-11-24T11:00"), t("2026-11-24T11:08")))
        self.assertTrue(run["complete"])

    def test_incomplete_within_target_uses_previous_run(self):
        assets = {**self.files("202611241000", 3, "2026-11-24T10:05:00Z"),
                  **self.files("202611241100", 1, "2026-11-24T11:08:00Z")}
        ref, available, run = self.run_with(assets, t("2026-11-24T11:10"))
        self.assertEqual(ref, t("2026-11-24T10:00"))
        self.assertTrue(run["complete"])

    def test_incomplete_beyond_target_reports_latency_so_far(self):
        assets = {**self.files("202611241000", 3, "2026-11-24T10:05:00Z"),
                  **self.files("202611241100", 1, "2026-11-24T11:08:00Z")}
        now = t("2026-11-24T11:40")
        ref, available, run = self.run_with(assets, now)
        self.assertEqual((ref, available), (t("2026-11-24T11:00"), now))
        self.assertEqual(run, {"files": 1, "expected": 3, "complete": False})


class CheckItem(unittest.TestCase):
    """One check of one item, with the network functions replaced."""
    cfg = {"key": "smn", "collection": "c", "group": "A", "metric": "age", "ok_max_min": 20, "warn_max_min": 60}
    now = t("2026-11-24T12:00")

    def check(self, measured=None, access=None, error=None):
        measure = mock.Mock(side_effect=error) if error else mock.Mock(return_value=measured or {})
        with mock.patch.object(m, "measure_item", measure), \
                mock.patch.object(m, "newest_access", return_value=access), mock.patch("builtins.print"):
            return m.check_item("api", self.cfg, self.now)

    def test_ok(self):
        row, error = self.check({"updated": t("2026-11-24T11:50")}, {"ok": True, "host": "h", "http_status": 206})
        self.assertEqual((row["status"], row["value_min"], row["updated"], error), ("ok", 10.0, "2026-11-24T11:50:00Z", None))
        self.assertNotIn("reason", row)
        self.assertEqual(row["checked"], "2026-11-24T12:00:00Z")

    def test_failed_download_makes_it_down(self):
        access = {"ok": False, "host": "rgw.cscs.ch", "http_status": 503, "error": "HTTP 503"}
        row, _ = self.check({"updated": t("2026-11-24T11:50")}, access)
        self.assertEqual((row["status"], row["reason"], row["detail"]), ("bad", "download_failed", "HTTP 503, rgw.cscs.ch"))
        self.assertEqual(row["access"], access)

    def test_no_download_test_when_already_down(self):
        with mock.patch.object(m, "measure_item", return_value={"updated": t("2026-11-24T10:00")}), \
                mock.patch.object(m, "newest_access") as access:
            row, _ = m.check_item("api", self.cfg, self.now)
        access.assert_not_called()
        self.assertEqual((row["status"], row["reason"]), ("bad", "no_new_data"))

    def test_measurement_error(self):
        with mock.patch("sys.stderr"):
            row, error = self.check(error=OSError("timeout"))
        self.assertEqual((row["status"], row["reason"], row["detail"], error), ("bad", "check_failed", "OSError", "OSError"))

    def test_measurement_error_of_static_item_is_reported(self):
        static = {**self.cfg, "ok_max_min": None, "warn_max_min": None}
        with mock.patch.object(m, "measure_item", side_effect=OSError), mock.patch("sys.stderr"):
            row, error = m.check_item("api", static, self.now)
        self.assertEqual((row["status"], error), ("static", "OSError"))


def row(key, checked, status, reason=None, detail=None):
    r = {"key": key, "checked": checked, "status": status, "value_min": 1}
    if reason:
        r["reason"] = reason
    if detail:
        r["detail"] = detail
    return r


class BuildIncidents(unittest.TestCase):
    cfg = {"items": [{"key": k, "ok_max_min": 10} for k in "abcde"] + [{"key": "s", "ok_max_min": None}]}
    now = t("2026-11-24T12:00")

    def incidents(self, rows):
        return m.build_incidents(self.cfg, rows, self.now)["incidents"]

    def test_single_delayed_check_is_noise(self):
        rows = [row("a", "2026-11-24T10:07:00Z", "ok"), row("a", "2026-11-24T10:37:00Z", "warn", "late"),
                row("a", "2026-11-24T11:07:00Z", "ok")]
        self.assertEqual(self.incidents(rows), [])

    def test_single_bad_check_counts(self):
        rows = [row("a", "2026-11-24T10:37:00Z", "bad", "no_new_data"), row("a", "2026-11-24T11:07:00Z", "ok")]
        [inc] = self.incidents(rows)
        self.assertEqual((inc["start"], inc["end"], inc["duration_min"]),
                         ("2026-11-24T10:37:00Z", "2026-11-24T11:07:00Z", 30.0))
        self.assertEqual((inc["layer"], inc["severity"], inc["ongoing"]), ("dataset", "bad", False))
        self.assertEqual(inc["datasets"][0]["reasons"], ["no_new_data"])

    def test_ongoing(self):
        [inc] = self.incidents([row("a", "2026-11-24T11:37:00Z", "bad")])
        self.assertTrue(inc["ongoing"])
        self.assertIsNone(inc["end"])
        self.assertEqual(inc["duration_min"], 23.0)

    def test_failures_within_an_hour_form_one_incident(self):
        rows = [row("a", "2026-11-24T09:07:00Z", "bad"), row("a", "2026-11-24T09:37:00Z", "ok"),
                row("b", "2026-11-24T09:37:00Z", "bad"), row("b", "2026-11-24T10:07:00Z", "ok")]
        [inc] = self.incidents(rows)
        self.assertEqual([d["key"] for d in inc["datasets"]], ["a", "b"])
        self.assertEqual(inc["layer"], "delivery")

    def test_failure_while_another_runs_joins_it(self):
        rows = [row("a", f"2026-11-24T0{h}:07:00Z", "bad") for h in range(5, 10)] + [row("a", "2026-11-24T10:07:00Z", "ok")]
        rows += [row("b", "2026-11-24T08:07:00Z", "bad"), row("b", "2026-11-24T08:37:00Z", "ok")]
        [inc] = self.incidents(rows)
        self.assertEqual(len(inc["datasets"]), 2)

    def test_separate_incidents_newest_first(self):
        rows = [row("a", "2026-11-24T06:07:00Z", "bad"), row("a", "2026-11-24T06:37:00Z", "ok"),
                row("b", "2026-11-24T09:07:00Z", "bad"), row("b", "2026-11-24T09:37:00Z", "ok")]
        incs = self.incidents(rows)
        self.assertEqual([i["datasets"][0]["key"] for i in incs], ["b", "a"])

    def test_layer_storage(self):
        rows = []
        for k in "ab":
            rows += [row(k, "2026-11-24T09:07:00Z", "bad", "download_failed", "HTTP 503, rgw.cscs.ch"),
                     row(k, "2026-11-24T09:37:00Z", "ok")]
        [inc] = self.incidents(rows)
        self.assertEqual((inc["layer"], inc["hosts"]), ("storage", ["rgw.cscs.ch"]))

    def test_layer_catalog(self):
        rows = []
        for k in "abcd":  # 4 of 5 rated datasets = 80 %
            rows += [row(k, "2026-11-24T09:07:00Z", "bad", "check_failed"), row(k, "2026-11-24T09:37:00Z", "ok")]
        [inc] = self.incidents(rows)
        self.assertEqual(inc["layer"], "catalog")

    def test_unrated_items_are_ignored(self):
        self.assertEqual(self.incidents([row("s", "2026-11-24T09:07:00Z", "bad")]), [])


class AssessBackfill(unittest.TestCase):
    """After an incident: which data of the gap came late, are incomplete or still missing."""

    def assess(self, c, assets, start, end):
        items = {"20261124-ch": {"assets": assets}}
        with mock.patch.object(m, "get_item", side_effect=lambda api, coll, item_id: items.get(item_id)):
            return m.assess_backfill("api", c, {"start": start, "end": end}, {})

    def test_images(self):
        c = {"key": "radar-hail", "collection": "c", "ok_max_min": 15, "interval_min": 5,
             "backfill": {"prefix": "bzc", "time": "yyjjjhhmm", "interval_min": 5, "unit": "image"}}
        assets = {}

        def image(hhmm, created):
            assets[f"bzc26328{hhmm}vl.h5"] = {"created": f"2026-11-24T{created}:00Z"}

        for minute in range(0, 55, 5):  # 09:00-09:50 on time, before the incident
            image(f"09{minute:02d}", f"09:{minute + 2:02d}")
        image("0955", "10:40")  # late by 45 min
        # 10:00 missing
        for minute in range(5, 35, 5):  # 10:05-10:30 late
            image(f"10{minute:02d}", "10:48")
        for minute in (35, 40, 45):  # on time again
            image(f"10{minute:02d}", f"10:{minute + 2:02d}")
        b = self.assess(c, assets, "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")
        self.assertEqual(b["unit"], "image")
        self.assertEqual(b["missing"], ["2026-11-24T10:00:00Z"])
        self.assertEqual(b["late"], ["2026-11-24T09:55:00Z"] + [f"2026-11-24T10:{mi:02d}:00Z" for mi in range(5, 35, 5)])
        self.assertEqual((b["on_time"], b["max_delay_min"], b["incomplete"], b["interval_min"]), (3, 45.0, [], 5))

    def test_model_runs(self):
        c = {"key": "local-forecasting", "collection": "c", "ok_max_min": 15, "interval_min": 60,
             "source": {"kind": "asset_name", "prefix": "vnut12", "time": "yyyymmddhhmm", "complete_run": True}}
        assets = {}

        def run(hh, files, created):
            for i in range(files):
                assets[f"vnut12.lssw.20261124{hh}00.p{i}.csv"] = {"created": f"2026-11-24T{created}:00Z"}

        for hh in ("08", "09", "10"):
            run(hh, 3, f"{hh}:10")
        run("11", 3, "11:10")  # in the gap, but on time
        run("12", 2, "12:10")  # incomplete
        run("13", 3, "13:50")  # late by 50 min
        b = self.assess(c, assets, "2026-11-24T10:30:00Z", "2026-11-24T14:00:00Z")
        self.assertEqual((b["unit"], b["files_expected"]), ("run", 3))
        self.assertEqual(b["late"], ["2026-11-24T13:00:00Z"])
        self.assertEqual(b["incomplete"], [{"ref": "2026-11-24T12:00:00Z", "files": 2}])
        self.assertEqual((b["missing"], b["on_time"], b["max_delay_min"]), ([], 1, 50.0))

    def test_not_assessed(self):
        c = {"key": "smn", "collection": "c", "ok_max_min": 20, "interval_min": 10, "source": {"kind": "newest_filled_item"}}
        self.assertIsNone(m.assess_backfill("api", c, {"start": "2026-11-24T10:00:00Z", "end": "2026-11-24T11:00:00Z"}, {}))
        radar = {"key": "r", "collection": "c", "ok_max_min": 15, "interval_min": 5,
                 "backfill": {"prefix": "bzc", "time": "yyjjjhhmm", "interval_min": 5}}
        # still ongoing, or the items of that time are no longer on the STAC API
        self.assertIsNone(m.assess_backfill("api", radar, {"start": "2026-11-24T10:00:00Z", "end": None}, {}))
        self.assertIsNone(self.assess(radar, {}, "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z"))

    def test_attached_to_incidents_and_failure_tolerated(self):
        cfg = {"items": [{"key": "r", "collection": "c", "ok_max_min": 15, "interval_min": 5,
                          "backfill": {"prefix": "bzc", "time": "yyjjjhhmm", "interval_min": 5}}]}
        rows = [row("r", "2026-11-24T10:07:00Z", "bad", "no_new_data"), row("r", "2026-11-24T10:37:00Z", "ok")]
        now = t("2026-11-24T12:00")
        with mock.patch.object(m, "assess_backfill", return_value={"late": []}):
            [inc] = m.build_incidents(cfg, rows, now, api="api")["incidents"]
        self.assertEqual(inc["datasets"][0]["backfill"], {"late": []})
        with mock.patch.object(m, "assess_backfill", side_effect=OSError("down")), mock.patch("sys.stderr"):
            [inc] = m.build_incidents(cfg, rows, now, api="api")["incidents"]
        self.assertNotIn("backfill", inc["datasets"][0])


class ApplyCorrections(unittest.TestCase):
    def test_fix_and_recount(self):
        cfg = {"items": [{"key": "a", "realtime": True}, {"key": "b"}]}
        checked = "2026-11-24T09:07:00Z"
        history = [{"checked": checked, "monitored_total": 2, "monitored_ok": 0, "realtime_total": 1, "realtime_ok": 0}]
        items = [row("a", checked, "bad"), row("b", checked, "bad")]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"items": [{"key": "a", "checked": checked, "status": "ok", "value_min": 3}]}, f)
        try:
            with mock.patch("builtins.print"):
                m.apply_corrections(cfg, f.name, history, items)
                self.assertEqual(items[0]["status"], "ok")
                self.assertEqual(history[0], {"checked": checked, "monitored_total": 2, "monitored_ok": 1,
                                              "realtime_total": 1, "realtime_ok": 1})
                # idempotent
                m.apply_corrections(cfg, f.name, history, items)
                self.assertEqual(history[0]["monitored_ok"], 1)
        finally:
            os.unlink(f.name)

    def test_missing_file(self):
        m.apply_corrections({"items": []}, "/nonexistent.json", [], [])


if __name__ == "__main__":
    unittest.main()
