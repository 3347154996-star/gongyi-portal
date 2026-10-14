"""Console entry point for the self-contained Windows collector."""

from pathlib import Path
import sys

import vision_ingest


DEVICE_ID = "vision-01"


def application_directory():
    """Keep data beside the executable, independent of the launch directory."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def collection_arguments(directory, *, watch=False):
    data_directory = Path(directory) / "data"
    arguments = [
        "collect",
        "--source-root", vision_ingest.DEFAULT_SOURCE_ROOT,
        "--device-id", DEVICE_ID,
        "--database", str(data_directory / "vision.sqlite"),
        "--output", str(data_directory / "vision.json"),
        "--stable-seconds", "3",
        "--interval", "5",
        "--recent-days", "2",
        "--progress",
    ]
    if watch:
        arguments.append("--watch")
    return arguments


def _pause():
    try:
        input("按回车返回菜单；退出请在菜单输入 0。")
        return True
    except (EOFError, KeyboardInterrupt):
        print()
        return False


def run_menu():
    directory = application_directory()
    print("视觉检具数据采集工具 v2 · 近期采集")
    print("适用：Windows 10 / 11，64 位。")
    print(f"数据来源：{vision_ingest.DEFAULT_SOURCE_ROOT}")
    print("采集型号：Tesla_Front11、Tesla_Front12。")
    print("排除：全部 _ALLmeasure 全检目录，以及 failure 目录。")
    print(f"采集结果：{directory / 'data' / 'vision.json'}")
    print(f"设备标识：{DEVICE_ID}（同一台检具保持不变；其他检具需使用不同标识）。")
    print("仅仅读取备份 CSV，采集结果另存到工具旁的 data 文件夹。")
    print("采集和输出范围：今天及昨天；持续采集时随电脑日期更新。")
    print("已保存的更早历史记录保留在数据库中，不删除，也不整库导出。")
    print("首次打开旧数据库可能需要建立日期索引，请观察进度提示。")
    print("本工具生成本机数据文件；跨电脑传输和网页连接需要另外配置。")

    while True:
        print("\n1. 近期采集一次（直接按回车）")
        print("2. 持续采集（按 Ctrl+C 停止采集并返回）")
        print("0. 退出")
        try:
            choice = input("请选择：").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n已退出。")
            return 0
        if choice == "0":
            return 0
        if choice not in ("", "1", "2"):
            print("请输入 1、2 或 0。")
            continue

        watch = choice == "2"
        print("\n正在采集，请等待输出。")
        print("结果字段：imported = 新增；duplicates = 已采集；deferred = 等待文件写完；errors = 错误列表。")
        try:
            result = vision_ingest.main(collection_arguments(directory, watch=watch))
            status = int(result or 0)
        except KeyboardInterrupt:
            print("\n已停止本次采集。")
            status = 130
        except SystemExit as exc:
            status = exc.code if isinstance(exc.code, int) else 2
            if exc.code and not isinstance(exc.code, int):
                print(str(exc.code))
        except Exception as exc:
            print(f"采集遇到错误：{exc}")
            status = 2

        if status == 130:
            print("已停止采集，本轮是否完成以统计结果为准。已提交的数据保留，下次继续处理。")
        elif status == 0:
            if watch:
                print("持续采集已结束。请查看上面的 errors 列表，确认各轮是否有读取错误。")
            else:
                print("本次采集完成。请查看上面的新增数量；0 条新增也可能是此前已采集。")
        else:
            print("本次采集出现错误。请保留上方完整提示或截图，先核对来源路径与文件访问权限。")
        if not _pause():
            return status


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments:
        return vision_ingest.main(arguments)
    return run_menu()


if __name__ == "__main__":
    raise SystemExit(main())
