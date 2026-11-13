import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import tls from 'node:tls';
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
  autoStartStrategyOnLaunch: false,
  launchOnWindowsStartup: false,
  startMinimizedToTray: false,
  minimizeToTrayOnClose: true,
  autoRestartOnFilterChange: true,
  autoCheckUpdates: true,
  showWinwsConsole: false,
  showBestStrategyCards: true,
  connectLayout: 'split',
};

export const LIST_DEFINITIONS = [
  {
    id: 'list-general-user',
    title: 'Пользовательский список доменов',
    subtitle: 'Ваши собственные домены для обхода (не затираются в оригинальном Zapret)',
    relPath: 'lists/list-general-user.txt',
    kind: 'domains',
    isUser: true,
  },
  {
    id: 'list-exclude-user',
    title: 'Пользовательские исключения доменов',
    subtitle: 'Домены, которые никогда не должны подвергаться десинку',
    relPath: 'lists/list-exclude-user.txt',
    kind: 'domains',
    isUser: true,
  },
  {
    id: 'ipset-exclude-user',
    title: 'Пользовательские исключения IP',
    subtitle: 'IP-адреса и CIDR-подсети, исключённые из обработки',
    relPath: 'lists/ipset-exclude-user.txt',
    kind: 'ipset',
    isUser: true,
  },
  {
    id: 'list-general',
    title: 'Основной список (list-general)',
    subtitle: 'Базовый список Discord, Cloudflare и добавленных сервисов',
    relPath: 'lists/list-general.txt',
    kind: 'domains',
    isUser: false,
  },
  {
    id: 'list-google',
    title: 'Список YouTube и Google',
    subtitle: 'Домены видеосерверов googlevideo.com, youtube.com и сервисов Google',
    relPath: 'lists/list-google.txt',
    kind: 'domains',
    isUser: false,
  },
  {
    id: 'list-exclude',
    title: 'Основные исключения (list-exclude)',
    subtitle: 'Российские сервисы, банки, Госуслуги и лаунчеры без блокировок',
    relPath: 'lists/list-exclude.txt',
    kind: 'domains',
    isUser: false,
  },
  {
    id: 'ipset-exclude',
    title: 'Основные исключения IP',
    subtitle: 'Системные и локальные подсети, исключённые из IPSet',
    relPath: 'lists/ipset-exclude.txt',
    kind: 'ipset',
    isUser: false,
  },
  {
    id: 'targets',
    title: 'Цели тестирования (targets.txt)',
    subtitle: 'Список эндпоинтов для проверки соединения и пинга по категориям',
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
  return { ...DEFAULT_SETTINGS };
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
      latestRelease: 'https://github.com/Flowseal/zapret-discord-youtube/releases/latest',
      coreRepo: 'https://github.com/bol-van/zapret',
      userRepo: 'https://github.com/flare-award/ZapretMaronnFix',
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

function httpsGetViaNode(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ca: SYSTEM_CA_BUNDLE,
        headers: {
          'User-Agent': 'ZapretControl/1.0',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetViaNode(res.headers.location, extraHeaders).then(resolve, reject);
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
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 180)}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Таймаут запроса к GitHub API'));
    });
    req.on('error', reject);
  });
}

