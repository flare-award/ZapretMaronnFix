import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import dns from 'node:dns';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(APP_DIR, '..');
export const DATA_DIR = path.join(APP_DIR, 'data');
export const BACKUPS_DIR = path.join(DATA_DIR, 'user-lists-backup');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');

const DEFAULT_SETTINGS = {
  zapretDir: path.join(REPO_ROOT, 'zapret'),
  selectedStrategy: 'general (ALT11).bat',
  activeProfileId: 'default',
  favoriteStrategies: [],
  autoStartStrategyOnLaunch: false,
  launchOnWindowsStartup: false,
  startMinimizedToTray: false,
  minimizeToTrayOnClose: true,
  autoRestartOnFilterChange: true,
  autoRestartOnCrash: true,
  autoCheckUpdates: true,
  showWinwsConsole: false,
  showBestStrategyCards: true,
  connectLayout: 'split',
  developerMode: false,
};

export const LIST_DEFINITIONS = [
  {
    id: 'list-general-user',
    title: 'Мои сайты для обхода',
    subtitle: 'Личный список доменов (сохраняется при обновлениях)',
    relPath: 'lists/list-general-user.txt',
    kind: 'domains',
    isUser: true,
  },
  {
    id: 'list-exclude-user',
    title: 'Мои исключения сайтов',
    subtitle: 'Сайты, к которым обход не применяется',
    relPath: 'lists/list-exclude-user.txt',
    kind: 'domains',
    isUser: true,
  },
  {
    id: 'ipset-exclude-user',
    title: 'Мои исключения IP',
    subtitle: 'IP-адреса и подсети без обработки',
    relPath: 'lists/ipset-exclude-user.txt',
    kind: 'ipset',
    isUser: true,
  },
  {
    id: 'list-general',
    title: 'Основной список (list-general)',
    subtitle: 'Базовые домены Discord, Cloudflare и других сервисов',
    relPath: 'lists/list-general.txt',
    kind: 'domains',
    isUser: false,
  },
  {
    id: 'list-google',
    title: 'YouTube и Google',
    subtitle: 'Домены видеосерверов YouTube и сервисов Google',
    relPath: 'lists/list-google.txt',
    kind: 'domains',
    isUser: false,
  },
  {
    id: 'list-exclude',
    title: 'Базовые исключения',
    subtitle: 'Сайты и сервисы РФ, работающие напрямую',
    relPath: 'lists/list-exclude.txt',
    kind: 'domains',
    isUser: false,
  },
  {
    id: 'ipset-exclude',
    title: 'Базовые исключения IP',
    subtitle: 'Локальные и системные подсети',
    relPath: 'lists/ipset-exclude.txt',
    kind: 'ipset',
    isUser: false,
  },
  {
    id: 'targets',
    title: 'Цели проверки (targets.txt)',
    subtitle: 'Адреса сервисов для вкладки "Тесты"',
    relPath: 'utils/targets.txt',
    kind: 'targets',
    isUser: false,
  },
];

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

export function loadSettings() {
  ensureDirs();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      const merged = { ...DEFAULT_SETTINGS, ...parsed };
      if (!Array.isArray(merged.favoriteStrategies)) {
        merged.favoriteStrategies = [];
      } else {
        merged.favoriteStrategies = Array.from(
          new Set(merged.favoriteStrategies.filter((x) => typeof x === 'string' && x.trim()))
        );
      }
      merged.autoRestartOnCrash = merged.autoRestartOnCrash !== false;
      if (!path.isAbsolute(merged.zapretDir)) {
        merged.zapretDir = path.resolve(REPO_ROOT, merged.zapretDir);
      }
      if (!fs.existsSync(merged.zapretDir) && fs.existsSync(DEFAULT_SETTINGS.zapretDir)) {
        merged.zapretDir = DEFAULT_SETTINGS.zapretDir;
      }
      return merged;
    }
  } catch {
    // ignore corrupt settings and restore defaults
  }
  return { ...DEFAULT_SETTINGS, favoriteStrategies: [] };
}

export function saveSettings(partial) {
  ensureDirs();
  const current = loadSettings();
  const next = { ...current, ...partial };
  if (partial.zapretDir) {
    next.zapretDir = path.resolve(REPO_ROOT, partial.zapretDir);
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function writeCrlfFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmedEnd = normalized.endsWith('\n') ? normalized : normalized + '\n';
  fs.writeFileSync(filePath, trimmedEnd.replace(/\n/g, '\r\n'), 'utf8');
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function validatePortRange(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.replace(/\s+/g, '');
  if (!cleaned) return null;
  const parts = cleaned.split(',');
  for (const part of parts) {
    if (!/^[1-9]\d*(?:-[1-9]\d*)?$/.test(part)) return null;
    const [startStr, endStr] = part.split('-');
    const start = Number(startStr);
    const end = endStr ? Number(endStr) : start;
    if (start < 1 || start > 65535 || end < 1 || end > 65535 || start > end) {
      return null;
    }
  }
  return cleaned;
}

export function readGameFilter(zapretDir) {
  const flagFile = path.join(zapretDir, 'utils', 'game_filter.enabled');
  let mode = 'disabled';
  let tcpRange = '1024-65535';
  let udpRange = '1024-65535';

  if (fs.existsSync(flagFile)) {
    const lines = fs.readFileSync(flagFile, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) {
        const low = line.toLowerCase();
        if (low === 'all' || low === 'tcp' || low === 'udp' || low === 'disabled') {
          mode = low;
        }
      } else {
        const key = line.slice(0, eqIdx).trim().toLowerCase();
        const val = line.slice(eqIdx + 1).trim();
        if (key === 'mode' && ['disabled', 'all', 'tcp', 'udp'].includes(val.toLowerCase())) {
          mode = val.toLowerCase();
        } else if (key === 'tcp') {
          const valid = validatePortRange(val);
          if (valid) tcpRange = valid;
        } else if (key === 'udp') {
          const valid = validatePortRange(val);
          if (valid) udpRange = valid;
        }
      }
    }
  }

  const effectiveTcp = mode === 'all' || mode === 'tcp' ? tcpRange : '12';
  const effectiveUdp = mode === 'all' || mode === 'udp' ? udpRange : '12';

  return { mode, tcpRange, udpRange, effectiveTcp, effectiveUdp };
}

export function writeGameFilter(zapretDir, { mode, tcpRange, udpRange }) {
  const current = readGameFilter(zapretDir);
  const nextMode = ['disabled', 'all', 'tcp', 'udp'].includes(mode) ? mode : current.mode;
  const nextTcp = tcpRange !== undefined ? validatePortRange(tcpRange) : current.tcpRange;
  const nextUdp = udpRange !== undefined ? validatePortRange(udpRange) : current.udpRange;
  if (!nextTcp || !nextUdp) {
    throw new Error('Некорректный диапазон портов. Используйте числа 1-65535, например: 1024-65535 или 1024-1934,1936-65535');
  }
  const flagFile = path.join(zapretDir, 'utils', 'game_filter.enabled');
  writeCrlfFile(flagFile, `mode=${nextMode}\ntcp=${nextTcp}\nudp=${nextUdp}\n`);
  return readGameFilter(zapretDir);
}

function countNonEmptyLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8');
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (s && !s.startsWith('#')) count++;
  }
  return count;
}

export function readIpsetFilter(zapretDir) {
  const listFile = path.join(zapretDir, 'lists', 'ipset-all.txt');
  const backupFile = path.join(zapretDir, 'lists', 'ipset-all.txt.backup');
  const hasBackup = fs.existsSync(backupFile);
  const backupEntriesCount = hasBackup ? countNonEmptyLines(backupFile) : 0;

  if (!fs.existsSync(listFile)) {
    return { mode: 'any', entriesCount: 0, hasBackup, backupEntriesCount };
  }
  const raw = fs.readFileSync(listFile, 'utf8');
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { mode: 'any', entriesCount: 0, hasBackup, backupEntriesCount };
  }
  if (lines.some((l) => l.includes('203.0.113.113/32'))) {
    return { mode: 'none', entriesCount: 0, hasBackup, backupEntriesCount };
  }
  return { mode: 'loaded', entriesCount: lines.length, hasBackup, backupEntriesCount };
}

