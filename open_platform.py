from __future__ import annotations

import ctypes
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:8765"
HEALTH_URL = URL + "/api/system"


def service_ready() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=0.8) as response:
            return response.status == 200
    except Exception:
        return False


def show_error(message: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(0, message, "LatAmCollector", 0x10)
    except Exception:
        pass


def main() -> None:
    if not service_ready():
        launcher = ROOT / "launcher.py"
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        try:
            subprocess.Popen(
                [sys.executable, str(launcher), "--no-browser"],
                cwd=str(ROOT),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=flags,
                close_fds=True,
            )
        except OSError as exc:
            show_error("Local platform could not start.\n\n" + str(exc))
            return
        for _ in range(40):
            if service_ready():
                break
            time.sleep(0.2)
    if service_ready():
        webbrowser.open(URL + "/?page=dashboard")
    else:
        show_error("Local platform did not start. Please run the installer again.")


if __name__ == "__main__":
    main()
