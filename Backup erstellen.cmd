@echo off
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

for /f "usebackq delims=" %%V in (`"%NODE_EXE%" -e "const v=require('./package.json').version; const l=String(v).match(/^(\d+)\.(\d+)\.(\d+)-beta\.legacy\.\d+$/); const b=String(v).match(/^(\d+)\.(\d+)\.(\d+)-beta/); console.log(l ? ('v' + l[1] + '.' + l[2] + (l[3] === '0' ? '' : '.' + l[3]) + ' Legacy') : b ? ('v' + b[1] + '.' + b[2] + (b[3] === '0' ? '' : '.' + b[3]) + ' Beta') : 'v' + v)"`) do set "APP_VERSION=%%V"
if "%APP_VERSION%"=="" set "APP_VERSION=v0.87 Legacy"
title Grabenplaner %APP_VERSION% Backup

echo.
echo  Eine konsistente Sicherung der Dienstplan-Datenbank wird erstellt ...
echo.
"%NODE_EXE%" backup.js

echo.
pause
