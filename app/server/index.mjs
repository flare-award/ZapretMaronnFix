import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  APP_DIR,
  loadSettings,
  saveSettings,
  readZapretInfo,
  readStrategies,
  readGameFilter,
  writeGameFilter,
  readIpsetFilter,
  switchIpsetFilter,
  readActiveFakes,
  replaceActiveFake,
  readListsMeta,
  readListContent,
  saveListContent,
  backupUserLists,
  restoreUserLists,
  readTestHistory,
  parseTestResultContent,
  readTargetCategories,
  checkZapretUpdates,
  updateRemoteIpsetList,
  checkRemoteHostsDiff,
  runDiagnostics,
  readProfiles,
  syncCurrentStateToActiveProfile,
  activateProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  computeZapretDirectoryFingerprint,
} from './zapretAdapter.mjs';
import {
  getRuntimeState,
  getTestJobState,
  startStrategyProcess,
  stopStrategyProcess,
  shutdownBypassServicesAndDriver,
  restartIfRunning,
  applyWindowsStartupSetting,
  fixWinDivertConflictsOnWindows,
  clearDiscordCacheOnWindows,
  startTestSuite,
  stopTestSuite,
} from './runnerAndTester.mjs';
import {
  readLocalAppUpdateState,
  checkProgramUpdate,
  installProgramUpdate,
  consumeResumeAfterUpdateFlag,
} from './appUpdater.mjs';

const STATIC_DIR = path.join(APP_DIR, 'static');
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_BOOT_ID = crypto.randomUUID();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const sseClients = new Set();
let lastZapretFingerprint = '';
let fsWatchers = [];
let watchedRootPath = '';
let watchDebounceTimer = null;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024 * 1024) {
        reject(new Error('Превышен допустимый размер тела запроса'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Некорректный JSON в запросе'));
      }
    });
    req.on('error', reject);
  });
}

function buildFullState() {
  const settings = loadSettings();
  const zapretDir = settings.zapretDir;
  const zapretInfo = readZapretInfo(zapretDir);
  const strategies = zapretInfo.valid ? readStrategies(zapretDir) : [];
  const gameFilter = zapretInfo.valid
    ? readGameFilter(zapretDir)
    : { mode: 'disabled', tcpRange: '1024-65535', udpRange: '1024-65535' };
  const ipsetFilter = zapretInfo.valid
    ? readIpsetFilter(zapretDir)
    : { mode: 'none', entriesCount: 0, hasBackup: false, backupEntriesCount: 0 };
  const activeFakes = zapretInfo.valid
    ? readActiveFakes(zapretDir)
    : { discordCurrent: null, gameCurrent: null, availableBins: [] };
  const listsMeta = zapretInfo.valid ? readListsMeta(zapretDir) : [];
  const targetCategories = zapretInfo.valid ? readTargetCategories(zapretDir) : [];
  const { history: testHistory, latestRun } = zapretInfo.valid
    ? readTestHistory(zapretDir)
    : { history: [], latestRun: null };
  const profilesData = zapretInfo.valid
    ? readProfiles(zapretDir)
    : { profiles: [], activeProfileId: 'default' };
  const testJob = getTestJobState();

  // In non-Windows preview mode where tests aren't written to disk, expose in-memory results
  const effectiveLatestRun =
    testJob.results && testJob.results.length > 0 && !testJob.savedFileName
      ? {
          fileName: 'Текущая сессия тестирования',
          timestamp: new Date(testJob.finishedAt || testJob.startedAt || Date.now()).toISOString(),
          strategies: testJob.results,
        }
      : latestRun;

  return {
    platform: {
      os: os.platform(),
      arch: os.arch(),
    },
    settings: loadSettings(),
    runtime: getRuntimeState(),
    zapretInfo,
    strategies,
    profiles: profilesData.profiles,
    activeProfileId: profilesData.activeProfileId,
    filters: {
      gameFilter,
      ipsetFilter,
      activeFakes,
    },
    listsMeta,
    targetCategories,
    testHistory,
    latestTestRun: effectiveLatestRun,
    testJob,
    appUpdateState: readLocalAppUpdateState(),
    serverBootId: SERVER_BOOT_ID,
    zapretFingerprint: lastZapretFingerprint || computeZapretDirectoryFingerprint(zapretDir),
  };
}

