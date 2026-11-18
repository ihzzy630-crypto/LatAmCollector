@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo 尚未安装运行环境，请先运行 install_windows.ps1
    pause
    exit /b 1
)

echo 正在启动 LatAmCollector...
echo 关闭本窗口将停止平台。
".venv\Scripts\python.exe" launcher.py
if errorlevel 1 (
    echo.
    echo 平台异常退出，请把本窗口内容截图发给开发者。
    pause
)
