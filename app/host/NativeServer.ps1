param(
    [int]$Port = 3847,
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppDir = Join-Path $RepoRoot "app"
$StaticDir = Join-Path $AppDir "static"
$DataDir = Join-Path $AppDir "data"
$BackupDir = Join-Path $DataDir "user-lists-backup"
$SettingsFile = Join-Path $DataDir "settings.json"
$ProfilesFile = Join-Path $DataDir "profiles.json"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$script:ActiveWinws = $null
$script:StartedAtMs = $null
$script:ActiveStrategy = $null

function Get-AppSettings {
    $defaults = [ordered]@{
        zapretDir = (Join-Path $RepoRoot "zapret")
        selectedStrategy = "general (ALT11).bat"
        activeProfileId = "default"
        showBestStrategyCards = $true
        connectLayout = "split"
        autoStartStrategyOnLaunch = $false
        launchOnWindowsStartup = $false
        startMinimizedToTray = $false
        minimizeToTrayOnClose = $true
        autoRestartOnFilterChange = $true
        autoCheckUpdates = $true
        showWinwsConsole = $false
    }
    if (Test-Path $SettingsFile) {
        try {
            $loaded = Get-Content $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $loaded.PSObject.Properties) {
                $defaults[$p.Name] = $p.Value
            }
        } catch {}
    }
    return $defaults
}

function Save-AppSettings($patch) {
    $cur = Get-AppSettings
    foreach ($p in $patch.PSObject.Properties) {
        $cur[$p.Name] = $p.Value
    }
    ($cur | ConvertTo-Json -Depth 6) | Set-Content -Path $SettingsFile -Encoding UTF8
    return $cur
}

function Read-GameFilter($zapretDir) {
    $flag = Join-Path $zapretDir "utils\game_filter.enabled"
    $mode = "disabled"
    $tcp = "1024-65535"
    $udp = "1024-65535"
    if (Test-Path $flag) {
        $lines = Get-Content $flag -Encoding UTF8
        $hasKv = $false
        foreach ($l in $lines) {
            if ($l -match "^mode=(.+)$") { $mode = $Matches[1].Trim(); $hasKv = $true }
            elseif ($l -match "^tcp=(.+)$") { $tcp = $Matches[1].Trim(); $hasKv = $true }
            elseif ($l -match "^udp=(.+)$") { $udp = $Matches[1].Trim(); $hasKv = $true }
        }
        if (-not $hasKv -and $lines.Count -gt 0) {
            $first = $lines[0].Trim().ToLower()
            if ($first -in @("all", "tcp", "udp", "disabled")) { $mode = $first }
        }
    }
    return @{ mode = $mode; tcpRange = $tcp; udpRange = $udp }
}

function Write-GameFilter($zapretDir, $mode, $tcp, $udp) {
    $utilsDir = Join-Path $zapretDir "utils"
    New-Item -ItemType Directory -Force -Path $utilsDir | Out-Null
    $flag = Join-Path $utilsDir "game_filter.enabled"
    if ($mode -eq "disabled") {
        if (Test-Path $flag) { Remove-Item -Force $flag }
        return
    }
    $text = "$mode`r`nmode=$mode`r`ntcp=$tcp`r`nudp=$udp`r`n"
    Set-Content -Path $flag -Value $text -Encoding UTF8
}

function Get-ProfilesList($settings) {
    $gf = Read-GameFilter $settings.zapretDir
    $nowIso = [DateTime]::UtcNow.ToString("o")
    $defaultProf = [ordered]@{
        id = "default"
        name = "Основной"
        description = ""
        isDefault = $true
        strategy = $settings.selectedStrategy
        gameFilterMode = $gf.mode
        gameFilterTcp = $gf.tcpRange
        gameFilterUdp = $gf.udpRange
        ipsetMode = "none"
        discordFakeBin = $null
        gameFakeBin = $null
        updatedAt = $nowIso
    }
    if (Test-Path $ProfilesFile) {
        try {
            $arr = @(Get-Content $ProfilesFile -Raw -Encoding UTF8 | ConvertFrom-Json)
            if ($arr.Count -gt 0) {
                return $arr
            }
        } catch {}
    }
    $initList = @($defaultProf)
    ($initList | ConvertTo-Json -Depth 6) | Set-Content -Path $ProfilesFile -Encoding UTF8
    return $initList
}

