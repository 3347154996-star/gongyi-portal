"""Read-only ingestion of the two regular BaseV3 CSV variants.

Python 3.10+; standard library only. Source files and the machine database are
never changed. This module does not connect to a network or to BaseV3's DB.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone

ALLOWED_PARTS = ("Tesla_Front11", "Tesla_Front12")
DEFAULT_SOURCE_ROOT = r"D:\BaseV3\ReleaseEXE\backup"
FILE_PATTERN = re.compile(r"^(Tesla_Front11|Tesla_Front12)_(\d{8}-\d{6})\.csv$")
HEADERS = ["Name", "Nominal", "Lower_SL", "Upper_SL", "IsCritical", "Dev", "OK/NG"]
EXPECTED_ITEMS = 61  # Regular variants, verified against the provided sample/log.


class CSVFormatError(ValueError):
    pass


class ExcludedFile(CSVFormatError):
    pass


class ChangingFile(CSVFormatError):
    pass


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _signature(path):
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def _number(text, field, allow_nan=False):
    if allow_nan and text.casefold() == "nan":
        return None
    try:
        value = float(text)
    except (ValueError, TypeError) as exc:
        raise CSVFormatError(f"{field}: invalid number {text!r}") from exc
    if not math.isfinite(value):
        raise CSVFormatError(f"{field}: non-finite number {text!r}")
    # Signed zero is the same measurement; retain its text separately while
    # normalizing the numeric value used for semantic duplicate detection.
    return 0.0 if value == 0 else value


def _filename(path):
    if any(p.casefold() == "failure" or p.casefold().endswith("_allmeasure") for p in path.parts):
        raise ExcludedFile("failure and _ALLmeasure directories are excluded")
    match = FILE_PATTERN.fullmatch(path.name)
    if not match:
        raise ExcludedFile("Only the two regular part filenames are allowed")
    return match


def parse_csv(path, device_id="sample", expected_part=None):
    path = Path(path)
    match = _filename(path)
    before = _signature(path)
    raw = path.read_bytes()
    if _signature(path) != before:
        raise ChangingFile("File changed while being read")
    if not raw.endswith((b"\n", b"\r")):
        raise CSVFormatError("Missing final newline; file may still be incomplete")
    try:
        text = raw.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text), strict=True))
    except (UnicodeError, csv.Error) as exc:
        raise CSVFormatError(f"Invalid UTF-8 CSV: {exc}") from exc
    while rows and not any(cell.strip() for cell in rows[-1]):
        rows.pop()
    if len(rows) != 5 + EXPECTED_ITEMS:
        raise CSVFormatError(f"Expected {EXPECTED_ITEMS} measurement rows, found {max(0, len(rows)-5)}")
    if any(len(row) != 7 for row in rows):
        raise CSVFormatError("Every row must contain exactly seven columns")
    metadata = {}
    for row, key in zip(rows[:4], ("PartName", "SN", "TimeStamp", "Result")):
        if row[0].strip() != key or any(cell.strip() for cell in row[2:]):
            raise CSVFormatError(f"Invalid metadata row: expected {key}")
        metadata[key] = row[1].strip()
    part = metadata["PartName"]
    if part not in ALLOWED_PARTS:
        raise ExcludedFile(f"PartName is not an allowed regular variant: {part}")
    if part != match.group(1) or (expected_part is not None and part != expected_part):
        raise CSVFormatError("Directory, filename and PartName do not agree")
    if not device_id.strip() or not metadata["SN"]:
        raise CSVFormatError("Device ID and SN must not be empty")
    if metadata["Result"] not in ("OK", "NG"):
        raise CSVFormatError(f"Unsupported overall result: {metadata['Result']!r}")
    if [v.strip() for v in rows[4]] != HEADERS:
        raise CSVFormatError("Measurement header differs from the verified format")
    measured_at = None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            measured_at = datetime.strptime(metadata["TimeStamp"], fmt)
            break
        except ValueError:
            continue
    if measured_at is None:
        raise CSVFormatError("Invalid TimeStamp")
    warnings = []
    if match.group(2) != measured_at.strftime("%Y%m%d-%H%M%S"):
        warnings.append("Filename time differs from the record timestamp; record timestamp is retained")
    measurements, seen = [], set()
    for line_no, values in enumerate(rows[5:], start=6):
        name, nominal, low, high, critical, dev, result = [v.strip() for v in values]
        if not name or name in seen:
            raise CSVFormatError(f"Line {line_no}: blank or duplicate measurement name")
        seen.add(name)
        if critical not in ("Yes", "No", "1", "0"):
            raise CSVFormatError(f"Line {line_no}: unrecognized IsCritical")
        if result not in ("OK", "NG", "NAN", "NaN", "NA", "N/A"):
            raise CSVFormatError(f"Line {line_no}: unrecognized item result {result!r}")
        nominal_value = _number(nominal, f"{name}.Nominal")
        lower = _number(low, f"{name}.Lower_SL")
        upper = _number(high, f"{name}.Upper_SL")
        deviation = _number(dev, f"{name}.Dev", allow_nan=True)
        if lower > upper:
            raise CSVFormatError(f"{name}: lower limit exceeds upper limit")
        comparison = None if deviation is None else ("OK" if lower <= deviation <= upper else "NG")
        if deviation is None:
            warnings.append(f"{name}: source Dev is NaN; no numeric value is substituted")
        elif comparison != result:
            warnings.append(f"{name}: range comparison {comparison} differs from source {result}")
        measurements.append({
            "name": name, "nominal": nominal_value, "lower_limit": lower,
            "upper_limit": upper, "is_critical": critical in ("Yes", "1"),
            "deviation": deviation, "deviation_raw": dev,
            "source_result": result, "range_comparison": comparison, "unit": None,
        })
    measured_local = measured_at.isoformat(timespec="seconds")
    identity = [device_id.strip(), part, metadata["SN"], measured_local]
    # Names, not row positions, are the feature identities. Cosmetic CSV changes
    # and reordered measurement rows do not create duplicate detections.
    semantic_measurements = [
        {k: item[k] for k in ("name", "nominal", "lower_limit", "upper_limit", "is_critical", "deviation", "source_result")}
        for item in sorted(measurements, key=lambda item: item["name"])
    ]
    record = {
        "schema_version": 1, "device_id": device_id.strip(), "part_name": part,
        "serial_number": metadata["SN"], "measured_at_local": measured_local,
        "timestamp_raw": metadata["TimeStamp"], "timezone": None,
        "source_result": metadata["Result"], "measurements": measurements,
        "warnings": warnings, "logical_key": _digest(identity),
        "record_id": _digest([identity, metadata["Result"], semantic_measurements]),
        "source_file": path.name, "source_path": str(path.resolve()),
        "source_sha256": hashlib.sha256(raw).hexdigest(),
    }
    return record


def _date_bounds(start_date=None, end_date=None):
    """Validate inclusive calendar dates without assuming a record timezone."""
    values = []
    for value in (start_date, end_date):
        if value is None:
            values.append(None)
            continue
        if isinstance(value, date) and not isinstance(value, datetime):
            value = value.isoformat()
        if not isinstance(value, str):
            raise ValueError("Date bounds must be YYYY-MM-DD strings or dates")
        try:
            canonical = date.fromisoformat(value).isoformat()
        except ValueError as exc:
            raise ValueError("Date bounds must use YYYY-MM-DD") from exc
        if canonical != value:
            raise ValueError("Date bounds must use canonical YYYY-MM-DD")
        values.append(value)
    start, end = values
    if start is not None and end is not None and start > end:
        raise ValueError("start_date must not be after end_date")
    return start, end


def discover_files(root, start_date=None, end_date=None):
    """Only backup/<exact regular part>/<ISO date>/<regular filename>.csv."""
    start_date, end_date = _date_bounds(start_date, end_date)
    root = Path(root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Source backup directory not found: {root}")
    for part in ALLOWED_PARTS:
        part_dir = root / part
        if not part_dir.is_dir() or part_dir.is_symlink():
            continue
        for day_dir in sorted(part_dir.iterdir()):
            if not day_dir.is_dir() or day_dir.is_symlink():
                continue
            try:
                if date.fromisoformat(day_dir.name).isoformat() != day_dir.name:
                    continue
            except ValueError:
                continue
            # Do not enumerate CSVs inside historical directories outside the
            # requested window. Their previously imported records stay intact.
            if start_date is not None and day_dir.name < start_date:
                continue
            if end_date is not None and day_dir.name > end_date:
                continue
            for path in sorted(day_dir.glob("*.csv")):
                if not path.is_file() or path.is_symlink():
                    continue
                try:
                    path.resolve().relative_to(root)
                    match = _filename(path)
                except (ValueError, ExcludedFile):
                    continue
                if match.group(1) == part:
                    yield path


def _connect(db_path):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=10)
    try:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS detections (
            record_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL,
            payload TEXT NOT NULL, imported_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_logical_key ON detections(logical_key);
        CREATE INDEX IF NOT EXISTS idx_measured_at_local
            ON detections(json_extract(payload, '$.measured_at_local'));
        CREATE TABLE IF NOT EXISTS source_files (
            path TEXT NOT NULL, device_id TEXT NOT NULL, size INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL, record_id TEXT NOT NULL,
            PRIMARY KEY(path, device_id)
        );
        """)
    except BaseException:
        con.close()
        raise
    return con


