"""Contract tests for offline vision-result ingestion.

All fixtures are synthetic and live in temporary directories. These tests never
connect to a device or depend on a user's production CSV files.
"""

import csv
import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from vision_ingest import (
    CSVFormatError,
    ExcludedFile,
    discover_files,
    export_data,
    ingest_once,
    main,
    parse_csv,
)


PART = "Tesla_Front12"
STAMP = "2026/10/13 00:05:49"
FILENAME = "Tesla_Front12_20261013-000549.csv"


def fixture_rows(part=PART, serial="TEST-SN-001", timestamp=STAMP):
    """61 measurements, 59 critical, with two noncritical NG results."""
    rows = [
        ["PartName", part, "", "", "", "", ""],
        ["SN", serial, "", "", "", "", ""],
        ["TimeStamp", timestamp, "", "", "", "", ""],
        ["Result", "OK", "", "", "", "", ""],
        ["Name", "Nominal", "Lower_SL", "Upper_SL", "IsCritical", "Dev", "OK/NG"],
    ]
    for index in range(61):
        critical = index < 59
        rows.append([
            f"位置{index + 1}_X",
            "1225.00",
            "-1.00",
            "1.00",
            "Yes" if critical else "No",
            "-0.04" if critical else "2.40",
            "OK" if critical else "NG",
        ])
    return rows


def write_fixture(path, rows=None, encoding="utf-8-sig"):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding=encoding, newline="") as stream:
        csv.writer(stream).writerows(fixture_rows() if rows is None else rows)
    return path


class VisionIngestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.backup_root("first")
        self.database = self.base / "collected.sqlite3"

    def tearDown(self):
        self.temporary.cleanup()

    def backup_root(self, name):
        root = self.base / name / "backup"
        root.mkdir(parents=True, exist_ok=True)
        return root

    def source_path(self, root=None, part=PART, filename=FILENAME):
        return (root or self.root) / part / "2026-10-13" / filename

    def collect(self, root=None):
        return ingest_once(
            root or self.root,
            self.database,
            device_id="inspection-device-A",
            stable_seconds=0,
        )

    def test_utf8_bom_chinese_names_and_all_measurements_survive(self):
        path = write_fixture(self.source_path())
        original_bytes = path.read_bytes()

        record = parse_csv(path, device_id="inspection-device-A", expected_part=PART)

        self.assertEqual(record["device_id"], "inspection-device-A")
        self.assertEqual(record["part_name"], PART)
        self.assertEqual(record["serial_number"], "TEST-SN-001")
        self.assertEqual(record["measured_at_local"], "2026-10-13T00:05:49")
        self.assertEqual(record["source_result"], "OK")
        self.assertEqual(len(record["measurements"]), 61)
        self.assertEqual(sum(item["is_critical"] for item in record["measurements"]), 59)
        self.assertEqual(record["measurements"][0], {
            "name": "位置1_X",
            "nominal": 1225.0,
            "lower_limit": -1.0,
            "upper_limit": 1.0,
            "is_critical": True,
            "deviation": -0.04,
            "deviation_raw": "-0.04",
            "source_result": "OK",
            "range_comparison": "OK",
            "unit": None,
        })
        self.assertEqual(record["measurements"][-1]["name"], "位置61_X")
        self.assertTrue(record["record_id"])
        self.assertTrue(record["logical_key"])
        self.assertIsInstance(record["warnings"], list)
        self.assertEqual(path.read_bytes(), original_bytes)

    def test_plain_utf8_is_also_accepted(self):
        path = write_fixture(self.source_path(), encoding="utf-8")
        self.assertEqual(len(parse_csv(path)["measurements"]), 61)

    def test_noncritical_ng_does_not_overwrite_source_overall_ok(self):
        path = write_fixture(self.source_path())
        record = parse_csv(path)
        failures = [item for item in record["measurements"] if item["source_result"] == "NG"]
        self.assertEqual(len(failures), 2)
        self.assertTrue(all(item["is_critical"] is False for item in failures))
        self.assertTrue(all(item["range_comparison"] == "NG" for item in failures))
        self.assertEqual(record["source_result"], "OK")

        self.collect()
        summary = export_data(self.database)["summary"]
        self.assertEqual(summary["eligible_records"], 1)
        self.assertEqual(summary["ok_records"], 1)
        self.assertEqual(summary["ng_records"], 0)
        self.assertEqual(summary["pass_rate"], 1.0)

    def test_nan_deviation_is_explicit_missing_value_with_warning(self):
        rows = fixture_rows()
        rows[-1][5] = "NaN"
        path = write_fixture(self.source_path(), rows)
        record = parse_csv(path)
        self.assertIsNone(record["measurements"][-1]["deviation"])
        self.assertEqual(record["measurements"][-1]["deviation_raw"], "NaN")
        self.assertEqual(record["measurements"][-1]["source_result"], "NG")
        self.assertIsNone(record["measurements"][-1]["range_comparison"])
        self.assertIsNone(record["measurements"][-1]["unit"])
        self.assertTrue(record["warnings"])

    def test_truncated_sixty_measurement_file_is_rejected(self):
        rows = fixture_rows()[:-1]
        path = write_fixture(self.source_path(), rows)
        with self.assertRaises(CSVFormatError):
            parse_csv(path)

    def test_duplicate_measurement_name_is_rejected(self):
        rows = fixture_rows()
        rows[-1][0] = rows[5][0]
        path = write_fixture(self.source_path(), rows)
        with self.assertRaises(CSVFormatError):
            parse_csv(path)

    def test_invalid_numeric_values_are_rejected(self):
        for column in (1, 2, 3, 5):
            for value in ("not-a-number", "", "Infinity"):
                with self.subTest(column=column, value=value):
                    rows = fixture_rows()
                    rows[5][column] = value
                    path = write_fixture(self.source_path(), rows)
                    with self.assertRaises(CSVFormatError):
                        parse_csv(path)

    def test_expected_directory_part_must_match_metadata(self):
        rows = fixture_rows(part="Tesla_Front11")
        path = write_fixture(self.source_path(), rows)
        with self.assertRaises(CSVFormatError):
            parse_csv(path, expected_part=PART)

    def test_allmeasure_directory_filename_and_metadata_are_excluded(self):
        cases = [
            (self.root / "Tesla_Front12_ALLmeasure" / FILENAME, fixture_rows()),
            (self.root / PART / "_ALLmeasure" / FILENAME, fixture_rows()),
            (self.root / PART / "Tesla_Front12_ALLmeasure_20261013-000549.csv", fixture_rows()),
            (self.source_path(), fixture_rows(part="Tesla_Front12_ALLmeasure")),
        ]
        for path, rows in cases:
            with self.subTest(path=str(path), part=rows[0][1]):
                write_fixture(path, rows)
                with self.assertRaises(ExcludedFile):
                    parse_csv(path)

    def test_failure_files_and_directory_are_excluded(self):
        cases = [
            self.root / "failure" / FILENAME,
            self.root / PART / "2026-10-13" / "failure.csv",
            self.root / PART / "2026-10-13" / "Tesla_Front12_20261013-000549_failure.csv",
        ]
        for path in cases:
            with self.subTest(path=str(path)):
                write_fixture(path)
                with self.assertRaises(ExcludedFile):
                    parse_csv(path)

    def test_failure_result_is_rejected_instead_of_counted_as_ng(self):
        rows = fixture_rows()
        rows[3][1] = "failure"
        path = write_fixture(self.source_path(), rows)
        with self.assertRaises(CSVFormatError):
            parse_csv(path)

    def test_discovery_only_visits_exact_allowed_model_directories(self):
        expected = set()
        for part in ("Tesla_Front11", "Tesla_Front12"):
            filename = f"{part}_20261013-000549.csv"
            path = self.source_path(part=part, filename=filename)
            expected.add(write_fixture(path, fixture_rows(part=part)))
        for folder in ("Tesla_Front12_ALLmeasure", "Tesla_Front11_extra", "Tesla_Front12_old", "failure"):
            write_fixture(self.root / folder / "2026-10-13" / FILENAME)
        write_fixture(self.root / PART / "_ALLmeasure" / FILENAME)
        write_fixture(self.root / PART / "2026-10-13" / "failure.csv")
        write_fixture(self.root / PART / "2026-10-13" / "Tesla_Front12_ALLmeasure_20261013-000549.csv")
        self.assertEqual(set(discover_files(self.root)), expected)

    def test_invalid_files_are_reported_and_valid_file_still_imports(self):
        write_fixture(self.source_path())
        bad = self.source_path(filename="Tesla_Front12_20261013-000550.csv")
        write_fixture(bad, fixture_rows(timestamp="2026/10/13 00:05:50")[:-1])
        result = self.collect()
        self.assertEqual(result["imported"], 1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(Path(result["errors"][0]["path"]), bad)
        self.assertTrue(result["errors"][0]["error"])
        self.assertEqual(len(export_data(self.database)["records"]), 1)

    def test_ingestion_checks_directory_part_and_preserves_source_bytes(self):
        valid = write_fixture(self.source_path())
        original = valid.read_bytes()
        invalid = self.source_path(filename="Tesla_Front12_20261013-000550.csv")
        write_fixture(invalid, fixture_rows(part="Tesla_Front11", timestamp="2026/10/13 00:05:50"))
        result = self.collect()
        self.assertEqual(result["imported"], 1)
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(Path(result["errors"][0]["path"]), invalid)
        self.assertEqual(valid.read_bytes(), original)

    def test_parse_cli_cannot_overwrite_another_source_csv(self):
        source = write_fixture(self.source_path())
        another_root = self.backup_root("another-source")
        target = write_fixture(
            self.source_path(root=another_root, filename="Tesla_Front12_20261013-000550.csv"),
            fixture_rows(serial="TEST-SN-002", timestamp="2026/10/13 00:05:50"),
        )
        source_before = source.read_bytes()
        target_before = target.read_bytes()

        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                main(["parse", str(source), "--output", str(target)])

        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(source.read_bytes(), source_before)
        self.assertEqual(target.read_bytes(), target_before)

    def test_parse_cli_cannot_write_json_anywhere_inside_standard_backup_tree(self):
        source = write_fixture(self.source_path())
        source_before = source.read_bytes()
        existing_target = source.parent / "existing-results.json"
        existing_target.write_bytes(b'{"existing": true}\n')
        existing_before = existing_target.read_bytes()
        new_target = self.root / "new-results.json"

        for target in (existing_target, new_target):
            with self.subTest(target=str(target)):
                with redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        main(["parse", str(source), "--output", str(target)])
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(source.read_bytes(), source_before)
                self.assertEqual(existing_target.read_bytes(), existing_before)
                self.assertFalse(new_target.exists())

    def test_identical_content_from_another_copy_is_not_duplicated(self):
        first = write_fixture(self.source_path())
        another_root = self.backup_root("second")
        second = write_fixture(self.source_path(root=another_root))
        self.assertEqual(first.read_bytes(), second.read_bytes())
        first_record = parse_csv(first, device_id="inspection-device-A")
        second_record = parse_csv(second, device_id="inspection-device-A")
        self.assertEqual(first_record["record_id"], second_record["record_id"])
        self.assertEqual(first_record["logical_key"], second_record["logical_key"])

        self.assertEqual(self.collect()["imported"], 1)
        duplicate_result = self.collect(another_root)
        self.assertEqual(duplicate_result["imported"], 0)
        self.assertGreaterEqual(duplicate_result["duplicates"], 1)
        self.assertEqual(duplicate_result["errors"], [])
        exported = export_data(self.database)
        self.assertEqual(len(exported["records"]), 1)
        self.assertEqual(exported["summary"]["eligible_records"], 1)

    def test_same_sn_at_different_times_remains_two_detection_records(self):
        first = write_fixture(self.source_path())
        second = write_fixture(
            self.source_path(filename="Tesla_Front12_20261013-000550.csv"),
            fixture_rows(timestamp="2026/10/13 00:05:50"),
        )
        self.assertNotEqual(parse_csv(first)["logical_key"], parse_csv(second)["logical_key"])
        self.assertEqual(self.collect()["imported"], 2)
        exported = export_data(self.database)
        self.assertEqual(len(exported["records"]), 2)
        self.assertEqual(exported["summary"]["eligible_records"], 2)
        self.assertTrue(all(not item["identity_conflict"] for item in exported["records"]))

    def test_negative_and_positive_zero_copies_deduplicate_without_losing_raw_text(self):
        negative_rows = fixture_rows()
        negative_rows[5][5] = "-0.00"
        negative_path = write_fixture(self.source_path(), negative_rows)
        positive_rows = fixture_rows()
        positive_rows[5][5] = "0.00"
        another_root = self.backup_root("positive-zero-copy")
        positive_path = write_fixture(self.source_path(root=another_root), positive_rows)

        negative_record = parse_csv(negative_path, device_id="inspection-device-A")
        positive_record = parse_csv(positive_path, device_id="inspection-device-A")
        self.assertEqual(negative_record["measurements"][0]["deviation"], 0.0)
        self.assertEqual(positive_record["measurements"][0]["deviation"], 0.0)
        self.assertEqual(negative_record["measurements"][0]["deviation_raw"], "-0.00")
        self.assertEqual(positive_record["measurements"][0]["deviation_raw"], "0.00")
        self.assertEqual(negative_record["logical_key"], positive_record["logical_key"])
        self.assertEqual(negative_record["record_id"], positive_record["record_id"])

        first_result = self.collect()
        self.assertEqual(first_result["imported"], 1)
        self.assertEqual(first_result["conflicts"], 0)
        self.assertEqual(first_result["errors"], [])
        duplicate_result = self.collect(another_root)
        self.assertEqual(duplicate_result["imported"], 0)
        self.assertGreaterEqual(duplicate_result["duplicates"], 1)
        self.assertEqual(duplicate_result["conflicts"], 0)
        self.assertEqual(duplicate_result["errors"], [])

        exported = export_data(self.database)
        self.assertEqual(len(exported["records"]), 1)
        self.assertFalse(exported["records"][0]["identity_conflict"])
        self.assertEqual(exported["records"][0]["measurements"][0]["deviation_raw"], "-0.00")
        self.assertEqual(exported["summary"]["total_records"], 1)
        self.assertEqual(exported["summary"]["eligible_records"], 1)
        self.assertEqual(exported["summary"]["conflict_records"], 0)

    def test_identity_conflict_retains_both_versions_and_excludes_both_from_counts(self):
        write_fixture(self.source_path())
        unrelated_rows = fixture_rows(serial="TEST-SN-002", timestamp="2026/10/13 00:05:50")
        unrelated_rows[3][1] = "NG"
        unrelated_rows[5][5] = "2.00"
        unrelated_rows[5][6] = "NG"
        write_fixture(self.source_path(filename="Tesla_Front12_20261013-000550.csv"), unrelated_rows)
        self.assertEqual(self.collect()["imported"], 2)

        changed_rows = fixture_rows()
        changed_rows[5][5] = "0.05"
        second_root = self.backup_root("conflicting")
        write_fixture(self.source_path(root=second_root), changed_rows)
        conflict_result = self.collect(second_root)
        self.assertGreaterEqual(conflict_result["conflicts"], 1)
        self.assertEqual(conflict_result["errors"], [])

        exported = export_data(self.database)
        records = exported["records"]
        self.assertEqual(len(records), 3)
        conflicts = [record for record in records if record["identity_conflict"]]
        self.assertEqual(len(conflicts), 2)
        self.assertEqual(len({record["logical_key"] for record in conflicts}), 1)
        self.assertEqual(len({record["record_id"] for record in conflicts}), 2)
        self.assertEqual({record["measurements"][0]["deviation"] for record in conflicts}, {-0.04, 0.05})
        summary = exported["summary"]
        self.assertEqual(summary["total_records"], 3)
        self.assertEqual(summary["conflict_records"], 2)
        self.assertEqual(summary["eligible_records"], 1)
        self.assertEqual(summary["ok_records"], 0)
        self.assertEqual(summary["ng_records"], 1)
        self.assertEqual(summary["pass_rate"], 0.0)


if __name__ == "__main__":
    unittest.main()
