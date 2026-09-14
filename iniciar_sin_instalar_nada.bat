@echo off
title Tacala PDF Studio - Servidor Local Windows
cd /d "%~dp0"

echo ========================================================
echo   Iniciando Tacala (100%% Nativo de Windows)
echo   NO requiere instalar Node.js ni ningun programa extra.
echo ========================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server_windows.ps1"
pause
