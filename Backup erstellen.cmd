@echo off
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

for /f "usebackq delims=" %%V in (`"%NODE_EXE%" -e "const v=require('./package.json').version; const m=String(v).match(/^(\d+)\.(\d+)\.(\d+)-beta/); console.log(m ? ('v' + m[1] + '.' + m[2] + (m[3] === '0' ? '' : '.' + m[3]) + ' Beta') : 'v' + v)"`) do set "APP_VERSION=%%V"
if "%APP_VERSION%"=="" set "APP_VERSION=v0.78.5 Beta"
title Grabenplaner %APP_VERSION% Backup

echo.
echo  Eine konsistente Sicherung der Dienstplan-Datenbank wird erstellt ...
echo.
"%NODE_EXE%" backup.js

echo.
pause
