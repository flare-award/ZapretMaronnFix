@echo off
chcp 65001 > nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "EXE_PATH=%~dp0ZapretControl.exe"
set "CS_PATH=%~dp0app\host\ZapretControl.cs"
set "CSC64=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "CSC32=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

if not exist "%EXE_PATH%" (
    echo Сборка нативного лаунчера ZapretControl.exe...
    if exist "%CSC64%" (
        "%CSC64%" /nologo /target:winexe /optimize+ /out:"%EXE_PATH%" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "%CS_PATH%"
    ) else if exist "%CSC32%" (
        "%CSC32%" /nologo /target:winexe /optimize+ /out:"%EXE_PATH%" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "%CS_PATH%"
    )
)

if exist "%EXE_PATH%" (
    start "" "%EXE_PATH%" %*
    exit /b 0
)

where node > nul 2>&1
if !errorlevel!==0 (
    start "Zapret Control Server" /min cmd /c "node app\server\index.mjs"
    timeout /t 1 /nobreak > nul
    start "" "http://127.0.0.1:3847"
    exit /b 0
)

echo Не удалось найти компилятор .NET Framework или Node.js.
pause
