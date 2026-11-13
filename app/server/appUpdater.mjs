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
const HOST_UPDATING_LOCK_FILE = path.join(DATA_DIR, 'host-updating.lock');

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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZapretControl/1.4',
          Accept: '*/*',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
        timeout: 25000,
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

async function fetchViaCurl(url, extraHeaders = {}) {
  const curlBin = isWin ? 'curl.exe' : 'curl';
  const tmpOut = path.join(
    os.tmpdir(),
    `zapret-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`
  );
  const args = [
    '-fsSL',
    '--connect-timeout',
    '8',
    '-m',
    '30',
    '-H',
    'User-Agent: Mozilla/5.0 ZapretControl/1.4',
    '-o',
    tmpOut,
  ];
  for (const [k, v] of Object.entries(extraHeaders)) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  try {
    await execFileAsync(curlBin, args, { windowsHide: true });
    const buf = fs.readFileSync(tmpOut);
    fs.rmSync(tmpOut, { force: true });
    return buf;
  } catch (err) {
    try {
      fs.rmSync(tmpOut, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

async function fetchBufferWithFallback(url, extraHeaders = {}) {
  if (isWin) {
    try {
      return await fetchViaCurl(url, extraHeaders);
    } catch {
      return await httpsGetBufferViaNode(url, extraHeaders);
    }
  }
  try {
    return await httpsGetBufferViaNode(url, extraHeaders);
  } catch {
    return await fetchViaCurl(url, extraHeaders);
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
  if (/^zapret\/custom\s*-.*\.bat$/i.test(relPosix)) return true;
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

    if (!raw.includes(0x00) && raw.includes(0x0d)) {
      const lfBuf = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      if (gitBlobSha1(lfBuf) === expectedBlobSha) return true;
    }
    return false;
  } catch {
    return false;
  }
}

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
 * Pure Node.js in-memory ZIP reader using Central Directory + zlib.inflateRawSync.
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
    const primary = atomCandidates.find((c) => c.branch === PRIMARY_BRANCH);
    if (primary) return primary;
    atomCandidates.sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || ''));
    return atomCandidates[0];
  }

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
  const archivePath = getCachedArchivePath(sha);

  if (fs.existsSync(manifestPath) && fs.existsSync(archivePath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      // ignore corrupt cache
    }
  }

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

function removeStaleManagedAppFiles(validRelPosixSet) {
  const pruneWalk = (dirRel) => {
    const absDir = path.join(REPO_ROOT, ...dirRel.split('/'));
    if (!fs.existsSync(absDir)) return;
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const relPosix = `${dirRel}/${ent.name}`;
      if (isProtectedPath(relPosix)) continue;
      const fullPath = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        pruneWalk(relPosix);
        try {
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch {
          // ignore
        }
      } else if (ent.isFile() && !validRelPosixSet.has(relPosix)) {
        try {
          fs.rmSync(fullPath, { force: true });
        } catch {
          // ignore
        }
      }
    }
  };

  for (const sub of APP_SUBDIRS_TO_SYNC) {
    pruneWalk(`app/${sub}`);
  }
}

/**
 * Fast delta-apply directly from in-memory ZIP entries.
 * Only writes files whose content actually changed, avoiding locked kernel drivers (WinDivert64.sys)
 * and eliminating slow multi-pass robocopy runs.
 */