export function switchIpsetFilter(zapretDir, targetMode) {
  const listFile = path.join(zapretDir, 'lists', 'ipset-all.txt');
  const backupFile = path.join(zapretDir, 'lists', 'ipset-all.txt.backup');
  const current = readIpsetFilter(zapretDir);

  if (!['none', 'loaded', 'any'].includes(targetMode)) {
    throw new Error('Недопустимый режим IPSet');
  }
  if (current.mode === targetMode) return current;

  // Preserve loaded list into .backup before overwriting with none/any
  if (current.mode === 'loaded' && fs.existsSync(listFile)) {
    fs.copyFileSync(listFile, backupFile);
  }

  if (targetMode === 'none') {
    writeCrlfFile(listFile, '203.0.113.113/32\n');
  } else if (targetMode === 'any') {
    fs.mkdirSync(path.dirname(listFile), { recursive: true });
    fs.writeFileSync(listFile, '', 'utf8');
  } else if (targetMode === 'loaded') {
    if (!fs.existsSync(backupFile)) {
      throw new Error('Резервная база ipset-all.txt.backup не найдена. Нажмите "Обновить базу IPSet" для загрузки актуального списка.');
    }
    fs.copyFileSync(backupFile, listFile);
  }

  return readIpsetFilter(zapretDir);
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function readActiveFakes(zapretDir) {
  const binDir = path.join(zapretDir, 'bin');
  if (!fs.existsSync(binDir)) {
    return { discordCurrent: null, gameCurrent: null, availableBins: [] };
  }
  const discordPath = path.join(binDir, 'ACTIVE_DISCORD_UDP.bin');
  const gamePath = path.join(binDir, 'ACTIVE_GAME_UDP.bin');
  const discordHash = fs.existsSync(discordPath) ? sha256File(discordPath) : null;
  const gameHash = fs.existsSync(gamePath) ? sha256File(gamePath) : null;

  const entries = fs.readdirSync(binDir)
    .filter((f) => f.toLowerCase().endsWith('.bin') && !f.toUpperCase().startsWith('ACTIVE_'))
    .sort(naturalCompare);

  const availableBins = entries.map((fileName) => {
    const full = path.join(binDir, fileName);
    const stat = fs.statSync(full);
    const hash = sha256File(full);
    return {
      name: fileName.replace(/\.bin$/i, ''),
      fileName,
      sizeBytes: stat.size,
      sha256: hash,
    };
  });

  const discordMatch = availableBins.find((b) => b.sha256 === discordHash);
  const gameMatch = availableBins.find((b) => b.sha256 === gameHash);

  return {
    discordCurrent: discordMatch ? discordMatch.fileName : (discordHash ? 'Пользовательский файл' : null),
    gameCurrent: gameMatch ? gameMatch.fileName : (gameHash ? 'Пользовательский файл' : null),
    availableBins,
  };
}

export function replaceActiveFake(zapretDir, target, binFileName) {
  const binDir = path.join(zapretDir, 'bin');
  const safeName = path.basename(binFileName);
  const sourcePath = path.join(binDir, safeName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Файл фейка ${safeName} не найден в bin/`);
  }
  const destName = target === 'discord' ? 'ACTIVE_DISCORD_UDP.bin' : target === 'game' ? 'ACTIVE_GAME_UDP.bin' : null;
  if (!destName) throw new Error('Некорректный тип активного фейка');
  fs.copyFileSync(sourcePath, path.join(binDir, destName));
  return readActiveFakes(zapretDir);
}

export function ensureUserListsExist(zapretDir) {
  const listsDir = path.join(zapretDir, 'lists');
  if (!fs.existsSync(listsDir)) return;
  const defaults = [
    ['ipset-exclude-user.txt', '203.0.113.113/32\n'],
    ['list-general-user.txt', 'domain.example.abc\n'],
    ['list-exclude-user.txt', 'domain.example.abc\n'],
  ];
  for (const [name, fallback] of defaults) {
    const p = path.join(listsDir, name);
    if (!fs.existsSync(p)) {
      writeCrlfFile(p, fallback);
    }
  }
}

export function formatStrategyShortName(fileName) {
  const base = fileName.replace(/\.bat$/i, '');
  if (base.toLowerCase() === 'general') return 'General (Базовая)';
  const m = base.match(/^general\s*\((.+)\)$/i);
  return m ? m[1].trim() : base;
}

function summarizeStrategyEngine(rawBat) {
  const modes = new Set();
  for (const m of rawBat.matchAll(/--dpi-desync=([a-z0-9,]+)/gi)) {
    for (const part of m[1].split(',')) {
      if (part !== 'fake' || !m[1].includes(',')) modes.add(part);
      if (m[1].includes('fake,')) modes.add('fake+' + m[1].split(',')[1]);
    }
  }
  // Extract primary TCP 80,443 rule details
  const mainTcpMatch = rawBat.match(/--filter-tcp=80,443\s+--hostlist=[^\r\n]+/i);
  const line = mainTcpMatch ? mainTcpMatch[0] : rawBat;

  const desync = (line.match(/--dpi-desync=([^\s]+)/i) || [])[1] || 'desync';
  const seqovl = (line.match(/--dpi-desync-split-seqovl=([^\s]+)/i) || [])[1];
  const splitPos = (line.match(/--dpi-desync-split-pos=([^\s]+)/i) || [])[1];
  const hfsHost = (line.match(/host=([^,\s]+)/i) || [])[1];
  const tlsModSni = (line.match(/sni=([^,\s]+)/i) || [])[1];
  const patternBin = (line.match(/--dpi-desync-(?:split-seqovl-pattern|fake-tls)="%BIN%([^"]+)"/i) || [])[1];

  const tags = [desync.replace(',', ' + ')];
  if (splitPos) tags.push(`pos ${splitPos}`);
  if (seqovl) tags.push(`ovl ${seqovl}`);
  if (hfsHost) tags.push(`host ${hfsHost}`);
  else if (tlsModSni) tags.push(`sni ${tlsModSni}`);
  else if (patternBin) {
    const cleanBin = patternBin
      .replace(/^tls_clienthello_/i, '')
      .replace(/^quic_initial_/i, '')
      .replace(/\.bin$/i, '')
      .replace(/_/g, '.');
    tags.push(cleanBin);
  }
  return tags.join(' / ');
}

export function parseBatWinwsArgs(zapretDir, batFileName) {
  const batPath = path.join(zapretDir, path.basename(batFileName));
  if (!fs.existsSync(batPath)) {
    throw new Error(`Стратегия ${batFileName} не найдена в папке zapret`);
  }
  const gf = readGameFilter(zapretDir);
  const binDir = path.join(zapretDir, 'bin') + path.sep;
  const listsDir = path.join(zapretDir, 'lists') + path.sep;

  const raw = fs.readFileSync(batPath, 'utf8');
  const idx = raw.toLowerCase().indexOf('winws.exe"');
  if (idx === -1) {
    throw new Error(`В файле ${batFileName} не найден вызов winws.exe`);
  }
  const afterExe = raw
    .slice(idx + 'winws.exe"'.length)
    .replace(/\^\r?\n/g, ' ')
    .split(/\r?\n/)[0];

  const expanded = afterExe
    .replace(/%BIN%/gi, binDir)
    .replace(/%LISTS%/gi, listsDir)
    .replace(/%GameFilterTCP%/gi, gf.effectiveTcp)
    .replace(/%GameFilterUDP%/gi, gf.effectiveUdp)
    .replace(/%GameFilter%/gi, gf.effectiveTcp);

  // Tokenize respecting double quotes (just like Windows CommandLineToArgvW)
  const args = [];
  const tokenRegex = /[^\s"]+|"([^"]*)"/g;
  let match;
  let current = '';
  let lastEnd = -1;

  // Merge adjacent tokens like --hostlist="C:\path\list.txt" into --hostlist=C:\path\list.txt
  const rawTokens = expanded.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const tok of rawTokens) {
    if (tok === '^') continue;
    args.push(tok.replace(/"/g, ''));
  }

  return {
    winwsPath: path.join(zapretDir, 'bin', 'winws.exe'),
    cwd: path.join(zapretDir, 'bin'),
    args,
    expandedPreview: `"${path.join(zapretDir, 'bin', 'winws.exe')}" ` + rawTokens.join(' '),
    appliedGameFilter: gf.mode,
  };
}

export function readStrategies(zapretDir) {
  if (!fs.existsSync(zapretDir)) return [];
  const files = fs.readdirSync(zapretDir)
    .filter((f) => f.toLowerCase().endsWith('.bat') && !f.toLowerCase().startsWith('service'))
    .sort((a, b) => {
      if (a.toLowerCase() === 'general.bat') return -1;
      if (b.toLowerCase() === 'general.bat') return 1;
      return naturalCompare(a, b);
    });

  return files.map((fileName) => {
    const fullPath = path.join(zapretDir, fileName);
    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    let commandPreview = '';
    try {
      commandPreview = parseBatWinwsArgs(zapretDir, fileName).expandedPreview;
    } catch {
      commandPreview = content;
    }
    return {
      fileName,
      displayName: formatStrategyShortName(fileName),
      isCustom: /^custom\s*-/i.test(fileName),
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      engineSummary: summarizeStrategyEngine(content),
      usesGameFilter: /%GameFilter/i.test(content),
      usesIpset: /ipset-all\.txt/i.test(content),
      commandPreview,
    };
  });
}

export function readZapretInfo(zapretDir) {
  const servicePath = path.join(zapretDir, 'service.bat');
  const winwsPath = path.join(zapretDir, 'bin', 'winws.exe');
  const listsPath = path.join(zapretDir, 'lists');
  const valid = fs.existsSync(servicePath) && fs.existsSync(listsPath);

  let localVersion = 'Неизвестно';
  let lastModified = null;

  if (fs.existsSync(servicePath)) {
    const content = fs.readFileSync(servicePath, 'utf8');
    const m = content.match(/LOCAL_VERSION=([^\r\n"]+)/i);
    if (m) localVersion = m[1].trim();
    lastModified = fs.statSync(servicePath).mtime.toISOString();
  }

  const strategies = valid ? fs.readdirSync(zapretDir).filter((f) => f.toLowerCase().endsWith('.bat') && !f.toLowerCase().startsWith('service')) : [];
  const binDir = path.join(zapretDir, 'bin');
  const bins = fs.existsSync(binDir) ? fs.readdirSync(binDir).filter((f) => f.toLowerCase().endsWith('.bin')) : [];

  return {
    valid,
    hasWinwsBinary: fs.existsSync(winwsPath),
    localVersion,
    zapretPath: zapretDir,
    lastModified,
    strategyCount: strategies.length,
    binCount: bins.length,
    links: {
      upstreamRepo: 'https://github.com/Flowseal/zapret-discord-youtube',
      latestRelease: 'https://github.com/Flowseal/zapret-discord-youtube/releases',
      coreRepo: 'https://github.com/bol-van/zapret',
      userRepo: 'https://github.com/flare-award/ZapretMaronnFix/tree/arena/9383b414-zapretmaronnfix',
    },
  };
}

const STANDARD_CATEGORIES = {
  discord: { id: 'discord', label: 'Discord', shortLabel: 'Discord' },
  youtube: { id: 'youtube', label: 'YouTube', shortLabel: 'YT' },
  google: { id: 'google', label: 'Google', shortLabel: 'Google' },
  cloudflare: { id: 'cloudflare', label: 'Cloudflare', shortLabel: 'CF' },
  github: { id: 'github', label: 'GitHub', shortLabel: 'GH' },
  dns: { id: 'dns', label: 'DNS Ping', shortLabel: 'DNS' },
};

function normalizeSectionHeader(rawHeader) {
  const cleaned = rawHeader
    .replace(/^#+\s*/, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  if (!cleaned) return null;
  const low = cleaned.toLowerCase();
  if (low.includes('discord')) return STANDARD_CATEGORIES.discord;
  if (low.includes('youtube') || low === 'yt') return STANDARD_CATEGORIES.youtube;
  if (low === 'google') return STANDARD_CATEGORIES.google;
  if (low.includes('cloudflare') && !low.includes('dns')) return STANDARD_CATEGORIES.cloudflare;
  if (low.includes('github')) return STANDARD_CATEGORIES.github;
  if (low.includes('dns')) return STANDARD_CATEGORIES.dns;

  const slug =
    cleaned
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'custom';
  const shortLabel = cleaned.length > 12 ? cleaned.slice(0, 12).trim() : cleaned;
  return { id: slug, label: cleaned, shortLabel, isCustomSection: true };
}

function deriveCustomServiceFromTarget(targetId, rawValue) {
  // Derive a clean human-readable service name from KeyName (e.g. "TwitchMain" -> "Twitch") or URL hostname
  const strippedKey = String(targetId || '')
    .replace(/(?:Main|Web|Short|Image|VideoRedirect|Video|Gateway|CDN|API|Updates|Auth|Login|Voice|Server|\d+)$/i, '')
    .trim();
  const baseLabel = strippedKey.length >= 2 ? strippedKey : String(targetId || '').trim();
  if (baseLabel) {
    const slug =
      baseLabel
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'custom';
    const pretty = baseLabel.charAt(0).toUpperCase() + baseLabel.slice(1);
    return {
      id: slug,
      label: pretty,
      shortLabel: pretty.length > 12 ? pretty.slice(0, 12) : pretty,
    };
  }

  try {
    if (rawValue && !rawValue.toUpperCase().startsWith('PING:')) {
      const host = new URL(rawValue).hostname.replace(/^www\./i, '');
      const domainPart = host.split('.')[0] || host;
      const pretty = domainPart.charAt(0).toUpperCase() + domainPart.slice(1);
      return { id: domainPart.toLowerCase(), label: pretty, shortLabel: pretty.slice(0, 12) };
    }
  } catch {
    // ignore
  }
  return { id: 'custom', label: 'Другие', shortLabel: 'Другие' };
}

export function classifyTargetCategory(targetId, rawValue = '', currentSection = null) {
  const low = String(targetId || '').toLowerCase();
  const valLow = String(rawValue || '').toLowerCase();

  if (low.includes('discord') || valLow.includes('discord.gg') || valLow.includes('discord.com') || valLow.includes('discordapp.')) {
    return STANDARD_CATEGORIES.discord;
  }
  if (
    low.includes('youtube') ||
    low.startsWith('yt') ||
    valLow.includes('youtube.com') ||
    valLow.includes('youtu.be') ||
    valLow.includes('ytimg.com') ||
    valLow.includes('googlevideo.com')
  ) {
    return STANDARD_CATEGORIES.youtube;
  }
  if ((low.includes('google') || valLow.includes('google.com') || valLow.includes('gstatic.com')) && !low.includes('dns')) {
    return STANDARD_CATEGORIES.google;
  }
  if ((low.includes('cloudflare') || valLow.includes('cloudflare.com') || valLow.includes('cdnjs.cloudflare.com')) && !low.includes('dns')) {
    return STANDARD_CATEGORIES.cloudflare;
  }
  if (low.includes('github') || valLow.includes('github.com')) {
    return STANDARD_CATEGORIES.github;
  }
  if (low.includes('dns')) {
    return STANDARD_CATEGORIES.dns;
  }

  // If placed under an explicit custom "### SectionName", group all entries under that section
  if (currentSection && currentSection.isCustomSection) {
    return currentSection;
  }

  // Otherwise derive a dedicated service category from the entry itself (e.g. appended at bottom of targets.txt)
  return deriveCustomServiceFromTarget(targetId, rawValue);
}

export function parseTargetsFile(zapretDir) {
  const targetsPath = path.join(zapretDir, 'utils', 'targets.txt');
  const targets = [];
  if (!fs.existsSync(targetsPath)) return targets;

  let currentSection = null;
  for (const raw of fs.readFileSync(targetsPath, 'utf8').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    if (/^#{2,}\s*\S+/.test(s)) {
      currentSection = normalizeSectionHeader(s);
      continue;
    }
    if (s.startsWith('#')) continue;

    const m = s.match(/^([A-Za-z0-9_.-]+)\s*=\s*"?([^"]+)"?$/);
    if (m) {
      const id = m[1].trim();
      const value = m[2].trim();
      const isPingOnly = value.toUpperCase().startsWith('PING:');
      let pingHost = '';
      try {
        pingHost = isPingOnly ? value.slice(5).trim() : new URL(value).hostname;
      } catch {
        pingHost = value.replace(/^https?:\/\//i, '').split('/')[0].trim();
      }
      const catMeta = classifyTargetCategory(id, value, currentSection);
      targets.push({
        id,
        value,
        isPingOnly,
        pingHost,
        category: catMeta.id,
        categoryLabel: catMeta.label,
        categoryShortLabel: catMeta.shortLabel || catMeta.label,
      });
    }
  }
  return targets;
}

export function readTargetCategories(zapretDir) {
  const targets = parseTargetsFile(zapretDir);
  const map = new Map();
  for (const t of targets) {
    const existing = map.get(t.category);
    if (!existing) {
      map.set(t.category, {
        id: t.category,
        label: t.categoryLabel || t.category,
        shortLabel: t.categoryShortLabel || t.categoryLabel || t.category,
        count: 1,
        pingOnlyCount: t.isPingOnly ? 1 : 0,
      });
    } else {
      existing.count += 1;
      if (t.isPingOnly) existing.pingOnlyCount += 1;
    }
  }
  return Array.from(map.values()).map(({ pingOnlyCount, ...rest }) => ({
    ...rest,
    isPingOnlyGroup: pingOnlyCount === rest.count,
  }));
}

export function parseTestResultContent(fileName, content, zapretDir = null) {
  // Extract timestamp from test_results_YYYY-MM-DD_HH-MM-SS.txt
  const tsMatch = fileName.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  const timestamp = tsMatch ? `${tsMatch[1]}T${tsMatch[2]}:${tsMatch[3]}:${tsMatch[4]}` : null;

  const targetCatLookup = new Map();
  if (zapretDir) {
    for (const t of parseTargetsFile(zapretDir)) {
      targetCatLookup.set(t.id.toLowerCase(), t.category);
    }
  }

  const resolveCategory = (id) => {
    const fromFile = targetCatLookup.get(String(id || '').toLowerCase());
    if (fromFile) return fromFile;
    return classifyTargetCategory(id).id;
  };

  const mainSection = content.split(/===\s*ANALYTICS\s*===/i)[0];
  const strategies = [];
  let currentStrat = null;
  let currentType = 'standard';
  let currentTargets = [];

  const flushCurrent = () => {
    if (currentStrat && currentTargets.length > 0) {
      strategies.push(computeStrategyMetrics(currentStrat, currentType, currentTargets));
    }
    currentStrat = null;
    currentType = 'standard';
    currentTargets = [];
  };

  for (const rawLine of mainSection.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Match Config header including strategies with parentheses like "general (ALT11).bat"
    const mConfig = line.match(/^Config:\s+(.+?\.bat)(?:\s*\(Type:\s*([^)]+)\))?\s*$/i);
    if (mConfig) {
      flushCurrent();
      currentStrat = mConfig[1].trim();
      currentType = (mConfig[2] || 'standard').trim();
      continue;
    }

    if (!currentStrat) continue;

    // Match HTTP/TLS line: TargetId : HTTP:OK TLS1.2:OK TLS1.3:UNSUP | Ping: 31 ms
    const mHttp = line.match(/^(\S+)\s*:\s*HTTP:(\S+)\s+TLS1\.2:(\S+)\s+TLS1\.3:(\S+)\s*\|\s*Ping:\s*(.+)$/i);
    if (mHttp) {
      const [, id, http, tls12, tls13, pingRaw] = mHttp;
      const pingNum = parseInt(pingRaw, 10);
      currentTargets.push({
        id,
        category: resolveCategory(id),
        isPingOnly: false,
        http: http.toUpperCase(),
        tls12: tls12.toUpperCase(),
        tls13: tls13.toUpperCase(),
        pingMs: Number.isFinite(pingNum) ? pingNum : null,
      });
      continue;
    }

    // Match Ping-only line: CloudflareDNS1111 : | Ping: 32 ms
    const mPing = line.match(/^(\S+)\s*:\s*\|\s*Ping:\s*(.+)$/i);
    if (mPing) {
      const [, id, pingRaw] = mPing;
      const pingNum = parseInt(pingRaw, 10);
      currentTargets.push({
        id,
        category: resolveCategory(id),
        isPingOnly: true,
        http: 'NA',
        tls12: 'NA',
        tls13: 'NA',
        pingMs: Number.isFinite(pingNum) ? pingNum : null,
      });
    }
  }
  flushCurrent();

  return {
    fileName,
    timestamp,
    strategies,
  };
}

export function computeStrategyMetrics(strategyFile, testType, targets) {
  let passedChecks = 0;
  let totalChecks = 0;
  const pings = [];
  const categoryMap = {};

  for (const t of targets) {
    if (!categoryMap[t.category]) {
      categoryMap[t.category] = { ok: 0, total: 0, pingOk: 0, pingTotal: 0, pings: [] };
    }
    const cat = categoryMap[t.category];

    if (t.pingMs !== null && t.pingMs > 0) {
      pings.push(t.pingMs);
      cat.pings.push(t.pingMs);
    }

    if (t.isPingOnly) {
      cat.pingTotal++;
      if (t.pingMs !== null && t.pingMs > 0) {
        cat.pingOk++;
      }
    } else {
      // Evaluate HTTP and TLS1.2; include TLS1.3 only if OS curl supports TLS1.3 (not global UNSUP)
      const checks = [t.http, t.tls12];
      if (t.tls13 === 'OK' || t.tls13 === 'ERROR') {
        checks.push(t.tls13);
      }
      for (const c of checks) {
        totalChecks++;
        cat.total++;
        if (c === 'OK') {
          passedChecks++;
          cat.ok++;
        }
      }
    }
  }

  const categoryScores = {};
  for (const [catName, data] of Object.entries(categoryMap)) {
    const effOk = data.total > 0 ? data.ok : data.pingOk;
    const effTotal = data.total > 0 ? data.total : data.pingTotal;
    const pct = effTotal > 0 ? Math.round((effOk / effTotal) * 100) : 100;
    const avgPing = data.pings.length > 0 ? Math.round(data.pings.reduce((a, b) => a + b, 0) / data.pings.length) : null;
    categoryScores[catName] = {
      ok: effOk,
      total: effTotal,
      pct,
      avgPingMs: avgPing,
    };
  }

  const overallScore = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;
  const avgPingMs = pings.length > 0 ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : null;

  return {
    fileName: strategyFile,
    displayName: formatStrategyShortName(strategyFile),
    testType,
    overallScore,
    passedChecks,
    totalChecks,
    avgPingMs,
    categoryScores,
    targets,
  };
}

export function readTestHistory(zapretDir) {
  const resultsDir = path.join(zapretDir, 'utils', 'test results');
  if (!fs.existsSync(resultsDir)) {
    return { history: [], latestRun: null };
  }
  const files = fs.readdirSync(resultsDir)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .sort()
    .reverse();

  const history = files.map((fileName) => {
    const full = path.join(resultsDir, fileName);
    const stat = fs.statSync(full);
    const tsMatch = fileName.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    const label = tsMatch ? `${tsMatch[1]} ${tsMatch[2]}:${tsMatch[3]}:${tsMatch[4]}` : fileName;
    return {
      fileName,
      label,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  });

  let latestRun = null;
  for (const item of history) {
    try {
      const content = fs.readFileSync(path.join(resultsDir, item.fileName), 'utf8');
      const parsed = parseTestResultContent(item.fileName, content, zapretDir);
      if (parsed.strategies.length > 0) {
        latestRun = parsed;
        break;
      }
    } catch {
      // skip unreadable log
    }
  }

  return { history, latestRun };
}

export function readListsMeta(zapretDir) {
  ensureUserListsExist(zapretDir);
  return LIST_DEFINITIONS.map((def) => {
    const fullPath = path.join(zapretDir, def.relPath);
    const backupPath = path.join(BACKUPS_DIR, path.basename(def.relPath));
    const exists = fs.existsSync(fullPath);
    return {
      ...def,
      exists,
      entriesCount: exists ? countNonEmptyLines(fullPath) : 0,
      sizeBytes: exists ? fs.statSync(fullPath).size : 0,
      hasBackup: fs.existsSync(backupPath),
    };
  });
}

export function readListContent(zapretDir, listId) {
  const def = LIST_DEFINITIONS.find((d) => d.id === listId);
  if (!def) throw new Error('Список не найден');
  const fullPath = path.join(zapretDir, def.relPath);
  const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n') : '';
  return { ...def, content };
}

export function saveListContent(zapretDir, listId, rawContent, { autoClean = false } = {}) {
  const def = LIST_DEFINITIONS.find((d) => d.id === listId);
  if (!def) throw new Error('Список не найден');

  let finalContent = rawContent;
  if (autoClean && def.kind === 'domains') {
    const seen = new Set();
    const cleaned = [];
    for (const rawLine of rawContent.split(/\r?\n/)) {
      let s = rawLine.trim();
      if (!s) continue;
      if (s.startsWith('#')) {
        cleaned.push(s);
        continue;
      }
      s = s.replace(/^https?:\/\//i, '').split('/')[0].trim();
      if (s.startsWith('*.')) s = s.slice(2);
      // Split accidental space-separated domains
      for (const token of s.split(/\s+/)) {
        const t = token.replace(/^\*\./, '').trim();
        if (!t) continue;
        const low = t.toLowerCase();
        if (!seen.has(low)) {
          seen.add(low);
          cleaned.push(low);
        }
      }
    }
    finalContent = cleaned.join('\n');
  }

  const fullPath = path.join(zapretDir, def.relPath);
  writeCrlfFile(fullPath, finalContent);

  // Automatically keep a safe backup of user lists outside zapret/
  if (def.isUser) {
    ensureDirs();
    writeCrlfFile(path.join(BACKUPS_DIR, path.basename(def.relPath)), finalContent);
  }

  return readListContent(zapretDir, listId);
}

export function extractCleanDomainFromInput(rawToken) {
  let s = String(rawToken || '').trim();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^[.,;'"`([{<]+|[.,;'"`)\]}>]+$/g, '').trim();
  if (!s) return null;
  if (s.startsWith('*.')) s = s.slice(2);

  let host = '';
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withProto);
    host = u.hostname || '';
  } catch {
    host = s.replace(/^[a-z]+:\/\//i, '').split(/[/?#:]/)[0].trim();
  }

  host = host.toLowerCase().replace(/^\.+|\.+$/g, '').replace(/^\*\./, '');
  if (host.startsWith('www.')) {
    const rest = host.slice(4);
    if (rest.includes('.')) host = rest;
  }

  if (!host || host.length > 253 || host.includes('..')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

function extractCleanIpOrCidrFromInput(rawToken) {
  let s = String(rawToken || '').trim();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^[.,;'"`([{<]+|[.,;'"`)\]}>]+$/g, '').trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      s = new URL(s).hostname;
    }
  } catch {
    // keep raw
  }
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => n < 0 || n > 255)) return null;
  if (m[5] !== undefined) {
    const prefix = Number(m[5]);
    if (prefix < 0 || prefix > 32) return null;
    return `${octets.join('.')}/${prefix}`;
  }
  return octets.join('.');
}

function readDomainSetFromFile(filePath) {
  const set = new Set();
  if (!fs.existsSync(filePath)) return set;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const s = raw.trim().toLowerCase();
    if (s && !s.startsWith('#')) set.add(s);
  }
  return set;
}

function findCoveringParentDomain(domain, domainSet) {
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (domainSet.has(parent)) return parent;
  }
  return null;
}

export function smartAddEntriesToList(zapretDir, listId, rawInput) {
  const def = LIST_DEFINITIONS.find((d) => d.id === listId);
  if (!def) throw new Error('Список не найден');
  if (def.kind === 'targets') {
    throw new Error('Для файла целей используйте текстовый режим');
  }

  const tokens = String(rawInput || '')
    .split(/[\r\n\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error('Введите ссылку, домен или IP-адрес');
  }

  const currentDoc = readListContent(zapretDir, listId);
  const existingLines = currentDoc.content.split(/\r?\n/);
  const currentSet = new Set(
    existingLines.map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'))
  );

  const companionFiles =
    listId === 'list-general-user'
      ? [
          { label: 'list-general', path: path.join(zapretDir, 'lists', 'list-general.txt') },
          { label: 'list-google', path: path.join(zapretDir, 'lists', 'list-google.txt') },
        ]
      : listId === 'list-exclude-user'
        ? [{ label: 'list-exclude', path: path.join(zapretDir, 'lists', 'list-exclude.txt') }]
        : listId === 'ipset-exclude-user'
          ? [{ label: 'ipset-exclude', path: path.join(zapretDir, 'lists', 'ipset-exclude.txt') }]
          : [];

  const companionSets = companionFiles.map((cf) => ({
    label: cf.label,
    set: readDomainSetFromFile(cf.path),
  }));

  const added = [];
  const skippedDuplicates = [];
  const coveredByBase = [];
  const invalid = [];

  for (const tok of tokens) {
    if (def.kind === 'domains') {
      const domain = extractCleanDomainFromInput(tok);
      if (!domain) {
        invalid.push(tok);
        continue;
      }
      if (currentSet.has(domain)) {
        skippedDuplicates.push(domain);
        continue;
      }
      const parentInSelf = findCoveringParentDomain(domain, currentSet);
      if (parentInSelf) {
        coveredByBase.push(`${domain} (покрыт ${parentInSelf})`);
        continue;
      }
      let coveredLabel = null;
      for (const comp of companionSets) {
        if (comp.set.has(domain)) {
          coveredLabel = `${domain} (${comp.label})`;
          break;
        }
        const parent = findCoveringParentDomain(domain, comp.set);
        if (parent) {
          coveredLabel = `${domain} (${parent} в ${comp.label})`;
          break;
        }
      }
      if (coveredLabel) {
        coveredByBase.push(coveredLabel);
        continue;
      }
      currentSet.add(domain);
      added.push(domain);
    } else if (def.kind === 'ipset') {
      const ip = extractCleanIpOrCidrFromInput(tok);
      if (!ip) {
        invalid.push(tok);
        continue;
      }
      if (currentSet.has(ip)) {
        skippedDuplicates.push(ip);
        continue;
      }
      const inBase = companionSets.find((c) => c.set.has(ip));
      if (inBase) {
        coveredByBase.push(`${ip} (${inBase.label})`);
        continue;
      }
      currentSet.add(ip);
      added.push(ip);
    }
  }

  let updatedList = currentDoc;
  if (added.length > 0) {
    const baseText = currentDoc.content.trim();
    const combined = baseText ? `${baseText}\n${added.join('\n')}\n` : `${added.join('\n')}\n`;
    updatedList = saveListContent(zapretDir, listId, combined, { autoClean: false });
  }

  let message = '';
  if (added.length === 1 && coveredByBase.length === 0 && invalid.length === 0) {
    message = `Добавлено: ${added[0]}`;
  } else if (added.length > 1) {
    message = `Добавлено записей: ${added.length}`;
  } else if (coveredByBase.length > 0) {
    message = `Уже есть в базовом списке: ${coveredByBase[0]}`;
  } else if (skippedDuplicates.length > 0) {
    message = `Уже есть в этом списке: ${skippedDuplicates[0]}`;
  } else {
    throw new Error('Некорректный формат ссылки, домена или IP');
  }

  return {
    list: updatedList,
    added,
    skippedDuplicates,
    coveredByBase,
    invalid,
    message,
  };
}

export function cleanAllDomainLists(zapretDir) {
  let cleanedFiles = 0;
  for (const def of LIST_DEFINITIONS.filter((d) => d.kind === 'domains')) {
    const full = path.join(zapretDir, def.relPath);
    if (!fs.existsSync(full)) continue;
    const raw = fs.readFileSync(full, 'utf8');
    saveListContent(zapretDir, def.id, raw, { autoClean: true });
    cleanedFiles++;
  }
  return { cleanedFiles };
}

export function backupUserLists(zapretDir) {
  ensureDirs();
  const saved = [];
  for (const def of LIST_DEFINITIONS.filter((d) => d.isUser)) {
    const src = path.join(zapretDir, def.relPath);
    if (fs.existsSync(src)) {
      const dst = path.join(BACKUPS_DIR, path.basename(def.relPath));
      fs.copyFileSync(src, dst);
      saved.push(path.basename(def.relPath));
    }
  }
  return { saved, backupDir: BACKUPS_DIR, timestamp: new Date().toISOString() };
}

export function restoreUserLists(zapretDir) {
  ensureDirs();
  const restored = [];
  for (const def of LIST_DEFINITIONS.filter((d) => d.isUser)) {
    const src = path.join(BACKUPS_DIR, path.basename(def.relPath));
    if (fs.existsSync(src)) {
      const dst = path.join(zapretDir, def.relPath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      restored.push(path.basename(def.relPath));
    }
  }
  if (restored.length === 0) {
    throw new Error('Резервные копии пользовательских списков ещё не создавались');
  }
  return { restored, timestamp: new Date().toISOString() };
}

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

function httpsGetViaNode(url, extraHeaders = {}, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ca: SYSTEM_CA_BUNDLE,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZapretControl/1.3',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
        timeout: 12000,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const nextUrl = new URL(res.headers.location, url).toString();
          httpsGetViaNode(nextUrl, extraHeaders, maxRedirects - 1).then(resolve, reject);
          res.resume();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`HTTP ${res.statusCode} при обращении к ${new URL(url).hostname}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Превышено время ожидания ответа от GitHub'));
    });
    req.on('error', reject);
  });
}

function httpsGetBufferRaw(url, extraHeaders = {}, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ca: SYSTEM_CA_BUNDLE,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZapretControl/1.3',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
        timeout: 20000,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          httpsGetBufferRaw(nextUrl, extraHeaders, maxRedirects - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

function resolveRedirectLocation(url) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'HEAD',
        ca: SYSTEM_CA_BUNDLE,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZapretControl/1.3',
        },
        timeout: 8000,
      },
      (res) => {
        const loc = res.headers.location ? new URL(res.headers.location, url).toString() : null;
        res.resume();
        resolve(loc);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

export async function httpsGetJsonOrText(url, extraHeaders = {}) {
  try {
    return await httpsGetViaNode(url, extraHeaders);
  } catch (nodeErr) {
    // Fallback to OS curl (uses Windows Schannel / OS CA store natively)
    const curlBin = os.platform() === 'win32' ? 'curl.exe' : 'curl';
    const curlArgs = ['-fsSL', '-m', '12', '-H', 'User-Agent: Mozilla/5.0 ZapretControl/1.3'];
    for (const [k, v] of Object.entries(extraHeaders)) {
      curlArgs.push('-H', `${k}: ${v}`);
    }
    curlArgs.push(url);
    try {
      const { stdout } = await execFileAsync(curlBin, curlArgs, { maxBuffer: 12 * 1024 * 1024 });
      return stdout;
    } catch {
      throw nodeErr;
    }
  }
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function htmlReleaseContentToPlainText(rawHtml) {
  if (!rawHtml) return '';
  const decoded = decodeHtmlEntities(rawHtml);
  return decoded
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

function compareSemver(localVer, remoteVer) {
  const clean = (v) => String(v || '').replace(/^v/i, '').trim();
  const a = clean(localVer).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = clean(remoteVer).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return 1;
    if (bv < av) return -1;
  }
  return clean(localVer) !== clean(remoteVer) ? 1 : 0;
}

let inFlightZapretReleasePromise = null;
let cachedZapretReleaseMeta = { ts: 0, meta: null };

async function fetchLatestFlowsealReleaseMeta() {
  const now = Date.now();
  if (cachedZapretReleaseMeta.meta && now - cachedZapretReleaseMeta.ts < 15000) {
    return cachedZapretReleaseMeta.meta;
  }
  if (inFlightZapretReleasePromise) {
    return inFlightZapretReleasePromise;
  }

  inFlightZapretReleasePromise = (async () => {
    const [redirectLoc, atomXml] = await Promise.all([
      resolveRedirectLocation('https://github.com/Flowseal/zapret-discord-youtube/releases/latest'),
      httpsGetJsonOrText('https://github.com/Flowseal/zapret-discord-youtube/releases.atom', {
        Accept: 'application/atom+xml, text/xml, */*',
      }).catch(() => ''),
    ]);

    let targetTag = null;
    if (redirectLoc) {
      const m = redirectLoc.match(/\/releases\/tag\/([^/?#]+)/i);
      if (m) targetTag = decodeURIComponent(m[1]);
    }

    const entries = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
    let em;
    while ((em = entryRe.exec(atomXml)) !== null) {
      const block = em[1];
      const linkMatch = block.match(/\/releases\/tag\/([^"&<>?#]+)/i);
      const tag = linkMatch ? decodeURIComponent(linkMatch[1]) : null;
      const updated = (block.match(/<updated>([^<]+)<\/updated>/i) || [])[1] || null;
      const titleRaw = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const contentRaw = (block.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] || '';
      if (tag) {
        entries.push({
          tag,
          publishedAt: updated ? updated.trim() : null,
          releaseName: decodeHtmlEntities(titleRaw).trim() || `Zapret ${tag}`,
          releaseNotes: htmlReleaseContentToPlainText(contentRaw),
        });
      }
    }

    const matchedEntry =
      (targetTag && entries.find((e) => e.tag === targetTag)) || entries[0] || null;
    const finalTag = targetTag || (matchedEntry ? matchedEntry.tag : null);
    if (!finalTag) {
      throw new Error('Не удалось определить последнюю версию Zapret на GitHub');
    }

    const cleanVersion = finalTag.replace(/^v/i, '').trim();
    let downloadUrl = `https://github.com/Flowseal/zapret-discord-youtube/releases/download/${encodeURIComponent(finalTag)}/zapret-discord-youtube-${cleanVersion}.zip`;
    let assetName = `zapret-discord-youtube-${cleanVersion}.zip`;

    try {
      const assetsHtml = await httpsGetJsonOrText(
        `https://github.com/Flowseal/zapret-discord-youtube/releases/expanded_assets/${encodeURIComponent(finalTag)}`
      );
      const hrefs = [];
      const hrefRe = /href="([^"]+\.zip)"/gi;
      let hm;
      while ((hm = hrefRe.exec(assetsHtml)) !== null) {
        hrefs.push(hm[1]);
      }
      const releaseZipHref =
        hrefs.find((h) => h.includes('/releases/download/') && h.toLowerCase().endsWith('.zip')) ||
        hrefs.find((h) => h.toLowerCase().endsWith('.zip'));
      if (releaseZipHref) {
        downloadUrl = new URL(releaseZipHref, 'https://github.com').toString();
        assetName = decodeURIComponent(downloadUrl.split('/').pop() || assetName);
      }
    } catch {
      // fallback to standard Flowseal zip naming above
    }

    const meta = {
      tag: finalTag,
      latestVersion: cleanVersion,
      publishedAt: matchedEntry ? matchedEntry.publishedAt : null,
      releaseName: matchedEntry ? matchedEntry.releaseName : `Zapret ${cleanVersion}`,
      releaseNotes: matchedEntry ? matchedEntry.releaseNotes : '',
      htmlUrl: 'https://github.com/Flowseal/zapret-discord-youtube/releases',
      downloadUrl,
      assetName,
    };

    cachedZapretReleaseMeta = { ts: Date.now(), meta };
    return meta;
  })().finally(() => {
    inFlightZapretReleasePromise = null;
  });

  return inFlightZapretReleasePromise;
}

