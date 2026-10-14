"""Launcher behavior tests; these never read inspection data or start a watcher."""

import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import vision_portable


class PortableLauncherTests(unittest.TestCase):
    def invoke_menu(self, answers, *, result=0, error=None):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            output = io.StringIO()
            with mock.patch.object(vision_portable, "application_directory", return_value=base), \
                    mock.patch("builtins.input", side_effect=answers) as reader, \
                    mock.patch.object(vision_portable.vision_ingest, "main", return_value=result,
                                      side_effect=error) as collector, \
                    contextlib.redirect_stdout(output):
                status = vision_portable.main([])
            self.assertEqual(list(base.iterdir()), [], "The launcher itself must not write files")
            return status, output.getvalue(), reader, collector, base

    def test_enter_runs_once_and_waits_before_returning_to_menu(self):
        status, output, reader, collector, base = self.invoke_menu(["", "", "0"])
        self.assertEqual(status, 0)
        collector.assert_called_once_with(vision_portable.collection_arguments(base))
        self.assertNotIn("--watch", collector.call_args.args[0])
        self.assertIn("本次采集完成", output)
        self.assertIn("按回车返回菜单", reader.call_args_list[1].args[0])

    def test_watch_is_explicit_and_interrupt_returns_to_menu(self):
        status, output, reader, collector, base = self.invoke_menu(
            ["2", "", "0"], error=KeyboardInterrupt)
        collector.assert_called_once_with(vision_portable.collection_arguments(base, watch=True))
        self.assertEqual(status, 0)
        self.assertIn("已停止采集", output)
        self.assertNotIn("本次采集完成", output)
        self.assertEqual(reader.call_count, 3)

    def test_cli_arguments_bypass_menu_unchanged(self):
        arguments = ["parse", "sample.csv", "--output", "result.json"]
        with mock.patch.object(vision_portable.vision_ingest, "main", return_value=2) as collector, \
                mock.patch("builtins.input") as reader:
            self.assertEqual(vision_portable.main(arguments), 2)
        collector.assert_called_once_with(arguments)
        reader.assert_not_called()

    def test_cli_system_exit_is_preserved(self):
        with mock.patch.object(vision_portable.vision_ingest, "main", side_effect=SystemExit(2)), \
                mock.patch("builtins.input") as reader:
            with self.assertRaises(SystemExit) as raised:
                vision_portable.main(["collect"])
        self.assertEqual(raised.exception.code, 2)
        reader.assert_not_called()

    def test_core_error_does_not_close_the_menu_without_pause(self):
        for failure in (SystemExit(2), OSError("permission denied")):
            with self.subTest(failure=failure):
                status, output, reader, collector, base = self.invoke_menu(
                    ["1", "", "0"], error=failure)
                self.assertIn("本次采集出现错误", output)
                self.assertIn("按回车返回菜单", reader.call_args_list[1].args[0])
                self.assertEqual(status, 0)

    def test_nonzero_return_is_reported_as_error(self):
        status, output, reader, collector, base = self.invoke_menu(["1", "", "0"], result=2)
        self.assertIn("本次采集出现错误", output)
        self.assertNotIn("本次采集完成", output)

    def test_core_interrupt_result_is_not_reported_as_success(self):
        status, output, reader, collector, base = self.invoke_menu(["1", "", "0"], result=130)
        self.assertEqual(status, 0)
        self.assertIn("已停止采集", output)
        self.assertNotIn("本次采集完成", output)

    def test_exit_and_invalid_selection_never_collect(self):
        status, output, reader, collector, base = self.invoke_menu(["invalid", "0"])
        collector.assert_not_called()
        self.assertEqual(status, 0)
        self.assertIn("请输入 1、2 或 0", output)

    def test_eof_at_menu_exits_without_collecting(self):
        status, output, reader, collector, base = self.invoke_menu([EOFError()])
        collector.assert_not_called()
        self.assertEqual(status, 0)

    def test_eof_at_error_pause_preserves_error_status(self):
        status, output, reader, collector, base = self.invoke_menu(["1", EOFError()], result=2)
        self.assertEqual(status, 2)

    def test_executable_directory_is_used_for_frozen_build(self):
        executable = Path(tempfile.gettempdir()) / "portable" / "vision_collector.exe"
        with mock.patch.object(vision_portable.sys, "frozen", True, create=True), \
                mock.patch.object(vision_portable.sys, "executable", str(executable)):
            self.assertEqual(vision_portable.application_directory(), executable.resolve().parent)

    def test_script_directory_is_used_without_frozen_build(self):
        with mock.patch.object(vision_portable.sys, "frozen", False, create=True):
            self.assertEqual(vision_portable.application_directory(),
                             Path(vision_portable.__file__).resolve().parent)

    def test_paths_with_spaces_are_passed_as_individual_arguments(self):
        base = Path(tempfile.gettempdir()) / "检具 采集"
        arguments = vision_portable.collection_arguments(base)
        self.assertEqual(arguments[arguments.index("--source-root") + 1],
                         vision_portable.vision_ingest.DEFAULT_SOURCE_ROOT)
        self.assertEqual(arguments[arguments.index("--database") + 1], str(base / "data" / "vision.sqlite"))
        self.assertEqual(arguments[arguments.index("--output") + 1], str(base / "data" / "vision.json"))
        self.assertEqual(arguments[arguments.index("--device-id") + 1], "vision-01")
        self.assertEqual(arguments[arguments.index("--recent-days") + 1], "2")
        self.assertIn("--progress", arguments)


if __name__ == "__main__":
    unittest.main()
