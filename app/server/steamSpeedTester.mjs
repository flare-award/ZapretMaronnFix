import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadSettings, readStrategies, DATA_DIR } from './zapretAdapter.mjs';
import { getRuntimeState, startStrategyProcess, stopStrategyProcess } from './runnerAndTester.mjs';

const isWin = os.platform() === 'win32';
const HISTORY_PATH = path.join(DATA_DIR, 'steam-speed-history.json');
const STEAM_CDN_URLS = [
  'https://client-update.akamai.steamstatic.com/client/steam_client_win32',
  'https://media.steampowered.com/client/installer/SteamSetup.exe',
];
const STREAMS = 4;
const TARGET_BYTES_PER_STRATEGY = 200 * 1024 * 1024;
const BYTES_PER_STREAM = Math.ceil(TARGET_BYTES_PER_STRATEGY / STREAMS);
const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const MAX_HISTORY_RUNS = 8;

let activeCurlChildren = new Set();
let stateListener = null;
let steamSpeedJob = createIdleJob();

function createIdleJob() {
  return {
    running: false,
    aborted: false,
    startedAt: null,
    finishedAt: null,
    currentStrategy: null,
    completedCount: 0,
    totalCount: 0,
    progressPct: 0,
    results: [],
    error: null,
    sourceLabel: 'Официальная CDN Steam',
    sampleBytesPerStrategy: TARGET_BYTES_PER_STRATEGY,
  };
}

function notify() {
  if (stateListener) {
    try {
      stateListener();
    } catch {
      // ignore a disconnected UI
    }
  }
}

export function setSteamSpeedChangeListener(listener) {
  stateListener = typeof listener === 'function' ? listener : null;
}

export function getSteamSpeedJobState() {
  return {
    ...steamSpeedJob,
    results: steamSpeedJob.results.map((item) => ({ ...item })),
  };
}

export function readSteamSpeedHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_RUNS) : [];
  } catch {
    return [];
  }
}

function saveCompletedRun() {
  if (!steamSpeedJob.results.length) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const run = {
    id: `steam-${steamSpeedJob.startedAt}`,
    startedAt: steamSpeedJob.startedAt,
    finishedAt: steamSpeedJob.finishedAt,
    aborted: steamSpeedJob.aborted,
    sourceLabel: steamSpeedJob.sourceLabel,
    sampleBytesPerStrategy: steamSpeedJob.sampleBytesPerStrategy,
    results: steamSpeedJob.results,
  };
  const history = [run, ...readSteamSpeedHistory()].slice(0, MAX_HISTORY_RUNS);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

function runCurlSample(url, rangeEnd) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const separator = '__ZAPRET_STEAM_METRIC__';
    const args = [
      '-fsSL',
      '--connect-timeout',
      '6',
      '--max-time',
      '240',
      '--retry',
      '1',
      '--retry-delay',
      '0',
      '--range',
      `0-${rangeEnd}`,
      '-H',
      'Accept-Encoding: identity',
      '-o',
      'NUL',
      '-w',
      `${separator}%{http_code}|%{size_download}|%{time_total}|%{time_starttransfer}`,
      url,
    ];
    const child = spawn('curl.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeCurlChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      activeCurlChildren.delete(child);
      reject(err);
    });
    child.on('exit', (code) => {
      activeCurlChildren.delete(child);
      if (steamSpeedJob.aborted) {
        reject(new Error('Тест остановлен'));
        return;
      }
      const metricAt = stdout.lastIndexOf(separator);
      const metric = metricAt >= 0 ? stdout.slice(metricAt + separator.length).trim() : '';
      const [statusRaw, bytesRaw, secondsRaw, ttfbRaw] = metric.split('|');
      const status = Number(statusRaw);
      const bytes = Number(bytesRaw);
      const seconds = Number(secondsRaw);
      const ttfbSeconds = Number(ttfbRaw);
      if (code !== 0 || status < 200 || status >= 400 || !Number.isFinite(bytes) || bytes <= 0) {
        reject(new Error(stderr.trim() || `Steam CDN вернула HTTP ${status || 0}`));
        return;
      }
      resolve({
        bytes,
        seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : (Date.now() - startedAt) / 1000,
        ttfbMs: Number.isFinite(ttfbSeconds) ? Math.round(ttfbSeconds * 1000) : null,
      });
    });
  });
}

async function downloadSteamStream(url, targetBytes) {
  let bytes = 0;
  let ttfbTotal = 0;
  let requestCount = 0;
  while (bytes < targetBytes) {
    if (steamSpeedJob.aborted) throw new Error('Тест остановлен');
    const remaining = targetBytes - bytes;
    const requestBytes = Math.min(MAX_REQUEST_BYTES, remaining);
    const sample = await runCurlSample(url, requestBytes - 1);
    bytes += sample.bytes;
    if (sample.ttfbMs !== null) ttfbTotal += sample.ttfbMs;
    requestCount += 1;
    if (requestCount > 100) {
      throw new Error('Steam CDN возвращает слишком маленькие фрагменты данных');
    }
  }
  return {
    bytes,
    ttfbMs: requestCount > 0 ? Math.round(ttfbTotal / requestCount) : null,
    requestCount,
  };
}

