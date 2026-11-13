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
const STAGING_DIR = path.join(DATA_DIR, 'staging-update');

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

  // Fallback if running inside a git checkout before first check
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

  // Fetch commit details for candidate branches and pick the newest one that contains Zapret Control app/
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

  const programBlobs = latest.entries.filter((e) => e.type === 'blob' && isProgramFilePath(e.path));
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

  return {
    repo: APP_REPO,
    currentShortSha: localState.installedShortSha || null,
    currentDate: localState.commitDate || null,
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
          'User-Agent': 'ZapretControl/1.2',
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

  // Collect custom sections/keys added by the user that are absent from incoming targets.txt
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
    // User placed zapret/ in an external folder outside repo; repo copy won't touch it at all
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

  // Preserve test results history
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

  // Merge user's custom targets.txt services with incoming targets.txt
  const localTargets = path.join(REPO_ROOT, 'zapret', 'utils', 'targets.txt');
  const incomingTargets = path.join(extractedRoot, 'zapret', 'utils', 'targets.txt');
  const mergedTargets = mergeTargetsPreservingUserEntries(localTargets, incomingTargets);
  if (mergedTargets !== null) {
    const dstTargets = path.join(preserveDir, 'zapret', 'utils', 'targets.txt');
    fs.mkdirSync(path.dirname(dstTargets), { recursive: true });
    fs.writeFileSync(dstTargets, mergedTargets, 'utf8');
  }
}

function copyDirRecursiveSync(srcDir, dstDir, skipRelSet = new Set(), currentRel = '') {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (skipRelSet.has(rel)) continue;
    const srcFull = path.join(srcDir, entry.name);
    const dstFull = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcFull, dstFull, skipRelSet, rel);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcFull, dstFull);
    }
  }
}

function buildWindowsUpdaterPs1({ repoRoot, stagingDir, sourceDir, preserveDir, serverPid }) {
  const esc = (p) => String(p).replace(/'/g, "''");
  const lines = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$RepoRoot = '${esc(repoRoot)}'`,
    `$StagingDir = '${esc(stagingDir)}'`,
    `$SourceDir = '${esc(sourceDir)}'`,
    `$PreserveDir = '${esc(preserveDir)}'`,
    `$ServerPid = ${Number(serverPid) || 0}`,
    '',
    'Start-Sleep -Milliseconds 700',
    '',
    '# Close dedicated --app UI window (ui-window-v2 / window-profile) without touching regular browser tabs',
    'Get-CimInstance Win32_Process | Where-Object {',
    '    $_.CommandLine -and ($_.CommandLine -like "*ui-window-v2*" -or $_.CommandLine -like "*window-profile*")',
    '} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '',
    'Stop-Process -Name "ZapretControl" -Force -ErrorAction SilentlyContinue',
    'if ($ServerPid -gt 0) {',
    '    Stop-Process -Id $ServerPid -Force -ErrorAction SilentlyContinue',
    '}',
    'Stop-Process -Name "winws" -Force -ErrorAction SilentlyContinue',
    '',
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
    '$oldAssets = Join-Path $RepoRoot "app\\static\\assets"',
    'if (Test-Path -LiteralPath $oldAssets) {',
    '    Remove-Item -LiteralPath $oldAssets -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    '',
    'Get-ChildItem -LiteralPath $SourceDir -Force | ForEach-Object {',
    '    if ($_.Name -eq ".git") { return }',
    '    if ($_.Name -eq "app") {',
    '        Get-ChildItem -LiteralPath $_.FullName -Force | Where-Object { $_.Name -ne "data" -and $_.Name -ne "node_modules" } | ForEach-Object {',
    '            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RepoRoot "app") -Recurse -Force',
    '        }',
    '    } else {',
    '        Copy-Item -LiteralPath $_.FullName -Destination $RepoRoot -Recurse -Force',
    '    }',
    '}',
    '',
    'if (Test-Path -LiteralPath $PreserveDir) {',
    '    Get-ChildItem -LiteralPath $PreserveDir -Force | ForEach-Object {',
    '        Copy-Item -LiteralPath $_.FullName -Destination $RepoRoot -Recurse -Force',
    '    }',
    '}',
    '',
    'Start-Sleep -Milliseconds 250',
    'Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue',
    '',
    '$batLauncher = Join-Path $RepoRoot "ZapretControl.bat"',
    'if (Test-Path -LiteralPath $batLauncher) {',
    '    Start-Process -FilePath $batLauncher -WorkingDirectory $RepoRoot',
    '}',
    '',
  ];
  return '\uFEFF' + lines.join('\r\n');
}

export async function installProgramUpdate({ zipBase64 = null, activeRunningStrategy = null } = {}) {
  ensureDataDir();
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const zipPath = path.join(STAGING_DIR, 'update.zip');
  const extractDir = path.join(STAGING_DIR, 'extracted');
  const preserveDir = path.join(STAGING_DIR, 'preserve');

  let targetMeta = null;

  if (zipBase64) {
    const cleaned = String(zipBase64).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(cleaned, 'base64');
    if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
      throw new Error('Выбранный файл не является корректным ZIP-архивом');
    }
    fs.writeFileSync(zipPath, buf);
  } else {
    targetMeta = await resolveLatestProgramCommit();
    const archiveUrl = `https://codeload.github.com/${APP_REPO}/zip/${targetMeta.sha}`;
    await downloadFileWithFallback(archiveUrl, zipPath);
    const stat = fs.existsSync(zipPath) ? fs.statSync(zipPath) : null;
    if (!stat || stat.size < 100) {
      fs.rmSync(STAGING_DIR, { recursive: true, force: true });
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

  if (targetMeta) {
    saveLocalAppUpdateState({
      installedSha: targetMeta.sha,
      installedShortSha: targetMeta.shortSha,
      installedBranch: targetMeta.branch,
      commitDate: targetMeta.publishedAt,
      commitMessage: targetMeta.message,
      installedAt: new Date().toISOString(),
    });
  }

  if (os.platform() === 'win32') {
    const scriptPath = path.join(STAGING_DIR, 'apply-update.ps1');
    const scriptContent = buildWindowsUpdaterPs1({
      repoRoot: REPO_ROOT,
      stagingDir: STAGING_DIR,
      sourceDir: extractedRoot,
      preserveDir,
      serverPid: process.pid,
    });
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      {
        cwd: REPO_ROOT,
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
      message: 'Обновление подготовлено. Программа сейчас автоматически перезапустится.',
    };
  }

  // Non-Windows in-place apply (preserves app/data, app/node_modules, .git, and user zapret files)
  const oldAssets = path.join(APP_DIR, 'static', 'assets');
  if (fs.existsSync(oldAssets)) {
    fs.rmSync(oldAssets, { recursive: true, force: true });
  }
  const skipSet = new Set(['.git', 'app/data', 'app/node_modules']);
  copyDirRecursiveSync(extractedRoot, REPO_ROOT, skipSet);
  if (fs.existsSync(preserveDir)) {
    copyDirRecursiveSync(preserveDir, REPO_ROOT);
  }
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });

  return {
    ok: true,
    restarting: false,
    installedShortSha: targetMeta ? targetMeta.shortSha : 'zip',
    message: 'Файлы программы успешно обновлены.',
  };
}
