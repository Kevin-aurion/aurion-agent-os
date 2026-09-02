@echo off
chcp 65001 >nul
title Aurion AIOS Plugin Updater
cls
echo Aurion AIOS Plugin Installer and Updater
echo ========================================
echo.
echo This tool installs or updates the Claude and Codex plugins and checks the MCP login.
echo If authorization is needed, your browser will open automatically.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0resources\Update-Aurion-AIOS-Plugins.ps1"
set "AURION_RESULT=%ERRORLEVEL%"

echo.
if "%AURION_RESULT%"=="0" (
  echo Installation or update completed. Restart Claude or Codex and open a new conversation.
) else (
  echo Some items were not completed. Please keep this window for support.
)
echo.
pause
exit /b %AURION_RESULT%