def _require_outside_source(output, root):
    try:
        Path(output).resolve().relative_to(Path(root).resolve())
    except ValueError:
        return
    raise ValueError("Collector output must be outside the source backup directory")


def _require_json_output(output):
    if Path(output).suffix.casefold() != ".json":
        raise ValueError("JSON output must have a .json extension")


def ingest_once(root, db_path, device_id, stable_seconds=0,
                start_date=None, end_date=None, progress=None):
    if not str(device_id).strip():
        raise ValueError("A device ID is required")
    if stable_seconds < 0:
        raise ValueError("stable_seconds must not be negative")
    start_date, end_date = _date_bounds(start_date, end_date)
    device_id = str(device_id).strip()
    root = Path(root).resolve()
    _require_outside_source(db_path, root)
    if progress:
        progress("正在查找范围内的普通检测 CSV 文件……")
    paths = []
    last_progress = time.monotonic()
    for path in discover_files(root, start_date, end_date):
        paths.append(path)
        if progress and (len(paths) % 100 == 0 or time.monotonic() - last_progress >= 2):
            progress(f"已找到 {len(paths)} 个普通检测文件……")
            last_progress = time.monotonic()
    if progress:
        progress(f"共找到 {len(paths)} 个文件；正在准备采集数据库，首次建立日期索引可能需要等待……")
    stats = {"imported": 0, "duplicates": 0, "conflicts": 0, "deferred": 0, "errors": []}
    candidates = []
    con = _connect(db_path)
    try:
        last_progress = time.monotonic()
        for position, path in enumerate(paths, start=1):
            if progress and (position % 100 == 0 or time.monotonic() - last_progress >= 2):
                progress(f"正在检查文件：{position}/{len(paths)}……")
                last_progress = time.monotonic()
            try:
                signature = _signature(path)
                cached = con.execute(
                    "SELECT size,mtime_ns FROM source_files WHERE path=? AND device_id=?",
                    (str(path), device_id),
                ).fetchone()
                if cached is not None and tuple(cached) == signature:
                    stats["duplicates"] += 1
                    continue
                candidates.append((path, signature))
            except OSError as exc:
                stats["errors"].append({"path": str(path), "error": str(exc)})
        if candidates and stable_seconds:
            if progress:
                progress(f"等待 {stable_seconds:g} 秒，确认 {len(candidates)} 个待处理文件已写完……")
            time.sleep(stable_seconds)
        if progress:
            progress(f"开始读取 {len(candidates)} 个待处理文件，已采集文件 {stats['duplicates']} 个……")
        last_progress = time.monotonic()
        for position, (path, before) in enumerate(candidates, start=1):
            try:
                if _signature(path) != before:
                    stats["deferred"] += 1
                    continue
                expected_part = path.relative_to(root).parts[0]
                record = parse_csv(path, device_id=device_id, expected_part=expected_part)
                if _signature(path) != before:
                    stats["deferred"] += 1
                    continue
                existing = con.execute("SELECT 1 FROM detections WHERE record_id=?", (record["record_id"],)).fetchone()
                conflict = con.execute("SELECT 1 FROM detections WHERE logical_key=?", (record["logical_key"],)).fetchone()
                with con:
                    if existing:
                        stats["duplicates"] += 1
                    else:
                        con.execute(
                            "INSERT INTO detections VALUES (?,?,?,?)",
                            (record["record_id"], record["logical_key"], _json(record), datetime.now(timezone.utc).isoformat()),
                        )
                        stats["imported"] += 1
                        if conflict:
                            stats["conflicts"] += 1
                    con.execute(
                        "INSERT OR REPLACE INTO source_files VALUES (?,?,?,?,?)",
                        (str(path), device_id, before[0], before[1], record["record_id"]),
                    )
            except (ChangingFile, FileNotFoundError):
                stats["deferred"] += 1
            except (CSVFormatError, OSError) as exc:
                stats["errors"].append({"path": str(path), "error": str(exc)})
            finally:
                if progress and (position % 100 == 0 or time.monotonic() - last_progress >= 2):
                    progress(f"已处理 {position}/{len(candidates)} 个文件；新增 {stats['imported']}，错误 {len(stats['errors'])}……")
                    last_progress = time.monotonic()
    finally:
        con.close()
    if progress:
        progress(f"文件读取完成：新增 {stats['imported']}，已采集 {stats['duplicates']}，等待写完 {stats['deferred']}，错误 {len(stats['errors'])}。")
    return stats