export async function checkZapretUpdates(zapretDir) {
  const info = readZapretInfo(zapretDir);
  const meta = await fetchLatestFlowsealReleaseMeta();
  const cmp = compareSemver(info.localVersion, meta.latestVersion);

  return {
    localVersion: info.localVersion,
    latestVersion: meta.latestVersion || info.localVersion,
    updateAvailable: cmp > 0,
    publishedAt: meta.publishedAt,
    releaseName: meta.releaseName,
    releaseNotes: meta.releaseNotes,
    htmlUrl: 'https://github.com/Flowseal/zapret-discord-youtube/releases',
    downloadUrl: meta.downloadUrl,
    assetName: meta.assetName,
    checkedAt: new Date().toISOString(),
  };
}

async function fetchSingleFileFromCodeloadRepoZip(repoSlug, branch, targetRelPath) {
  const zipBuf = await httpsGetBufferRaw(
    `https://codeload.github.com/${repoSlug}/zip/refs/heads/${branch}`
  );
  let eocdPos = -1;
  const minPos = Math.max(0, zipBuf.length - 65558);
  for (let i = zipBuf.length - 22; i >= minPos; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) throw new Error('Invalid archive');
  const cdSize = zipBuf.readUInt32LE(eocdPos + 12);
  const cdOffset = zipBuf.readUInt32LE(eocdPos + 16);
  const cdEnd = cdOffset + cdSize;
  const suffix = `/${targetRelPath.replace(/^\/+/, '')}`;

  let pos = cdOffset;
  while (pos < cdEnd && pos + 46 <= zipBuf.length) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    const rawName = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith(suffix)) {
      const lhNameLen = zipBuf.readUInt16LE(localOffset + 26);
      const lhExtraLen = zipBuf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const compSlice = zipBuf.subarray(dataStart, dataStart + compSize);
      const out = method === 0 ? compSlice : zlib.inflateRawSync(compSlice);
      return out.toString('utf8');
    }
  }
  throw new Error(`Файл ${targetRelPath} не найден в архиве репозитория`);
}

