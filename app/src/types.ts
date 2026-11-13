export type GameFilterMode = 'disabled' | 'all' | 'tcp' | 'udp';
export type IpsetFilterMode = 'none' | 'loaded' | 'any';
export type TargetCategory = string;
export type ConnectLayoutMode = 'split' | 'stacked';

export interface AppSettings {
  zapretDir: string;
  selectedStrategy: string;
  activeProfileId: string;
  favoriteStrategies: string[];
  autoStartStrategyOnLaunch: boolean;
  launchOnWindowsStartup: boolean;
  startMinimizedToTray: boolean;
  minimizeToTrayOnClose: boolean;
  autoRestartOnFilterChange: boolean;
  autoRestartOnCrash: boolean;
  autoCheckUpdates: boolean;
  showWinwsConsole: boolean;
  showBestStrategyCards: boolean;
  connectLayout: ConnectLayoutMode;
  developerMode: boolean;
}

export interface UserProfile {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  strategy: string;
  gameFilterMode: GameFilterMode;
  gameFilterTcp: string;
  gameFilterUdp: string;
  ipsetMode: IpsetFilterMode;
  discordFakeBin: string | null;
  gameFakeBin: string | null;
}

export interface RuntimeState {
  running: boolean;
  activeStrategy: string | null;
  startedAt: number | null;
  pid: number | null;
  appliedGameFilter: string;
  appliedIpsetMode: string;
  expandedCommand: string | null;
  autoRestartsCount?: number;
  lastRecoveryAt?: number | null;
  lastExitReason?: string | null;
  modeNote: string | null;
}

export interface ZapretInfo {
  valid: boolean;
  hasWinwsBinary: boolean;
  localVersion: string;
  zapretPath: string;
  lastModified: string | null;
  strategyCount: number;
  binCount: number;
  links: {
    upstreamRepo: string;
    latestRelease: string;
    coreRepo: string;
    userRepo: string;
  };
}

export interface StrategyItem {
  fileName: string;
  displayName: string;
  isCustom?: boolean;
  sizeBytes: number;
  modifiedAt: string;
  engineSummary: string;
  usesGameFilter: boolean;
  usesIpset: boolean;
  commandPreview: string;
}