def export_data(db_path, start_date=None, end_date=None, device_id=None):
    start_date, end_date = _date_bounds(start_date, end_date)
    conditions, parameters = [], []
    if start_date is not None:
        conditions.append("json_extract(d.payload, '$.measured_at_local') >= ?")
        parameters.append(start_date + "T00:00:00")
    if end_date is not None:
        conditions.append("json_extract(d.payload, '$.measured_at_local') <= ?")
        parameters.append(end_date + "T23:59:59")
    if device_id is not None:
        if not str(device_id).strip():
            raise ValueError("A device ID must not be empty")
        conditions.append("json_extract(d.payload, '$.device_id') = ?")
        parameters.append(str(device_id).strip())
    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    if not Path(db_path).is_file():
        raise FileNotFoundError(db_path)
    con = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        records = []
        # Filter using the indexed timestamp before materializing payloads in
        # Python. Check each selected identity against the complete DB so that
        # duplicate versions cannot be hidden by a filtered export.
        query = """
            SELECT d.payload, d.imported_at, EXISTS (
                SELECT 1 FROM detections AS other
                WHERE other.logical_key = d.logical_key
                  AND other.record_id <> d.record_id
            )
            FROM detections AS d
        """ + where
        for payload, imported_at, conflict in con.execute(query, parameters):
            record = json.loads(payload)
            record["identity_conflict"] = bool(conflict)
            record["imported_at"] = imported_at
            records.append(record)
    finally:
        con.close()
    records.sort(key=lambda r: (r["measured_at_local"], r["record_id"]))
    eligible = [r for r in records if not r["identity_conflict"]]
    ok = sum(r["source_result"] == "OK" for r in eligible)
    return {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "total_records": len(records), "eligible_records": len(eligible),
            "ok_records": ok, "ng_records": len(eligible) - ok,
            "conflict_records": len(records) - len(eligible),
            "pass_rate": ok / len(eligible) if eligible else None,
            "measurement_count": sum(len(r["measurements"]) for r in records),
            "count_basis": "detection_events_not_unique_parts",
        },
        "records": records,
    }


