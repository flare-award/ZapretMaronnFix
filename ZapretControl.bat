@echo off
chcp 65001 > nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "EXE_PATH=%~dp0ZapretControl.exe"
set "CS_PATH=%~dp0app\host\ZapretControl.cs"
set "ICO_PATH=%~dp0app\host\app.ico"
set "CSC64=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "CSC32=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

set "NEED_BUILD=0"
if not exist "%EXE_PATH%" (
    set "NEED_BUILD=1"
) else (
    powershell -NoProfile -Command "$exe=(Get-Item -LiteralPath '%EXE_PATH%').LastWriteTimeUtc; $cs=(Get-Item -LiteralPath '%CS_PATH%').LastWriteTimeUtc; $ico=if(Test-Path -LiteralPath '%ICO_PATH%'){(Get-Item -LiteralPath '%ICO_PATH%').LastWriteTimeUtc}else{[datetime]::MinValue}; if($cs -gt $exe -or $ico -gt $exe){exit 1}else{exit 0}" > nul 2>&1
    if !errorlevel! equ 1 set "NEED_BUILD=1"
)

if "!NEED_BUILD!"=="1" (
    echo Сборка нативного лаунчера ZapretControl.exe...
    if exist "%CSC64%" (
        if exist "%ICO_PATH%" (
            "%CSC64%" /nologo /target:winexe /optimize+ /win32icon:"%ICO_PATH%" /out:"%EXE_PATH%" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "%CS_PATH%"
        ) else (
            "%CSC64%" /nologo /target:winexe /optimize+ /out:"%EXE_PATH%" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "%CS_PATH%"
        )
    ) else if exist "%CSC32%" (
        if exist "%ICO_PATH%" (
            "%CSC32%" /nologo /target:winexe /optimize+ /win32icon:"%ICO_PATH%" /out:"%EXE_PATH%" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "%CS_PATH%"
        ) else (
            "%CSC32%" /nologo /target:winexe /optimize+ /out:"%EXE_PATH%" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "%CS_PATH%"
        )
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
    rundll32.exe url.dll,FileProtocolHandler "http://127.0.0.1:3847"
    exit /b 0
)

echo Не удалось найти компилятор .NET Framework или Node.js.
pause
