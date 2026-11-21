param(
    [int]$Port = 3847,
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
)

$ProgressPreference = "SilentlyContinue"
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
        developerMode = $false
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
    $problemPrefix = Get-ProblemLaunchPrefix $zDir
    if ($problemPrefix) {
        $firstFilter = New-Object System.Text.RegularExpressions.Regex('(?=--filter-)')
        $argLine = $firstFilter.Replace($argLine, "$problemPrefix ", 1)
    }

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
$SteamSpeedStateFile = Join-Path $DataDir "steam-speed-state.json"
$SteamSpeedHistoryFile = Join-Path $DataDir "steam-speed-history.json"
$SteamSpeedStopFile = Join-Path $DataDir "steam-speed-stop.flag"
$ProblemFixesFile = Join-Path $DataDir "problem-fixes.json"
$SystemHostsFile = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$script:SteamSpeedProcess = $null
$script:SteamRestoreStrategy = $null
$ServerBootId = [guid]::NewGuid().ToString()

function Get-SteamSpeedState {
    if (Test-Path $SteamSpeedStateFile) {
        try { return Get-Content $SteamSpeedStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
    }
    return [ordered]@{
        running = $false; aborted = $false; startedAt = $null; finishedAt = $null
        currentStrategy = $null; completedCount = 0; totalCount = 0; progressPct = 0
results = @(); error = $null; sourceLabel = "Официальная CDN Steam"; sampleBytesPerStrategy = 209715200
    }
}

function Get-SteamSpeedHistory {
    if (Test-Path $SteamSpeedHistoryFile) {
        try { return @(Get-Content $SteamSpeedHistoryFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch {}
    }
    return @()
}

function Get-ProblemFixConfig {
    $default = [ordered]@{ discordMedia = $false; steamWeb = $false }
    if (Test-Path $ProblemFixesFile) {
        try {
            $loaded = Get-Content $ProblemFixesFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $loaded.fixes) {
                $discordFix = $loaded.fixes.PSObject.Properties['discord-media']
                $steamFix = $loaded.fixes.PSObject.Properties['steam-web']
                if ($null -ne $discordFix) { $default.discordMedia = [bool]$discordFix.Value.enabled }
                if ($null -ne $steamFix) { $default.steamWeb = [bool]$steamFix.Value.enabled }
            } else {
                if ($null -ne $loaded.discordMedia) { $default.discordMedia = [bool]$loaded.discordMedia }
                if ($null -ne $loaded.steamWeb) { $default.steamWeb = [bool]$loaded.steamWeb }
            }
        } catch {}
    }
    return $default
}

function Set-DomainFileEntries([string]$filePath, [string[]]$add, [string[]]$remove) {
    $lines = if (Test-Path $filePath) { @(Get-Content $filePath -Encoding UTF8) } else { @() }
    $removeSet = @{}
    foreach ($domain in $remove) { $removeSet[$domain.ToLower()] = $true }
    $kept = @($lines | Where-Object { -not $removeSet.ContainsKey(($_.Trim().TrimStart('^')).ToLower()) })
    $present = @{}
    foreach ($line in $kept) { $present[($line.Trim().TrimStart('^')).ToLower()] = $true }
    foreach ($domain in $add) {
        if (-not $present.ContainsKey($domain.ToLower())) { $kept += $domain }
    }
    $text = (($kept -join "`r`n").TrimEnd() + "`r`n")
    [System.IO.File]::WriteAllText($filePath, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-DiscordHostsFixPs([bool]$enabled) {
    $begin = "# Zapret Control: Discord media fix"
    $end = "# Zapret Control: end Discord media fix"
    $ips = @("162.159.138.232", "162.159.137.232", "162.159.128.233", "162.159.135.232", "162.159.134.232")
    try {
        $content = if (Test-Path $SystemHostsFile) { [System.IO.File]::ReadAllText($SystemHostsFile) } else { "" }
        $pattern = "(?ms)(?:^|\r?\n)" + [regex]::Escape($begin) + "\r?\n.*?\r?\n" + [regex]::Escape($end) + "(?=\r?\n|$)"
        $clean = ([regex]::Replace($content, $pattern, "")).TrimEnd()
        $managed = @()
        if ($enabled) {
            $managed += $begin
            foreach ($ip in $ips) { $managed += "$ip media.discordapp.net" }
            foreach ($ip in $ips) { $managed += "$ip images-ext-1.discordapp.net" }
            $managed += $end
        }
        $parts = @()
        if ($clean) { $parts += $clean }
        if ($managed.Count -gt 0) { $parts += ($managed -join "`r`n") }
        [System.IO.File]::WriteAllText($SystemHostsFile, (($parts -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
        & ipconfig.exe /flushdns 2>&1 | Out-Null
    } catch {
        throw "Не удалось изменить системный hosts. Запустите Zapret Control от имени администратора."
    }
}

function Test-DiscordHostsFixPs {
    try {
        $content = [System.IO.File]::ReadAllText($SystemHostsFile)
        return $content.Contains("# Zapret Control: Discord media fix") -and $content.Contains("# Zapret Control: end Discord media fix")
    } catch { return $false }
}

function Apply-ProblemFixLists($settings) {
    $config = Get-ProblemFixConfig
    $lists = Join-Path $settings.zapretDir "lists"
    $userGeneral = Join-Path $lists "list-general-user.txt"
    $baseExclude = Join-Path $lists "list-exclude.txt"
    $userExclude = Join-Path $lists "list-exclude-user.txt"
    $discordDomains = @("discordapp.net", "media.discordapp.net", "cdn.discordapp.com", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net")
    $steamDomains = @("cdn.akamai.steamstatic.com", "store.akamai.steamstatic.com", "community.akamai.steamstatic.com")
    if ($config.discordMedia) {
        try { Set-DiscordHostsFixPs $true } catch {}
        Set-DomainFileEntries $userGeneral $discordDomains @()
        Set-DomainFileEntries $userExclude @() @("discordapp.net", "discordapp.com")
    }
    if ($config.steamWeb) {
        Set-DomainFileEntries $userGeneral $steamDomains @()
        Set-DomainFileEntries $baseExclude @() @()
        Set-DomainFileEntries $userExclude @() @()
    }
}

function Get-ProblemFixRecord([string]$id) {
    if (Test-Path $ProblemFixesFile) {
        try {
            $raw = Get-Content $ProblemFixesFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $raw.fixes) {
                $property = $raw.fixes.PSObject.Properties[$id]
                if ($null -ne $property) { return $property.Value }
            }
        } catch {}
    }
    return [pscustomobject]@{ enabled = $false; enabledAt = $null; addedDomains = @(); removedExclusions = @(); version = 2 }
}

function Restore-ProblemExclusions([string]$listsDir, $entries) {
    foreach ($fileName in @("list-exclude.txt", "list-exclude-user.txt")) {
        $selected = @($entries | Where-Object { $_.fileName -eq $fileName } | Sort-Object index)
        if ($selected.Count -eq 0) { continue }
        $filePath = Join-Path $listsDir $fileName
        $lines = New-Object System.Collections.ArrayList
        if (Test-Path $filePath) { @(Get-Content $filePath -Encoding UTF8) | ForEach-Object { [void]$lines.Add($_) } }
        foreach ($entry in $selected) {
            $exists = @($lines | Where-Object { ($_.Trim().TrimStart('^')).ToLower() -eq ($entry.line.Trim().TrimStart('^')).ToLower() }).Count -gt 0
            if ($exists) { continue }
            $insertAt = if ($null -ne $entry.index) { [Math]::Max(0, [Math]::Min([int]$entry.index, $lines.Count)) } else { $lines.Count }
            $lines.Insert($insertAt, [string]$entry.line)
        }
        $text = (($lines.ToArray() -join "`r`n").TrimEnd() + "`r`n")
        [System.IO.File]::WriteAllText($filePath, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
}

function Set-ProblemFixPs([string]$id, [bool]$enabled, $settings) {
    if ($id -notin @("discord-media", "steam-web")) { throw "Неизвестное исправление" }
    $config = Get-ProblemFixConfig
    $discordRecord = Get-ProblemFixRecord "discord-media"
    $steamRecord = Get-ProblemFixRecord "steam-web"
    $targetRecord = if ($id -eq "discord-media") { $discordRecord } else { $steamRecord }
    $domains = if ($id -eq "discord-media") {
        @("discordapp.net", "media.discordapp.net", "cdn.discordapp.com", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net")
    } else {
        @("cdn.akamai.steamstatic.com", "store.akamai.steamstatic.com", "community.akamai.steamstatic.com")
    }
    $excludeDomains = if ($id -eq "discord-media") { @("discordapp.net", "discordapp.com") } else { @() }
    $lists = Join-Path $settings.zapretDir "lists"
    if ($id -eq "discord-media") { Set-DiscordHostsFixPs $enabled }

    if ($enabled) {
        $userGeneral = Join-Path $lists "list-general-user.txt"
        $present = @{}
        if (Test-Path $userGeneral) {
            Get-Content $userGeneral -Encoding UTF8 | ForEach-Object { $present[($_.Trim().TrimStart('^')).ToLower()] = $true }
        }
        $addedDomains = @($domains | Where-Object { -not $present.ContainsKey($_.ToLower()) })
        $removed = @()
        foreach ($fileName in @("list-exclude.txt", "list-exclude-user.txt")) {
            $filePath = Join-Path $lists $fileName
            $lines = if (Test-Path $filePath) { @(Get-Content $filePath -Encoding UTF8) } else { @() }
            for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
                $normalized = ($lines[$lineIndex].Trim().TrimStart('^')).ToLower()
                if ($excludeDomains -contains $normalized) {
                    $removed += [ordered]@{ fileName = $fileName; line = $lines[$lineIndex].Trim(); index = $lineIndex }
                }
            }
        }
        $targetRecord = [pscustomobject]@{ enabled = $true; enabledAt = [DateTime]::UtcNow.ToString("o"); addedDomains = $addedDomains; removedExclusions = $removed; version = 2 }
    } else {
        Set-DomainFileEntries (Join-Path $lists "list-general-user.txt") @() @($targetRecord.addedDomains)
        Restore-ProblemExclusions $lists @($targetRecord.removedExclusions)
        $targetRecord = [pscustomobject]@{ enabled = $false; enabledAt = $null; addedDomains = @(); removedExclusions = @(); version = 2 }
    }

    if ($id -eq "discord-media") { $discordRecord = $targetRecord; $config.discordMedia = $enabled }
    else { $steamRecord = $targetRecord; $config.steamWeb = $enabled }
    $savedConfig = [ordered]@{ fixes = [ordered]@{ "discord-media" = $discordRecord; "steam-web" = $steamRecord } }
    ($savedConfig | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $ProblemFixesFile -Encoding UTF8
    Apply-ProblemFixLists $settings
}

function Migrate-ProblemFixesPs($settings) {
    $steamRecord = Get-ProblemFixRecord "steam-web"
    if (-not [bool]$steamRecord.enabled -or [int]$steamRecord.version -eq 2) { return }
    $lists = Join-Path $settings.zapretDir "lists"
    Set-DomainFileEntries (Join-Path $lists "list-general-user.txt") @() @($steamRecord.addedDomains)
    Restore-ProblemExclusions $lists @($steamRecord.removedExclusions)
    $newDomains = @("cdn.akamai.steamstatic.com", "store.akamai.steamstatic.com", "community.akamai.steamstatic.com")
    $present = @{}
    Get-Content (Join-Path $lists "list-general-user.txt") -Encoding UTF8 | ForEach-Object { $present[($_.Trim().TrimStart('^')).ToLower()] = $true }
    $newRecord = [pscustomobject]@{
        enabled = $true
        enabledAt = [DateTime]::UtcNow.ToString("o")
        addedDomains = @($newDomains | Where-Object { -not $present.ContainsKey($_.ToLower()) })
        removedExclusions = @()
        version = 2
    }
    $discordRecord = Get-ProblemFixRecord "discord-media"
    $savedConfig = [ordered]@{ fixes = [ordered]@{ "discord-media" = $discordRecord; "steam-web" = $newRecord } }
    ($savedConfig | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $ProblemFixesFile -Encoding UTF8
}

function Get-ProblemFixesPs {
    $config = Get-ProblemFixConfig
    return @(
        [ordered]@{ id = "discord-media"; title = "Изображения Discord"; description = "Восстанавливает загрузку превью и вложений с media.discordapp.net."; enabled = [bool]$config.discordMedia; applied = ([bool]$config.discordMedia -and (Test-DiscordHostsFixPs)); enabledAt = $null; domains = @("discordapp.net", "media.discordapp.net", "cdn.discordapp.com", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net") },
        [ordered]@{ id = "steam-web"; title = "Сайты Steam"; description = "Восстанавливает стили и изображения с трёх проблемных CDN Steam."; enabled = [bool]$config.steamWeb; applied = [bool]$config.steamWeb; enabledAt = $null; domains = @("cdn.akamai.steamstatic.com", "store.akamai.steamstatic.com", "community.akamai.steamstatic.com") }
    )
}

function Get-ProblemLaunchPrefix([string]$zapretDir) {
    $config = Get-ProblemFixConfig
    $bin = (Join-Path $zapretDir "bin") + "\"
    $parts = @()
    if ($config.discordMedia) {
        $domains = "media.discordapp.net,cdn.discordapp.com,images-ext-1.discordapp.net,images-ext-2.discordapp.net"
        $parts += "--filter-udp=443 --hostlist-domains=$domains --dpi-desync=fake --dpi-desync-repeats=11 --dpi-desync-fake-quic=`"$($bin)quic_initial_4pda_to.bin`" --new"
        $parts += "--filter-tcp=80,443 --hostlist-domains=$domains --dpi-desync=fake --dpi-desync-fake-tls-mod=none --dpi-desync-repeats=6 --dpi-desync-fooling=badseq,hopbyhop2 --new"
    }
    if ($config.steamWeb) {
        $domains = "cdn.akamai.steamstatic.com,store.akamai.steamstatic.com,community.akamai.steamstatic.com"
        $parts += "--filter-udp=443 --hostlist-domains=$domains --dpi-desync=fake --dpi-desync-repeats=11 --dpi-desync-fake-quic=`"$($bin)quic_initial_steamstatic_com.bin`" --new"
        $parts += "--filter-tcp=80,443 --hostlist-domains=$domains --dpi-desync=fake --dpi-desync-fake-tls=`"$($bin)tls_clienthello_steamstatic_com.bin`" --dpi-desync-repeats=6 --dpi-desync-fooling=badseq,hopbyhop2 --new"
    }
    return ($parts -join " ")
}

function Get-GitBlobSha1([byte[]]$bytes) {
    $header = [System.Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)`0")
    $combined = New-Object byte[] ($header.Length + $bytes.Length)
    [System.Buffer]::BlockCopy($header, 0, $combined, 0, $header.Length)
    [System.Buffer]::BlockCopy($bytes, 0, $combined, $header.Length, $bytes.Length)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    $hash = $sha1.ComputeHash($combined)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLower()
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-LatestAppCommit {
    $headers = @{ "User-Agent" = "Mozilla/5.0 ZapretControl/1.3" }
    $branch = "arena/9383b414-zapretmaronnfix"
    $atomResp = Invoke-WebRequest -Uri "https://github.com/flare-award/ZapretMaronnFix/commits/$branch.atom" -Headers $headers -UseBasicParsing -TimeoutSec 15
    $xmlText = $atomResp.Content
    $entryMatch = [regex]::Match($xmlText, "<entry>([\s\S]*?)</entry>", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $entryMatch.Success) { throw "Не удалось прочитать ленту обновлений GitHub" }
    $entry = $entryMatch.Groups[1].Value
    $shaMatch = [regex]::Match($entry, "Commit/([0-9a-f]{40})", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $shaMatch.Success) { $shaMatch = [regex]::Match($entry, "/commit/([0-9a-f]{40})", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) }
    if (-not $shaMatch.Success) { throw "Не удалось определить SHA коммита" }
    $sha = $shaMatch.Groups[1].Value.ToLower()
    $updMatch = [regex]::Match($entry, "<updated>([^<]+)</updated>", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $titleMatch = [regex]::Match($entry, "<title[^>]*>([\s\S]*?)</title>", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $msg = if ($titleMatch.Success) { ([System.Net.WebUtility]::HtmlDecode($titleMatch.Groups[1].Value) -replace "\s+", " ").Trim() } else { "Обновление Zapret Control" }
    return @{
        branch = $branch
        sha = $sha
        shortSha = $sha.Substring(0, 7)
        publishedAt = if ($updMatch.Success) { $updMatch.Groups[1].Value.Trim() } else { $null }
        message = $msg
        htmlUrl = "https://github.com/flare-award/ZapretMaronnFix/tree/arena/9383b414-zapretmaronnfix"
    }
}

function Download-FastFile([string]$url, [string]$outFile) {
    $curlCmd = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($null -ne $curlCmd) {
        & $curlCmd.Source -fsSL --connect-timeout 8 -m 30 -H "User-Agent: Mozilla/5.0 ZapretControl/1.4" -o $outFile $url 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $outFile) -and (Get-Item -LiteralPath $outFile).Length -gt 200) {
            return
        }
    }
    Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing -TimeoutSec 35
}

function Check-AppUpdatePs {
    $latest = Get-LatestAppCommit
    $zipCache = Join-Path ([System.IO.Path]::GetTempPath()) "zapret-control-pkg-$($latest.sha).zip"
    if (-not (Test-Path -LiteralPath $zipCache)) {
        Download-FastFile "https://codeload.github.com/flare-award/ZapretMaronnFix/zip/$($latest.sha)" $zipCache
    }
    $changed = 0
    $za = [System.IO.Compression.ZipFile]::OpenRead($zipCache)
    try {
        foreach ($ze in $za.Entries) {
            if ([string]::IsNullOrEmpty($ze.Name)) { continue }
            $slashIdx = $ze.FullName.IndexOf("/")
            if ($slashIdx -lt 0) { continue }
            $p = $ze.FullName.Substring($slashIdx + 1)
            if ($p -ne "ZapretControl.bat" -and (-not $p.StartsWith("app/") -or $p.StartsWith("app/data/") -or $p.StartsWith("app/node_modules/"))) { continue }
            $localFile = Join-Path $RepoRoot ($p -replace "/", "\")
            if (-not (Test-Path -LiteralPath $localFile)) { $changed++; continue }
            $ms = New-Object System.IO.MemoryStream
            $st = $ze.Open()
            $st.CopyTo($ms)
            $st.Close()
            $remoteSha = Get-GitBlobSha1 ($ms.ToArray())
            $ms.Close()
            $raw = [System.IO.File]::ReadAllBytes($localFile)
            if ((Get-GitBlobSha1 $raw) -eq $remoteSha) { continue }
            $lfText = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($raw) -replace "`r`n", "`n"
            if ((Get-GitBlobSha1 ([System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($lfText))) -eq $remoteSha) { continue }
            $changed++
        }
    } finally {
        $za.Dispose()
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
    $repLocal = if ($changed -eq 0) { $latest.shortSha } elseif ($localState -and $localState.installedShortSha -ne $latest.shortSha) { $localState.installedShortSha } else { $null }
    return @{
        repo = "flare-award/ZapretMaronnFix"
        currentShortSha = $repLocal
        currentDate = if ($changed -eq 0) { $latest.publishedAt } elseif ($repLocal -and $localState) { $localState.commitDate } else { $null }
        latestSha = $latest.sha
        latestShortSha = $latest.shortSha
        branch = $latest.branch
        publishedAt = $latest.publishedAt
        commitMessage = $latest.message
        changedFilesCount = $changed
        updateAvailable = ($changed -gt 0)
        htmlUrl = "https://github.com/flare-award/ZapretMaronnFix/tree/arena/9383b414-zapretmaronnfix"
        checkedAt = [DateTime]::UtcNow.ToString("o")
    }
}

function Check-ZapretReleasePs([string]$zDir) {
    $svcPath = Join-Path $zDir "service.bat"
    $localVer = "Неизвестно"
    if (Test-Path $svcPath) {
        $rawSvc = Get-Content $svcPath -Raw -Encoding UTF8
        if ($rawSvc -match 'LOCAL_VERSION=([^\r\n"]+)') { $localVer = $Matches[1].Trim() }
    }
    $headers = @{ "User-Agent" = "Mozilla/5.0 ZapretControl/1.3" }
    $atomXml = (Invoke-WebRequest -Uri "https://github.com/Flowseal/zapret-discord-youtube/releases.atom" -Headers $headers -UseBasicParsing -TimeoutSec 15).Content
    $em = [regex]::Match($atomXml, "<entry>([\s\S]*?)</entry>", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $em.Success) { throw "Не удалось прочитать список релизов Zapret" }
    $block = $em.Groups[1].Value
    $tagMatch = [regex]::Match($block, "/releases/tag/([^`"&<>?#]+)", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $tag = if ($tagMatch.Success) { [Uri]::UnescapeDataString($tagMatch.Groups[1].Value) } else { $localVer }
    $cleanVer = $tag -replace "^v", ""
    $updMatch = [regex]::Match($block, "<updated>([^<]+)</updated>", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $pubAt = if ($updMatch.Success) { $updMatch.Groups[1].Value.Trim() } else { $null }
    $assetName = "zapret-discord-youtube-$cleanVer.zip"
    $dlUrl = "https://github.com/Flowseal/zapret-discord-youtube/releases/download/$tag/$assetName"
    try {
        $assetsHtml = (Invoke-WebRequest -Uri "https://github.com/Flowseal/zapret-discord-youtube/releases/expanded_assets/$tag" -Headers $headers -UseBasicParsing -TimeoutSec 12).Content
        $zm = [regex]::Match($assetsHtml, 'href="([^"]*/releases/download/[^"]+\.zip)"', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($zm.Success) {
            $dlUrl = "https://github.com" + $zm.Groups[1].Value
            $assetName = [System.IO.Path]::GetFileName($dlUrl)
        }
    } catch {}
    return @{
        localVersion = $localVer
        latestVersion = $cleanVer
        updateAvailable = ($localVer -ne $cleanVer)
        publishedAt = $pubAt
        releaseName = "Zapret $cleanVer"
        releaseNotes = ""
        htmlUrl = "https://github.com/Flowseal/zapret-discord-youtube/releases"
        downloadUrl = $dlUrl
        assetName = $assetName
        checkedAt = [DateTime]::UtcNow.ToString("o")
    }
}

$initSettings = Get-AppSettings
Migrate-ProblemFixesPs $initSettings
Apply-ProblemFixLists $initSettings
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

            if ($urlPath -eq "/api/updates/check" -and $req.HttpMethod -eq "GET") {
                $stCur = Get-AppSettings
                $uInfo = Check-ZapretReleasePs $stCur.zapretDir
                $uBytes = [System.Text.Encoding]::UTF8.GetBytes(($uInfo | ConvertTo-Json -Depth 6))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($uBytes, 0, $uBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -eq "/api/updates/download-latest") {
                $stCur = Get-AppSettings
                $uInfo = Check-ZapretReleasePs $stCur.zapretDir
                if ($req.HttpMethod -eq "GET") {
                    $res.StatusCode = 302
                    $res.RedirectLocation = $uInfo.downloadUrl
                    $res.Close()
                    continue
                }
                Start-Process "rundll32.exe" -ArgumentList "url.dll,FileProtocolHandler $($uInfo.downloadUrl)" | Out-Null
                $dBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ ok = $true; delegatedToOs = $true; downloadUrl = $uInfo.downloadUrl; assetName = $uInfo.assetName; updateInfo = $uInfo } | ConvertTo-Json -Depth 6))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($dBytes, 0, $dBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -eq "/api/system/shutdown" -and $req.HttpMethod -eq "POST") {
                if ($script:SteamSpeedProcess -and -not $script:SteamSpeedProcess.HasExited) {
                    & taskkill.exe /PID $script:SteamSpeedProcess.Id /T /F 2>&1 | Out-Null
                }
                Stop-WinwsDirect
                foreach ($svc in @("zapret","GoodbyeDPI","discordfix_zapret","winws1","winws2")) { & sc.exe stop $svc 2>&1 | Out-Null }
                & taskkill.exe /IM winws.exe /F 2>&1 | Out-Null
                & taskkill.exe /IM goodbyedpi.exe /F 2>&1 | Out-Null
                Start-Sleep -Milliseconds 180
                foreach ($drv in @("WinDivert","WinDivert14","WinDivert64")) { & sc.exe stop $drv 2>&1 | Out-Null; & sc.exe delete $drv 2>&1 | Out-Null }
                $okBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ ok = $true } | ConvertTo-Json))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($okBytes, 0, $okBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -match '^/api/problems/(discord-media|steam-web)$' -and $req.HttpMethod -eq "POST") {
                $stCur = Get-AppSettings
                $enabled = if ($null -ne $bodyObj.enabled) { [bool]$bodyObj.enabled } else { $true }
                Set-ProblemFixPs $Matches[1] $enabled $stCur
                if ($script:ActiveWinws -and -not $script:ActiveWinws.HasExited) {
                    Start-WinwsDirect $script:ActiveStrategy
                }
            }

            if ($urlPath -eq "/api/steam-speed/start" -and $req.HttpMethod -eq "POST") {
                $existingSteam = Get-SteamSpeedState
                if ($existingSteam.running) { throw "Тест скорости Steam уже выполняется" }
                $stCur = Get-AppSettings
                $script:SteamRestoreStrategy = if ($script:ActiveWinws -and -not $script:ActiveWinws.HasExited) { $script:ActiveStrategy } else { $null }
                Stop-WinwsDirect
                Remove-Item -LiteralPath $SteamSpeedStopFile -Force -ErrorAction SilentlyContinue
                $strategyCount = @(Get-ChildItem -LiteralPath $stCur.zapretDir -Filter "*.bat" | Where-Object { $_.Name -ne "service.bat" }).Count
                $initialSteam = [ordered]@{ running = $true; aborted = $false; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); finishedAt = $null; currentStrategy = $null; completedCount = 0; totalCount = $strategyCount; progressPct = 0; results = @(); error = $null; sourceLabel = "Официальная CDN Steam"; sampleBytesPerStrategy = 209715200 }
                ($initialSteam | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $SteamSpeedStateFile -Encoding UTF8
                $steamScript = Join-Path $PSScriptRoot "SteamSpeedTest.ps1"
                $steamArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$steamScript`" -RepoRoot `"$RepoRoot`" -ZapretDir `"$($stCur.zapretDir)`""
                $script:SteamSpeedProcess = Start-Process "powershell.exe" -ArgumentList $steamArgs -WindowStyle Hidden -PassThru
                $speedBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ steamSpeedJob = $initialSteam } | ConvertTo-Json -Depth 8))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($speedBytes, 0, $speedBytes.Length)
                $res.Close()
                continue
            }

            if ($urlPath -eq "/api/steam-speed/stop" -and $req.HttpMethod -eq "POST") {
                New-Item -ItemType File -Force -Path $SteamSpeedStopFile | Out-Null
                if ($script:SteamSpeedProcess -and -not $script:SteamSpeedProcess.HasExited) {
                    & taskkill.exe /PID $script:SteamSpeedProcess.Id /T /F 2>&1 | Out-Null
                }
                Stop-WinwsDirect
                $stoppedSteam = Get-SteamSpeedState
                $stoppedSteam.running = $false
                $stoppedSteam.aborted = $true
                $stoppedSteam.currentStrategy = $null
                $stoppedSteam.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                ($stoppedSteam | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $SteamSpeedStateFile -Encoding UTF8
                $speedBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ steamSpeedJob = $stoppedSteam } | ConvertTo-Json -Depth 8))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($speedBytes, 0, $speedBytes.Length)
                $res.Close()
                continue
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
                $tmpWork = Join-Path ([System.IO.Path]::GetTempPath()) ("zapret-control-upd-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
                New-Item -ItemType Directory -Force -Path $tmpWork | Out-Null
                $zipPath = Join-Path $tmpWork "update.zip"
                $protectedList = @(
                    "zapret/lists/list-general-user.txt",
                    "zapret/lists/list-exclude-user.txt",
                    "zapret/lists/ipset-exclude-user.txt",
                    "zapret/lists/ipset-all.txt",
                    "zapret/lists/ipset-all.txt.backup",
                    "zapret/utils/game_filter.enabled",
                    "zapret/utils/check_updates.enabled",
                    "zapret/utils/targets.txt",
                    "zapret/bin/ACTIVE_DISCORD_UDP.bin",
                    "zapret/bin/ACTIVE_GAME_UDP.bin"
                )

                $nextStateObj = $null
                if ($bodyObj -and $bodyObj.zipBase64) {
                    $b64 = ([string]$bodyObj.zipBase64) -replace "^data:[^;]+;base64,", ""
                    [System.IO.File]::WriteAllBytes($zipPath, [Convert]::FromBase64String($b64))
                    $nextStateObj = @{
                        installedShortSha = "zip"
                        commitDate = [DateTime]::UtcNow.ToString("o")
                        commitMessage = "Обновлено из ZIP-архива"
                    }
                } else {
                    $latest = Get-LatestAppCommit
                    $zipCache = Join-Path ([System.IO.Path]::GetTempPath()) "zapret-control-pkg-$($latest.sha).zip"
                    if (Test-Path -LiteralPath $zipCache) {
                        $zipPath = $zipCache
                    } else {
                        Download-FastFile "https://codeload.github.com/flare-award/ZapretMaronnFix/zip/$($latest.sha)" $zipPath
                    }
                    $nextStateObj = @{
                        installedSha = $latest.sha
                        installedShortSha = $latest.shortSha
                        installedBranch = $latest.branch
                        commitDate = $latest.publishedAt
                        commitMessage = $latest.message
                    }
                }

                if ($null -ne $script:ActiveWinws -and -not $script:ActiveWinws.HasExited -and $script:ActiveStrategy) {
                    (@{ strategy = $script:ActiveStrategy } | ConvertTo-Json) | Set-Content -Path $ResumeFlagFile -Encoding UTF8
                    Stop-WinwsDirect
                }

                $hostChanged = $false
                $validRelPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
                $za = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
                try {
                    foreach ($ze in $za.Entries) {
                        if ([string]::IsNullOrEmpty($ze.Name)) { continue }
                        $fullEntry = $ze.FullName -replace "\\", "/"
                        $slashIdx = $fullEntry.IndexOf("/")
                        $relPosix = if ($slashIdx -gt 0) { $fullEntry.Substring($slashIdx + 1) } else { $fullEntry }
                        if ([string]::IsNullOrEmpty($relPosix) -or $relPosix.Contains("..")) { continue }
                        [void]$validRelPaths.Add($relPosix)

                        if ($relPosix.StartsWith(".git/") -or $relPosix.StartsWith("app/data/") -or $relPosix.StartsWith("app/node_modules/") -or $relPosix.StartsWith("zapret/utils/test results/") -or $relPosix -eq "ZapretControl.exe") { continue }
                        if ($relPosix -match '^zapret/custom\s*-.*\.bat$') { continue }
                        if ($protectedList -contains $relPosix) { continue }

                        $dstPath = Join-Path $RepoRoot ($relPosix -replace "/", "\")
                        $ms = New-Object System.IO.MemoryStream
                        $stEntry = $ze.Open()
                        $stEntry.CopyTo($ms)
                        $stEntry.Close()
                        $entryBytes = $ms.ToArray()
                        $ms.Close()

                        $remoteSha = Get-GitBlobSha1 $entryBytes
                        if (Test-Path -LiteralPath $dstPath) {
                            $localRaw = [System.IO.File]::ReadAllBytes($dstPath)
                            if ((Get-GitBlobSha1 $localRaw) -eq $remoteSha) { continue }
                            $lfText = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($localRaw) -replace "`r`n", "`n"
                            if ((Get-GitBlobSha1 ([System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($lfText))) -eq $remoteSha) { continue }
                        }

                        if ($relPosix -eq "app/host/ZapretControl.cs" -or $relPosix -eq "app/host/app.ico") {
                            $hostChanged = $true
                        }

                        $outBytes = $entryBytes
                        if ($relPosix.EndsWith(".cs") -or $relPosix.EndsWith(".ps1")) {
                            $txt = [System.Text.Encoding]::UTF8.GetString($entryBytes).TrimStart([char]0xFEFF)
                            $txt = ($txt -replace "`r`n", "`n" -replace "`r", "`n" -replace "`n", "`r`n")
                            $utf8Body = [System.Text.Encoding]::UTF8.GetBytes($txt)
                            $outBytes = New-Object byte[] ($utf8Body.Length + 3)
                            $outBytes[0] = 0xEF; $outBytes[1] = 0xBB; $outBytes[2] = 0xBF
                            [System.Buffer]::BlockCopy($utf8Body, 0, $outBytes, 3, $utf8Body.Length)
                        }

                        $parentDir = [System.IO.Path]::GetDirectoryName($dstPath)
                        if (-not (Test-Path -LiteralPath $parentDir)) {
                            New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
                        }
                        try { [System.IO.File]::WriteAllBytes($dstPath, $outBytes) } catch {}
                    }
                } finally {
                    $za.Dispose()
                }

                foreach ($sub in @("server","static","src","host","public")) {
                    $absSub = Join-Path (Join-Path $RepoRoot "app") $sub
                    if (Test-Path -LiteralPath $absSub) {
                        Get-ChildItem -LiteralPath $absSub -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
                            $relFile = $_.FullName.Substring($RepoRoot.Length).TrimStart('\','/') -replace "\\", "/"
                            if (-not $validRelPaths.Contains($relFile)) {
                                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                            }
                        }
                    }
                }

                if ($null -ne $nextStateObj) {
                    ($nextStateObj | ConvertTo-Json) | Set-Content -Path $UpdateStateFile -Encoding UTF8
                }

                $exeLocal = Join-Path $RepoRoot "ZapretControl.exe"
                $csLocal = Join-Path $RepoRoot "app\host\ZapretControl.cs"
                $needRebuild = $hostChanged -or (-not (Test-Path -LiteralPath $exeLocal))
                if (-not $needRebuild -and (Test-Path -LiteralPath $exeLocal) -and (Test-Path -LiteralPath $csLocal)) {
                    if ((Get-Item -LiteralPath $csLocal).LastWriteTimeUtc -gt (Get-Item -LiteralPath $exeLocal).LastWriteTimeUtc.AddSeconds(1)) {
                        $needRebuild = $true
                    }
                }

                $lockFile = Join-Path $DataDir "host-updating.lock"
                if ($needRebuild) {
                    [System.IO.File]::WriteAllText($lockFile, "updating")
                }

                $applyScript = Join-Path ([System.IO.Path]::GetTempPath()) ("zapret-control-restart-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ".ps1")
                $vbsPath = Join-Path ([System.IO.Path]::GetTempPath()) ("zapret-control-launch-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ".vbs")
                $psNeedStr = if ($needRebuild) { '$true' } else { '$false' }
                $safeRepoEsc = $RepoRoot.Replace("'", "''")
                $safeLockEsc = $lockFile.Replace("'", "''")
                $safeTmpEsc = $tmpWork.Replace("'", "''")

                $scriptBody = @"
`$ProgressPreference = 'SilentlyContinue'
`$ErrorActionPreference = 'Continue'
`$repoRoot = '$safeRepoEsc'
`$lockFile = '$safeLockEsc'
`$tmpWork = '$safeTmpEsc'
`$targetPort = $Port
`$needRebuild = $psNeedStr

Start-Sleep -Milliseconds 220
Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue

function Test-BackendAlive([int]`$p) {
    try {
        `$r = [System.Net.HttpWebRequest]::Create(('http://127.0.0.1:' + `$p + '/api/state'))
        `$r.Timeout = 450
        `$resp = `$r.GetResponse()
        `$c = [int]`$resp.StatusCode
        `$resp.Close()
        return (`$c -eq 200)
    } catch { return `$false }
}

if (-not `$needRebuild) {
    `$trayAlive = @(Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue).Count -gt 0
    if (`$trayAlive) {
        for (`$w = 0; `$w -lt 14; `$w++) {
            Start-Sleep -Milliseconds 180
            if (Test-BackendAlive `$targetPort) {
                Remove-Item -LiteralPath `$lockFile -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath `$tmpWork -Recurse -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath `$MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
                exit 0
            }
        }
    }
}

try { [System.IO.File]::WriteAllText(`$lockFile, 'updating') } catch {}
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        `$_.CommandLine -and (`$_.CommandLine -like '*ui-window-v2*' -or `$_.CommandLine -like '*window-profile*')
    } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Wait-Process -Name 'ZapretControl' -Timeout 4 -ErrorAction SilentlyContinue
& taskkill.exe /IM winws.exe /F 2>&1 | Out-Null

for (`$pWait = 0; `$pWait -lt 45; `$pWait++) {
    try {
        `$tl = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, `$targetPort)
        `$tl.Start(); `$tl.Stop(); break
    } catch { Start-Sleep -Milliseconds 90 }
}

`$exePath = Join-Path `$repoRoot 'ZapretControl.exe'
if (`$needRebuild -or -not (Test-Path -LiteralPath `$exePath)) {
    for (`$i = 0; `$i -lt 20; `$i++) {
        if (-not (Test-Path -LiteralPath `$exePath)) { break }
        try { Remove-Item -LiteralPath `$exePath -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 150 }
    }
    `$csPath = Join-Path `$repoRoot 'app\host\ZapretControl.cs'
    `$icoPath = Join-Path `$repoRoot 'app\host\app.ico'
    `$csc64 = Join-Path `$env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    `$csc32 = Join-Path `$env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    `$csc = if (Test-Path -LiteralPath `$csc64) { `$csc64 } elseif (Test-Path -LiteralPath `$csc32) { `$csc32 } else { `$null }
    if (`$null -ne `$csc -and (Test-Path -LiteralPath `$csPath)) {
        `$cscArgs = @('/nologo', '/target:winexe', '/optimize+', ("/out:`$exePath"), '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll')
        if (Test-Path -LiteralPath `$icoPath) { `$cscArgs += ("/win32icon:`$icoPath") }
        `$cscArgs += `$csPath
        & `$csc @cscArgs 2>&1 | Out-Null
    }
}

Remove-Item -LiteralPath `$lockFile -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath `$exePath) {
    `$psi = New-Object System.Diagnostics.ProcessStartInfo
    `$psi.FileName = `$exePath
    `$psi.Arguments = '--relaunch-after-update --port=' + `$targetPort
    `$psi.WorkingDirectory = `$repoRoot
    `$psi.UseShellExecute = `$false
    `$psi.CreateNoWindow = `$true
    [System.Diagnostics.Process]::Start(`$psi) | Out-Null
}
Start-Sleep -Milliseconds 300
Remove-Item -LiteralPath `$tmpWork -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath `$MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
"@
                Set-Content -Path $applyScript -Value $scriptBody -Encoding UTF8

                $escapedPs = $applyScript.Replace('"', '""')
                $vbsLines = @(
                    'Set sh = CreateObject("WScript.Shell")',
                    "sh.Run ""powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$escapedPs"""""", 0, False",
                    'Set fso = CreateObject("Scripting.FileSystemObject")',
                    'On Error Resume Next',
                    'fso.DeleteFile WScript.ScriptFullName, True'
                ) -join "`r`n"
                [System.IO.File]::WriteAllText($vbsPath, $vbsLines, [System.Text.Encoding]::ASCII)

                $psiWsh = New-Object System.Diagnostics.ProcessStartInfo
                $psiWsh.FileName = "wscript.exe"
                $psiWsh.Arguments = "//B //NoLogo `"$vbsPath`""
                $psiWsh.UseShellExecute = $true
                $psiWsh.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
                [System.Diagnostics.Process]::Start($psiWsh) | Out-Null

                $okBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ ok = $true; restarting = $true; message = "Обновление установлено, выполняется перезапуск..." } | ConvertTo-Json))
                $res.StatusCode = 200
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($okBytes, 0, $okBytes.Length)
                $res.Close()
                try { $listener.Stop(); $listener.Close() } catch {}
                break
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
                if ((Get-SteamSpeedState).running) { throw "Сначала остановите тест скорости Steam" }
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

            $steamState = Get-SteamSpeedState
            if (-not $steamState.running -and $script:SteamRestoreStrategy) {
                $restoreName = $script:SteamRestoreStrategy
                $script:SteamRestoreStrategy = $null
                try { Start-WinwsDirect $restoreName } catch {}
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
                        isCustom = ($_.Name -match '^custom\s*-')
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
                        latestRelease = "https://github.com/Flowseal/zapret-discord-youtube/releases"
                        coreRepo = "https://github.com/bol-van/zapret"
                        userRepo = "https://github.com/flare-award/ZapretMaronnFix/tree/arena/9383b414-zapretmaronnfix"
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
                problemFixes = @(Get-ProblemFixesPs)
                steamSpeedJob = $steamState
                steamSpeedHistory = @(Get-SteamSpeedHistory)
                appUpdateState = if (Test-Path $UpdateStateFile) { try { Get-Content $UpdateStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null }
                serverBootId = $ServerBootId
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
        if ($urlPath.StartsWith("/assets/")) {
            $res.AddHeader("Cache-Control", "public, max-age=31536000, immutable")
        } else {
            $res.AddHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        }
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