def _write_json(path, value, compact=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            json.dump(value, stream, ensure_ascii=False,
                      indent=None if compact else 2,
                      separators=(",", ":") if compact else None,
                      allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("parse", help="Parse a single regular CSV without connecting to the machine")
    one.add_argument("file", type=Path)
    one.add_argument("--output", type=Path)
    ingest = sub.add_parser("collect", help="Read completed CSV backups into a separate local SQLite file")
    ingest.add_argument("--source-root", type=Path, default=Path(DEFAULT_SOURCE_ROOT))
    ingest.add_argument("--device-id", required=True)
    ingest.add_argument("--database", type=Path, default=Path("data/vision.sqlite"))
    ingest.add_argument("--output", type=Path, default=Path("data/vision.json"))
    ingest.add_argument("--stable-seconds", type=float, default=3)
    ingest.add_argument("--interval", type=float, default=5)
    ingest.add_argument("--watch", action="store_true")
    ingest.add_argument("--recent-days", type=int,
                        help="Collect/export the most recent N local calendar days, including today")
    ingest.add_argument("--progress", action="store_true",
                        help="Print flushed progress messages to stderr")
    args = parser.parse_args(argv)
    try:
        if args.command == "parse":
            if args.output:
                _require_json_output(args.output)
                source = args.file.resolve()
                if source.parent.parent.name in ALLOWED_PARTS:
                    _require_outside_source(args.output, source.parent.parent.parent)
            if args.output and args.output.resolve() == args.file.resolve():
                raise ValueError("Output must not overwrite the source CSV")
            record = parse_csv(args.file)
            if args.output:
                _write_json(args.output, record)
            else:
                print(json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False))
            return 0
        if args.interval < 1 or args.stable_seconds < 0:
            raise ValueError("interval must be at least 1 second; stable-seconds must be nonnegative")
        if args.recent_days is not None and args.recent_days < 1:
            raise ValueError("recent-days must be a positive integer")
        _require_json_output(args.output)
        _require_outside_source(args.output, args.source_root)
        if args.output.resolve() == args.database.resolve():
            raise ValueError("JSON output and local database must use different paths")
        progress = (lambda message: print(message, file=sys.stderr, flush=True)) if args.progress else None
        while True:
            # Recalculate after each watch interval so midnight advances both
            # discovery and export together without requiring a restart.
            start_date = end_date = None
            if args.recent_days is not None:
                today = date.today()
                end_date = today.isoformat()
                try:
                    start_date = (today - timedelta(days=args.recent_days - 1)).isoformat()
                except OverflowError as exc:
                    raise ValueError("recent-days exceeds the supported calendar range") from exc
            if progress:
                progress(f"本轮日期范围：{start_date or '最早'} 至 {end_date or '最新'}；设备：{args.device_id.strip()}。")
            stats = ingest_once(args.source_root, args.database, args.device_id, args.stable_seconds,
                                start_date=start_date, end_date=end_date, progress=progress)
            if progress:
                progress("正在生成所选范围的网页数据……")
            document = export_data(args.database, start_date=start_date, end_date=end_date,
                                   device_id=args.device_id)
            document["last_scan"] = {
                "source_root": str(args.source_root),
                "start_date": start_date, "end_date": end_date,
                "scanned_at_utc": datetime.now(timezone.utc).isoformat(), **stats,
            }
            _write_json(args.output, document, compact=True)
            if progress:
                progress(f"网页数据已写入：{args.output}；共 {document['summary']['total_records']} 条检测记录。")
            print(json.dumps(stats, ensure_ascii=False), flush=True)
            if not args.watch:
                return 2 if stats["errors"] else 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 130
    except (CSVFormatError, ValueError, OSError, sqlite3.Error) as exc:
        parser.exit(2, f"Error: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
