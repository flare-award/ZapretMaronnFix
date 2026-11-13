import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_DIR, DATA_DIR, REPO_ROOT } from './zapretAdapter.mjs';

const execFileAsync = promisify(execFile);
const isWin = os.platform() === 'win32';

export const APP_REPO = 'flare-award/ZapretMaronnFix';
export const PRIMARY_BRANCH = 'arena/9383b414-zapretmaronnfix';
export const APP_REPO_TREE_URL = `https://github.com/${APP_REPO}/tree/${PRIMARY_BRANCH}`;

const CANDIDATE_BRANCHES = [PRIMARY_BRANCH, 'main'];
const APP_UPDATE_STATE_FILE = path.join(DATA_DIR, 'app-update-state.json');
const RESUME_AFTER_UPDATE_FILE = path.join(DATA_DIR, 'resume-after-update.json');
const UPDATE_LOG_FILE = path.join(DATA_DIR, 'last-update.log');

// Files inside zapret/ and app/data/ that belong to the user and must never be overwritten
const PRESERVED_ZAPRET_REL_PATHS = [
  'zapret/lists/list-general-user.txt',
  'zapret/lists/list-exclude-user.txt',
  'zapret/lists/ipset-exclude-user.txt',
  'zapret/lists/ipset-all.txt',
  'zapret/lists/ipset-all.txt.backup',
  'zapret/utils/game_filter.enabled',
  'zapret/utils/check_updates.enabled',
  'zapret/utils/targets.txt',
  'zapret/bin/ACTIVE_DISCORD_UDP.bin',
  'zapret/bin/ACTIVE_GAME_UDP.bin',
];

const APP_SUBDIRS_TO_SYNC = ['server', 'static', 'src', 'host', 'public'];

let inFlightCheckPromise = null;
let lastCheckCache = { ts: 0, result: null };

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

function httpsGetBufferViaNode(url, extraHeaders = {}, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ca: SYSTEM_CA_BUNDLE,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZapretControl/1.3',
          Accept: '*/*',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
        timeout: 30000,
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
          httpsGetBufferViaNode(nextUrl, extraHeaders, maxRedirects - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buf);
          } else {
            reject(new Error(`HTTP ${res.statusCode} при обращении к ${new URL(url).hostname}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Превышено время ожидания ответа от GitHub')));
    req.on('error', reject);
  });
}

async function fetchBufferWithFallback(url, extraHeaders = {}) {
  try {
    return await httpsGetBufferViaNode(url, extraHeaders);
  } catch (nodeErr) {
    const curlBin = isWin ? 'curl.exe' : 'curl';
    const tmpOut = path.join(
      os.tmpdir(),
      `zapret-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`
    );
    const args = ['-fsSL', '-m', '35', '-H', 'User-Agent: Mozilla/5.0 ZapretControl/1.3', '-o', tmpOut];
    for (const [k, v] of Object.entries(extraHeaders)) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push(url);
    try {
      await execFileAsync(curlBin, args);
      const buf = fs.readFileSync(tmpOut);
      fs.rmSync(tmpOut, { force: true });
      return buf;
    } catch {
      try {
        fs.rmSync(tmpOut, { force: true });
      } catch {
        // ignore
      }
      throw nodeErr;
    }
  }
}

async function fetchText(url, extraHeaders = {}) {
  const buf = await fetchBufferWithFallback(url, extraHeaders);
  return buf.toString('utf8');
}

function decodeXmlEntities(str) {
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

function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

function isProtectedPath(relPosix) {
  if (!relPosix) return true;
  if (relPosix.startsWith('.git/') || relPosix === '.git') return true;
  if (relPosix.startsWith('app/node_modules/') || relPosix.startsWith('node_modules/')) return true;
  if (relPosix.startsWith('app/data/')) return true;
  if (relPosix.startsWith('zapret/utils/test results/')) return true;
  if (relPosix === 'ZapretControl.exe') return true;
  if (PRESERVED_ZAPRET_REL_PATHS.includes(relPosix)) return true;
  return false;
}

function matchesRemoteBlob(localPath, expectedBlobSha) {
  if (!fs.existsSync(localPath)) return false;
  try {
    const stat = fs.statSync(localPath);
    if (!stat.isFile()) return false;
    const raw = fs.readFileSync(localPath);
    if (gitBlobSha1(raw) === expectedBlobSha) return true;

    // Git checkout on Windows converts LF -> CRLF; normalize CRLF -> LF for accurate comparison
    if (!raw.includes(0x00) && raw.includes(0x0d)) {
      const lfBuf = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      if (gitBlobSha1(lfBuf) === expectedBlobSha) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Computes a fast deterministic SHA-256 digest of local program files so repeat update checks
 * do not need to re-download or re-compare archives when nothing on disk or GitHub changed.
 */
function computeLocalProgramDigest() {
  const hash = crypto.createHash('sha256');
  const walk = (dirRel) => {
    const absDir = path.join(REPO_ROOT, dirRel);
    if (!fs.existsSync(absDir)) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const ent of entries) {
      const relPosix = `${dirRel}/${ent.name}`.replace(/\\/g, '/');
      if (isProtectedPath(relPosix)) continue;
      const full = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        walk(relPosix);
      } else if (ent.isFile()) {
        const st = fs.statSync(full);
        hash.update(`${relPosix}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      }
    }
  };

  const launcherPath = path.join(REPO_ROOT, 'ZapretControl.bat');
  if (fs.existsSync(launcherPath)) {
    const st = fs.statSync(launcherPath);
    hash.update(`ZapretControl.bat:${st.size}:${Math.floor(st.mtimeMs)}\n`);
  }
  for (const sub of APP_SUBDIRS_TO_SYNC) {
    walk(`app/${sub}`);
  }
  return hash.digest('hex');
}