async function fetchFlowsealRepoFileText(relPath) {
  // Primary: codeload zip stream on codeload.github.com (no api.github.com 60/hr rate limit)
  try {
    return await fetchSingleFileFromCodeloadRepoZip(
      'Flowseal/zapret-discord-youtube',
      'main',
      relPath
    );
  } catch {
    // Fallback to raw github url
    return await httpsGetJsonOrText(
      `https://github.com/Flowseal/zapret-discord-youtube/raw/main/${relPath}`
    );
  }
}

export async function updateRemoteIpsetList(zapretDir) {
  const raw = await fetchFlowsealRepoFileText('.service/ipset-service.txt');
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 10) {
    throw new Error('Получен некорректный ответ при загрузке ipset-service.txt');
  }
  const listFile = path.join(zapretDir, 'lists', 'ipset-all.txt');
  const backupFile = path.join(zapretDir, 'lists', 'ipset-all.txt.backup');
  const current = readIpsetFilter(zapretDir);

  writeCrlfFile(backupFile, lines.join('\n'));
  if (current.mode === 'loaded') {
    writeCrlfFile(listFile, lines.join('\n'));
  }

  return {
    updatedEntries: lines.length,
    ipsetFilter: readIpsetFilter(zapretDir),
  };
}

export async function checkRemoteHostsDiff() {
  const remoteHosts = await fetchFlowsealRepoFileText('.service/hosts');
  const remoteLines = remoteHosts
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

  let systemHostsPath = '/etc/hosts';
  if (os.platform() === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    systemHostsPath = path.join(sysRoot, 'System32', 'drivers', 'etc', 'hosts');
  }

  const localContent = fs.existsSync(systemHostsPath) ? fs.readFileSync(systemHostsPath, 'utf8') : '';
  const missingLines = remoteLines.filter((line) => !localContent.includes(line));

  return {
    systemHostsPath,
    upToDate: missingLines.length === 0,
    totalRemoteEntries: remoteLines.length,
    missingCount: missingLines.length,
    missingLines,
    remoteRaw: remoteHosts.trim(),
  };
}

