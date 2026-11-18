@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" py -3.12 -m venv .venv
call .venv\Scripts\python.exe -m pip install -r requirements.txt
call .venv\Scripts\python.exe launcher.py
pause

