param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$ZapretDir
)

$ProgressPreference = "SilentlyContinue"
$ErrorActionPreference = "Stop"
$DataDir = Join-Path $RepoRoot "app\data"
$StateFile = Join-Path $DataDir "steam-speed-state.json"
$HistoryFile = Join-Path $DataDir "steam-speed-history.json"
$StopFile = Join-Path $DataDir "steam-speed-stop.flag"
$BytesPerStream = 4194304
$Streams = 2
$Urls = @(
    "https://client-update.akamai.steamstatic.com/client/steam_client_win32",
    "https://media.steampowered.com/client/installer/SteamSetup.exe"
)
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue

function Write-State($state) {
    $tmp = "$StateFile.tmp"
    ($state | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $StateFile -Force
}

function Stop-Winws {
    Get-Process -Name "winws" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Start-Strategy([string]$fileName) {
    $settingsFile = Join-Path $DataDir "settings.json"
    $settings = if (Test-Path $settingsFile) { Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $batPath = Join-Path $ZapretDir $fileName
    $raw = (Get-Content $batPath -Raw -Encoding UTF8) -replace "\^\r?\n", " "
    $match = [regex]::Match($raw, '(?im)winws\.exe"\s+(.+)$')
    if (-not $match.Success) { throw "Не найдена команда winws.exe" }
    $argLine = $match.Groups[1].Value.Trim()
    $binPath = (Join-Path $ZapretDir "bin") + "\"
    $listsPath = (Join-Path $ZapretDir "lists") + "\"
    $argLine = $argLine.Replace("%BIN%", $binPath).Replace("!BIN!", $binPath)
    $argLine = $argLine.Replace("%LISTS%", $listsPath).Replace("!LISTS!", $listsPath)
    $argLine = $argLine.Replace("%GameFilterTCP%", "1024-65535").Replace("!GameFilterTCP!", "1024-65535")
    $argLine = $argLine.Replace("%GameFilterUDP%", "1024-65535").Replace("!GameFilterUDP!", "1024-65535")
    $argLine = $argLine.Replace("%GameFilter%", "1024-65535").Replace("!GameFilter!", "1024-65535")
    Stop-Winws
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $ZapretDir "bin\winws.exe"
    $psi.Arguments = $argLine
    $psi.WorkingDirectory = Join-Path $ZapretDir "bin"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Measure-SteamCdn {
    $curl = (Get-Command "curl.exe" -ErrorAction Stop).Source
    $lastError = "Steam CDN недоступна"
    foreach ($url in $Urls) {
        $tempFiles = @()
        $processes = @()
        $started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        try {
            for ($i = 0; $i -lt $Streams; $i++) {
                $outFile = Join-Path $env:TEMP "zapret-steam-$PID-$i.txt"
                $errFile = Join-Path $env:TEMP "zapret-steam-$PID-$i.err"
                $tempFiles += @($outFile, $errFile)
                $target = "$url`?zapret_speed_test=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$i"
                $curlArgs = @("-fsSL", "--connect-timeout", "6", "--max-time", "18", "--retry", "1", "--range", "0-$($BytesPerStream - 1)", "-H", "Accept-Encoding:identity", "-o", "NUL", "-w", "%{http_code}|%{size_download}|%{time_starttransfer}", $target)
                $processes += Start-Process -FilePath $curl -ArgumentList $curlArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            }
            $processes | ForEach-Object { $_.WaitForExit() }
            $elapsed = [Math]::Max(0.001, ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started) / 1000.0)
            $totalBytes = 0.0
            $totalLatency = 0.0
            $valid = 0
            for ($i = 0; $i -lt $processes.Count; $i++) {
                if ($processes[$i].ExitCode -ne 0) { throw "Ошибка загрузки Steam CDN" }
                $metric = (Get-Content $tempFiles[$i * 2] -Raw -ErrorAction Stop).Trim()
                $parts = $metric.Split('|')
                if ($parts.Count -lt 3 -or [int]$parts[0] -lt 200 -or [int]$parts[0] -ge 400) { throw "Некорректный ответ Steam CDN" }
                $totalBytes += [double]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture)
                $totalLatency += [double]::Parse($parts[2], [Globalization.CultureInfo]::InvariantCulture) * 1000
                $valid++
            }
            $mbps = ($totalBytes / 1MB) / $elapsed
            return [ordered]@{
                ok = $true
                megabytesPerSecond = [Math]::Round($mbps, 2)
                megabitsPerSecond = [Math]::Round($mbps * 8, 1)
                latencyMs = [Math]::Round($totalLatency / $valid)
                bytesDownloaded = [Math]::Round($totalBytes)
                durationMs = [Math]::Round($elapsed * 1000)
                endpointHost = ([Uri]$url).Host
                error = $null
            }
        } catch {
            $lastError = $_.Exception.Message
        } finally {
            $tempFiles | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
        }
    }
    return [ordered]@{ ok = $false; megabytesPerSecond = 0; megabitsPerSecond = 0; latencyMs = $null; bytesDownloaded = 0; durationMs = 0; endpointHost = $null; error = $lastError }
}

$strategies = @(Get-ChildItem -LiteralPath $ZapretDir -Filter "*.bat" | Where-Object { $_.Name -ne "service.bat" } | Sort-Object Name)
$startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$state = [ordered]@{
    running = $true; aborted = $false; startedAt = $startedAt; finishedAt = $null
    currentStrategy = if ($strategies.Count) { $strategies[0].Name } else { $null }
    completedCount = 0; totalCount = $strategies.Count; progressPct = 0; results = @(); error = $null
    sourceLabel = "Официальная CDN Steam"; sampleBytesPerStrategy = $Streams * $BytesPerStream
}
Write-State $state

try {
    for ($i = 0; $i -lt $strategies.Count; $i++) {
        if (Test-Path $StopFile) { $state.aborted = $true; break }
        $fileName = $strategies[$i].Name
        $state.currentStrategy = $fileName
        Write-State $state
        try {
            Start-Strategy $fileName
            Start-Sleep -Milliseconds 900
            $measurement = Measure-SteamCdn
        } catch {
            $measurement = [ordered]@{ ok = $false; megabytesPerSecond = 0; megabitsPerSecond = 0; latencyMs = $null; bytesDownloaded = 0; durationMs = 0; endpointHost = $null; error = $_.Exception.Message }
        } finally {
            Stop-Winws
        }
        $result = [ordered]@{ fileName = $fileName }
        foreach ($property in $measurement.GetEnumerator()) { $result[$property.Key] = $property.Value }
        $state.results += $result
        $state.completedCount = $i + 1
        $state.progressPct = [Math]::Round((($i + 1) / $strategies.Count) * 100)
        Write-State $state
    }
} catch {
    $state.error = $_.Exception.Message
} finally {
    Stop-Winws
    $state.running = $false
    $state.currentStrategy = $null
    $state.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-State $state
    if ($state.results.Count -gt 0) {
        $run = [ordered]@{ id = "steam-$startedAt"; startedAt = $startedAt; finishedAt = $state.finishedAt; aborted = $state.aborted; sourceLabel = $state.sourceLabel; sampleBytesPerStrategy = $state.sampleBytesPerStrategy; results = $state.results }
        $history = @()
        if (Test-Path $HistoryFile) { try { $history = @(Get-Content $HistoryFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch {} }
        $newHistory = @($run) + @($history)
        $newHistory | Select-Object -First 8 | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $HistoryFile -Encoding UTF8
    }
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}