function broadcastStateChange() {
  if (sseClients.size === 0) return;
  try {
    const payload = JSON.stringify(buildFullState());
    for (const client of sseClients) {
      try {
        client.write(`event: state\ndata: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  } catch {
    // ignore transient read error while files are being copied
  }
}

function checkZapretFingerprintAndBroadcast() {
  try {
    const settings = loadSettings();
    const fp = computeZapretDirectoryFingerprint(settings.zapretDir);
    if (fp !== lastZapretFingerprint) {
      lastZapretFingerprint = fp;
      broadcastStateChange();
    }
  } catch {
    // ignore
  }
}

function setupZapretWatchers(zapretDir) {
  if (watchedRootPath === zapretDir && fsWatchers.length > 0) return;
  for (const w of fsWatchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  fsWatchers = [];
  watchedRootPath = zapretDir;
  if (!fs.existsSync(zapretDir)) return;

  const dirs = [
    zapretDir,
    path.join(zapretDir, 'lists'),
    path.join(zapretDir, 'bin'),
    path.join(zapretDir, 'utils'),
    path.join(zapretDir, 'utils', 'test results'),
  ];

  const onFsEvent = () => {
    if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      checkZapretFingerprintAndBroadcast();
    }, 250);
  };

  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    try {
      const watcher = fs.watch(d, onFsEvent);
      watcher.on('error', () => {});
      fsWatchers.push(watcher);
    } catch {
      // ignore if OS watch limit hit; periodic fingerprint check still catches changes
    }
  }
}

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/runner/start') {
    const body = await readJsonBody(req);
    await startStrategyProcess(body.strategy);
    if (body.strategy) {
      const s = loadSettings();
      syncCurrentStateToActiveProfile(s.zapretDir);
    }
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/runner/stop') {
    await stopStrategyProcess();
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/runner/restart') {
    await restartIfRunning();
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const prev = loadSettings();
    const updated = saveSettings(body);
    if (body.zapretDir && body.zapretDir !== prev.zapretDir) {
      setupZapretWatchers(updated.zapretDir);
    }
    if (body.selectedStrategy && body.selectedStrategy !== prev.selectedStrategy) {
      syncCurrentStateToActiveProfile(updated.zapretDir);
      if (updated.autoRestartOnFilterChange) {
        await restartIfRunning();
      }
    }
    if (body.launchOnWindowsStartup !== undefined || body.startMinimizedToTray !== undefined) {
      if (
        prev.launchOnWindowsStartup !== updated.launchOnWindowsStartup ||
        prev.startMinimizedToTray !== updated.startMinimizedToTray
      ) {
        await applyWindowsStartupSetting(updated.launchOnWindowsStartup, updated.startMinimizedToTray);
      }
    }
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  // Profiles API
  if (method === 'POST' && pathname === '/api/profiles/activate') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    activateProfile(settings.zapretDir, String(body.id || ''));
    const nextSettings = loadSettings();
    if (body.startNow) {
      await startStrategyProcess(nextSettings.selectedStrategy);
    } else if (nextSettings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(nextSettings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/profiles') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    createProfile(settings.zapretDir, body);
    if (body.activateNow && settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  const profileMatch = pathname.match(/^\/api\/profiles\/([a-z0-9-]+)$/i);
  if (profileMatch) {
    const profileId = profileMatch[1];
    const settings = loadSettings();
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      updateProfile(settings.zapretDir, profileId, body);
      if (settings.activeProfileId === profileId && settings.autoRestartOnFilterChange) {
        await restartIfRunning();
      }
      lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
      broadcastStateChange();
      sendJson(res, 200, buildFullState());
      return;
    }
    if (method === 'DELETE') {
      const wasActive = settings.activeProfileId === profileId;
      deleteProfile(settings.zapretDir, profileId);
      if (wasActive && settings.autoRestartOnFilterChange) {
        await restartIfRunning();
      }
      lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
      broadcastStateChange();
      sendJson(res, 200, buildFullState());
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/filters/game') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    writeGameFilter(settings.zapretDir, body);
    syncCurrentStateToActiveProfile(settings.zapretDir);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/ipset') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    switchIpsetFilter(settings.zapretDir, body.mode);
    syncCurrentStateToActiveProfile(settings.zapretDir);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/ipset-update') {
    const settings = loadSettings();
    const result = await updateRemoteIpsetList(settings.zapretDir);
    syncCurrentStateToActiveProfile(settings.zapretDir);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, { ...result, state: buildFullState() });
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/fakes') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    replaceActiveFake(settings.zapretDir, body.target, body.binFileName);
    syncCurrentStateToActiveProfile(settings.zapretDir);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, buildFullState());
    return;
  }

  const listMatch = pathname.match(/^\/api\/lists\/([a-z0-9-]+)$/i);
  if (listMatch) {
    const listId = listMatch[1];
    const settings = loadSettings();
    if (method === 'GET') {
      sendJson(res, 200, readListContent(settings.zapretDir, listId));
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const saved = saveListContent(settings.zapretDir, listId, String(body.content ?? ''), {
        autoClean: Boolean(body.autoClean),
      });
      if (settings.autoRestartOnFilterChange) {
        await restartIfRunning();
      }
      lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
      broadcastStateChange();
      sendJson(res, 200, { list: saved, state: buildFullState() });
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/backups/save') {
    const settings = loadSettings();
    const result = backupUserLists(settings.zapretDir);
    sendJson(res, 200, { ...result, state: buildFullState() });
    return;
  }

  if (method === 'POST' && pathname === '/api/backups/restore') {
    const settings = loadSettings();
    const result = restoreUserLists(settings.zapretDir);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    broadcastStateChange();
    sendJson(res, 200, { ...result, state: buildFullState() });
    return;
  }

  if (method === 'GET' && pathname === '/api/updates/check') {
    const settings = loadSettings();
    const updateInfo = await checkZapretUpdates(settings.zapretDir);
    sendJson(res, 200, updateInfo);
    return;
  }

  if (pathname === '/api/updates/download-latest') {
    const settings = loadSettings();
    const updateInfo = await checkZapretUpdates(settings.zapretDir);
    const zipUrl = updateInfo.downloadUrl;
    if (method === 'GET' || method === 'HEAD') {
      res.writeHead(302, {
        Location: zipUrl,
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      });
      res.end();
      return;
    }
    if (method === 'POST') {
      const delegated = os.platform() === 'win32';
      if (delegated) {
        execFile('rundll32.exe', ['url.dll,FileProtocolHandler', zipUrl], () => {});
      }
      sendJson(res, 200, {
        ok: true,
        delegatedToOs: delegated,
        downloadUrl: zipUrl,
        assetName: updateInfo.assetName,
        updateInfo,
      });
      return;
    }
  }

  if (method === 'POST' && pathname === '/api/system/shutdown') {
    await shutdownBypassServicesAndDriver();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/app-update/check') {
    const appUpdate = await checkProgramUpdate();
    sendJson(res, 200, appUpdate);
    return;
  }

  if (method === 'POST' && pathname === '/api/app-update/install') {
    const body = await readJsonBody(req);
    const runtime = getRuntimeState();
    const result = await installProgramUpdate({
      zipBase64: body.zipBase64 || null,
      activeRunningStrategy: runtime.running ? runtime.activeStrategy : null,
      onBeforeApply: async () => {
        if (runtime.running) {
          await stopStrategyProcess();
        }
      },
    });
    sendJson(res, 200, result);
    return;
  }

  const histMatch = pathname.match(/^\/api\/tests\/history\/(.+)$/);
  if (method === 'GET' && histMatch) {
    const settings = loadSettings();
    const fileName = path.basename(decodeURIComponent(histMatch[1]));
    const fullPath = path.join(settings.zapretDir, 'utils', 'test results', fileName);
    if (!fs.existsSync(fullPath)) {
      sendJson(res, 404, { error: 'Файл отчёта не найден' });
      return;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    sendJson(res, 200, parseTestResultContent(fileName, content, settings.zapretDir));
    return;
  }

  if (method === 'POST' && pathname === '/api/tests/start') {
    const body = await readJsonBody(req);
    const job = await startTestSuite(body);
    sendJson(res, 200, { testJob: job });
    return;
  }

  if (method === 'POST' && pathname === '/api/tests/stop') {
    const job = stopTestSuite();
    sendJson(res, 200, { testJob: job });
    return;
  }

  if (method === 'GET' && pathname === '/api/tests/job') {
    sendJson(res, 200, { testJob: getTestJobState() });
    return;
  }

  if (method === 'GET' && pathname === '/api/diagnostics') {
    const settings = loadSettings();
    const diag = await runDiagnostics(settings.zapretDir);
    sendJson(res, 200, diag);
    return;
  }

  if (method === 'POST' && pathname === '/api/diagnostics/fix-windivert') {
    const resFix = await fixWinDivertConflictsOnWindows();
    sendJson(res, 200, resFix);
    return;
  }

  if (method === 'POST' && pathname === '/api/diagnostics/clear-discord-cache') {
    const resClear = await clearDiscordCacheOnWindows();
    sendJson(res, 200, resClear);
    return;
  }

  if (method === 'GET' && pathname === '/api/diagnostics/check-hosts') {
    const hostsReport = await checkRemoteHostsDiff();
    sendJson(res, 200, hostsReport);
    return;
  }

  if (method === 'POST' && pathname === '/api/system/open-folder') {
    const settings = loadSettings();
    if (os.platform() === 'win32') {
      execFile('explorer.exe', [settings.zapretDir], () => {});
      sendJson(res, 200, { opened: true, path: settings.zapretDir });
    } else {
      sendJson(res, 200, { opened: false, path: settings.zapretDir, note: `Путь к папке: ${settings.zapretDir}` });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/system/open-url') {
    const body = await readJsonBody(req);
    const targetUrl = String(body.url || '').trim();
    if (!/^https?:\/\/[^\s"<>]+$/i.test(targetUrl)) {
      sendJson(res, 400, { error: 'Некорректный адрес ссылки' });
      return;
    }
    if (os.platform() === 'win32') {
      // Open strictly in user's default OS browser instead of the msedge --app container
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', targetUrl], () => {});
      sendJson(res, 200, { opened: true, delegatedToOs: true });
    } else {
      sendJson(res, 200, { opened: false, delegatedToOs: false });
    }
    return;
  }

  sendJson(res, 404, { error: `Неизвестный метод API: ${method} ${pathname}` });
}

function serveStatic(req, res, pathname) {
  let targetPath = pathname === '/' ? path.join(STATIC_DIR, 'index.html') : path.join(STATIC_DIR, pathname);
  if (!path.resolve(targetPath).startsWith(path.resolve(STATIC_DIR))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    targetPath = path.join(STATIC_DIR, 'index.html');
  }
  if (!fs.existsSync(targetPath)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Static UI bundle not built yet.');
    return;
  }

  const ext = path.extname(targetPath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const isAsset = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': isAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-store, no-cache, must-revalidate, max-age=0',
    ...(isAsset ? {} : { Pragma: 'no-cache', Expires: '0' }),
  });
  fs.createReadStream(targetPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const pathname = urlObj.pathname;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Zapret Control UI server listening on http://${HOST}:${PORT}`);
  try {
    const settings = loadSettings();
    lastZapretFingerprint = computeZapretDirectoryFingerprint(settings.zapretDir);
    setupZapretWatchers(settings.zapretDir);
    setInterval(checkZapretFingerprintAndBroadcast, 1500).unref();

    const info = readZapretInfo(settings.zapretDir);
    if (info.valid) {
      backupUserLists(settings.zapretDir);
      const { activeProfileId } = readProfiles(settings.zapretDir);
      activateProfile(settings.zapretDir, activeProfileId);
      const resumedStrategy = consumeResumeAfterUpdateFlag();
      if (resumedStrategy) {
        console.log(`Resuming active strategy after program self-update: ${resumedStrategy}`);
        await startStrategyProcess(resumedStrategy);
      } else if (settings.autoStartStrategyOnLaunch) {
        const refreshed = loadSettings();
        console.log(`Auto-starting last selected strategy on launch: ${refreshed.selectedStrategy}`);
        await startStrategyProcess(refreshed.selectedStrategy);
      }
    }
  } catch (err) {
    console.error('Startup init warning:', err);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shutdownBypassServicesAndDriver().finally(() => process.exit(0));
  });
}