async function measureSteamCdn() {
  let lastError = null;
  for (const url of STEAM_CDN_URLS) {
    try {
      const wallStartedAt = Date.now();
      const settled = await Promise.allSettled(
        Array.from({ length: STREAMS }, () =>
          downloadSteamStream(url, BYTES_PER_STREAM)
        )
      );
      const failed = settled.find((item) => item.status === 'rejected');
      if (failed && failed.status === 'rejected') throw failed.reason;
      const samples = settled.map((item) => item.status === 'fulfilled' ? item.value : null).filter(Boolean);
      const wallSeconds = Math.max(0.001, (Date.now() - wallStartedAt) / 1000);
      const bytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
      const megabytesPerSecond = bytes / 1024 / 1024 / wallSeconds;
      return {
        ok: true,
        megabytesPerSecond: Math.round(megabytesPerSecond * 100) / 100,
        megabitsPerSecond: Math.round(megabytesPerSecond * 8 * 10) / 10,
        latencyMs: Math.round(
          samples.reduce((sum, sample) => sum + (sample.ttfbMs || 0), 0) / samples.length
        ),
        bytesDownloaded: bytes,
        durationMs: Math.round(wallSeconds * 1000),
        endpointHost: new URL(url).hostname,
        error: null,
      };
    } catch (err) {
      lastError = err;
      if (steamSpeedJob.aborted) throw err;
    }
  }
  return {
    ok: false,
    megabytesPerSecond: 0,
    megabitsPerSecond: 0,
    latencyMs: null,
    bytesDownloaded: 0,
    durationMs: 0,
    endpointHost: null,
    error: lastError instanceof Error ? lastError.message : 'Steam CDN недоступна',
  };
}

export function stopSteamSpeedTest() {
  if (!steamSpeedJob.running) return getSteamSpeedJobState();
  steamSpeedJob.aborted = true;
  for (const child of activeCurlChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  activeCurlChildren.clear();
  notify();
  return getSteamSpeedJobState();
}

export async function startSteamSpeedTest({ strategies: requestedStrategies } = {}) {
  if (steamSpeedJob.running) throw new Error('Тест скорости Steam уже выполняется');
  if (!isWin) throw new Error('Реальный тест Steam доступен в приложении на Windows');

  const settingsBefore = loadSettings();
  const allStrategies = readStrategies(settingsBefore.zapretDir).map((item) => item.fileName);
  const selected = Array.isArray(requestedStrategies) && requestedStrategies.length
    ? allStrategies.filter((fileName) => requestedStrategies.includes(fileName))
    : allStrategies;
  if (!selected.length) throw new Error('Не найдено стратегий для тестирования');

  const previousRuntime = getRuntimeState();
  const strategyToRestore = previousRuntime.running ? previousRuntime.activeStrategy : null;
  if (previousRuntime.running) await stopStrategyProcess();

  steamSpeedJob = {
    ...createIdleJob(),
    running: true,
    startedAt: Date.now(),
    currentStrategy: selected[0],
    totalCount: selected.length,
  };
  notify();

  (async () => {
    try {
      for (let index = 0; index < selected.length; index++) {
        if (steamSpeedJob.aborted) break;
        const fileName = selected[index];
        steamSpeedJob.currentStrategy = fileName;
        notify();

        let result;
        try {
          await startStrategyProcess(fileName, { preserveSelectedStrategy: true, keepDriver: true });
          await new Promise((resolve) => setTimeout(resolve, 900));
          result = await measureSteamCdn();
        } catch (err) {
          result = {
            ok: false,
            megabytesPerSecond: 0,
            megabitsPerSecond: 0,
            latencyMs: null,
            bytesDownloaded: 0,
            durationMs: 0,
            endpointHost: null,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          await stopStrategyProcess({ keepDriver: true });
        }

        if (!steamSpeedJob.aborted || result.ok) {
          steamSpeedJob.results.push({ fileName, ...result });
        }
        steamSpeedJob.completedCount = index + 1;
        steamSpeedJob.progressPct = Math.round(((index + 1) / selected.length) * 100);
        notify();
      }
    } catch (err) {
      steamSpeedJob.error = err instanceof Error ? err.message : String(err);
    } finally {
      steamSpeedJob.running = false;
      steamSpeedJob.currentStrategy = null;
      steamSpeedJob.finishedAt = Date.now();
      saveCompletedRun();
      if (strategyToRestore) {
        try {
          await startStrategyProcess(strategyToRestore, {
            preserveSelectedStrategy: true,
            keepDriver: true,
          });
        } catch {
          await stopStrategyProcess();
        }
      } else {
        await stopStrategyProcess();
      }
      notify();
    }
  })();

  return getSteamSpeedJobState();
}
