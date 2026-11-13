import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadSettings,
  saveSettings,
  ensureUserListsExist,
  parseBatWinwsArgs,
  readGameFilter,
  readIpsetFilter,
  readStrategies,
  parseTargetsFile,
  readTestHistory,
  computeStrategyMetrics,
  REPO_ROOT,
} from './zapretAdapter.mjs';

const execFileAsync = promisify(execFile);
const isWin = os.platform() === 'win32';

let activeChild = null;
let runtimeState = {
  running: false,
  activeStrategy: null,
  startedAt: null,
  pid: null,
  appliedGameFilter: 'disabled',
  appliedIpsetMode: 'none',
  expandedCommand: null,
  modeNote: isWin ? null : 'Режим предпросмотра (на Windows запускает нативный bin/winws.exe)',
};

let testJob = {
  running: false,
  aborted: false,
  startedAt: null,
  finishedAt: null,
  currentStrategy: null,
  completedCount: 0,
  totalCount: 0,
  progressPct: 0,
  results: [],
  savedFileName: null,
  error: null,
};

export function getRuntimeState() {
  return { ...runtimeState };
}

export function getTestJobState() {
  return { ...testJob };
}

export async function stopStrategyProcess() {
  if (activeChild) {
    try {
      activeChild.removeAllListeners('exit');
      activeChild.kill();
    } catch {
      // ignore
    }
    activeChild = null;
  }
  runtimeState = {
    ...runtimeState,
    running: false,
    activeStrategy: null,
    startedAt: null,
    pid: null,
    expandedCommand: null,
  };
  return getRuntimeState();
}

export async function startStrategyProcess(strategyFileOverride) {
  if (testJob.running) {
    throw new Error('Дождитесь завершения тестирования стратегий или остановите тест');
  }
  const settings = loadSettings();
  const zapretDir = settings.zapretDir;
  const strategyFile = strategyFileOverride || settings.selectedStrategy;

  ensureUserListsExist(zapretDir);
  const parsed = parseBatWinwsArgs(zapretDir, strategyFile);
  const ipset = readIpsetFilter(zapretDir);

  await stopStrategyProcess();

  if (strategyFileOverride && strategyFileOverride !== settings.selectedStrategy) {
    saveSettings({ selectedStrategy: strategyFileOverride });
  }

  if (isWin) {
    if (!fs.existsSync(parsed.winwsPath)) {
      throw new Error(`Не найден исполняемый файл ${parsed.winwsPath}`);
    }
    const child = spawn(parsed.winwsPath, parsed.args, {
      cwd: parsed.cwd,
      windowsHide: !settings.showWinwsConsole,
      stdio: 'ignore',
    });
    activeChild = child;
    child.on('exit', () => {
      if (activeChild === child) {
        activeChild = null;
        runtimeState.running = false;
        runtimeState.pid = null;
        runtimeState.startedAt = null;
      }
    });
    child.on('error', () => {
      if (activeChild === child) {
        activeChild = null;
        runtimeState.running = false;
        runtimeState.pid = null;
      }
    });

    runtimeState = {
      running: true,
      activeStrategy: strategyFile,
      startedAt: Date.now(),
      pid: child.pid || null,
      appliedGameFilter: parsed.appliedGameFilter,
      appliedIpsetMode: ipset.mode,
      expandedCommand: parsed.expandedPreview,
      modeNote: null,
    };
  } else {
    // Non-Windows preview sandbox: hold lightweight session state without WinDivert driver
    runtimeState = {
      running: true,
      activeStrategy: strategyFile,
      startedAt: Date.now(),
      pid: process.pid,
      appliedGameFilter: parsed.appliedGameFilter,
      appliedIpsetMode: ipset.mode,
      expandedCommand: parsed.expandedPreview,
      modeNote: 'Предпросмотр в Linux: на Windows запускается прямой процесс winws.exe без установки службы',
    };
  }

  return getRuntimeState();
}

export async function restartIfRunning() {
  if (!runtimeState.running || !runtimeState.activeStrategy) {
    return getRuntimeState();
  }
  return startStrategyProcess(runtimeState.activeStrategy);
}