export async function runDiagnostics(zapretDir) {
  const isWin = os.platform() === 'win32';
  const checks = [];

  const hasCyrillic = /[\u0400-\u04FF]/.test(zapretDir);
  checks.push({
    id: 'path-cyrillic',
    title: 'Путь без кириллицы',
    status: hasCyrillic ? 'warn' : 'ok',
    detail: hasCyrillic ? `В пути есть кириллица (${zapretDir}). Лучше перенести в C:\\Zapret.` : zapretDir,
    fixAction: null,
  });

  const inOneDrive = Boolean(process.env.OneDrive && zapretDir.toLowerCase().includes(process.env.OneDrive.toLowerCase()));
  checks.push({
    id: 'onedrive',
    title: 'Вне папки OneDrive',
    status: inOneDrive ? 'error' : 'ok',
    detail: inOneDrive ? 'Папка в OneDrive может блокировать драйвер WinDivert' : 'Синхронизация OneDrive не мешает',
    fixAction: null,
  });

  const binDir = path.join(zapretDir, 'bin');
  const hasWinws = fs.existsSync(path.join(binDir, 'winws.exe'));
  const hasWinDivert = fs.existsSync(path.join(binDir, 'WinDivert64.sys')) || fs.existsSync(path.join(binDir, 'WinDivert.dll'));
  checks.push({
    id: 'binaries',
    title: 'Файлы winws.exe и WinDivert',
    status: hasWinws && hasWinDivert ? 'ok' : 'error',
    detail: hasWinws && hasWinDivert ? 'Исполняемые файлы на месте' : 'Не найдены файлы в zapret/bin/',
    fixAction: null,
  });

  // Validate all user/general domain lists for broken wildcards or spaces
  let listIssues = 0;
  for (const fn of ['list-general.txt', 'list-general-user.txt', 'list-exclude.txt', 'list-exclude-user.txt']) {
    const p = path.join(zapretDir, 'lists', fn);
    if (fs.existsSync(p)) {
      for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const s = raw.trim();
        if (!s || s.startsWith('#')) continue;
        if (s.includes(' ') || s.includes('*') || /^https?:\/\//i.test(s)) listIssues++;
      }
    }
  }
  checks.push({
    id: 'hostlists',
    title: 'Синтаксис списков доменов',
    status: listIssues === 0 ? 'ok' : 'warn',
    detail: listIssues === 0 ? 'Ошибок нет' : `Найдено строк с лишними символами: ${listIssues}`,
    fixAction: listIssues > 0 ? 'clean-lists' : null,
  });

  if (isWin) {
    try {
      const { stdout: bfeOut } = await execFileAsync('sc.exe', ['query', 'BFE']);
      const bfeOk = /RUNNING/i.test(bfeOut);
      checks.push({
        id: 'bfe',
        title: 'Служба фильтрации Windows (BFE)',
        status: bfeOk ? 'ok' : 'error',
        detail: bfeOk ? 'Запущена' : 'Остановлена (нужна для работы WinDivert)',
        fixAction: null,
      });
    } catch {
      checks.push({ id: 'bfe', title: 'Служба фильтрации (BFE)', status: 'warn', detail: 'Нет данных от sc.exe', fixAction: null });
    }

    try {
      const { stdout: tsOut } = await execFileAsync('netsh', ['interface', 'tcp', 'show', 'global']);
      const tsOk = /timestamps.*enabled/i.test(tsOut);
      checks.push({
        id: 'timestamps',
        title: 'TCP Timestamps в Windows',
        status: tsOk ? 'ok' : 'warn',
        detail: tsOk ? 'Включены' : 'Отключены (нужны для части стратегий)',
        fixAction: tsOk ? null : 'enable-timestamps',
      });
    } catch {
      checks.push({ id: 'timestamps', title: 'TCP Timestamps', status: 'ok', detail: 'Включаются при старте обхода', fixAction: null });
    }

    try {
      const { stdout: scOut } = await execFileAsync('sc.exe', ['query']);
      const conflicts = ['zapret', 'GoodbyeDPI', 'discordfix_zapret', 'winws1', 'winws2', 'Killer', 'SmartByte', 'TracSrvWrapper'].filter(
        (c) => new RegExp(`SERVICE_NAME:\\s*${c}\\b`, 'i').test(scOut)
      );
      checks.push({
        id: 'conflicts',
        title: 'Конфликтующие фоновые службы',
        status: conflicts.length === 0 ? 'ok' : 'warn',
        detail:
          conflicts.length === 0
            ? 'Чужих служб zapret и GoodbyeDPI не найдено'
            : `Активны фоновые службы: ${conflicts.join(', ')}`,
        fixAction: conflicts.length > 0 ? 'fix-windivert' : null,
      });
    } catch {
      // ignore
    }

    try {
      const { stdout: regOut } = await execFileAsync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ]);
      const proxyOn = /0x1\b/i.test(regOut);
      let proxyServer = '';
      if (proxyOn) {
        try {
          const { stdout: srvOut } = await execFileAsync('reg', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v',
            'ProxyServer',
          ]);
          const m = srvOut.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
          if (m) proxyServer = m[1].trim();
        } catch {
          // ignore
        }
      }
      checks.push({
        id: 'system-proxy',
        title: 'Системный прокси Windows',
        status: proxyOn ? 'warn' : 'ok',
        detail: proxyOn
          ? `Включён системный прокси${proxyServer ? ` (${proxyServer})` : ''} - трафик может идти мимо winws`
          : 'Выключен, трафик идёт напрямую',
        fixAction: null,
      });
    } catch {
      // ignore
    }
  } else {
    checks.push({
      id: 'env-preview',
      title: 'Сетевые службы и стек ОС',
      status: 'ok',
      detail: 'На Windows дополнительно проверяются BFE, службы GoodbyeDPI и системный прокси',
      fixAction: null,
    });
  }

  return { checks, checkedAt: new Date().toISOString() };
}

