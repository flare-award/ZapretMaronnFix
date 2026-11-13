import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  checkZapretUpdates,
  updateRemoteIpsetList,
  checkRemoteHostsDiff,
  runDiagnostics,
} from './zapretAdapter.mjs';
import {
  getRuntimeState,
  getTestJobState,
  startStrategyProcess,
  stopStrategyProcess,
  restartIfRunning,
  applyWindowsStartupSetting,
  fixWinDivertConflictsOnWindows,
  clearDiscordCacheOnWindows,
  startTestSuite,
  stopTestSuite,
} from './runnerAndTester.mjs';

const STATIC_DIR = path.join(APP_DIR, 'static');
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

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
      if (raw.length > 8 * 1024 * 1024) {
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
  const gameFilter = zapretInfo.valid ? readGameFilter(zapretDir) : { mode: 'disabled', tcpRange: '1024-65535', udpRange: '1024-65535' };
  const ipsetFilter = zapretInfo.valid ? readIpsetFilter(zapretDir) : { mode: 'none', entriesCount: 0, hasBackup: false, backupEntriesCount: 0 };
  const activeFakes = zapretInfo.valid ? readActiveFakes(zapretDir) : { discordCurrent: null, gameCurrent: null, availableBins: [] };
  const listsMeta = zapretInfo.valid ? readListsMeta(zapretDir) : [];
  const { history: testHistory, latestRun } = zapretInfo.valid ? readTestHistory(zapretDir) : { history: [], latestRun: null };
  const testJob = getTestJobState();

  // If an in-memory test run just finished (e.g. in preview mode), expose its results immediately
  const effectiveLatestRun =
    testJob.results && testJob.results.length > 0 && (!latestRun || !testJob.savedFileName)
      ? {
          fileName: testJob.savedFileName || 'Текущая сессия тестирования',
          timestamp: new Date(testJob.finishedAt || testJob.startedAt || Date.now()).toISOString(),
          strategies: testJob.results,
        }
      : latestRun;

  return {
    platform: {
      os: os.platform(),
      arch: os.arch(),
    },
    settings,
    runtime: getRuntimeState(),
    zapretInfo,
    strategies,
    filters: {
      gameFilter,
      ipsetFilter,
      activeFakes,
    },
    listsMeta,
    testHistory,
    latestTestRun: effectiveLatestRun,
    testJob,
  };
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

  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/runner/start') {
    const body = await readJsonBody(req);
    await startStrategyProcess(body.strategy);
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/runner/stop') {
    await stopStrategyProcess();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/runner/restart') {
    await restartIfRunning();
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const prev = loadSettings();
    const updated = saveSettings(body);
    if (body.launchOnWindowsStartup !== undefined || body.startMinimizedToTray !== undefined) {
      if (prev.launchOnWindowsStartup !== updated.launchOnWindowsStartup || prev.startMinimizedToTray !== updated.startMinimizedToTray) {
        await applyWindowsStartupSetting(updated.launchOnWindowsStartup, updated.startMinimizedToTray);
      }
    }
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/game') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    writeGameFilter(settings.zapretDir, body);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/ipset') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    switchIpsetFilter(settings.zapretDir, body.mode);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    sendJson(res, 200, buildFullState());
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/ipset-update') {
    const settings = loadSettings();
    const result = await updateRemoteIpsetList(settings.zapretDir);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
    sendJson(res, 200, { ...result, state: buildFullState() });
    return;
  }

  if (method === 'POST' && pathname === '/api/filters/fakes') {
    const body = await readJsonBody(req);
    const settings = loadSettings();
    replaceActiveFake(settings.zapretDir, body.target, body.binFileName);
    if (settings.autoRestartOnFilterChange) {
      await restartIfRunning();
    }
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
    sendJson(res, 200, { ...result, state: buildFullState() });
    return;
  }

  if (method === 'GET' && pathname === '/api/updates/check') {
    const settings = loadSettings();
    const updateInfo = await checkZapretUpdates(settings.zapretDir);
    sendJson(res, 200, updateInfo);
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
    sendJson(res, 200, parseTestResultContent(fileName, content));
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

  sendJson(res, 404, { error: `Неизвестный метод API: ${method} ${pathname}` });
}

function serveStatic(req, res, pathname) {
  let targetPath = pathname === '/' ? path.join(STATIC_DIR, 'index.html') : path.join(STATIC_DIR, pathname);
  // Prevent path traversal
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
    'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
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
  if (os.platform() === 'win32' && process.argv.includes('--open')) {
    const localUrl = `http://127.0.0.1:${PORT}`;
    const edgePaths = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
    const edgeExe = edgePaths.find((p) => fs.existsSync(p));
    if (edgeExe) {
      execFile(edgeExe, [`--app=${localUrl}`, '--window-size=1220,800'], () => {});
    } else {
      execFile('explorer.exe', [localUrl], () => {});
    }
  }
  // Create initial backup of user lists if not yet backed up
  try {
    const settings = loadSettings();
    const info = readZapretInfo(settings.zapretDir);
    if (info.valid) {
      backupUserLists(settings.zapretDir);
      if (settings.autoStartStrategyOnLaunch) {
        console.log(`Auto-starting last selected strategy on launch: ${settings.selectedStrategy}`);
        await startStrategyProcess(settings.selectedStrategy);
      }
    }
  } catch (err) {
    console.error('Startup init warning:', err);
  }
});
