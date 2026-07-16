@echo off
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

for /f "usebackq delims=" %%V in (`"%NODE_EXE%" -e "const v=require('./package.json').version; const m=String(v).match(/^(\d+)\.(\d+)\.(\d+)-beta/); console.log(m ? ('v' + m[1] + '.' + m[2] + (m[3] === '0' ? '' : '.' + m[3]) + ' Beta') : 'v' + v)"`) do set "APP_VERSION=%%V"
if "%APP_VERSION%"=="" set "APP_VERSION=v0.63 Beta"

title Grabenplaner %APP_VERSION%

echo.
echo  Grabenplaner %APP_VERSION% wird gestartet ...
echo.

powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { Start-Process 'http://localhost:3000'; exit 10 }"
if %errorlevel% equ 10 (
    echo  Der Server laeuft bereits. Grabenplaner wurde im Browser geoeffnet.
    timeout /t 2 /nobreak >nul
    exit /b 0
)

if not exist "node_modules\" (
    echo  Der Ordner node_modules fehlt. Bitte die komplette App erneut herunterladen.
    pause
    exit /b 1
)

echo  Grabenplaner ist gleich unter http://localhost:3000 erreichbar.
echo  Zum Beenden dieses Fenster schliessen oder den Button Beenden nutzen.
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
"%NODE_EXE%" server.js

echo.
echo  Grabenplaner wurde beendet.
pause