// ============================================================================
// Profiles Management (Default undeletable profile + custom goal profiles)
// ============================================================================

function buildSnapshotFromZapret(zapretDir, strategyFallback) {
  const gf = readGameFilter(zapretDir);
  const ipset = readIpsetFilter(zapretDir);
  const fakes = readActiveFakes(zapretDir);
  return {
    strategy: strategyFallback || 'general (ALT11).bat',
    gameFilterMode: gf.mode,
    gameFilterTcp: gf.tcpRange,
    gameFilterUdp: gf.udpRange,
    ipsetMode: ipset.mode,
    discordFakeBin: fakes.discordCurrent || null,
    gameFakeBin: fakes.gameCurrent || null,
  };
}

function writeProfilesRaw(profiles) {
  ensureDirs();
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf8');
}

export function readProfiles(zapretDir) {
  ensureDirs();
  const settings = loadSettings();
  let profiles = [];
  if (fs.existsSync(PROFILES_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
      if (Array.isArray(parsed)) {
        profiles = parsed;
      }
    } catch {
      profiles = [];
    }
  }

  let defaultProf = profiles.find((p) => p && p.id === 'default');
  if (!defaultProf) {
    const snap = buildSnapshotFromZapret(zapretDir, settings.selectedStrategy);
    defaultProf = {
      id: 'default',
      name: 'Основной',
      description: '',
      isDefault: true,
      ...snap,
    };
    profiles = [defaultProf, ...profiles.filter((p) => p && p.id !== 'default')];
    writeProfilesRaw(profiles);
  } else {
    defaultProf.isDefault = true;
    if (!defaultProf.name) defaultProf.name = 'Основной';
    if (defaultProf.description === 'Профиль по умолчанию') {
      defaultProf.description = '';
      writeProfilesRaw(profiles);
    }
  }

  // Ensure Default profile is always first
  const ordered = [
    defaultProf,
    ...profiles.filter((p) => p && p.id !== 'default').map((p) => ({ ...p, isDefault: false })),
  ];

  const activeExists = ordered.some((p) => p.id === settings.activeProfileId);
  const activeProfileId = activeExists ? settings.activeProfileId : 'default';
  if (!activeExists) {
    saveSettings({ activeProfileId: 'default' });
  }

  return { profiles: ordered, activeProfileId };
}

export function syncCurrentStateToActiveProfile(zapretDir) {
  const settings = loadSettings();
  const { profiles, activeProfileId } = readProfiles(zapretDir);
  const snap = buildSnapshotFromZapret(zapretDir, settings.selectedStrategy);
  const next = profiles.map((p) =>
    p.id === activeProfileId
      ? {
          ...p,
          ...snap,
        }
      : p
  );
  writeProfilesRaw(next);
  return { profiles: next, activeProfileId };
}

function applyProfileToZapretFiles(zapretDir, profile) {
  const strategies = readStrategies(zapretDir);
  const stratExists = strategies.some((s) => s.fileName === profile.strategy);
  const targetStrategy = stratExists
    ? profile.strategy
    : strategies[0]?.fileName || profile.strategy;

  saveSettings({
    activeProfileId: profile.id,
    selectedStrategy: targetStrategy,
  });

  writeGameFilter(zapretDir, {
    mode: profile.gameFilterMode || 'disabled',
    tcpRange: profile.gameFilterTcp || '1024-65535',
    udpRange: profile.gameFilterUdp || '1024-65535',
  });

  try {
    switchIpsetFilter(zapretDir, profile.ipsetMode || 'none');
  } catch {
    // If 'loaded' was requested without backup file, fallback safely to 'none'
    if (profile.ipsetMode === 'loaded') {
      switchIpsetFilter(zapretDir, 'none');
    }
  }

  const binDir = path.join(zapretDir, 'bin');
  if (profile.discordFakeBin && fs.existsSync(path.join(binDir, profile.discordFakeBin))) {
    try {
      replaceActiveFake(zapretDir, 'discord', profile.discordFakeBin);
    } catch {
      // ignore
    }
  }
  if (profile.gameFakeBin && fs.existsSync(path.join(binDir, profile.gameFakeBin))) {
    try {
      replaceActiveFake(zapretDir, 'game', profile.gameFakeBin);
    } catch {
      // ignore
    }
  }
}

export function activateProfile(zapretDir, profileId) {
  const { profiles } = readProfiles(zapretDir);
  const target = profiles.find((p) => p.id === profileId);
  if (!target) {
    throw new Error('Профиль не найден');
  }
  applyProfileToZapretFiles(zapretDir, target);
  return readProfiles(zapretDir);
}