export interface BinItem {
  name: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface FiltersState {
  gameFilter: {
    mode: GameFilterMode;
    tcpRange: string;
    udpRange: string;
    effectiveTcp?: string;
    effectiveUdp?: string;
  };
  ipsetFilter: {
    mode: IpsetFilterMode;
    entriesCount: number;
    hasBackup: boolean;
    backupEntriesCount: number;
  };
  activeFakes: {
    discordCurrent: string | null;
    gameCurrent: string | null;
    availableBins: BinItem[];
  };
}

export interface ListMeta {
  id: string;
  title: string;
  subtitle: string;
  relPath: string;
  kind: 'domains' | 'ipset' | 'targets';
  isUser: boolean;
  exists: boolean;
  entriesCount: number;
  sizeBytes: number;
  hasBackup: boolean;
}

export interface ListDocument extends ListMeta {
  content: string;
}

export interface TargetCategoryMeta {
  id: string;
  label: string;
  shortLabel: string;
  count: number;
  isPingOnlyGroup: boolean;
}

export interface TargetTestItem {
  id: string;
  category: TargetCategory;
  isPingOnly: boolean;
  http: string;
  tls12: string;
  tls13: string;
  pingMs: number | null;
}

export interface CategoryScore {
  ok: number;
  total: number;
  pct: number;
  avgPingMs: number | null;
}

export interface StrategyTestMetrics {
  fileName: string;
  displayName: string;
  testType: string;
  overallScore: number;
  passedChecks: number;
  totalChecks: number;
  avgPingMs: number | null;
  categoryScores: Record<string, CategoryScore | undefined>;
  targets: TargetTestItem[];
}

export interface TestRunReport {
  fileName: string;
  timestamp: string | null;
  strategies: StrategyTestMetrics[];
}

export interface TestHistoryEntry {
  fileName: string;
  label: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface TestJobState {
  running: boolean;
  aborted: boolean;
  mode?: 'standard' | 'express';
  phaseLabel?: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  currentStrategy: string | null;
  completedCount: number;
  totalCount: number;
  progressPct: number;
  results: StrategyTestMetrics[];
  savedFileName: string | null;
  error: string | null;
}

export interface LocalAppUpdateState {
  installedSha: string | null;
  installedShortSha: string | null;
  installedBranch: string | null;
  commitDate: string | null;
  commitMessage: string;
}

export interface AppProgramUpdateResult {
  repo: string;
  currentShortSha: string | null;
  currentDate: string | null;
  latestSha: string;
  latestShortSha: string;
  branch: string;
  publishedAt: string | null;
  commitMessage: string;
  changedFilesCount: number;
  updateAvailable: boolean;
  htmlUrl: string;
  checkedAt: string;
}

export interface FullAppState {
  platform: {
    os: string;
    arch: string;
  };
  settings: AppSettings;
  runtime: RuntimeState;
  zapretInfo: ZapretInfo;
  strategies: StrategyItem[];
  profiles: UserProfile[];
  activeProfileId: string;
  filters: FiltersState;
  listsMeta: ListMeta[];
  targetCategories: TargetCategoryMeta[];
  testHistory: TestHistoryEntry[];
  latestTestRun: TestRunReport | null;
  testJob: TestJobState;
  appUpdateState?: LocalAppUpdateState;
  serverBootId?: string;
  zapretFingerprint: string;
}

export interface UpdateCheckResult {
  localVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  publishedAt: string | null;
  releaseName: string;
  releaseNotes: string;
  htmlUrl: string;
  downloadUrl: string;
  assetName: string | null;
  checkedAt: string;
}

export interface DiagnosticCheck {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  fixAction?: 'fix-windivert' | 'clean-lists' | 'enable-timestamps' | null;
}

export interface HostsCheckReport {
  systemHostsPath: string;
  upToDate: boolean;
  totalRemoteEntries: number;
  missingCount: number;
  missingLines: string[];
  remoteRaw: string;
}

export interface QuickProbeItem {
  category: string;
  label: string;
  shortLabel: string;
  targetId: string;
  ok: boolean;
  pingMs: number | null;
}

export interface QuickProbeResult {
  checkedAt: string;
  bypassRunning: boolean;
  activeStrategy: string | null;
  items: QuickProbeItem[];
}

export interface SmartListAddResult {
  list: ListDocument;
  added: string[];
  skippedDuplicates: string[];
  coveredByBase: string[];
  invalid: string[];
  message: string;
  state: FullAppState;
}

export interface SiteDiagnosisReport {
  domain: string;
  verdictStatus: 'ok' | 'warn' | 'error';
  summary: string;
  dns: {
    ok: boolean;
    hasStubIp: boolean;
    systemIps: string[];
    dohIps: string[];
  };
  lists: {
    inBypassList: boolean;
    inExcludeList: boolean;
    inUserBypass: boolean;
    inUserExclude: boolean;
    label: string;
    matchedRule: string | null;
  };
  tcp: {
    ok: boolean;
    pingMs: number | null;
  };
  tls: {
    ok: boolean;
    httpOk: boolean;
  };
  checkedAt: string;
}

export interface CustomStrategySource {
  fileName: string;
  isCustom: boolean;
  cleanTitle: string;
  winwsArgsText: string;
}

export interface CustomStrategyParams {
  tcpDesync: string;
  tcpRepeats: number;
  fooling: string;
  autottl: string;
  tlsFakeBin: string;
  quicFakeBin: string;
  quicRepeats: number;
  includeDiscordVoice: boolean;
  includeGameFilter: boolean;
}