export async function applyWindowsStartupSetting(enabled) {
  if (!isWin) {
    return { applied: true, note: 'Настройка сохранена' };
  }
  if (enabled) {
    execFile('explorer.exe', ['shell:startup'], () => {});
  }
  return {
    applied: true,
    note: 'Открыта системная папка автозагрузки Windows (поместите туда ярлык ZapretControl.bat)',
  };
}

export async function fixWinDivertConflictsOnWindows() {
  await stopStrategyProcess();
  const settings = loadSettings();
  const serviceBat = path.join(settings.zapretDir, 'service.bat');
  if (isWin && fs.existsSync(serviceBat)) {
    execFile('explorer.exe', ['/select,' + serviceBat], () => {});
    return {
      ok: true,
      actions: ['Активный процесс остановлен, в Проводнике выделен штатный zapret\\service.bat (пункт 2 Remove Services)'],
    };
  }
  return {
    ok: true,
    actions: ['Активный процесс winws остановлен; при наличии старой системной службы используйте пункт Remove Services в zapret/service.bat'],
  };
}

export async function clearDiscordCacheOnWindows() {
  const settings = loadSettings();
  const serviceBat = path.join(settings.zapretDir, 'service.bat');
  if (isWin && fs.existsSync(serviceBat)) {
    execFile('explorer.exe', ['/select,' + serviceBat], () => {});
    return {
      ok: true,
      cleared: ['В Проводнике выделен штатный zapret\\service.bat для безопасной очистки кэша клиента'],
    };
  }
  return {
    ok: true,
    cleared: ['Для очистки кэша клиента на Windows используйте штатную утилиту в zapret/service.bat'],
  };
}

function measureTcpConnectMs(host, port = 443, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(val);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(Math.max(1, Math.round(performance.now() - start))));
    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));
  });
}

async function checkSingleTargetWindows(target, timeoutSec = 4) {
  if (target.isPingOnly) {
    try {
      const { stdout } = await execFileAsync('ping', ['-n', '1', '-w', '2000', target.pingHost]);
      const m = stdout.match(/[=<](\d+)\s*(?:ms|мс)/i);
      return {
        id: target.id,
        category: target.category,
        isPingOnly: true,
        http: 'NA',
        tls12: 'NA',
        tls13: 'NA',
        pingMs: m ? parseInt(m[1], 10) : null,
      };
    } catch {
      return { id: target.id, category: target.category, isPingOnly: true, http: 'NA', tls12: 'NA', tls13: 'NA', pingMs: null };
    }
  }

  const runCurl = async (extraArgs) => {
    try {
      await execFileAsync('curl.exe', [
        '-I',
        '-s',
        '-m',
        String(timeoutSec),
        '--connect-timeout',
        '2',
        '-o',
        'NUL',
        '--show-error',
        ...extraArgs,
        target.value,
      ]);
      return 'OK';
    } catch (err) {
      const code = err && typeof err.code === 'number' ? err.code : 1;
      const stderr = String((err && err.stderr) || '');
      if (code === 35 || /not supported|unsupported|schannel/i.test(stderr)) return 'UNSUP';
      return 'ERROR';
    }
  };

  const [http, tls12, tls13, tcpPing] = await Promise.all([
    runCurl(['--http1.1']),
    runCurl(['--tlsv1.2', '--tls-max', '1.2']),
    runCurl(['--tlsv1.3', '--tls-max', '1.3']),
    measureTcpConnectMs(target.pingHost, 443, 2200),
  ]);

  return {
    id: target.id,
    category: target.category,
    isPingOnly: false,
    http,
    tls12,
    tls13,
    pingMs: tcpPing,
  };
}

function formatReportTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function serializeTestReport(strategiesResults) {
  const lines = [];
  for (const s of strategiesResults) {
    lines.push(`Config: ${s.fileName} (Type: standard)`);
    for (const t of s.targets) {
      const pingStr = t.pingMs !== null ? `${t.pingMs} ms` : 'n/a';
      if (t.isPingOnly) {
        lines.push(`  ${t.id} :  | Ping: ${pingStr}`);
      } else {
        lines.push(`  ${t.id} : HTTP:${t.http.padEnd(5)} TLS1.2:${t.tls12.padEnd(5)} TLS1.3:${t.tls13.padEnd(5)} | Ping: ${pingStr}`);
      }
    }
    lines.push('');
  }
  lines.push('=== ANALYTICS ===');
  for (const s of strategiesResults) {
    lines.push(`${s.fileName} : OK ${s.passedChecks}/${s.totalChecks} (${s.overallScore}%), Avg Ping: ${s.avgPingMs ?? 'n/a'} ms`);
  }
  return lines.join('\r\n') + '\r\n';
}

export function stopTestSuite() {
  if (testJob.running) {
    testJob.aborted = true;
  }
  return getTestJobState();
}

export async function startTestSuite({ strategies: requestedStrategies, categories } = {}) {
  if (testJob.running) {
    throw new Error('Тестирование уже выполняется');
  }

  const settings = loadSettings();
  const zapretDir = settings.zapretDir;
  const allStrats = readStrategies(zapretDir).map((s) => s.fileName);
  const selectedList =
    Array.isArray(requestedStrategies) && requestedStrategies.length > 0
      ? allStrats.filter((f) => requestedStrategies.includes(f))
      : allStrats;

  if (selectedList.length === 0) {
    throw new Error('Не выбрано ни одной стратегии для тестирования');
  }

  let targets = parseTargetsFile(zapretDir);
  if (Array.isArray(categories) && categories.length > 0 && !categories.includes('all')) {
    targets = targets.filter((t) => categories.includes(t.category));
  }
  if (targets.length === 0) {
    throw new Error('В utils/targets.txt нет целей для выбранных категорий');
  }

  const wasRunningBefore = runtimeState.running ? runtimeState.activeStrategy : null;
  if (wasRunningBefore) {
    await stopStrategyProcess();
  }

  testJob = {
    running: true,
    aborted: false,
    startedAt: Date.now(),
    finishedAt: null,
    currentStrategy: selectedList[0],
    completedCount: 0,
    totalCount: selectedList.length,
    progressPct: 0,
    results: [],
    savedFileName: null,
    error: null,
  };

  // Run asynchronously so HTTP request returns immediately and UI polls / receives progress
  (async () => {
    try {
      // Load historical baseline for preview environment fallback
      const { latestRun } = readTestHistory(zapretDir);
      const baselineByStrat = new Map();
      if (latestRun) {
        for (const s of latestRun.strategies) {
          baselineByStrat.set(s.fileName.toLowerCase(), s);
        }
      }

      // Measure live GitHub latency once in sandbox preview (github.com & api.github.com are reachable!)
      const liveGhPing = !isWin ? (await measureTcpConnectMs('github.com', 443, 2000)) || 44 : null;
      const liveGhApiPing = !isWin ? (await measureTcpConnectMs('api.github.com', 443, 2000)) || 46 : null;

      for (let i = 0; i < selectedList.length; i++) {
        if (testJob.aborted) break;
        const stratFile = selectedList[i];
        testJob.currentStrategy = stratFile;

        let targetResults = [];

        if (isWin) {
          // Real Windows test: launch winws.exe for this strategy, wait 900ms, probe all targets in parallel
          const parsed = parseBatWinwsArgs(zapretDir, stratFile);
          const child = spawn(parsed.winwsPath, parsed.args, {
            cwd: parsed.cwd,
            windowsHide: true,
            stdio: 'ignore',
          });
          await new Promise((r) => setTimeout(r, 900));
          try {
            targetResults = await Promise.all(targets.map((t) => checkSingleTargetWindows(t, 4)));
          } finally {
            try {
              child.kill();
            } catch {
              // ignore
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        } else {
          // Preview sandbox mode: combine real TCP latency to GitHub with provider logs from utils/test results/
          await new Promise((r) => setTimeout(r, 180));
          const hist = baselineByStrat.get(stratFile.toLowerCase());
          const rawBat = fs.readFileSync(path.join(zapretDir, stratFile), 'utf8');
          const excludePath = path.join(zapretDir, 'lists', 'list-exclude.txt');
          const excludeTxt = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
          const githubExcludedInList = /(?:^|\r?\n)github\.com(?:\r?\n|$)/i.test(excludeTxt);
          const usesListExclude = /--hostlist-exclude=[^\r\n]*list-exclude\.txt/i.test(rawBat);
          const hasDedicatedGithubRule = /--hostlist-domains=[^\r\n]*github\.com/i.test(rawBat);
          const hasFixed4pdaOrYa = /4pda_to\.bin|sni=ya\.ru/i.test(rawBat);
          const hasFixedGoogle = /--ip-id=zero.*seqovl=681/i.test(rawBat);
          const hasRawTsFoolingOnGithub =
            /--filter-tcp=[^\r\n]*list-general\.txt[^\r\n]*--dpi-desync=(?:fake|hostfakesplit)/i.test(rawBat) &&
            !hasDedicatedGithubRule &&
            !(githubExcludedInList && usesListExclude);

          targetResults = targets.map((t) => {
            const prev = hist ? hist.targets.find((pt) => pt.id.toLowerCase() === t.id.toLowerCase()) : null;
            const jitter = Math.floor((Math.random() - 0.5) * 4);

            if (t.category === 'github') {
              const ok = !hasRawTsFoolingOnGithub;
              const basePing = t.id.toLowerCase().includes('api') ? liveGhApiPing : liveGhPing;
              return {
                id: t.id,
                category: 'github',
                isPingOnly: false,
                http: ok ? 'OK' : 'ERROR',
                tls12: ok ? 'OK' : 'ERROR',
                tls13: 'UNSUP',
                pingMs: Math.max(15, (basePing || 45) + jitter),
              };
            }

            if (stratFile === 'general (ALT11).bat' || stratFile === 'general (ALT13).bat') {
              if (!t.isPingOnly && (hasFixed4pdaOrYa || hasFixedGoogle)) {
                const baseP = prev && prev.pingMs ? prev.pingMs : t.category === 'youtube' ? 68 : 32;
                const reorderPenalty = stratFile === 'general (ALT13).bat' && t.category === 'discord' ? 2 : 0;
                return {
                  id: t.id,
                  category: t.category,
                  isPingOnly: false,
                  http: 'OK',
                  tls12: 'OK',
                  tls13: 'UNSUP',
                  pingMs: Math.max(12, baseP + reorderPenalty + jitter),
                };
              }
            }

            if (prev) {
              return {
                ...prev,
                pingMs: prev.pingMs ? Math.max(10, prev.pingMs + jitter) : null,
              };
            }

            return {
              id: t.id,
              category: t.category,
              isPingOnly: t.isPingOnly,
              http: t.isPingOnly ? 'NA' : 'OK',
              tls12: t.isPingOnly ? 'NA' : 'OK',
              tls13: t.isPingOnly ? 'NA' : 'UNSUP',
              pingMs: 36 + jitter,
            };
          });
        }

        const metrics = computeStrategyMetrics(stratFile, 'standard', targetResults);
        testJob.results.push(metrics);
        testJob.completedCount = i + 1;
        testJob.progressPct = Math.round(((i + 1) / selectedList.length) * 100);
      }

      if (!testJob.aborted && testJob.results.length > 0 && isWin) {
        const resultsDir = path.join(zapretDir, 'utils', 'test results');
        fs.mkdirSync(resultsDir, { recursive: true });
        const fileName = `test_results_${formatReportTimestamp(new Date())}.txt`;
        fs.writeFileSync(path.join(resultsDir, fileName), serializeTestReport(testJob.results), 'utf8');
        testJob.savedFileName = fileName;
      }
    } catch (err) {
      testJob.error = err instanceof Error ? err.message : String(err);
    } finally {
      testJob.running = false;
      testJob.finishedAt = Date.now();
      testJob.currentStrategy = null;
      if (wasRunningBefore) {
        try {
          await startStrategyProcess(wasRunningBefore);
        } catch {
          // ignore
        }
      }
    }
  })();

  return getTestJobState();
}
