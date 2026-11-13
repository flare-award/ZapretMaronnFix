export type GameFilterMode = 'disabled' | 'all' | 'tcp' | 'udp';
export type IpsetFilterMode = 'none' | 'loaded' | 'any';
export type TargetCategory = 'discord' | 'youtube' | 'google' | 'cloudflare' | 'github' | 'dns' | 'custom';
export type ConnectLayoutMode = 'split' | 'stacked';

export interface AppSettings {
  zapretDir: string;
  selectedStrategy: string;
  activeProfileId: string;
  autoStartStrategyOnLaunch: boolean;
  launchOnWindowsStartup: boolean;
  startMinimizedToTray: boolean;
  minimizeToTrayOnClose: boolean;
  autoRestartOnFilterChange: boolean;
  autoCheckUpdates: boolean;
  showWinwsConsole: boolean;
  showBestStrategyCards: boolean;
  connectLayout: ConnectLayoutMode;
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
  categoryScores: Partial<Record<TargetCategory, CategoryScore>>;
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
  testHistory: TestHistoryEntry[];
  latestTestRun: TestRunReport | null;
  testJob: TestJobState;
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
}

export interface HostsCheckReport {
  systemHostsPath: string;
  upToDate: boolean;
  totalRemoteEntries: number;
  missingCount: number;
  missingLines: string[];
  remoteRaw: string;
}