export function createProfile(zapretDir, payload = {}) {
  const { profiles } = readProfiles(zapretDir);
  const name = String(payload.name || '').trim();
  if (!name) {
    throw new Error('Введите название профиля');
  }
  const settings = loadSettings();
  const snap = buildSnapshotFromZapret(zapretDir, settings.selectedStrategy);

  const tcpValidated = payload.gameFilterTcp ? validatePortRange(payload.gameFilterTcp) : snap.gameFilterTcp;
  const udpValidated = payload.gameFilterUdp ? validatePortRange(payload.gameFilterUdp) : snap.gameFilterUdp;
  if (!tcpValidated || !udpValidated) {
    throw new Error('Некорректный диапазон портов в настройках профиля');
  }

  const newProf = {
    id: `prof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.slice(0, 28),
    description: String(payload.description || '').trim().slice(0, 90),
    isDefault: false,
    strategy: payload.strategy || snap.strategy,
    gameFilterMode: ['disabled', 'all', 'tcp', 'udp'].includes(payload.gameFilterMode)
      ? payload.gameFilterMode
      : snap.gameFilterMode,
    gameFilterTcp: tcpValidated,
    gameFilterUdp: udpValidated,
    ipsetMode: ['none', 'loaded', 'any'].includes(payload.ipsetMode)
      ? payload.ipsetMode
      : snap.ipsetMode,
    discordFakeBin: payload.discordFakeBin !== undefined ? payload.discordFakeBin : snap.discordFakeBin,
    gameFakeBin: payload.gameFakeBin !== undefined ? payload.gameFakeBin : snap.gameFakeBin,
  };

  const next = [...profiles, newProf];
  writeProfilesRaw(next);

  if (payload.activateNow) {
    applyProfileToZapretFiles(zapretDir, newProf);
  }
  return readProfiles(zapretDir);
}

export function updateProfile(zapretDir, profileId, patch = {}) {
  const { profiles, activeProfileId } = readProfiles(zapretDir);
  const idx = profiles.findIndex((p) => p.id === profileId);
  if (idx === -1) {
    throw new Error('Профиль не найден');
  }
  const existing = profiles[idx];

  const nextName = patch.name !== undefined ? String(patch.name).trim() : existing.name;
  if (!nextName) {
    throw new Error('Название профиля не может быть пустым');
  }

  const nextTcp = patch.gameFilterTcp !== undefined ? validatePortRange(patch.gameFilterTcp) : existing.gameFilterTcp;
  const nextUdp = patch.gameFilterUdp !== undefined ? validatePortRange(patch.gameFilterUdp) : existing.gameFilterUdp;
  if (!nextTcp || !nextUdp) {
    throw new Error('Некорректный диапазон портов TCP/UDP');
  }

  const updated = {
    ...existing,
    name: nextName.slice(0, 28),
    description:
      patch.description !== undefined ? String(patch.description).trim().slice(0, 90) : existing.description,
    isDefault: existing.id === 'default',
    strategy: patch.strategy !== undefined ? patch.strategy : existing.strategy,
    gameFilterMode:
      patch.gameFilterMode !== undefined && ['disabled', 'all', 'tcp', 'udp'].includes(patch.gameFilterMode)
        ? patch.gameFilterMode
        : existing.gameFilterMode,
    gameFilterTcp: nextTcp,
    gameFilterUdp: nextUdp,
    ipsetMode:
      patch.ipsetMode !== undefined && ['none', 'loaded', 'any'].includes(patch.ipsetMode)
        ? patch.ipsetMode
        : existing.ipsetMode,
    discordFakeBin: patch.discordFakeBin !== undefined ? patch.discordFakeBin : existing.discordFakeBin,
    gameFakeBin: patch.gameFakeBin !== undefined ? patch.gameFakeBin : existing.gameFakeBin,
  };

  const nextList = [...profiles];
  nextList[idx] = updated;
  writeProfilesRaw(nextList);

  if (activeProfileId === profileId) {
    applyProfileToZapretFiles(zapretDir, updated);
  }
  return readProfiles(zapretDir);
}

export function deleteProfile(zapretDir, profileId) {
  if (profileId === 'default') {
    throw new Error('Основной профиль по умолчанию нельзя удалить');
  }
  const { profiles, activeProfileId } = readProfiles(zapretDir);
  const next = profiles.filter((p) => p.id !== profileId);
  if (next.length === profiles.length) {
    throw new Error('Профиль не найден');
  }
  writeProfilesRaw(next);
  if (activeProfileId === profileId) {
    const def = next.find((p) => p.id === 'default') || next[0];
    applyProfileToZapretFiles(zapretDir, def);
  }
  return readProfiles(zapretDir);
}

// Fingerprint of zapret/ directory tree so new/modified .bat, lists, .bin, or test logs trigger live reload
export function computeZapretDirectoryFingerprint(zapretDir) {
  if (!fs.existsSync(zapretDir)) return 'missing';
  const subDirs = [
    zapretDir,
    path.join(zapretDir, 'lists'),
    path.join(zapretDir, 'bin'),
    path.join(zapretDir, 'utils'),
    path.join(zapretDir, 'utils', 'test results'),
  ];
  const parts = [];
  for (const dir of subDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir).sort();
      for (const name of entries) {
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) {
            parts.push(`${dir}/${name}:${st.size}:${Math.floor(st.mtimeMs)}`);
          }
        } catch {
          // ignore transient file
        }
      }
    } catch {
      // ignore
    }
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

// ============================================================================
// Site Availability & List Coverage Diagnostics (#5)
// ============================================================================

function checkDomainAgainstSet(domain, domainSet) {
  if (domainSet.has(domain)) return domain;
  const parent = findCoveringParentDomain(domain, domainSet);
  return parent || null;
}

function isBogonOrStubIp(ip) {
  return (
    ip === '0.0.0.0' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip.startsWith('198.18.') ||
    ip.startsWith('198.51.100.') ||
    ip.startsWith('203.0.113.')
  );
}

function measureTcp443(host, timeoutMs = 2600) {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.createConnection({ host, port: 443 });
    let finished = false;
    const done = (val) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve(val);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(Math.max(1, Math.round(performance.now() - start))));
    sock.on('timeout', () => done(null));
    sock.on('error', () => done(null));
  });
}

function measureTlsHandshake(domain, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = tls.connect({
      host: domain,
      port: 443,
      servername: domain,
      ca: SYSTEM_CA_BUNDLE,
      rejectUnauthorized: false,
    });
    let finished = false;
    const done = (ok, protocol = null) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve({ ok, protocol });
    };
    sock.setTimeout(timeoutMs);
    sock.on('secureConnect', () => done(true, sock.getProtocol() || 'TLS'));
    sock.on('timeout', () => done(false, null));
    sock.on('error', () => done(false, null));
  });
}

async function queryDohIps(domain) {
  if (os.platform() !== 'win32') {
    return [];
  }
  try {
    const raw = await httpsGetJsonOrText(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { Accept: 'application/dns-json' }
    );
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.Answer)) return [];
    return parsed.Answer.filter((a) => a && a.type === 1 && typeof a.data === 'string').map((a) => a.data.trim());
  } catch {
    return [];
  }
}

export async function diagnoseSite(zapretDir, rawInput) {
  const domain = extractCleanDomainFromInput(rawInput);
  if (!domain) {
    throw new Error('Введите корректную ссылку или домен (например, example.com)');
  }

  const listsDir = path.join(zapretDir, 'lists');
  const userGenSet = readDomainSetFromFile(path.join(listsDir, 'list-general-user.txt'));
  const baseGenSet = readDomainSetFromFile(path.join(listsDir, 'list-general.txt'));
  const googleSet = readDomainSetFromFile(path.join(listsDir, 'list-google.txt'));
  const userExclSet = readDomainSetFromFile(path.join(listsDir, 'list-exclude-user.txt'));
  const baseExclSet = readDomainSetFromFile(path.join(listsDir, 'list-exclude.txt'));

  const matchedUserExcl = checkDomainAgainstSet(domain, userExclSet);
  const matchedBaseExcl = checkDomainAgainstSet(domain, baseExclSet);
  const matchedUserGen = checkDomainAgainstSet(domain, userGenSet);
  const matchedBaseGen = checkDomainAgainstSet(domain, baseGenSet);
  const matchedGoogle = checkDomainAgainstSet(domain, googleSet);

  const inExcludeList = Boolean(matchedUserExcl || matchedBaseExcl);
  const inBypassList = !inExcludeList && Boolean(matchedUserGen || matchedBaseGen || matchedGoogle);

  let listLabel = 'Не в списках';
  let listMatchedRule = null;
  if (matchedUserExcl) {
    listLabel = 'В моих исключениях';
    listMatchedRule = matchedUserExcl;
  } else if (matchedBaseExcl) {
    listLabel = 'В базовых исключениях';
    listMatchedRule = matchedBaseExcl;
  } else if (matchedUserGen) {
    listLabel = 'В моих сайтах обхода';
    listMatchedRule = matchedUserGen;
  } else if (matchedGoogle) {
    listLabel = 'В списке YouTube/Google';
    listMatchedRule = matchedGoogle;
  } else if (matchedBaseGen) {
    listLabel = 'В основном списке обхода';
    listMatchedRule = matchedBaseGen;
  }

  // Step 1: DNS resolution
  let systemIps = [];
  try {
    const res = await dns.promises.lookup(domain, { all: true, family: 4 });
    systemIps = Array.from(new Set(res.map((r) => r.address)));
  } catch {
    systemIps = [];
  }
  const dohIps = await queryDohIps(domain);
  const hasStubIp = systemIps.some(isBogonOrStubIp);
  const dnsOk = systemIps.length > 0 && !hasStubIp;

  // Step 2 & 3: TCP 443 + TLS handshake
  let tcpPingMs = null;
  let tlsOk = false;
  let httpOk = false;

  if (dnsOk) {
    if (os.platform() === 'win32') {
      const [pingVal, curlRes] = await Promise.all([
        measureTcp443(domain, 2500),
        execFileAsync('curl.exe', ['-I', '-s', '-m', '3', '--connect-timeout', '2', '-o', 'NUL', `https://${domain}`])
          .then(() => true)
          .catch(() => false),
      ]);
      tcpPingMs = pingVal;
      tlsOk = curlRes;
      httpOk = curlRes;
    } else {
      const [pingVal, tlsRes] = await Promise.all([
        measureTcp443(domain, 2500),
        measureTlsHandshake(domain, 2800),
      ]);
      tcpPingMs = pingVal;
      tlsOk = tlsRes.ok;
      httpOk = tlsRes.ok;
    }
  }

  let verdictStatus = 'ok';
  let summary = 'Сайт доступен, соединение проходит штатно.';
  if (!dnsOk) {
    verdictStatus = 'error';
    summary = hasStubIp
      ? 'Провайдер подменяет DNS-ответ на заглушку. Включите защищённый DNS (DoH) в браузере или проверьте hosts.'
      : dohIps.length > 0
        ? 'Системный DNS не находит домен, но через DoH он виден. Включите защищённый DNS в браузере.'
        : 'Домен не найден в DNS (проверьте правильность адреса или интернет-соединение).';
  } else if (tcpPingMs === null) {
    verdictStatus = 'error';
    summary = 'Нет TCP-ответа на порт 443 - возможна блокировка по IP-адресу (попробуйте режим IPSet Loaded).';
  } else if (!tlsOk) {
    verdictStatus = 'warn';
    summary = inBypassList
      ? 'TCP проходит, но TLS блокируется - попробуйте другую стратегию на вкладке "Подключение".'
      : inExcludeList
        ? 'Домен находится в исключениях и блокируется по TLS - уберите его из исключений.'
        : 'Соединение обрывается на TLS - добавьте сайт в список обхода одной кнопкой ниже.';
  }

  return {
    domain,
    verdictStatus,
    summary,
    dns: {
      ok: dnsOk,
      hasStubIp,
      systemIps,
      dohIps,
    },
    lists: {
      inBypassList,
      inExcludeList,
      inUserBypass: Boolean(matchedUserGen),
      inUserExclude: Boolean(matchedUserExcl),
      label: listLabel,
      matchedRule: listMatchedRule,
    },
    tcp: {
      ok: tcpPingMs !== null,
      pingMs: tcpPingMs,
    },
    tls: {
      ok: tlsOk,
      httpOk,
    },
    checkedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Unified Configuration Export / Import (#11)
// ============================================================================

export function exportFullConfig(zapretDir) {
  const settings = loadSettings();
  const { zapretDir: _omitZapretDir, ...portableSettings } = settings;
  const { profiles, activeProfileId } = readProfiles(zapretDir);
  const gameFilter = readGameFilter(zapretDir);
  const ipsetFilter = readIpsetFilter(zapretDir);
  const activeFakes = readActiveFakes(zapretDir);

  const userLists = {};
  for (const def of LIST_DEFINITIONS.filter((d) => d.isUser)) {
    userLists[def.id] = readListContent(zapretDir, def.id).content;
  }

  const customStrategies = [];
  if (fs.existsSync(zapretDir)) {
    for (const fn of fs.readdirSync(zapretDir)) {
      if (/^custom\s*-.*\.bat$/i.test(fn)) {
        customStrategies.push({
          fileName: fn,
          content: fs.readFileSync(path.join(zapretDir, fn), 'utf8'),
        });
      }
    }
  }

  return {
    format: 'zapret-control-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: portableSettings,
    activeProfileId,
    profiles,
    gameFilter: {
      mode: gameFilter.mode,
      tcpRange: gameFilter.tcpRange,
      udpRange: gameFilter.udpRange,
    },
    ipsetMode: ipsetFilter.mode,
    activeFakes: {
      discord: activeFakes.discordCurrent,
      game: activeFakes.gameCurrent,
    },
    userLists,
    customStrategies,
  };
}

export function importFullConfig(zapretDir, bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.format !== 'zapret-control-config') {
    throw new Error('Файл не является резервной копией конфигурации Zapret Control');
  }

  let restoredCustomStrats = 0;
  if (Array.isArray(bundle.customStrategies)) {
    for (const cs of bundle.customStrategies) {
      if (!cs || typeof cs.fileName !== 'string' || typeof cs.content !== 'string') continue;
      const safeName = path.basename(cs.fileName).trim();
      if (!/^custom\s*-\s*[^\\/:*?"<>|]+\.bat$/i.test(safeName)) continue;
      if (!/winws\.exe/i.test(cs.content)) continue;
      writeCrlfFile(path.join(zapretDir, safeName), cs.content);
      restoredCustomStrats++;
    }
  }

  let restoredLists = 0;
  if (bundle.userLists && typeof bundle.userLists === 'object') {
    for (const def of LIST_DEFINITIONS.filter((d) => d.isUser)) {
      if (typeof bundle.userLists[def.id] === 'string') {
        saveListContent(zapretDir, def.id, bundle.userLists[def.id], { autoClean: false });
        restoredLists++;
      }
    }
  }

  if (Array.isArray(bundle.profiles) && bundle.profiles.length > 0) {
    const cleanedProfiles = bundle.profiles
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        id: p.id,
        name: String(p.name).trim().slice(0, 28) || 'Профиль',
        description: String(p.description || '').trim().slice(0, 90),
        isDefault: p.id === 'default',
        strategy: String(p.strategy || 'general (ALT11).bat'),
        gameFilterMode: ['disabled', 'all', 'tcp', 'udp'].includes(p.gameFilterMode)
          ? p.gameFilterMode
          : 'disabled',
        gameFilterTcp: validatePortRange(p.gameFilterTcp) || '1024-65535',
        gameFilterUdp: validatePortRange(p.gameFilterUdp) || '1024-65535',
        ipsetMode: ['none', 'loaded', 'any'].includes(p.ipsetMode) ? p.ipsetMode : 'none',
        discordFakeBin: typeof p.discordFakeBin === 'string' ? p.discordFakeBin : null,
        gameFakeBin: typeof p.gameFakeBin === 'string' ? p.gameFakeBin : null,
      }));
    if (cleanedProfiles.length > 0) {
      writeProfilesRaw(cleanedProfiles);
    }
  }

  if (bundle.settings && typeof bundle.settings === 'object') {
    const current = loadSettings();
    const allowedPatch = {};
    const boolKeys = [
      'autoStartStrategyOnLaunch',
      'launchOnWindowsStartup',
      'startMinimizedToTray',
      'minimizeToTrayOnClose',
      'autoRestartOnFilterChange',
      'autoRestartOnCrash',
      'autoCheckUpdates',
      'showWinwsConsole',
      'showBestStrategyCards',
      'developerMode',
    ];
    for (const k of boolKeys) {
      if (typeof bundle.settings[k] === 'boolean') allowedPatch[k] = bundle.settings[k];
    }
    if (bundle.settings.connectLayout === 'split' || bundle.settings.connectLayout === 'stacked') {
      allowedPatch.connectLayout = bundle.settings.connectLayout;
    }
    if (Array.isArray(bundle.settings.favoriteStrategies)) {
      allowedPatch.favoriteStrategies = bundle.settings.favoriteStrategies.filter((s) => typeof s === 'string');
    }
    if (typeof bundle.settings.selectedStrategy === 'string') {
      allowedPatch.selectedStrategy = bundle.settings.selectedStrategy;
    }
    if (typeof bundle.activeProfileId === 'string') {
      allowedPatch.activeProfileId = bundle.activeProfileId;
    } else if (typeof bundle.settings.activeProfileId === 'string') {
      allowedPatch.activeProfileId = bundle.settings.activeProfileId;
    }
    allowedPatch.zapretDir = current.zapretDir;
    saveSettings(allowedPatch);
  }

  const { activeProfileId } = readProfiles(zapretDir);
  activateProfile(zapretDir, activeProfileId);

  return {
    restoredLists,
    restoredCustomStrats,
    profilesCount: readProfiles(zapretDir).profiles.length,
  };
}