export async function httpsGetJsonOrText(url, extraHeaders = {}) {
  try {
    return await httpsGetViaNode(url, extraHeaders);
  } catch (nodeErr) {
    // Fallback to OS curl (uses Windows Schannel / OS CA store natively)
    const curlBin = os.platform() === 'win32' ? 'curl.exe' : 'curl';
    const curlArgs = ['-fsSL', '-m', '10', '-H', 'User-Agent: ZapretControl/1.0'];
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

export async function checkZapretUpdates(zapretDir) {
  const info = readZapretInfo(zapretDir);
  const releaseRaw = await httpsGetJsonOrText(
    'https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest',
    { Accept: 'application/vnd.github+json' }
  );
  const rel = JSON.parse(releaseRaw);
  const latestVersion = String(rel.tag_name || '').replace(/^v/i, '').trim();
  const asset = Array.isArray(rel.assets)
    ? rel.assets.find((a) => String(a.name || '').endsWith('.zip') || String(a.name || '').endsWith('.rar')) || rel.assets[0]
    : null;

  const cmp = compareSemver(info.localVersion, latestVersion);

  return {
    localVersion: info.localVersion,
    latestVersion: latestVersion || info.localVersion,
    updateAvailable: cmp > 0,
    publishedAt: rel.published_at || null,
    releaseName: rel.name || `Zapret ${latestVersion}`,
    releaseNotes: rel.body || '',
    htmlUrl: rel.html_url || info.links.latestRelease,
    downloadUrl: asset ? asset.browser_download_url : rel.zipball_url || info.links.latestRelease,
    assetName: asset ? asset.name : null,
    checkedAt: new Date().toISOString(),
  };
}

export async function updateRemoteIpsetList(zapretDir) {
  const raw = await httpsGetJsonOrText(
    'https://api.github.com/repos/Flowseal/zapret-discord-youtube/contents/.service/ipset-service.txt',
    { Accept: 'application/vnd.github.raw' }
  );
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
  const remoteHosts = await httpsGetJsonOrText(
    'https://api.github.com/repos/Flowseal/zapret-discord-youtube/contents/.service/hosts',
    { Accept: 'application/vnd.github.raw' }
  );
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
    title: 'Путь к папке Zapret без кириллицы',
    status: hasCyrillic ? 'warn' : 'ok',
    detail: hasCyrillic
      ? `В пути обнаружена кириллица (${zapretDir}). Рекомендуется размещать папку по пути вроде C:\\Zapret.`
      : zapretDir,
  });

  const inOneDrive = Boolean(process.env.OneDrive && zapretDir.toLowerCase().includes(process.env.OneDrive.toLowerCase()));
  checks.push({
    id: 'onedrive',
    title: 'Изоляция от синхронизации OneDrive',
    status: inOneDrive ? 'error' : 'ok',
    detail: inOneDrive ? 'Папка находится внутри OneDrive, это может блокировать WinDivert64.sys' : 'Папка вне каталога OneDrive',
  });

  const binDir = path.join(zapretDir, 'bin');
  const hasWinws = fs.existsSync(path.join(binDir, 'winws.exe'));
  const hasWinDivert = fs.existsSync(path.join(binDir, 'WinDivert64.sys')) || fs.existsSync(path.join(binDir, 'WinDivert.dll'));
  checks.push({
    id: 'binaries',
    title: 'Файлы winws.exe и драйвера WinDivert',
    status: hasWinws && hasWinDivert ? 'ok' : 'error',
    detail: hasWinws && hasWinDivert ? 'winws.exe и WinDivert64.sys присутствуют в zapret/bin/' : 'Не найдены файлы в zapret/bin/',
  });

  // Validate all user/general domain lists for broken wildcards or spaces
  let listIssues = 0;
  for (const fn of ['list-general.txt', 'list-general-user.txt', 'list-exclude.txt', 'list-exclude-user.txt']) {
    const p = path.join(zapretDir, 'lists', fn);
    if (fs.existsSync(p)) {
      for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const s = raw.trim();
        if (!s || s.startsWith('#')) continue;
        if (s.includes(' ') || s.includes('*')) listIssues++;
      }
    }
  }
  checks.push({
    id: 'hostlists',
    title: 'Целостность списков доменов (lists/*.txt)',
    status: listIssues === 0 ? 'ok' : 'warn',
    detail: listIssues === 0 ? 'Все списки синтаксически корректны (0 ошибок)' : `Обнаружено некорректных строк с пробелами или *: ${listIssues}`,
  });

  if (isWin) {
    try {
      const { stdout: bfeOut } = await execFileAsync('sc.exe', ['query', 'BFE']);
      const bfeOk = /RUNNING/i.test(bfeOut);
      checks.push({
        id: 'bfe',
        title: 'Служба фильтрации Base Filtering Engine (BFE)',
        status: bfeOk ? 'ok' : 'error',
        detail: bfeOk ? 'Служба BFE запущена и работает штатно' : 'Служба BFE остановлена - она необходима для WinDivert',
      });
    } catch {
      checks.push({ id: 'bfe', title: 'Служба Base Filtering Engine (BFE)', status: 'warn', detail: 'Не удалось опросить sc.exe' });
    }

    try {
      const { stdout: tsOut } = await execFileAsync('netsh', ['interface', 'tcp', 'show', 'global']);
      const tsOk = /timestamps.*enabled/i.test(tsOut);
      checks.push({
        id: 'timestamps',
        title: 'Глобальные TCP Timestamps в Windows',
        status: tsOk ? 'ok' : 'warn',
        detail: tsOk ? 'TCP Timestamps включены (enabled)' : 'TCP Timestamps отключены - будут включены автоматически при старте стратегии',
      });
    } catch {
      checks.push({ id: 'timestamps', title: 'Глобальные TCP Timestamps', status: 'ok', detail: 'Включаются при старте обхода' });
    }

    try {
      const { stdout: scOut } = await execFileAsync('sc.exe', ['query']);
      const conflicts = ['GoodbyeDPI', 'discordfix_zapret', 'Killer', 'SmartByte', 'TracSrvWrapper'].filter((c) =>
        new RegExp(c, 'i').test(scOut)
      );
      checks.push({
        id: 'conflicts',
        title: 'Конфликтующие сетевые службы и DPI-утилиты',
        status: conflicts.length === 0 ? 'ok' : 'warn',
        detail: conflicts.length === 0 ? 'Конфликтующих сервисов (GoodbyeDPI, Killer, SmartByte) не найдено' : `Найдены потенциальные конфликты: ${conflicts.join(', ')}`,
      });
    } catch {
      // ignore
    }
  } else {
    checks.push({
      id: 'env-preview',
      title: 'Среда выполнения ОС',
      status: 'ok',
      detail: 'Демонстрационный Linux-контейнер (на Windows ПК активируются системные проверки BFE, TCP Timestamps, реестра и WinDivert)',
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
    name: name.slice(0, 48),
    description: String(payload.description || '').trim().slice(0, 120),
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
    name: nextName.slice(0, 48),
    description:
      patch.description !== undefined ? String(patch.description).trim().slice(0, 120) : existing.description,
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

