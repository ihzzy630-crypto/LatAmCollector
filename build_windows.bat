@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/4] 创建独立打包环境...
py -3.12 -m venv .buildvenv
if errorlevel 1 goto :error
echo [2/4] 安装依赖...
call .buildvenv\Scripts\python.exe -m pip install --upgrade pip
call .buildvenv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto :error
echo [3/4] 生成 Windows EXE...
call .buildvenv\Scripts\pyinstaller.exe --noconfirm --clean --onefile --name LatAmCollector --add-data "static;static" launcher.py
if errorlevel 1 goto :error
echo [4/4] 完成。
echo EXE 文件位置: %CD%\dist\LatAmCollector.exe
pause
exit /b 0
:error
echo 打包失败，请把本窗口最后的错误截图发给我。
pause
exit /b 1