export function readLocalAppUpdateState() {
  try {
    if (fs.existsSync(APP_UPDATE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(APP_UPDATE_STATE_FILE, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {
    installedSha: null,
    installedShortSha: null,
    installedBranch: null,
    commitDate: null,
    commitMessage: null,
    verifiedDigest: null,
    updatedAt: null,
  };
}

export function writeLocalAppUpdateState(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = {
    ...readLocalAppUpdateState(),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(APP_UPDATE_STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function consumeResumeAfterUpdateFlag() {
  try {
    if (fs.existsSync(RESUME_AFTER_UPDATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESUME_AFTER_UPDATE_FILE, 'utf8'));
      fs.rmSync(RESUME_AFTER_UPDATE_FILE, { force: true });
      return data && typeof data.strategy === 'string' ? data.strategy : null;
    }
  } catch {
    try {
      fs.rmSync(RESUME_AFTER_UPDATE_FILE, { force: true });
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Pure Node.js ZIP reader using Central Directory + zlib.inflateRawSync.
 * Eliminates PowerShell Expand-Archive slowness/quirks and works identically on Windows & Linux.
 */
function iterateZipBuffer(zipBuf) {
  let eocdPos = -1;
  const minPos = Math.max(0, zipBuf.length - 65558);
  for (let i = zipBuf.length - 22; i >= minPos; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) {
    throw new Error('Повреждённый ZIP-архив обновления (не найден каталог EOCD)');
  }

  const cdSize = zipBuf.readUInt32LE(eocdPos + 12);
  const cdOffset = zipBuf.readUInt32LE(eocdPos + 16);
  const cdEnd = cdOffset + cdSize;
  const files = [];

  let pos = cdOffset;
  while (pos < cdEnd && pos + 46 <= zipBuf.length) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);
    const rawName = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    pos += 46 + nameLen + extraLen + commentLen;

    if (!rawName || rawName.endsWith('/')) continue;
    if (localHeaderOffset + 30 > zipBuf.length) continue;
    if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

    const lhNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const compSlice = zipBuf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = Buffer.from(compSlice);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compSlice);
    } else {
      throw new Error(`Неподдерживаемый метод сжатия ZIP (${method}) для ${rawName}`);
    }

    files.push({ rawName, data });
  }

  // Strip common top-level folder prefix if GitHub zip wraps everything in Repo-sha/
  let commonPrefix = '';
  const firstSlash = files[0]?.rawName.indexOf('/') ?? -1;
  if (firstSlash > 0) {
    const candidate = files[0].rawName.slice(0, firstSlash + 1);
    if (files.every((f) => f.rawName.startsWith(candidate))) {
      commonPrefix = candidate;
    }
  }

  return files
    .map((f) => ({
      relPath: commonPrefix ? f.rawName.slice(commonPrefix.length) : f.rawName,
      data: f.data,
    }))
    .filter((f) => f.relPath && !f.relPath.includes('..'));
}

function extractZipBufferToDir(zipBuf, destDir) {
  const entries = iterateZipBuffer(zipBuf);
  for (const entry of entries) {
    const fullPath = path.join(destDir, ...entry.relPath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, entry.data);
  }
  return destDir;
}

/**
 * Fetches latest commit info WITHOUT touching api.github.com (no 60 req/hr rate limit / HTTP 403).
 * Uses GitHub Atom feed + Git Smart HTTP info/refs on github.com.
 */
async function fetchBranchCommitViaAtom(branch) {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  const atomUrl = `https://github.com/${APP_REPO}/commits/${encodedBranch}.atom`;
  const xml = await fetchText(atomUrl, { Accept: 'application/atom+xml, text/xml, */*' });

  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) return null;
  const entry = entryMatch[1];

  const shaMatch =
    entry.match(/Commit\/([0-9a-f]{40})/i) || entry.match(/\/commit\/([0-9a-f]{40})/i);
  if (!shaMatch) return null;
  const sha = shaMatch[1].toLowerCase();

  const updatedMatch = entry.match(/<updated>([^<]+)<\/updated>/i);
  const publishedAt = updatedMatch ? updatedMatch[1].trim() : null;

  let message = '';
  const preMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
  if (preMatch) {
    const decodedHtml = decodeXmlEntities(preMatch[1]);
    const cleanText = decodedHtml.replace(/<[^>]+>/g, '').trim();
    message = cleanText.split(/\r?\n/)[0].trim();
  }
  if (!message) {
    const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      message = decodeXmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    }
  }

  return {
    branch,
    sha,
    shortSha: sha.slice(0, 7),
    publishedAt,
    message: message || 'Обновление Zapret Control',
    htmlUrl: APP_REPO_TREE_URL,
  };
}

async function fetchRefsViaSmartHttp() {
  const refsUrl = `https://github.com/${APP_REPO}.git/info/refs?service=git-upload-pack`;
  const raw = await fetchText(refsUrl);
  const refs = new Map();
  const re = /([0-9a-f]{40})\s+refs\/heads\/([^\s\0\r\n]+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    refs.set(m[2], m[1].toLowerCase());
  }
  return refs;
}

export async function fetchLatestCommitInfo() {
  // 1. Primary: Atom feeds on github.com (fast, rich metadata, no REST API 60/hr limit)
  const atomCandidates = [];
  for (const branch of CANDIDATE_BRANCHES) {
    try {
      const info = await fetchBranchCommitViaAtom(branch);
      if (info) atomCandidates.push(info);
    } catch {
      // try next branch or smart-http fallback
    }
  }

  if (atomCandidates.length > 0) {
    // Prefer PRIMARY_BRANCH unless another candidate has a strictly newer timestamp and includes app/
    const primary = atomCandidates.find((c) => c.branch === PRIMARY_BRANCH);
    if (primary) return primary;
    atomCandidates.sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || ''));
    return atomCandidates[0];
  }

  // 2. Secondary: Git Smart HTTP info/refs (ultra-lightweight git protocol on github.com)
  const refs = await fetchRefsViaSmartHttp();
  for (const branch of CANDIDATE_BRANCHES) {
    const sha = refs.get(branch);
    if (sha) {
      return {
        branch,
        sha,
        shortSha: sha.slice(0, 7),
        publishedAt: null,
        message: 'Актуальная сборка репозитория',
        htmlUrl: APP_REPO_TREE_URL,
      };
    }
  }

  throw new Error('Не удалось получить сведения о коммитах с GitHub');
}

function getCachedArchivePath(sha) {
  return path.join(os.tmpdir(), `zapret-control-pkg-${sha}.zip`);
}

function getCachedManifestPath(sha) {
  return path.join(os.tmpdir(), `zapret-control-manifest-${sha}.json`);
}

async function getOrFetchRemoteManifest(sha) {
  const manifestPath = getCachedManifestPath(sha);
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      // ignore corrupt cache
    }
  }

  const archivePath = getCachedArchivePath(sha);
  let zipBuf = null;
  if (fs.existsSync(archivePath)) {
    try {
      zipBuf = fs.readFileSync(archivePath);
    } catch {
      zipBuf = null;
    }
  }

  if (!zipBuf || zipBuf.length < 200) {
    const zipUrl = `https://codeload.github.com/${APP_REPO}/zip/${sha}`;
    zipBuf = await fetchBufferWithFallback(zipUrl);
    try {
      fs.writeFileSync(archivePath, zipBuf);
    } catch {
      // ignore temp cache write errors
    }
  }

  const entries = iterateZipBuffer(zipBuf);
  const manifest = entries.map((e) => ({
    path: e.relPath,
    sha: gitBlobSha1(e.data),
  }));

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  } catch {
    // ignore
  }
  return manifest;
}

