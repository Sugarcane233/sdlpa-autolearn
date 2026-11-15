@echo off
setlocal enabledelayedexpansion
set TARGET=%LOCALAPPDATA%\ngrok.zip
set URL=https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip
set FULL=12344369

:loop
set SIZE=0
if exist "%TARGET%" (
  for %%A in ("%TARGET%") do set SIZE=%%~zA
)
if !SIZE! GEQ %FULL% goto done
echo [!date! !time!] have !SIZE! / %FULL%
curl -sL -C - --max-time 600 --retry 5 --retry-delay 3 --retry-all-errors -o "%TARGET%" "%URL%"
timeout /t 8 /nobreak >nul
goto loop

:done
echo [!date! !time!] done !SIZE! bytes
