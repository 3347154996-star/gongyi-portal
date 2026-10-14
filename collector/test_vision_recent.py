"""Synthetic regression tests for bounded, resumable result collection.

All files and databases are created in a temporary directory. No network or
production source is accessed.
"""

import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing, redirect_stderr, redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import patch

import vision_ingest as ingest
from test_vision_ingest import PART, fixture_rows, write_fixture


class RecentCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "backup"
        self.root.mkdir()
        self.database = self.base / "data" / "vision.sqlite"
        self.output = self.base / "data" / "vision.json"

    def tearDown(self):
        self.temporary.cleanup()

    def source(self, day, serial=None, second=0, part=PART):
        filename = f"{part}_{day.replace('-', '')}-0000{second:02d}.csv"
        rows = fixture_rows(
            part=part,
            serial=serial or f"TEST-{day}-{second}",
            timestamp=f"{day.replace('-', '/')} 00:00:{second:02d}",
        )
        return write_fixture(self.root / part / day / filename, rows)

    def arguments(self, *extra):
        return [
            "collect", "--source-root", str(self.root),
            "--device-id", "test-device-A", "--database", str(self.database),
            "--output", str(self.output), "--stable-seconds", "0", *extra,
        ]

    def make_legacy_database(self, records):
        """Use the shipped pre-date-index database schema, without migration."""
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.database)) as con:
            con.executescript("""
                CREATE TABLE detections (
                    record_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL,
                    payload TEXT NOT NULL, imported_at TEXT NOT NULL
                );
                CREATE INDEX idx_logical_key ON detections(logical_key);
                CREATE TABLE source_files (
                    path TEXT NOT NULL, device_id TEXT NOT NULL,
                    size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
                    record_id TEXT NOT NULL, PRIMARY KEY(path, device_id)
                );
            """)
            for record in records:
                con.execute(
                    "INSERT INTO detections VALUES (?,?,?,?)",
                    (record["record_id"], record["logical_key"],
                     json.dumps(record, ensure_ascii=False), "2026-10-13T00:00:00+00:00"),
                )
            con.commit()

    def test_discovery_filters_inclusive_dates_before_entering_excluded_folders(self):
        old = self.source("2026-10-11")
        first = self.source("2026-10-12")
        last = self.source("2026-10-13")
        future = self.source("2026-10-14")
        excluded = {old.parent, future.parent}
        original_glob = Path.glob
        original_iterdir = Path.iterdir

        def checked_glob(path, *args, **kwargs):
            self.assertNotIn(path, excluded, "An out-of-range date folder was opened")
            return original_glob(path, *args, **kwargs)

        def checked_iterdir(path, *args, **kwargs):
            self.assertNotIn(path, excluded, "An out-of-range date folder was opened")
            return original_iterdir(path, *args, **kwargs)

        with patch.object(Path, "glob", checked_glob), patch.object(Path, "iterdir", checked_iterdir):
            actual = set(ingest.discover_files(
                self.root, start_date=date(2026, 10, 12), end_date="2026-10-13",
            ))
        self.assertEqual(actual, {first, last})

    def test_invalid_or_reversed_bounds_are_rejected(self):
        self.source("2026-10-13")
        for start, end in (("2026-13-01", None), ("2026-10-14", "2026-10-13")):
            with self.subTest(start=start, end=end):
                with self.assertRaises(ValueError):
                    list(ingest.discover_files(self.root, start_date=start, end_date=end))

    def test_collect_only_recent_sources_and_preserve_every_source_byte(self):
        sources = [self.source(day) for day in (
            "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14",
        )]
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in sources}
        messages = []
        first = ingest.ingest_once(
            self.root, self.database, "test-device-A", stable_seconds=0,
            start_date="2026-10-12", end_date="2026-10-13", progress=messages.append,
        )
        self.assertEqual(first["imported"], 2)
        self.assertEqual(first["errors"], [])
        self.assertTrue(messages)
        self.assertTrue(all(isinstance(message, str) and message for message in messages))

        second = ingest.ingest_once(
            self.root, self.database, "test-device-A", stable_seconds=0,
            start_date="2026-10-12", end_date="2026-10-13",
        )
        self.assertEqual(second["imported"], 0)
        self.assertEqual(second["duplicates"], 2)
        self.assertEqual(ingest.export_data(self.database)["summary"]["total_records"], 2)
        self.assertEqual(
            {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in sources}, before,
        )

    def test_legacy_export_filters_before_decoding_and_leaves_database_untouched(self):
        old = ingest.parse_csv(self.source("2026-10-11"), device_id="test-device-A")
        recent = ingest.parse_csv(self.source("2026-10-13"), device_id="test-device-A")
        other_device = ingest.parse_csv(self.source("2026-10-13", second=1), device_id="test-device-B")
        future = ingest.parse_csv(self.source("2026-10-14"), device_id="test-device-A")
        self.make_legacy_database([old, recent, other_device, future])
        before = self.database.read_bytes()

        with patch.object(ingest.json, "loads", wraps=json.loads) as decode:
            exported = ingest.export_data(
                self.database, start_date="2026-10-12", end_date="2026-10-13",
                device_id="test-device-A",
            )
        self.assertEqual(decode.call_count, 1, "Excluded records must not be decoded into memory")
        self.assertEqual([item["record_id"] for item in exported["records"]], [recent["record_id"]])
        self.assertEqual(exported["summary"]["total_records"], 1)
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(ingest.export_data(self.database)["summary"]["total_records"], 4)

    def test_collect_migrates_legacy_database_without_removing_old_or_other_device_records(self):
        old = ingest.parse_csv(self.source("2026-10-11"), device_id="test-device-A")
        other_device = ingest.parse_csv(self.source("2026-10-11", second=1), device_id="test-device-B")
        self.make_legacy_database([old, other_device])
        self.source("2026-10-13")
        stats = ingest.ingest_once(
            self.root, self.database, "test-device-A", start_date="2026-10-13", end_date="2026-10-13",
        )
        self.assertEqual(stats["imported"], 1)
        all_records = ingest.export_data(self.database)["records"]
        self.assertEqual(len(all_records), 3)
        self.assertTrue({old["record_id"], other_device["record_id"]}.issubset(
            {record["record_id"] for record in all_records}
        ))
        recent = ingest.export_data(self.database, start_date="2026-10-13", end_date="2026-10-13")
        self.assertEqual(recent["summary"]["total_records"], 1)

    def test_interrupt_preserves_committed_checkpoint_and_resume_has_no_duplicates(self):
        first = self.source("2026-10-13", second=0)
        second = self.source("2026-10-13", second=1)
        source_before = {path: path.read_bytes() for path in (first, second)}
        original_parse = ingest.parse_csv
        calls = 0

        def interrupted_parse(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise KeyboardInterrupt
            return original_parse(*args, **kwargs)

        with patch.object(ingest, "parse_csv", side_effect=interrupted_parse):
            with self.assertRaises(KeyboardInterrupt):
                ingest.ingest_once(self.root, self.database, "test-device-A")
        self.assertEqual(ingest.export_data(self.database)["summary"]["total_records"], 1)
        resumed = ingest.ingest_once(self.root, self.database, "test-device-A")
        self.assertEqual(resumed["imported"], 1)
        self.assertEqual(resumed["duplicates"], 1)
        self.assertEqual(resumed["errors"], [])
        self.assertEqual(ingest.export_data(self.database)["summary"]["total_records"], 2)
        self.assertEqual({path: path.read_bytes() for path in (first, second)}, source_before)

    def test_cli_progress_uses_stderr_and_stdout_remains_one_json_result(self):
        self.source("2026-10-13")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = ingest.main(self.arguments("--progress"))
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(stdout.getvalue())["imported"], 1)
        self.assertTrue(stderr.getvalue().strip())
        document = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(document["summary"]["total_records"], 1)
        self.assertIsNone(document["last_scan"]["start_date"])
        self.assertIsNone(document["last_scan"]["end_date"])

    def test_cli_watch_recomputes_today_at_midnight_and_keeps_old_database_records(self):
        self.source("2026-10-12")
        self.source("2026-10-13")
        self.source("2026-10-14")
        today_calls = []

        class CrossingMidnightDate(date):
            @classmethod
            def today(cls):
                current = date(2026, 10, 13 if not today_calls else 14)
                today_calls.append(current)
                return current

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(ingest, "date", CrossingMidnightDate), \
                patch.object(ingest.time, "sleep", side_effect=[None, KeyboardInterrupt]), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            result = ingest.main(self.arguments("--recent-days", "1", "--watch"))
        self.assertEqual(result, 130)
        scans = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([scan["imported"] for scan in scans], [1, 1])
        self.assertEqual(today_calls, [date(2026, 10, 13), date(2026, 10, 14)])
        document = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(document["last_scan"]["start_date"], "2026-10-14")
        self.assertEqual(document["last_scan"]["end_date"], "2026-10-14")
        self.assertEqual([record["measured_at_local"][:10] for record in document["records"]], ["2026-10-14"])
        self.assertEqual(ingest.export_data(self.database)["summary"]["total_records"], 2)

    def test_cli_recent_days_rejects_zero_and_negative_values_without_importing(self):
        self.source("2026-10-13")
        for days in ("0", "-1"):
            with self.subTest(days=days), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    ingest.main(self.arguments("--recent-days", days))
                self.assertEqual(raised.exception.code, 2)
                self.assertFalse(self.database.exists())
                self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