function applyDeltaZipEntriesInMemory(entries, deferredDir) {
  cleanAccidentalNestedDirs();

  const validRelPosixSet = new Set();
  let hostSourceChanged = false;
  let updatedCount = 0;
  let deferredCount = 0;

  for (const entry of entries) {
    const relPosix = entry.relPath;
    validRelPosixSet.add(relPosix);
    if (isProtectedPath(relPosix)) continue;

    const dstPath = path.join(REPO_ROOT, ...relPosix.split('/'));
    const remoteSha = gitBlobSha1(entry.data);
    if (matchesRemoteBlob(dstPath, remoteSha)) {
      continue;
    }

    if (relPosix === 'app/host/ZapretControl.cs' || relPosix === 'app/host/app.ico') {
      hostSourceChanged = true;
    }

    // Prepare buffer (ensure UTF-8 BOM + CRLF on .cs and .ps1 for Windows csc.exe / PowerShell 5.1)
    let outBuf = entry.data;
    if (relPosix.endsWith('.cs') || relPosix.endsWith('.ps1')) {
      let rawStr = outBuf.toString('utf8');
      if (rawStr.charCodeAt(0) === 0xfeff) {
        rawStr = rawStr.slice(1);
      }
      const crlfStr = rawStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
      outBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlfStr, 'utf8')]);
    } else if (relPosix.endsWith('.bat')) {
      let rawStr = outBuf.toString('utf8');
      if (rawStr.charCodeAt(0) === 0xfeff) {
        rawStr = rawStr.slice(1);
      }
      const crlfStr = rawStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
      outBuf = Buffer.from(crlfStr, 'utf8');
    }

    try {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.writeFileSync(dstPath, outBuf);
      updatedCount++;
    } catch {
      // File locked while running: stage ONLY this locked file for post-stop copy
      if (deferredDir) {
        const stageFile = path.join(deferredDir, ...relPosix.split('/'));
        fs.mkdirSync(path.dirname(stageFile), { recursive: true });
        fs.writeFileSync(stageFile, outBuf);
        deferredCount++;
      }
    }
  }

  removeStaleManagedAppFiles(validRelPosixSet);

  return { hostSourceChanged, updatedCount, deferredCount };
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

  const entries = iterateZipBuffer(zipBuf);
  const hasAppFiles = entries.some(
    (e) => e.relPath.startsWith('app/') || e.relPath === 'ZapretControl.bat'
  );
  if (!hasAppFiles) {
    throw new Error('Выбранный архив не содержит файлов программы Zapret Control');
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

  const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-control-upd-'));
  const deferredDir = path.join(tempWorkDir, 'deferred');

  const { hostSourceChanged, deferredCount } = applyDeltaZipEntriesInMemory(entries, deferredDir);
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

  writeLocalAppUpdateState(nextUpdateState);
  lastCheckCache = { ts: 0, result: null };

  if (isWin) {
    const exePath = path.join(REPO_ROOT, 'ZapretControl.exe');
    const csPath = path.join(REPO_ROOT, 'app', 'host', 'ZapretControl.cs');
    let needRebuildExe = hostSourceChanged || !fs.existsSync(exePath);
    if (!needRebuildExe && fs.existsSync(exePath) && fs.existsSync(csPath)) {
      try {
        if (fs.statSync(csPath).mtimeMs > fs.statSync(exePath).mtimeMs + 1000) {
          needRebuildExe = true;
        }
      } catch {
        needRebuildExe = true;
      }
    }

    const applyScriptPath = path.join(os.tmpdir(), `zapret-control-restart-${Date.now()}.ps1`);
    const vbsLauncherPath = path.join(os.tmpdir(), `zapret-control-launch-${Date.now()}.vbs`);
    const psRepo = escapePsSingleQuoted(REPO_ROOT);
    const psDeferred = escapePsSingleQuoted(deferredDir);
    const psTempWork = escapePsSingleQuoted(tempWorkDir);
    const psLog = escapePsSingleQuoted(UPDATE_LOG_FILE);
    const psLock = escapePsSingleQuoted(HOST_UPDATING_LOCK_FILE);
    const currentServerPid = process.pid;
    const safePort = Number(targetPort) > 0 ? Number(targetPort) : 3847;
    const psNeedRebuild = needRebuildExe ? '$true' : '$false';
    const psHasDeferred = deferredCount > 0 ? '$true' : '$false';

    if (needRebuildExe) {
      try {
        fs.writeFileSync(HOST_UPDATING_LOCK_FILE, String(Date.now()), 'utf8');
      } catch {
        // ignore
      }
    }

    const psScript = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
$repoRoot = '${psRepo}'
$deferredDir = '${psDeferred}'
$tempWork = '${psTempWork}'
$logFile = '${psLog}'
$lockFile = '${psLock}'
$targetPort = ${safePort}
$oldServerPid = ${currentServerPid}
$needRebuildExe = ${psNeedRebuild}
$hasDeferred = ${psHasDeferred}

function Write-UpdLog([string]$msg) {
    try {
        $line = ('[{0}] {1}' -f [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff'), $msg)
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

function Test-BackendAlive([int]$port) {
    try {
        $req = [System.Net.HttpWebRequest]::Create(('http://127.0.0.1:' + $port + '/api/state'))
        $req.Timeout = 450
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return ($code -eq 200)
    } catch {
        return $false
    }
}

function Wait-PortFree([int]$port, [int]$maxWaitMs) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $maxWaitMs) {
        try {
            $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
            $l.Start()
            $l.Stop()
            return $true
        } catch {
            Start-Sleep -Milliseconds 90
        }
    }
    return $false
}

Write-UpdLog ('Restart script started (needRebuildExe=' + $needRebuildExe + ', port=' + $targetPort + ')')
Start-Sleep -Milliseconds 220

# Stop old server process if still alive
try {
    $srvProc = Get-Process -Id $oldServerPid -ErrorAction SilentlyContinue
    if ($null -ne $srvProc) {
        Stop-Process -Id $oldServerPid -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $oldServerPid -Timeout 3 -ErrorAction SilentlyContinue
    }
} catch {}

$exePath = Join-Path $repoRoot 'ZapretControl.exe'

# Fast path: if ZapretControl.exe did NOT change and is running, let its watchdog respawn the server in-place!
if (-not $needRebuildExe -and -not $hasDeferred) {
    $trayRunning = @(Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue).Count -gt 0
    if ($trayRunning) {
        for ($w = 0; $w -lt 14; $w++) {
            Start-Sleep -Milliseconds 180
            if (Test-BackendAlive $targetPort) {
                Write-UpdLog 'In-place fast backend restart succeeded via TrayHost watchdog'
                Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $tempWork -Recurse -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
                exit 0
            }
        }
        Write-UpdLog 'TrayHost appears to be an older build without watchdog; performing full host relaunch'
    }
}

# Full host relaunch path (when ZapretControl.cs changed or tray host was an older build / not running)
try {
    [System.IO.File]::WriteAllText($lockFile, 'updating')
} catch {}

# Close old --app browser window so it can never get stuck on a dead socket
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and ($_.CommandLine -like '*ui-window-v2*' -or $_.CommandLine -like '*window-profile*')
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

try {
    Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Wait-Process -Name 'ZapretControl' -Timeout 4 -ErrorAction SilentlyContinue
} catch {}

& taskkill.exe /IM winws.exe /F 2>&1 | Out-Null
Wait-PortFree $targetPort 4500 | Out-Null

if ($hasDeferred -and (Test-Path -LiteralPath $deferredDir)) {
    Get-ChildItem -LiteralPath $deferredDir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $rel = $_.FullName.Substring($deferredDir.Length).TrimStart('\\', '/')
        $dst = Join-Path $repoRoot $rel
        $dstParent = [System.IO.Path]::GetDirectoryName($dst)
        if (-not (Test-Path -LiteralPath $dstParent)) {
            New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
        }
        try { [System.IO.File]::Copy($_.FullName, $dst, $true) } catch {}
    }
}

if ($needRebuildExe -or -not (Test-Path -LiteralPath $exePath)) {
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-Path -LiteralPath $exePath)) { break }
        try {
            Remove-Item -LiteralPath $exePath -Force -ErrorAction Stop
            break
        } catch {
            Get-Process -Name 'ZapretControl' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 150
        }
    }

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
}

Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $exePath) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exePath
    $psi.Arguments = ('--relaunch-after-update --port=' + $targetPort)
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-UpdLog 'Launched ZapretControl.exe cleanly'
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

