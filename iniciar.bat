@echo off
title Tacala - PDF Studio y Escaner HP
cd /d "%~dp0"

echo ========================================================
echo   Iniciando Tacala PDF Studio...
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] No se encontro Node.js instalado en esta PC.
    echo Por favor descarga e instala Node.js desde https://nodejs.org/
    echo.
    pause
    exit /b
)

start "" http://localhost:3000/
node server.js
pause
