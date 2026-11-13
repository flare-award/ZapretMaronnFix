import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_DIR, DATA_DIR, REPO_ROOT, httpsGetJsonOrText, loadSettings } from './zapretAdapter.mjs';

const execFileAsync = promisify(execFile);

const APP_REPO = 'flare-award/ZapretMaronnFix';
const UPDATE_STATE_PATH = path.join(DATA_DIR, 'app-update-state.json');
const RESUME_FLAG_PATH = path.join(DATA_DIR, 'resume-after-update.json');
const UPDATE_LOG_PATH = path.join(DATA_DIR, 'last-update.log');

const SYSTEM_CA_BUNDLE = (() => {
  try {
    if (fs.existsSync('/etc/ssl/certs/ca-certificates.crt')) {
      return [...tls.rootCertificates, fs.readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8')];
    }
  } catch {
    // ignore
  }
  return undefined;
})();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function gitBlobSha1(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

function isProgramFilePath(relPath) {
  if (relPath === 'ZapretControl.bat') return true;
  if (!relPath.startsWith('app/')) return false;
  if (relPath.startsWith('app/data/') || relPath.startsWith('app/node_modules/')) return false;
  return true;
}

function countMismatchedProgramBlobs(entries) {
  const programBlobs = entries.filter((e) => e.type === 'blob' && isProgramFilePath(e.path));
  let changedFilesCount = 0;

  for (const entry of programBlobs) {
    const localFile = path.join(REPO_ROOT, ...entry.path.split('/'));
    if (!fs.existsSync(localFile)) {
      changedFilesCount++;
      continue;
    }
    try {
      const buf = fs.readFileSync(localFile);
      const shaRaw = gitBlobSha1(buf);
      if (shaRaw === entry.sha) continue;

      const shaLf = gitBlobSha1(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
      if (shaLf === entry.sha) continue;

      changedFilesCount++;
    } catch {
      changedFilesCount++;
    }
  }

  return changedFilesCount;
}

export function readLocalAppUpdateState() {
  ensureDataDir();
  if (fs.existsSync(UPDATE_STATE_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(UPDATE_STATE_PATH, 'utf8'));
      if (parsed && parsed.installedSha) {
        return parsed;
      }
    } catch {
      // ignore corrupted file
    }
  }

  const gitHeadPath = path.join(REPO_ROOT, '.git', 'HEAD');
  if (fs.existsSync(gitHeadPath)) {
    try {
      const headRaw = fs.readFileSync(gitHeadPath, 'utf8').trim();
      let sha = null;
      let branch = null;
      if (headRaw.startsWith('ref: ')) {
        const refRel = headRaw.slice(5).trim();
        branch = refRel.replace(/^refs\/heads\//, '');
        const refFile = path.join(REPO_ROOT, '.git', refRel);
        if (fs.existsSync(refFile)) {
          sha = fs.readFileSync(refFile, 'utf8').trim();
        }
      } else if (/^[0-9a-f]{40}$/i.test(headRaw)) {
        sha = headRaw;
      }
      if (sha) {
        return {
          installedSha: sha,
          installedShortSha: sha.slice(0, 7),
          installedBranch: branch || 'main',
          commitDate: null,
          commitMessage: '',
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    installedSha: null,
    installedShortSha: null,
    installedBranch: null,
    commitDate: null,
    commitMessage: '',
  };
}

function saveLocalAppUpdateState(stateObj) {
  ensureDataDir();
  fs.writeFileSync(UPDATE_STATE_PATH, JSON.stringify(stateObj, null, 2), 'utf8');
}

export function consumeResumeAfterUpdateFlag() {
  if (!fs.existsSync(RESUME_FLAG_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(RESUME_FLAG_PATH, 'utf8'));
    fs.rmSync(RESUME_FLAG_PATH, { force: true });
    return data && data.strategy ? String(data.strategy) : null;
  } catch {
    try {
      fs.rmSync(RESUME_FLAG_PATH, { force: true });
    } catch {
      // ignore
    }
    return null;
  }
}

async function resolveLatestProgramCommit() {
  const headers = { Accept: 'application/vnd.github+json' };
  const branchesRaw = await httpsGetJsonOrText(
    `https://api.github.com/repos/${APP_REPO}/branches?per_page=20`,
    headers
  );
  const branches = JSON.parse(branchesRaw);
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error('Не удалось получить список веток репозитория на GitHub');
  }

  const candidates = await Promise.all(
    branches.slice(0, 8).map(async (b) => {
      try {
        const cRaw = await httpsGetJsonOrText(
          `https://api.github.com/repos/${APP_REPO}/commits/${encodeURIComponent(b.commit.sha)}`,
          headers
        );
        const commitObj = JSON.parse(cRaw);
        const treeSha = commitObj?.commit?.tree?.sha;
        if (!treeSha) return null;

        const treeRaw = await httpsGetJsonOrText(
          `https://api.github.com/repos/${APP_REPO}/git/trees/${treeSha}?recursive=1`,
          headers
        );
        const treeObj = JSON.parse(treeRaw);
        const entries = Array.isArray(treeObj?.tree) ? treeObj.tree : [];
        const hasAppServer = entries.some((e) => e.path === 'app/server/index.mjs');
        if (!hasAppServer) return null;

        const dateStr = commitObj?.commit?.committer?.date || commitObj?.commit?.author?.date || null;
        const ts = dateStr ? Date.parse(dateStr) : 0;
        return {
          branch: b.name,
          sha: commitObj.sha,
          shortSha: String(commitObj.sha).slice(0, 7),
          publishedAt: dateStr,
          timestamp: Number.isFinite(ts) ? ts : 0,
          message: String(commitObj?.commit?.message || '').split(/\r?\n/)[0].trim(),
          htmlUrl: commitObj?.html_url || `https://github.com/${APP_REPO}/commit/${commitObj.sha}`,
          entries,
        };
      } catch {
        return null;
      }
    })
  );

  const valid = candidates.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
  if (valid.length === 0) {
    throw new Error('В репозитории на GitHub не найдена сборка Zapret Control');
  }
  return valid[0];
}

export async function checkProgramUpdate() {
  const localState = readLocalAppUpdateState();
  const latest = await resolveLatestProgramCommit();
  const changedFilesCount = countMismatchedProgramBlobs(latest.entries);

  if (changedFilesCount === 0) {
    const synced = {
      installedSha: latest.sha,
      installedShortSha: latest.shortSha,
      installedBranch: latest.branch,
      commitDate: latest.publishedAt,
      commitMessage: latest.message,
      syncedAt: new Date().toISOString(),
    };
    saveLocalAppUpdateState(synced);
    return {
      repo: APP_REPO,
      currentShortSha: latest.shortSha,
      currentDate: latest.publishedAt,
      latestSha: latest.sha,
      latestShortSha: latest.shortSha,
      branch: latest.branch,
      publishedAt: latest.publishedAt,
      commitMessage: latest.message,
      changedFilesCount: 0,
      updateAvailable: false,
      htmlUrl: latest.htmlUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  // If app-update-state.json falsely claimed latest.shortSha from an older broken updater, do not mislead user
  const reportedLocalSha =
    localState.installedShortSha && localState.installedShortSha !== latest.shortSha
      ? localState.installedShortSha
      : null;

  return {
    repo: APP_REPO,
    currentShortSha: reportedLocalSha,
    currentDate: reportedLocalSha ? localState.commitDate || null : null,
    latestSha: latest.sha,
    latestShortSha: latest.shortSha,
    branch: latest.branch,
    publishedAt: latest.publishedAt,
    commitMessage: latest.message,
    changedFilesCount,
    updateAvailable: true,
    htmlUrl: latest.htmlUrl,
    checkedAt: new Date().toISOString(),
  };
}

function downloadViaHttpsNode(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      reject(new Error('Слишком много перенаправлений при скачивании обновления'));
      return;
    }
    const req = https.get(
      url,
      {
        ca: SYSTEM_CA_BUNDLE,
        headers: {
          'User-Agent': 'ZapretControl/1.3',
          Accept: '*/*',
        },
        timeout: 25000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          downloadViaHttpsNode(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Ошибка скачивания архива (HTTP ${res.statusCode})`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve(destPath));
        });
        out.on('error', (err) => {
          try {
            out.close();
          } catch {
            // ignore
          }
          reject(err);
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Превышено время ожидания при скачивании архива обновления с GitHub'));
    });
    req.on('error', reject);
  });
}

async function downloadFileWithFallback(url, destPath) {
  try {
    await downloadViaHttpsNode(url, destPath);
    return;
  } catch (nodeErr) {
    const curlBin = os.platform() === 'win32' ? 'curl.exe' : 'curl';
    try {
      await execFileAsync(curlBin, ['-fsSL', '-L', '-m', '45', '-o', destPath, url]);
      return;
    } catch {
      throw nodeErr;
    }
  }
}

async function extractZipToDirectory(zipPath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (os.platform() === 'win32') {
    try {
      await execFileAsync('tar.exe', ['-xf', zipPath, '-C', extractDir]);
      return;
    } catch {
      const psZip = zipPath.replace(/'/g, "''");
      const psDst = extractDir.replace(/'/g, "''");
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDst}' -Force`,
      ]);
      return;
    }
  }

  try {
    await execFileAsync('python3', ['-m', 'zipfile', '-e', zipPath, extractDir]);
  } catch {
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', extractDir]);
  }
}

function locateExtractedRoot(extractDir) {
  if (
    fs.existsSync(path.join(extractDir, 'ZapretControl.bat')) &&
    fs.existsSync(path.join(extractDir, 'app', 'server', 'index.mjs'))
  ) {
    return extractDir;
  }

  const children = fs.readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of children) {
    const candidate = path.join(extractDir, dir.name);
    if (
      fs.existsSync(path.join(candidate, 'ZapretControl.bat')) &&
      fs.existsSync(path.join(candidate, 'app', 'server', 'index.mjs'))
    ) {
      return candidate;
    }
  }
  throw new Error('В скачанном архиве не найдены файлы программы Zapret Control');
}

function mergeTargetsPreservingUserEntries(localTargetsPath, incomingTargetsPath) {
  if (!fs.existsSync(localTargetsPath)) return null;
  const localRaw = fs.readFileSync(localTargetsPath, 'utf8');
  if (!fs.existsSync(incomingTargetsPath)) return localRaw;

  const incomingRaw = fs.readFileSync(incomingTargetsPath, 'utf8');
  const incomingKeys = new Set();
  for (const line of incomingRaw.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (m) incomingKeys.add(m[1].toLowerCase());
  }

  const customLines = [];
  let pendingHeader = null;
  for (const rawLine of localRaw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^#{2,}\s*\S+/.test(trimmed)) {
      pendingHeader = trimmed;
      continue;
    }
    const m = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*.+$/);
    if (m && !incomingKeys.has(m[1].toLowerCase())) {
      if (pendingHeader) {
        customLines.push('', pendingHeader);
        pendingHeader = null;
      }
      customLines.push(trimmed);
    }
  }

  if (customLines.length === 0) {
    return incomingRaw;
  }
  return incomingRaw.replace(/\s*$/, '\r\n') + customLines.join('\r\n') + '\r\n';
}

function stagePreservedUserFiles(extractedRoot, preserveDir) {
  fs.mkdirSync(preserveDir, { recursive: true });
  const settings = loadSettings();
  const defaultZapretDir = path.join(REPO_ROOT, 'zapret');
  if (path.resolve(settings.zapretDir) !== path.resolve(defaultZapretDir)) {
    return;
  }

  const preserveRelPaths = [
    'zapret/lists/list-general-user.txt',
    'zapret/lists/list-exclude-user.txt',
    'zapret/lists/ipset-exclude-user.txt',
    'zapret/lists/ipset-all.txt',
    'zapret/lists/ipset-all.txt.backup',
    'zapret/utils/game_filter.enabled',
    'zapret/bin/ACTIVE_DISCORD_UDP.bin',
    'zapret/bin/ACTIVE_GAME_UDP.bin',
  ];

  for (const rel of preserveRelPaths) {
    const src = path.join(REPO_ROOT, ...rel.split('/'));
    if (fs.existsSync(src)) {
      const dst = path.join(preserveDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }

  const localResultsDir = path.join(REPO_ROOT, 'zapret', 'utils', 'test results');
  if (fs.existsSync(localResultsDir)) {
    const dstResultsDir = path.join(preserveDir, 'zapret', 'utils', 'test results');
    fs.mkdirSync(dstResultsDir, { recursive: true });
    for (const f of fs.readdirSync(localResultsDir)) {
      const fullSrc = path.join(localResultsDir, f);
      if (fs.statSync(fullSrc).isFile()) {
        fs.copyFileSync(fullSrc, path.join(dstResultsDir, f));
      }
    }
  }

  const localTargets = path.join(REPO_ROOT, 'zapret', 'utils', 'targets.txt');
  const incomingTargets = path.join(extractedRoot, 'zapret', 'utils', 'targets.txt');
  const mergedTargets = mergeTargetsPreservingUserEntries(localTargets, incomingTargets);
  if (mergedTargets !== null) {
    const dstTargets = path.join(preserveDir, 'zapret', 'utils', 'targets.txt');
    fs.mkdirSync(path.dirname(dstTargets), { recursive: true });
    fs.writeFileSync(dstTargets, mergedTargets, 'utf8');
  }
}

function copyDirRecursiveFilesOnly(srcDir, dstDir, skipRelSet = new Set(), currentRel = '') {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (skipRelSet.has(rel)) continue;
    const srcFull = path.join(srcDir, entry.name);
    const dstFull = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveFilesOnly(srcFull, dstFull, skipRelSet, rel);
    } else if (entry.isFile()) {
      try {
        fs.mkdirSync(path.dirname(dstFull), { recursive: true });
        fs.copyFileSync(srcFull, dstFull);
      } catch {
        // Locked binaries (e.g. ZapretControl.exe / winws.exe) will be synced by the post-exit script
      }
    }
  }
}

function cleanAccidentalNestedDirs() {
  // Clean any accidental nested dirs left by older PowerShell Copy-Item behavior
  const nestedCandidates = [
    path.join(APP_DIR, 'server', 'server'),
    path.join(APP_DIR, 'static', 'static'),
    path.join(APP_DIR, 'src', 'src'),
    path.join(APP_DIR, 'host', 'host'),
    path.join(APP_DIR, 'public', 'public'),
    path.join(REPO_ROOT, 'zapret', 'zapret'),
    path.join(DATA_DIR, 'staging-update'),
  ];
  for (const p of nestedCandidates) {
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function applyFilesInNodeSync(extractedRoot, preserveDir) {
  cleanAccidentalNestedDirs();
  const oldAssets = path.join(APP_DIR, 'static', 'assets');
  if (fs.existsSync(oldAssets)) {
    try {
      fs.rmSync(oldAssets, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  const skipSet = new Set(['.git', 'app/data', 'app/node_modules']);
  copyDirRecursiveFilesOnly(extractedRoot, REPO_ROOT, skipSet);
  if (fs.existsSync(preserveDir)) {
    copyDirRecursiveFilesOnly(preserveDir, REPO_ROOT);
  }
}

function buildWindowsRestartPs1({
  repoRoot,
  tmpWorkDir,
  sourceDir,
  preserveDir,
  stagedStateFile,
  logFile,
  serverPid,
}) {
  const esc = (p) => String(p).replace(/'/g, "''");
  const lines = [
    '$ErrorActionPreference = "Continue"',
    `$RepoRoot = '${esc(repoRoot)}'`,
    `$TmpWorkDir = '${esc(tmpWorkDir)}'`,
    `$SourceDir = '${esc(sourceDir)}'`,
    `$PreserveDir = '${esc(preserveDir)}'`,
    `$StagedStateFile = '${esc(stagedStateFile)}'`,
    `$LogFile = '${esc(logFile)}'`,
    `$ServerPid = ${Number(serverPid) || 0}`,
    '',
    'function Write-UpdLog([string]$msg) {',
    '    try { Add-Content -LiteralPath $LogFile -Value ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg) -Encoding UTF8 } catch {}',
    '}',
    '',
    'Write-UpdLog "Starting detached Windows update script"',
    'Start-Sleep -Milliseconds 900',
    '',
    '# 1. Close dedicated --app UI window (ui-window-v2 / window-profile)',
    'try {',
    '    Get-CimInstance Win32_Process | Where-Object {',
    '        $_.CommandLine -and ($_.CommandLine -like "*ui-window-v2*" -or $_.CommandLine -like "*window-profile*")',
    '    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '} catch {}',
    '',
    '# 2. Terminate tray host, old server process tree, and winws',
    '& taskkill.exe /IM ZapretControl.exe /F 2>&1 | Out-Null',
    'if ($ServerPid -gt 0) {',
    '    & taskkill.exe /PID $ServerPid /T /F 2>&1 | Out-Null',
    '}',
    '& taskkill.exe /IM winws.exe /F 2>&1 | Out-Null',
    'Start-Sleep -Milliseconds 400',
    '',
    '# 3. Delete old ZapretControl.exe so ZapretControl.bat compiles fresh C# host',
    '$exePath = Join-Path $RepoRoot "ZapretControl.exe"',
    'for ($i = 0; $i -lt 25; $i++) {',
    '    if (-not (Test-Path -LiteralPath $exePath)) { break }',
    '    try {',
    '        Remove-Item -LiteralPath $exePath -Force -ErrorAction Stop',
    '        break',
    '    } catch {',
    '        Start-Sleep -Milliseconds 200',
    '    }',
    '}',
    '',
    '# 4. Mirror program subfolders reliably via robocopy.exe (never suffers from PowerShell Copy-Item folder nesting bug)',
    'foreach ($sub in @("server", "static", "src", "host", "public")) {',
    '    $sSub = Join-Path (Join-Path $SourceDir "app") $sub',
    '    $dSub = Join-Path (Join-Path $RepoRoot "app") $sub',
    '    if (Test-Path -LiteralPath $sSub) {',
    '        & robocopy.exe $sSub $dSub /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
    '        Write-UpdLog ("Mirrored app\\" + $sub + " (exit=" + $LASTEXITCODE + ")")',
    '    }',
    '}',
    '',
    '# Copy top-level files in app/ and root ZapretControl.bat',
    'Get-ChildItem -LiteralPath (Join-Path $SourceDir "app") -File -Force -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $dst = Join-Path (Join-Path $RepoRoot "app") $_.Name',
    '    [System.IO.File]::Copy($_.FullName, $dst, $true)',
    '}',
    '$srcBat = Join-Path $SourceDir "ZapretControl.bat"',
    'if (Test-Path -LiteralPath $srcBat) {',
    '    [System.IO.File]::Copy($srcBat, (Join-Path $RepoRoot "ZapretControl.bat"), $true)',
    '}',
    '',
    '# 5. Sync zapret folder and restore preserved user lists/configs/fakes',
    '$sZap = Join-Path $SourceDir "zapret"',
    '$dZap = Join-Path $RepoRoot "zapret"',
    'if (Test-Path -LiteralPath $sZap) {',
    '    & robocopy.exe $sZap $dZap /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
    '}',
    '$pZap = Join-Path $PreserveDir "zapret"',
    'if (Test-Path -LiteralPath $pZap) {',
    '    & robocopy.exe $pZap $dZap /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
    '}',
    '',
    '# 6. Clear Chromium --app HTTP/JS cache so the new UI bundle always loads fresh',
    'foreach ($cacheRel in @("app\\data\\ui-window-v2\\Default\\Cache", "app\\data\\ui-window-v2\\Default\\Code Cache")) {',
    '    $cp = Join-Path $RepoRoot $cacheRel',
    '    if (Test-Path -LiteralPath $cp) { Remove-Item -LiteralPath $cp -Recurse -Force -ErrorAction SilentlyContinue }',
    '}',
    '',
    '# 7. Write app-update-state.json ONLY after all files are copied',
    'if (Test-Path -LiteralPath $StagedStateFile) {',
    '    $stateDst = Join-Path $RepoRoot "app\\data\\app-update-state.json"',
    '    [System.IO.File]::Copy($StagedStateFile, $stateDst, $true)',
    '}',
    '',
    '# 8. Launch updated ZapretControl.bat',
    '$batLauncher = Join-Path $RepoRoot "ZapretControl.bat"',
    'if (Test-Path -LiteralPath $batLauncher) {',
    '    Write-UpdLog "Launching updated ZapretControl.bat"',
    '    Start-Process -FilePath $batLauncher -WorkingDirectory $RepoRoot',
    '}',
    '',
    'Start-Sleep -Milliseconds 400',
    'Remove-Item -LiteralPath $TmpWorkDir -Recurse -Force -ErrorAction SilentlyContinue',
    'Write-UpdLog "Update completed successfully"',
    '',
  ];
  return '\uFEFF' + lines.join('\r\n');
}

export async function installProgramUpdate({
  zipBase64 = null,
  activeRunningStrategy = null,
  onBeforeApply = null,
} = {}) {
  ensureDataDir();

  // Stage entirely in OS temp directory so we never delete files out from under a running script inside REPO_ROOT
  const tmpWorkDir = path.join(
    os.tmpdir(),
    `zapret-control-upd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(tmpWorkDir, { recursive: true });

  const zipPath = path.join(tmpWorkDir, 'update.zip');
  const extractDir = path.join(tmpWorkDir, 'extracted');
  const preserveDir = path.join(tmpWorkDir, 'preserve');
  const stagedStateFile = path.join(tmpWorkDir, 'app-update-state.json');

  let targetMeta = null;

  try {
    if (zipBase64) {
      const cleaned = String(zipBase64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleaned, 'base64');
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error('Выбранный файл не является корректным ZIP-архивом');
      }
      fs.writeFileSync(zipPath, buf);
    } else {
      targetMeta = await resolveLatestProgramCommit();
      const archiveUrl = `https://codeload.github.com/${APP_REPO}/zip/${targetMeta.sha}`;
      await downloadFileWithFallback(archiveUrl, zipPath);
      const stat = fs.existsSync(zipPath) ? fs.statSync(zipPath) : null;
      if (!stat || stat.size < 100) {
        throw new Error('Скачанный архив обновления повреждён или пуст');
      }
    }

    await extractZipToDirectory(zipPath, extractDir);
    const extractedRoot = locateExtractedRoot(extractDir);
    stagePreservedUserFiles(extractedRoot, preserveDir);

    if (activeRunningStrategy) {
      fs.writeFileSync(
        RESUME_FLAG_PATH,
        JSON.stringify({ strategy: activeRunningStrategy, savedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    }

    if (typeof onBeforeApply === 'function') {
      try {
        await onBeforeApply();
      } catch {
        // ignore
      }
    }

    const nextStateObj = targetMeta
      ? {
          installedSha: targetMeta.sha,
          installedShortSha: targetMeta.shortSha,
          installedBranch: targetMeta.branch,
          commitDate: targetMeta.publishedAt,
          commitMessage: targetMeta.message,
          installedAt: new Date().toISOString(),
        }
      : null;

    if (nextStateObj) {
      fs.writeFileSync(stagedStateFile, JSON.stringify(nextStateObj, null, 2), 'utf8');
    }

    // Apply all unlocked program files immediately in Node (UTF-16 safe, zero PowerShell Copy-Item bugs)
    applyFilesInNodeSync(extractedRoot, preserveDir);

    if (os.platform() === 'win32') {
      const psScriptPath = path.join(os.tmpdir(), `zapret-control-restart-${Date.now()}.ps1`);
      const psContent = buildWindowsRestartPs1({
        repoRoot: REPO_ROOT,
        tmpWorkDir,
        sourceDir: extractedRoot,
        preserveDir,
        stagedStateFile,
        logFile: UPDATE_LOG_PATH,
        serverPid: process.pid,
      });
      fs.writeFileSync(psScriptPath, psContent, 'utf8');

      // Spawn detached via cmd.exe "start" so killing ServerPid (/T) never terminates the updater script!
      const child = spawn(
        'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          `start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psScriptPath}"`,
        ],
        {
          cwd: os.tmpdir(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }
      );
      child.unref();

      return {
        ok: true,
        restarting: true,
        installedShortSha: targetMeta ? targetMeta.shortSha : 'zip',
        message: 'Обновление установлено. Выполняется перезапуск программы...',
      };
    }

    // Non-Windows: verify blobs and persist update state now
    if (nextStateObj) {
      const remaining = countMismatchedProgramBlobs(targetMeta.entries);
      if (remaining === 0) {
        saveLocalAppUpdateState(nextStateObj);
      }
    }
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });

    return {
      ok: true,
      restarting: false,
      installedShortSha: targetMeta ? targetMeta.shortSha : 'zip',
      message: 'Файлы программы успешно обновлены.',
    };
  } catch (err) {
    try {
      fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}