Start-Sleep -Milliseconds 300
Remove-Item -LiteralPath $tempWork -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;

    writeUtf8BomCrlf(applyScriptPath, psScript);

    // Launch via silent wscript.exe //B trampoline so child powershell.exe NEVER inherits
    // open socket handles (port 3847) from the dying server process and produces zero window flash/sounds.
    const escapedPsPathForVbs = applyScriptPath.replace(/"/g, '""');
    const vbsContent = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${escapedPsPathForVbs}""", 0, False`,
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'On Error Resume Next',
      'fso.DeleteFile WScript.ScriptFullName, True',
    ].join('\r\n');
    fs.writeFileSync(vbsLauncherPath, vbsContent, 'utf8');

    try {
      const wscriptChild = spawn('wscript.exe', ['//B', '//NoLogo', vbsLauncherPath], {
        cwd: os.tmpdir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      wscriptChild.unref();
    } catch {
      const fallbackPs = spawn(
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
      fallbackPs.unref();
    }

    return {
      ok: true,
      restarting: true,
      installedShortSha: nextUpdateState.installedShortSha,
      message: 'Обновление установлено, выполняется перезапуск...',
    };
  }

  fs.rmSync(tempWorkDir, { recursive: true, force: true });

  return {
    ok: true,
    restarting: false,
    installedShortSha: nextUpdateState.installedShortSha,
    message: 'Файлы программы успешно обновлены.',
  };
}
