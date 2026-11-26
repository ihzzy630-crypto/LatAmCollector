import argparse
import ctypes
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


def launch() -> None:
    from app.main import run

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--no-browser", action="store_true")
    args, _ = parser.parse_known_args()
    run(open_browser=not args.no_browser)


def main() -> int:
    frozen = getattr(sys, "frozen", False)
    if sys.platform != "win32" or (not frozen and sys.stdout is not None and sys.stderr is not None):
        launch()
        return 0

    directory = Path(sys.executable if frozen else __file__).resolve().parent
    log_file = directory / "data" / "startup.log"
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8", buffering=1) as log:
            with redirect_stdout(log), redirect_stderr(log):
                try:
                    launch()
                except Exception:
                    traceback.print_exc()
                    raise
    except Exception as error:
        if "--no-browser" not in sys.argv:
            message = f"{error}\n\n运行日志\n{log_file}"
            ctypes.windll.user32.MessageBoxW(None, message, "LatAmCollector", 0x10)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

