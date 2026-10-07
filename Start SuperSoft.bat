@echo off
title SuperSoft
cd /d "%~dp0"
python server.py
if errorlevel 1 (
  echo.
  echo Could not start SuperSoft. Make sure Python is installed.
  pause
)