async function detectLocalGitHead() {
  try {
    const gitDir = path.join(REPO_ROOT, '.git');
    if (!fs.existsSync(gitDir)) return null;
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function performProgramUpdateCheck() {
  const latest = await fetchLatestCommitInfo();
  const localDigest = computeLocalProgramDigest();
  const localState = readLocalAppUpdateState();
  const gitHead = await detectLocalGitHead();

  // Fast-path: already verified this exact commit SHA against unchanged local files (0 extra downloads!)
  if (localState.installedSha === latest.sha && localState.verifiedDigest === localDigest) {
    return {
      repo: APP_REPO,
      currentSha: latest.sha,
      currentShortSha: latest.shortSha,
      currentDate: latest.publishedAt || localState.commitDate || null,
      latestSha: latest.sha,
      latestShortSha: latest.shortSha,
      branch: latest.branch,
      publishedAt: latest.publishedAt,
      commitMessage: latest.message,
      changedFilesCount: 0,
      changedSample: [],
      updateAvailable: false,
      htmlUrl: APP_REPO_TREE_URL,
      checkedAt: new Date().toISOString(),
    };
  }

  const manifest = await getOrFetchRemoteManifest(latest.sha);
  let changedFilesCount = 0;
  const changedSample = [];

  for (const item of manifest) {
    if (isProtectedPath(item.path)) continue;
    const localPath = path.join(REPO_ROOT, ...item.path.split('/'));
    if (!matchesRemoteBlob(localPath, item.sha)) {
      changedFilesCount++;
      if (changedSample.length < 12) {
        changedSample.push(item.path);
      }
    }
  }

  const updateAvailable = changedFilesCount > 0;
  let updatedState = localState;
  if (!updateAvailable) {
    updatedState = writeLocalAppUpdateState({
      installedSha: latest.sha,
      installedShortSha: latest.shortSha,
      installedBranch: latest.branch,
      commitDate: latest.publishedAt,
      commitMessage: latest.message,
      verifiedDigest: localDigest,
    });
  }

  const verifiedCurrentSha = !updateAvailable
    ? latest.sha
    : gitHead && gitHead !== latest.sha
      ? gitHead
      : updatedState.installedSha && updatedState.installedSha !== latest.sha
        ? updatedState.installedSha
        : null;

  return {
    repo: APP_REPO,
    currentSha: verifiedCurrentSha,
    currentShortSha: verifiedCurrentSha ? verifiedCurrentSha.slice(0, 7) : null,
    currentDate: !updateAvailable
      ? latest.publishedAt
      : verifiedCurrentSha
        ? updatedState.commitDate
        : null,
    latestSha: latest.sha,
    latestShortSha: latest.shortSha,
    branch: latest.branch,
    publishedAt: latest.publishedAt,
    commitMessage: latest.message,
    changedFilesCount,
    changedSample,
    updateAvailable,
    htmlUrl: APP_REPO_TREE_URL,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkProgramUpdate() {
  if (inFlightCheckPromise) {
    return inFlightCheckPromise;
  }
  const now = Date.now();
  if (lastCheckCache.result && now - lastCheckCache.ts < 8000) {
    return lastCheckCache.result;
  }

  inFlightCheckPromise = performProgramUpdateCheck()
    .then((res) => {
      lastCheckCache = { ts: Date.now(), result: res };
      return res;
    })
    .finally(() => {
      inFlightCheckPromise = null;
    });

  return inFlightCheckPromise;
}

function cleanAccidentalNestedDirs() {
  for (const sub of APP_SUBDIRS_TO_SYNC) {
    const accidentalNested = path.join(APP_DIR, sub, sub);
    if (fs.existsSync(accidentalNested)) {
      try {
        fs.rmSync(accidentalNested, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function copyTreeFilesRecursive(srcDir, dstDir, { mirrorDelete = false } = {}) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });

  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  if (mirrorDelete && fs.existsSync(dstDir)) {
    for (const existing of fs.readdirSync(dstDir, { withFileTypes: true })) {
      if (!srcNames.has(existing.name)) {
        try {
          fs.rmSync(path.join(dstDir, existing.name), { recursive: true, force: true });
        } catch {
          // ignore locked file
        }
      }
    }
  }

  for (const entry of srcEntries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeFilesRecursive(srcPath, dstPath, { mirrorDelete });
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function applyExtractedFilesInNode(sourceRoot, preserveDir) {
  cleanAccidentalNestedDirs();

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'app' || entry.name === 'zapret') continue;
    if (entry.name === 'ZapretControl.exe') continue;
    const sPath = path.join(sourceRoot, entry.name);
    const dPath = path.join(REPO_ROOT, entry.name);
    try {
      if (entry.isDirectory()) {
        copyTreeFilesRecursive(sPath, dPath, { mirrorDelete: false });
      } else if (entry.isFile()) {
        fs.copyFileSync(sPath, dPath);
      }
    } catch {
      // fallback PS script handles any locked root file
    }
  }

  const srcApp = path.join(sourceRoot, 'app');
  if (fs.existsSync(srcApp)) {
    for (const sub of APP_SUBDIRS_TO_SYNC) {
      const sSub = path.join(srcApp, sub);
      const dSub = path.join(APP_DIR, sub);
      if (fs.existsSync(sSub)) {
        copyTreeFilesRecursive(sSub, dSub, { mirrorDelete: true });
      }
    }
    for (const entry of fs.readdirSync(srcApp, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        fs.copyFileSync(path.join(srcApp, entry.name), path.join(APP_DIR, entry.name));
      } catch {
        // ignore
      }
    }
  }

  const srcZapret = path.join(sourceRoot, 'zapret');
  const dstZapret = path.join(REPO_ROOT, 'zapret');
  if (fs.existsSync(srcZapret)) {
    copyTreeFilesRecursive(srcZapret, dstZapret, { mirrorDelete: false });
  }

  const preservedZapret = path.join(preserveDir, 'zapret');
  if (fs.existsSync(preservedZapret)) {
    copyTreeFilesRecursive(preservedZapret, dstZapret, { mirrorDelete: false });
  }
}

function escapePsSingleQuoted(str) {
  return String(str).replace(/'/g, "''");
}

function writeUtf8BomCrlf(filePath, content) {
  const crlf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(filePath, Buffer.concat([bom, Buffer.from(crlf, 'utf8')]));
}

export async function installProgramUpdate({
  zipBase64 = null,
  activeRunningStrategy = null,
  targetPort = 3847,
  onBeforeApply = null,
} = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-control-upd-'));
  const extractDir = path.join(tempWorkDir, 'extracted');
  const preserveDir = path.join(tempWorkDir, 'preserve');
  const stagedStateFile = path.join(tempWorkDir, 'app-update-state.json');

  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(preserveDir, { recursive: true });

  let commitMeta = null;
  let zipBuf;

  if (zipBase64 && typeof zipBase64 === 'string') {
    const cleaned = zipBase64.replace(/^data:[^;]+;base64,/, '');
    zipBuf = Buffer.from(cleaned, 'base64');
    if (zipBuf.length < 200) {
      throw new Error('Загруженный ZIP-файл пуст или повреждён');
    }
  } else {
    commitMeta = await fetchLatestCommitInfo();
    const cachedArchive = getCachedArchivePath(commitMeta.sha);
    if (fs.existsSync(cachedArchive)) {
      zipBuf = fs.readFileSync(cachedArchive);
    } else {
      const zipUrl = `https://codeload.github.com/${APP_REPO}/zip/${commitMeta.sha}`;
      zipBuf = await fetchBufferWithFallback(zipUrl);
      try {
        fs.writeFileSync(cachedArchive, zipBuf);
      } catch {
        // ignore
      }
    }
  }

  const sourceRoot = extractZipBufferToDir(zipBuf, extractDir);
  if (
    !fs.existsSync(path.join(sourceRoot, 'app')) &&
    !fs.existsSync(path.join(sourceRoot, 'ZapretControl.bat'))
  ) {
    throw new Error('Выбранный архив не содержит файлов программы Zapret Control');
  }

  for (const rel of PRESERVED_ZAPRET_REL_PATHS) {
    const src = path.join(REPO_ROOT, ...rel.split('/'));
    if (fs.existsSync(src)) {
      const dst = path.join(preserveDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }

  const localZapretRoot = path.join(REPO_ROOT, 'zapret');
  if (fs.existsSync(localZapretRoot)) {
    for (const fn of fs.readdirSync(localZapretRoot)) {
      if (/^custom\s*-.*\.bat$/i.test(fn)) {
        const srcBat = path.join(localZapretRoot, fn);
        const dstBat = path.join(preserveDir, 'zapret', fn);
        fs.mkdirSync(path.dirname(dstBat), { recursive: true });
        fs.copyFileSync(srcBat, dstBat);
      }
    }
  }

  if (activeRunningStrategy) {
    fs.writeFileSync(
      RESUME_AFTER_UPDATE_FILE,
      JSON.stringify({ strategy: activeRunningStrategy, savedAt: Date.now() }, null, 2),
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

  applyExtractedFilesInNode(sourceRoot, preserveDir);
  const newDigest = computeLocalProgramDigest();

  const nextUpdateState = commitMeta
    ? {
        installedSha: commitMeta.sha,
        installedShortSha: commitMeta.shortSha,
        installedBranch: commitMeta.branch,
        commitDate: commitMeta.publishedAt,
        commitMessage: commitMeta.message,
        verifiedDigest: newDigest,
        updatedAt: new Date().toISOString(),
      }
    : {
        ...readLocalAppUpdateState(),
        installedShortSha: 'zip',
        commitDate: new Date().toISOString(),
        commitMessage: 'Обновлено вручную из ZIP-архива',
        verifiedDigest: newDigest,
        updatedAt: new Date().toISOString(),
      };

  fs.writeFileSync(stagedStateFile, JSON.stringify(nextUpdateState, null, 2), 'utf8');
  writeLocalAppUpdateState(nextUpdateState);
  lastCheckCache = { ts: 0, result: null };

  if (isWin) {
    const applyScriptPath = path.join(os.tmpdir(), `zapret-control-restart-${Date.now()}.ps1`);
    const psRepo = escapePsSingleQuoted(REPO_ROOT);
    const psSrc = escapePsSingleQuoted(sourceRoot);
    const psPreserve = escapePsSingleQuoted(preserveDir);
    const psStateSrc = escapePsSingleQuoted(stagedStateFile);
    const psStateDst = escapePsSingleQuoted(APP_UPDATE_STATE_FILE);
    const psTempWork = escapePsSingleQuoted(tempWorkDir);
    const psLog = escapePsSingleQuoted(UPDATE_LOG_FILE);
    const currentServerPid = process.pid;
    const safePort = Number(targetPort) > 0 ? Number(targetPort) : 3847;

    const psScript = `
$ErrorActionPreference = 'Continue'
$repoRoot = '${psRepo}'
$srcRoot = '${psSrc}'
$preserveDir = '${psPreserve}'
$stateSrc = '${psStateSrc}'
$stateDst = '${psStateDst}'
$tempWork = '${psTempWork}'
$logFile = '${psLog}'
$targetPort = ${safePort}
$oldServerPid = ${currentServerPid}

function Write-UpdLog([string]$msg) {
    try {
        $line = ('[{0}] {1}' -f [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff'), $msg)
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

Write-UpdLog ('Starting silent restart finalizer (oldServerPid=' + $oldServerPid + ', port=' + $targetPort + ')')
Start-Sleep -Milliseconds 600

# 1. Stop old tray host process (without killing our own PowerShell process)
try {
    Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Wait-Process -Name 'ZapretControl' -Timeout 5 -ErrorAction SilentlyContinue
} catch {}

# 2. Stop old Node server PID directly (NEVER use taskkill /T, which would kill this child PowerShell!)
try {
    $srvProc = Get-Process -Id $oldServerPid -ErrorAction SilentlyContinue
    if ($null -ne $srvProc) {
        Stop-Process -Id $oldServerPid -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $oldServerPid -Timeout 4 -ErrorAction SilentlyContinue
    }
} catch {}

& taskkill.exe /IM winws.exe /F 2>&1 | Out-Null
Start-Sleep -Milliseconds 250

# 3. Ensure old ZapretControl.exe is unlocked so csc.exe can rebuild cleanly
$exePath = Join-Path $repoRoot 'ZapretControl.exe'
for ($i = 0; $i -lt 25; $i++) {
    if (-not (Test-Path -LiteralPath $exePath)) { break }
    try {
        Remove-Item -LiteralPath $exePath -Force -ErrorAction Stop
        break
    } catch {
        Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 200
    }
}

# 4. Mirror updated files to ensure 100% consistency after process unlock
foreach ($sub in @('server', 'static', 'src', 'host', 'public')) {
    $nested = Join-Path (Join-Path (Join-Path $repoRoot 'app') $sub) $sub
    if (Test-Path -LiteralPath $nested) {
        Remove-Item -LiteralPath $nested -Recurse -Force -ErrorAction SilentlyContinue
    }
    $sSub = Join-Path (Join-Path $srcRoot 'app') $sub
    $dSub = Join-Path (Join-Path $repoRoot 'app') $sub
    if (Test-Path -LiteralPath $sSub) {
        & robocopy.exe $sSub $dSub /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        Write-UpdLog ('Mirrored app\\' + $sub + ' exit=' + $LASTEXITCODE)
    }
}

Get-ChildItem -LiteralPath (Join-Path $srcRoot 'app') -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    [System.IO.File]::Copy($_.FullName, (Join-Path (Join-Path $repoRoot 'app') $_.Name), $true)
}

$srcLauncher = Join-Path $srcRoot 'ZapretControl.bat'
if (Test-Path -LiteralPath $srcLauncher) {
    [System.IO.File]::Copy($srcLauncher, (Join-Path $repoRoot 'ZapretControl.bat'), $true)
}

$srcZapret = Join-Path $srcRoot 'zapret'
$dstZapret = Join-Path $repoRoot 'zapret'
if (Test-Path -LiteralPath $srcZapret) {
    & robocopy.exe $srcZapret $dstZapret /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
}

$presZapret = Join-Path $preserveDir 'zapret'
if (Test-Path -LiteralPath $presZapret) {
    & robocopy.exe $presZapret $dstZapret /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
}

if (Test-Path -LiteralPath $stateSrc) {
    $stateDir = [System.IO.Path]::GetDirectoryName($stateDst)
    if (-not (Test-Path -LiteralPath $stateDir)) {
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    }
    [System.IO.File]::Copy($stateSrc, $stateDst, $true)
}

# 5. Recompile ZapretControl.exe directly via csc.exe (silent, no .bat console window, no ShellExecute sound)
$csPath = Join-Path $repoRoot 'app\\host\\ZapretControl.cs'
$icoPath = Join-Path $repoRoot 'app\\host\\app.ico'
$csc64 = Join-Path $env:SystemRoot 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
$csc32 = Join-Path $env:SystemRoot 'Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
$csc = if (Test-Path -LiteralPath $csc64) { $csc64 } elseif (Test-Path -LiteralPath $csc32) { $csc32 } else { $null }

if ($null -ne $csc -and (Test-Path -LiteralPath $csPath)) {
    $cscArgs = @('/nologo', '/target:winexe', '/optimize+', ("/out:$exePath"), '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll')
    if (Test-Path -LiteralPath $icoPath) {
        $cscArgs += ("/win32icon:$icoPath")
    }
    $cscArgs += $csPath
    & $csc @cscArgs 2>&1 | Out-Null
    Write-UpdLog ('Compiled ZapretControl.exe exit=' + $LASTEXITCODE)
}

# 6. Launch new host (or fallback node server) via CreateProcess (UseShellExecute=$false -> zero OS error sounds)
if (Test-Path -LiteralPath $exePath) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exePath
    $psi.Arguments = ('--relaunch-after-update --port=' + $targetPort)
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-UpdLog 'Launched ZapretControl.exe successfully'
} else {
    $nodeCmd = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if ($null -ne $nodeCmd) {
        $psiNode = New-Object System.Diagnostics.ProcessStartInfo
        $psiNode.FileName = $nodeCmd.Source
        $psiNode.Arguments = ('"' + (Join-Path $repoRoot 'app\\server\\index.mjs') + '"')
        $psiNode.WorkingDirectory = $repoRoot
        $psiNode.UseShellExecute = $false
        $psiNode.CreateNoWindow = $true
        $psiNode.EnvironmentVariables['PORT'] = [string]$targetPort
        [System.Diagnostics.Process]::Start($psiNode) | Out-Null
        Write-UpdLog 'Launched fallback node.exe server'
    }
}

Start-Sleep -Milliseconds 500
Remove-Item -LiteralPath $tempWork -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;

    writeUtf8BomCrlf(applyScriptPath, psScript);

    const detached = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        applyScriptPath,
      ],
      {
        cwd: os.tmpdir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    detached.unref();

    return {
      ok: true,
      restarting: true,
      installedShortSha: nextUpdateState.installedShortSha,
      message: 'Обновление установлено, выполняется автоматический перезапуск...',
    };
  }

  writeLocalAppUpdateState(nextUpdateState);
  fs.rmSync(tempWorkDir, { recursive: true, force: true });

  return {
    ok: true,
    restarting: false,
    installedShortSha: nextUpdateState.installedShortSha,
    message: 'Файлы программы успешно обновлены.',
  };
}
