@echo off
chcp 65001 > nul
cd /d "%~dp0"
title Zapret Control

where node > nul 2>&1
if errorlevel 1 (
    echo Для запуска интерфейса Zapret Control установите Node.js LTS с официального сайта:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Сервер Zapret Control запущен (http://127.0.0.1:3847).
echo Для перехвата трафика через WinDivert запускайте этот файл от имени Администратора.
node "%~dp0app\server\index.mjs" --open