// ============================================================================
// Safe Custom Strategy Builder ("custom - <name>.bat", #12)
// ============================================================================

function sanitizeCustomStrategyTitle(rawName) {
  const stripped = String(rawName || '')
    .replace(/\.bat$/i, '')
    .replace(/^custom\s*-\s*/i, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 42);
  if (!stripped) {
    throw new Error('Введите название стратегии');
  }
  return stripped;
}

export function getStrategyBuilderSource(zapretDir, fileName) {
  const safe = path.basename(String(fileName || ''));
  const fullPath = path.join(zapretDir, safe);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Базовая стратегия не найдена');
  }
  const raw = fs.readFileSync(fullPath, 'utf8');
  const idx = raw.toLowerCase().indexOf('winws.exe"');
  let winwsTail = '';
  if (idx !== -1) {
    winwsTail = raw
      .slice(idx + 'winws.exe"'.length)
      .replace(/\^\r?\n/g, '\n')
      .trim();
  }
  return {
    fileName: safe,
    isCustom: /^custom\s*-/i.test(safe),
    cleanTitle: safe.replace(/\.bat$/i, '').replace(/^custom\s*-\s*/i, ''),
    winwsArgsText: winwsTail,
  };
}

export function buildWinwsArgsFromParams(params = {}) {
  const tcpMode = String(params.tcpDesync || 'fake,multisplit');
  const tcpRepeats = Math.min(16, Math.max(1, Number(params.tcpRepeats) || 6));
  const fooling = String(params.fooling || 'ts');
  const autottl = String(params.autottl || 'off');
  const tlsBin = String(params.tlsFakeBin || 'tls_clienthello_www_google_com.bin').replace(/["\r\n]/g, '');
  const quicBin = String(params.quicFakeBin || 'quic_initial_www_google_com.bin').replace(/["\r\n]/g, '');
  const quicRepeats = Math.min(16, Math.max(1, Number(params.quicRepeats) || 8));
  const includeDiscordVoice = params.includeDiscordVoice !== false;
  const includeGameFilter = params.includeGameFilter !== false;

  const wfTcp = includeGameFilter
    ? '--wf-tcp=80,443,2053,2083,2087,2096,8443,%GameFilterTCP%'
    : '--wf-tcp=80,443,2053,2083,2087,2096,8443';
  const wfUdp = includeGameFilter
    ? '--wf-udp=443,19294-19344,50000-50100,%GameFilterUDP%'
    : '--wf-udp=443,19294-19344,50000-50100';

  const tcpFlags = [`--dpi-desync=${tcpMode}`];
  if (tcpMode.includes('fake')) {
    tcpFlags.push(`--dpi-desync-repeats=${tcpRepeats}`);
    tcpFlags.push(`--dpi-desync-fake-tls="%BIN%${tlsBin}"`);
  }
  if (tcpMode.includes('split') || tcpMode.includes('disorder')) {
    tcpFlags.push('--dpi-desync-split-pos=1,midsld');
    tcpFlags.push('--dpi-desync-split-seqovl=568');
    tcpFlags.push(`--dpi-desync-split-seqovl-pattern="%BIN%${tlsBin}"`);
  }
  if (fooling && fooling !== 'none') {
    tcpFlags.push(`--dpi-desync-fooling=${fooling}`);
  }
  if (autottl && autottl !== 'off') {
    tcpFlags.push(`--dpi-desync-autottl=${autottl}`);
  }
  const tcpFlagStr = tcpFlags.join(' ');

  const rules = [
    `${wfTcp} ${wfUdp}`,
    `--filter-udp=443 --hostlist="%LISTS%list-google.txt" --dpi-desync=fake --dpi-desync-repeats=${quicRepeats} --dpi-desync-fake-quic="%BIN%${quicBin}"`,
    `--filter-udp=443 --hostlist="%LISTS%list-general.txt" --hostlist="%LISTS%list-general-user.txt" --hostlist-exclude="%LISTS%list-exclude.txt" --hostlist-exclude="%LISTS%list-exclude-user.txt" --ipset-exclude="%LISTS%ipset-exclude.txt" --ipset-exclude="%LISTS%ipset-exclude-user.txt" --dpi-desync=fake --dpi-desync-repeats=${quicRepeats} --dpi-desync-fake-quic="%BIN%${quicBin}"`,
  ];

  if (includeDiscordVoice) {
    rules.push(
      '--filter-udp=19294-19344,50000-50100 --filter-l7=discord,stun --dpi-desync=fake --dpi-desync-fake-discord="%BIN%ACTIVE_DISCORD_UDP.bin" --dpi-desync-fake-stun="%BIN%ACTIVE_DISCORD_UDP.bin" --dpi-desync-repeats=6'
    );
  }

  rules.push(
    `--filter-tcp=443 --hostlist="%LISTS%list-google.txt" --ip-id=zero ${tcpFlagStr}`,
    `--filter-tcp=80,443,2053,2083,2087,2096,8443 --hostlist="%LISTS%list-general.txt" --hostlist="%LISTS%list-general-user.txt" --hostlist-exclude="%LISTS%list-exclude.txt" --hostlist-exclude="%LISTS%list-exclude-user.txt" --ipset-exclude="%LISTS%ipset-exclude.txt" --ipset-exclude="%LISTS%ipset-exclude-user.txt" ${tcpFlagStr}`,
    `--filter-udp=443 --ipset="%LISTS%ipset-all.txt" --hostlist-exclude="%LISTS%list-exclude.txt" --hostlist-exclude="%LISTS%list-exclude-user.txt" --ipset-exclude="%LISTS%ipset-exclude.txt" --ipset-exclude="%LISTS%ipset-exclude-user.txt" --dpi-desync=fake --dpi-desync-repeats=${quicRepeats} --dpi-desync-fake-quic="%BIN%${quicBin}"`,
    `--filter-tcp=80,443,8443 --ipset="%LISTS%ipset-all.txt" --hostlist-exclude="%LISTS%list-exclude.txt" --hostlist-exclude="%LISTS%list-exclude-user.txt" --ipset-exclude="%LISTS%ipset-exclude.txt" --ipset-exclude="%LISTS%ipset-exclude-user.txt" ${tcpFlagStr}`
  );

  if (includeGameFilter) {
    rules.push(
      `--filter-tcp=%GameFilterTCP% --ipset="%LISTS%ipset-all.txt" --ipset-exclude="%LISTS%ipset-exclude.txt" --ipset-exclude="%LISTS%ipset-exclude-user.txt" --dpi-desync=multisplit --dpi-desync-any-protocol=1 --dpi-desync-cutoff=n3 --dpi-desync-split-seqovl=568 --dpi-desync-split-pos=1 --dpi-desync-split-seqovl-pattern="%BIN%${tlsBin}"`,
      '--filter-udp=%GameFilterUDP% --ipset="%LISTS%ipset-all.txt" --ipset-exclude="%LISTS%ipset-exclude.txt" --ipset-exclude="%LISTS%ipset-exclude-user.txt" --dpi-desync=fake --dpi-desync-repeats=10 --dpi-desync-any-protocol=1 --dpi-desync-fake-unknown-udp="%BIN%ACTIVE_GAME_UDP.bin" --dpi-desync-cutoff=n4'
    );
  }

  return `${rules[0]} ^\n` + rules.slice(1).join(' --new ^\n');
}

export function saveCustomStrategy(zapretDir, payload = {}) {
  const cleanTitle = sanitizeCustomStrategyTitle(payload.title);
  const fileName = `custom - ${cleanTitle}.bat`;

  if (payload.previousFileName) {
    const prevSafe = path.basename(String(payload.previousFileName));
    if (/^custom\s*-.*\.bat$/i.test(prevSafe) && prevSafe.toLowerCase() !== fileName.toLowerCase()) {
      const prevFull = path.join(zapretDir, prevSafe);
      if (fs.existsSync(prevFull)) {
        fs.unlinkSync(prevFull);
      }
    }
  }

  let argsBlock = '';
  if (payload.mode === 'raw' && typeof payload.winwsArgsText === 'string' && payload.winwsArgsText.trim()) {
    const lines = payload.winwsArgsText
      .split(/\r?\n/)
      .map((l) => l.replace(/\s*\^\s*$/, '').trim())
      .filter(Boolean);
    if (lines.length === 0) {
      throw new Error('Аргументы запуска winws.exe не могут быть пустыми');
    }
    // Disallow shell injection operators outside quotes
    for (const ln of lines) {
      const strippedQuotes = ln.replace(/"[^"]*"/g, '');
      if (/[&|<>]/.test(strippedQuotes)) {
        throw new Error('Недопустимые спецсимволы командной оболочки в аргументах');
      }
    }
    argsBlock = lines.map((ln, i) => (i < lines.length - 1 ? `${ln} ^` : ln)).join('\n');
  } else {
    argsBlock = buildWinwsArgsFromParams(payload.params || {});
  }

  const batContent = [
    '@echo off',
    'chcp 65001 > nul',
    ':: Custom strategy generated by Zapret Control',
    '',
    'cd /d "%~dp0"',
    'call service.bat status_zapret',
    'call service.bat check_updates',
    'call service.bat load_game_filter',
    'call service.bat load_user_lists',
    'echo:',
    '',
    'set "BIN=%~dp0bin\\"',
    'set "LISTS=%~dp0lists\\"',
    'cd /d %BIN%',
    '',
    `start "zapret: %~n0" /min "%BIN%winws.exe" ${argsBlock}`,
    '',
  ].join('\n');

  const fullPath = path.join(zapretDir, fileName);
  writeCrlfFile(fullPath, batContent);

  // Verify it parses cleanly with parseBatWinwsArgs
  parseBatWinwsArgs(zapretDir, fileName);

  if (payload.selectAfterSave) {
    saveSettings({ selectedStrategy: fileName });
    syncCurrentStateToActiveProfile(zapretDir);
  }

  return { fileName, strategies: readStrategies(zapretDir) };
}

export function deleteCustomStrategy(zapretDir, fileName) {
  const safe = path.basename(String(fileName || ''));
  if (!/^custom\s*-.*\.bat$/i.test(safe)) {
    throw new Error('Удалять можно только пользовательские стратегии (custom - *.bat)');
  }
  const fullPath = path.join(zapretDir, safe);
  if (!fs.existsSync(fullPath)) {
    throw new Error('Файл стратегии не найден');
  }
  fs.unlinkSync(fullPath);

  const remaining = readStrategies(zapretDir);
  const fallback =
    remaining.find((s) => s.fileName === 'general (ALT11).bat')?.fileName ||
    remaining[0]?.fileName ||
    'general.bat';

  const settings = loadSettings();
  const nextFavs = (settings.favoriteStrategies || []).filter((f) => f !== safe);
  const patch = { favoriteStrategies: nextFavs };
  if (settings.selectedStrategy === safe) {
    patch.selectedStrategy = fallback;
  }
  saveSettings(patch);

  // Update any profile pointing to the deleted custom strategy
  const { profiles } = readProfiles(zapretDir);
  const updatedProfiles = profiles.map((p) => (p.strategy === safe ? { ...p, strategy: fallback } : p));
  writeProfilesRaw(updatedProfiles);

  return { deleted: safe, fallbackStrategy: fallback };
}