function Stop-WinwsDirect {
    if ($script:ActiveWinws -and -not $script:ActiveWinws.HasExited) {
        try { $script:ActiveWinws.Kill() } catch {}
    }
    Get-Process -Name "winws" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $script:ActiveWinws = $null
    $script:StartedAtMs = $null
    $script:ActiveStrategy = $null
}

function Start-WinwsDirect($strategyName) {
    $settings = Get-AppSettings
    $zDir = $settings.zapretDir
    $batName = if ($strategyName) { $strategyName } else { $settings.selectedStrategy }
    $batPath = Join-Path $zDir $batName
    if (-not (Test-Path $batPath)) { throw "Файл стратегии не найден: $batName" }

    $gf = Read-GameFilter $zDir
    $effTcp = if ($gf.mode -in @("all", "tcp")) { $gf.tcpRange } else { "12" }
    $effUdp = if ($gf.mode -in @("all", "udp")) { $gf.udpRange } else { "12" }

    $raw = (Get-Content $batPath -Raw -Encoding UTF8) -replace "\^\r?\n", " "
    $match = [regex]::Match($raw, '(?im)winws\.exe"\s+(.+)$')
    if (-not $match.Success) { throw "Не найдена команда winws.exe в $batName" }

    $argLine = $match.Groups[1].Value.Trim()
    $binPath = (Join-Path $zDir "bin") + "\"
    $listsPath = (Join-Path $zDir "lists") + "\"
    $argLine = $argLine.Replace("%BIN%", $binPath).Replace("!BIN!", $binPath)
    $argLine = $argLine.Replace("%LISTS%", $listsPath).Replace("!LISTS!", $listsPath)
    $argLine = $argLine.Replace("%GameFilterTCP%", $effTcp).Replace("!GameFilterTCP!", $effTcp)
    $argLine = $argLine.Replace("%GameFilterUDP%", $effUdp).Replace("!GameFilterUDP!", $effUdp)
    $argLine = $argLine.Replace("%GameFilter%", $effUdp).Replace("!GameFilter!", $effUdp)

    Stop-WinwsDirect
    & netsh interface tcp set global timestamps=enabled | Out-Null

    $winwsExe = Join-Path $zDir "bin\winws.exe"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $winwsExe
    $psi.Arguments = $argLine
    $psi.WorkingDirectory = Join-Path $zDir "bin"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = (-not [bool]$settings.showWinwsConsole)
    $script:ActiveWinws = [System.Diagnostics.Process]::Start($psi)
    $script:ActiveStrategy = $batName
    $script:StartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$ResumeFlagFile = Join-Path $DataDir "resume-after-update.json"
$UpdateStateFile = Join-Path $DataDir "app-update-state.json"

function Get-GitBlobSha1([byte[]]$bytes) {
    $header = [System.Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)`0")
    $combined = New-Object byte[] ($header.Length + $bytes.Length)
    [System.Buffer]::BlockCopy($header, 0, $combined, 0, $header.Length)
    [System.Buffer]::BlockCopy($bytes, 0, $combined, $header.Length, $bytes.Length)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    $hash = $sha1.ComputeHash($combined)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLower()
}

function Get-LatestAppCommit {
    $headers = @{ "User-Agent" = "ZapretControl/1.2"; "Accept" = "application/vnd.github+json" }
    $branches = Invoke-RestMethod -Uri "https://api.github.com/repos/flare-award/ZapretMaronnFix/branches?per_page=20" -Headers $headers -TimeoutSec 15
    $best = $null
    foreach ($b in ($branches | Select-Object -First 8)) {
        try {
            $c = Invoke-RestMethod -Uri "https://api.github.com/repos/flare-award/ZapretMaronnFix/commits/$($b.commit.sha)" -Headers $headers -TimeoutSec 15
            $tree = Invoke-RestMethod -Uri "https://api.github.com/repos/flare-award/ZapretMaronnFix/git/trees/$($c.commit.tree.sha)?recursive=1" -Headers $headers -TimeoutSec 15
            $hasApp = $false
            foreach ($e in $tree.tree) { if ($e.path -eq "app/server/index.mjs") { $hasApp = $true; break } }
            if (-not $hasApp) { continue }
            $dt = [DateTimeOffset]::Parse($c.commit.committer.date).ToUnixTimeMilliseconds()
            if ($null -eq $best -or $dt -gt $best.ts) {
                $best = @{
                    branch = $b.name
                    sha = $c.sha
                    shortSha = $c.sha.Substring(0, 7)
                    publishedAt = $c.commit.committer.date
                    ts = $dt
                    message = ($c.commit.message -split "`r?`n")[0]
                    htmlUrl = $c.html_url
                    entries = $tree.tree
                }
            }
        } catch {}
    }
    if ($null -eq $best) { throw "В репозитории на GitHub не найдена сборка Zapret Control" }
    return $best
}

function Check-AppUpdatePs {
    $latest = Get-LatestAppCommit
    $changed = 0
    foreach ($e in $latest.entries) {
        if ($e.type -ne "blob") { continue }
        $p = [string]$e.path
        if ($p -ne "ZapretControl.bat" -and (-not $p.StartsWith("app/") -or $p.StartsWith("app/data/") -or $p.StartsWith("app/node_modules/"))) { continue }
        $localFile = Join-Path $RepoRoot ($p -replace "/", "\")
        if (-not (Test-Path -LiteralPath $localFile)) { $changed++; continue }
        $raw = [System.IO.File]::ReadAllBytes($localFile)
        $shaRaw = Get-GitBlobSha1 $raw
        if ($shaRaw -eq $e.sha) { continue }
        $lfText = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($raw) -replace "`r`n", "`n"
        $shaLf = Get-GitBlobSha1 ([System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($lfText))
        if ($shaLf -eq $e.sha) { continue }
        $changed++
    }
    if ($changed -eq 0) {
        (@{
            installedSha = $latest.sha
            installedShortSha = $latest.shortSha
            installedBranch = $latest.branch
            commitDate = $latest.publishedAt
            commitMessage = $latest.message
        } | ConvertTo-Json) | Set-Content -Path $UpdateStateFile -Encoding UTF8
    }
    $localState = if (Test-Path $UpdateStateFile) { Get-Content $UpdateStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    return @{
        repo = "flare-award/ZapretMaronnFix"
        currentShortSha = if ($changed -eq 0) { $latest.shortSha } elseif ($localState) { $localState.installedShortSha } else { $null }
        currentDate = if ($changed -eq 0) { $latest.publishedAt } elseif ($localState) { $localState.commitDate } else { $null }
        latestSha = $latest.sha
        latestShortSha = $latest.shortSha
        branch = $latest.branch
        publishedAt = $latest.publishedAt
        commitMessage = $latest.message
        changedFilesCount = $changed
        updateAvailable = ($changed -gt 0)
        htmlUrl = $latest.htmlUrl
        checkedAt = [DateTime]::UtcNow.ToString("o")
    }
}

$initSettings = Get-AppSettings
if (Test-Path $ResumeFlagFile) {
    try {
        $resumeObj = Get-Content $ResumeFlagFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Remove-Item -LiteralPath $ResumeFlagFile -Force -ErrorAction SilentlyContinue
        if ($resumeObj.strategy) { Start-WinwsDirect $resumeObj.strategy }
    } catch {}
} elseif ($initSettings.autoStartStrategyOnLaunch) {
    try { Start-WinwsDirect $initSettings.selectedStrategy } catch {}
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

$mimeMap = @{
    ".html"        = "text/html; charset=utf-8"
    ".js"          = "application/javascript; charset=utf-8"
    ".css"         = "text/css; charset=utf-8"
    ".json"        = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".ico"         = "image/x-icon"
    ".png"         = "image/png"
    ".woff2"       = "font/woff2"
    ".woff"        = "font/woff"
    ".svg"         = "image/svg+xml"
}

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $urlPath = $req.Url.AbsolutePath

    try {
        if ($urlPath.StartsWith("/api/")) {
            $bodyObj = $null
            if ($req.HasEntityBody) {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $rawBody = $reader.ReadToEnd()
                if ($rawBody.Trim()) { $bodyObj = $rawBody | ConvertFrom-Json }
            }

            if ($urlPath -eq "/api/app-update/check" -and $req.HttpMethod -eq "GET") {
                $chk = Check-AppUpdatePs
                $chkBytes = [System.Text.Encoding]::UTF8.GetBytes(($chk | ConvertTo-Json -Depth 6))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($chkBytes, 0, $chkBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -eq "/api/app-update/install" -and $req.HttpMethod -eq "POST") {
                $staging = Join-Path $DataDir "staging-update"
                if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
                New-Item -ItemType Directory -Force -Path $staging | Out-Null
                $zipPath = Join-Path $staging "update.zip"
                $extractDir = Join-Path $staging "extracted"
                $preserveDir = Join-Path $staging "preserve"
                New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
                New-Item -ItemType Directory -Force -Path $preserveDir | Out-Null

                if ($bodyObj -and $bodyObj.zipBase64) {
                    $b64 = ([string]$bodyObj.zipBase64) -replace "^data:[^;]+;base64,", ""
                    [System.IO.File]::WriteAllBytes($zipPath, [Convert]::FromBase64String($b64))
                } else {
                    $latest = Get-LatestAppCommit
                    Invoke-WebRequest -Uri "https://codeload.github.com/flare-award/ZapretMaronnFix/zip/$($latest.sha)" -OutFile $zipPath -UseBasicParsing -TimeoutSec 45
                    (@{
                        installedSha = $latest.sha
                        installedShortSha = $latest.shortSha
                        installedBranch = $latest.branch
                        commitDate = $latest.publishedAt
                        commitMessage = $latest.message
                    } | ConvertTo-Json) | Set-Content -Path $UpdateStateFile -Encoding UTF8
                }

                Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
                $srcRoot = $extractDir
                Get-ChildItem -LiteralPath $extractDir -Directory | ForEach-Object {
                    if (Test-Path (Join-Path $_.FullName "ZapretControl.bat")) { $srcRoot = $_.FullName }
                }

                foreach ($rel in @("zapret\lists\list-general-user.txt","zapret\lists\list-exclude-user.txt","zapret\lists\ipset-exclude-user.txt","zapret\lists\ipset-all.txt","zapret\lists\ipset-all.txt.backup","zapret\utils\game_filter.enabled","zapret\utils\targets.txt","zapret\bin\ACTIVE_DISCORD_UDP.bin","zapret\bin\ACTIVE_GAME_UDP.bin")) {
                    $sFile = Join-Path $RepoRoot $rel
                    if (Test-Path -LiteralPath $sFile) {
                        $dFile = Join-Path $preserveDir $rel
                        New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($dFile)) | Out-Null
                        Copy-Item -LiteralPath $sFile -Destination $dFile -Force
                    }
                }

                if ($null -ne $script:ActiveWinws -and -not $script:ActiveWinws.HasExited -and $script:ActiveStrategy) {
                    (@{ strategy = $script:ActiveStrategy } | ConvertTo-Json) | Set-Content -Path $ResumeFlagFile -Encoding UTF8
                }

                $applyScript = Join-Path $staging "apply-update.ps1"
                $scriptBody = @"
Start-Sleep -Milliseconds 700
Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -and (`$_.CommandLine -like '*ui-window-v2*' -or `$_.CommandLine -like '*window-profile*') } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Name 'ZapretControl' -Force -ErrorAction SilentlyContinue
Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue
Stop-Process -Name 'winws' -Force -ErrorAction SilentlyContinue
`$exePath = Join-Path '$($RepoRoot.Replace("'", "''"))' 'ZapretControl.exe'
for (`$i = 0; `$i -lt 25; `$i++) { if (-not (Test-Path -LiteralPath `$exePath)) { break }; try { Remove-Item -LiteralPath `$exePath -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 200 } }
`$oldAssets = Join-Path '$($RepoRoot.Replace("'", "''"))' 'app\static\assets'
if (Test-Path -LiteralPath `$oldAssets) { Remove-Item -LiteralPath `$oldAssets -Recurse -Force -ErrorAction SilentlyContinue }
Get-ChildItem -LiteralPath '$($srcRoot.Replace("'", "''"))' -Force | ForEach-Object {
    if (`$_.Name -eq '.git') { return }
    if (`$_.Name -eq 'app') {
        Get-ChildItem -LiteralPath `$_.FullName -Force | Where-Object { `$_.Name -ne 'data' -and `$_.Name -ne 'node_modules' } | ForEach-Object { Copy-Item -LiteralPath `$_.FullName -Destination (Join-Path '$($RepoRoot.Replace("'", "''"))' 'app') -Recurse -Force }
    } else {
        Copy-Item -LiteralPath `$_.FullName -Destination '$($RepoRoot.Replace("'", "''"))' -Recurse -Force
    }
}
if (Test-Path -LiteralPath '$($preserveDir.Replace("'", "''"))') {
    Get-ChildItem -LiteralPath '$($preserveDir.Replace("'", "''"))' -Force | ForEach-Object { Copy-Item -LiteralPath `$_.FullName -Destination '$($RepoRoot.Replace("'", "''"))' -Recurse -Force }
}
Start-Sleep -Milliseconds 250
Remove-Item -LiteralPath '$($staging.Replace("'", "''"))' -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path '$($RepoRoot.Replace("'", "''"))' 'ZapretControl.bat') -WorkingDirectory '$($RepoRoot.Replace("'", "''"))'
"@
                Set-Content -Path $applyScript -Value $scriptBody -Encoding UTF8
                Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$applyScript`"" -WindowStyle Hidden | Out-Null

                $okBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ ok = $true; restarting = $true; message = "Обновление установлено, выполняется перезапуск..." } | ConvertTo-Json))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($okBytes, 0, $okBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -eq "/api/system/open-url" -and $req.HttpMethod -eq "POST") {
                $u = [string]$bodyObj.url
                if ($u -match "^https?://") {
                    Start-Process "rundll32.exe" -ArgumentList "url.dll,FileProtocolHandler $u" | Out-Null
                }
                $okBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ opened = $true } | ConvertTo-Json))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($okBytes, 0, $okBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -eq "/api/runner/start" -and $req.HttpMethod -eq "POST") {
                Start-WinwsDirect $bodyObj.strategy
            } elseif ($urlPath -eq "/api/runner/stop" -and $req.HttpMethod -eq "POST") {
                Stop-WinwsDirect
            } elseif ($urlPath -eq "/api/settings" -and $req.HttpMethod -eq "POST") {
                Save-AppSettings $bodyObj | Out-Null
            } elseif ($urlPath -eq "/api/profiles/activate" -and $req.HttpMethod -eq "POST") {
                $stCur = Get-AppSettings
                $profs = Get-ProfilesList $stCur
                $targetProf = $profs | Where-Object { $_.id -eq $bodyObj.id } | Select-Object -First 1
                if ($targetProf) {
                    Write-GameFilter $stCur.zapretDir $targetProf.gameFilterMode $targetProf.gameFilterTcp $targetProf.gameFilterUdp
                    Save-AppSettings ([pscustomobject]@{
                        activeProfileId = $targetProf.id
                        selectedStrategy = $targetProf.strategy
                    }) | Out-Null
                    if ($bodyObj.startNow -or ($null -ne $script:ActiveWinws -and -not $script:ActiveWinws.HasExited)) {
                        Start-WinwsDirect $targetProf.strategy
                    }
                }
            }

            $st = Get-AppSettings
            $zDir = $st.zapretDir
            $svcFile = Join-Path $zDir "service.bat"
            $ver = "unknown"
            if (Test-Path $svcFile) {
                $svcRaw = Get-Content $svcFile -Raw -Encoding UTF8
                if ($svcRaw -match 'LOCAL_VERSION=([^\r\n"]+)') { $ver = $Matches[1].Trim() }
            }
            $strats = @()
            if (Test-Path $zDir) {
                Get-ChildItem -Path $zDir -Filter "*.bat" | Where-Object { $_.Name -ne "service.bat" } | Sort-Object Name | ForEach-Object {
                    $strats += @{
                        fileName = $_.Name
                        displayName = ($_.BaseName)
                        sizeBytes = $_.Length
                        modifiedAt = $_.LastWriteTimeUtc.ToString("o")
                        engineSummary = "Стратегия Zapret"
                        usesGameFilter = $true
                        usesIpset = $true
                        commandPreview = (Get-Content $_.FullName -Raw -Encoding UTF8)
                    }
                }
            }

            $profilesArr = @(Get-ProfilesList $st)
            $runningNow = ($null -ne $script:ActiveWinws -and -not $script:ActiveWinws.HasExited)
            $statePayload = @{
                platform = @{ os = "win32"; arch = "x64" }
                settings = $st
                profiles = $profilesArr
                activeProfileId = $st.activeProfileId
                runtime = @{
                    running = $runningNow
                    activeStrategy = if ($runningNow) { $script:ActiveStrategy } else { $null }
                    startedAt = if ($runningNow) { $script:StartedAtMs } else { $null }
                    pid = if ($runningNow) { $script:ActiveWinws.Id } else { $null }
                    appliedGameFilter = (Read-GameFilter $zDir).mode
                    appliedIpsetMode = "none"
                    expandedCommand = $null
                    modeNote = $null
                }
                zapretInfo = @{
                    valid = (Test-Path $svcFile)
                    hasWinwsBinary = (Test-Path (Join-Path $zDir "bin\winws.exe"))
                    localVersion = $ver
                    zapretPath = $zDir
                    lastModified = $null
                    strategyCount = $strats.Count
                    binCount = @(Get-ChildItem -Path (Join-Path $zDir "bin") -Filter "*.bin" -ErrorAction SilentlyContinue).Count
                    links = @{
                        upstreamRepo = "https://github.com/Flowseal/zapret-discord-youtube"
                        latestRelease = "https://github.com/Flowseal/zapret-discord-youtube/releases/latest"
                        coreRepo = "https://github.com/bol-van/zapret"
                        userRepo = "https://github.com/flare-award/ZapretMaronnFix"
                    }
                }
                strategies = $strats
                filters = @{
                    gameFilter = (Read-GameFilter $zDir)
                    ipsetFilter = @{ mode = "none"; entriesCount = 0; hasBackup = $true; backupEntriesCount = 0 }
                    activeFakes = @{ discordCurrent = $null; gameCurrent = $null; availableBins = @() }
                }
                listsMeta = @()
                testHistory = @()
                latestTestRun = $null
                zapretFingerprint = ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString())
                testJob = @{ running = $false; aborted = $false; completedCount = 0; totalCount = 0; progressPct = 0; results = @() }
            }

            $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes(($statePayload | ConvertTo-Json -Depth 8))
            $res.StatusCode = 200
            $res.ContentType = "application/json; charset=utf-8"
            $res.OutputStream.Write($jsonBytes, 0, $jsonBytes.Length)
            $res.Close()
            continue
        }

        $rel = if ($urlPath -eq "/") { "index.html" } else { $urlPath.TrimStart("/") }
        $filePath = Join-Path $StaticDir $rel
        if (-not (Test-Path $filePath -PathType Leaf)) {
            $filePath = Join-Path $StaticDir "index.html"
        }
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $res.ContentType = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $res.StatusCode = 200
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.Close()
    } catch {
        $errBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ error = $_.Exception.Message } | ConvertTo-Json))
        $res.StatusCode = 400
        $res.ContentType = "application/json; charset=utf-8"
        $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
        $res.Close()
    }
}
