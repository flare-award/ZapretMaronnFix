import type {
  AppSettings,
  DiagnosticCheck,
  FullAppState,
  GameFilterMode,
  HostsCheckReport,
  IpsetFilterMode,
  ListDocument,
  TestJobState,
  TestRunReport,
  UpdateCheckResult,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Ошибка запроса (${res.status})`);
  }
  return data as T;
}

export const api = {
  getState: () => request<FullAppState>('/api/state'),

  startRunner: (strategy?: string) =>
    request<FullAppState>('/api/runner/start', {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    }),

  stopRunner: () =>
    request<FullAppState>('/api/runner/stop', {
      method: 'POST',
    }),

  restartRunner: () =>
    request<FullAppState>('/api/runner/restart', {
      method: 'POST',
    }),

  updateSettings: (settings: Partial<AppSettings>) =>
    request<FullAppState>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  setGameFilter: (payload: { mode?: GameFilterMode; tcpRange?: string; udpRange?: string }) =>
    request<FullAppState>('/api/filters/game', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  setIpsetMode: (mode: IpsetFilterMode) =>
    request<FullAppState>('/api/filters/ipset', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  updateRemoteIpset: () =>
    request<{ updatedEntries: number; state: FullAppState }>('/api/filters/ipset-update', {
      method: 'POST',
    }),

  setActiveFake: (target: 'discord' | 'game', binFileName: string) =>
    request<FullAppState>('/api/filters/fakes', {
      method: 'POST',
      body: JSON.stringify({ target, binFileName }),
    }),

  getList: (id: string) => request<ListDocument>(`/api/lists/${encodeURIComponent(id)}`),

  saveList: (id: string, content: string, autoClean = false) =>
    request<{ list: ListDocument; state: FullAppState }>(`/api/lists/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, autoClean }),
    }),

  saveBackups: () =>
    request<{ saved: string[]; timestamp: string; state: FullAppState }>('/api/backups/save', {
      method: 'POST',
    }),

  restoreBackups: () =>
    request<{ restored: string[]; timestamp: string; state: FullAppState }>('/api/backups/restore', {
      method: 'POST',
    }),

  checkUpdates: () => request<UpdateCheckResult>('/api/updates/check'),

  getTestHistoryReport: (fileName: string) =>
    request<TestRunReport>(`/api/tests/history/${encodeURIComponent(fileName)}`),

  startTests: (payload: { strategies?: string[]; categories?: string[] }) =>
    request<{ testJob: TestJobState }>('/api/tests/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  stopTests: () =>
    request<{ testJob: TestJobState }>('/api/tests/stop', {
      method: 'POST',
    }),

  getDiagnostics: () => request<{ checks: DiagnosticCheck[]; checkedAt: string }>('/api/diagnostics'),

  fixWinDivert: () => request<{ ok: boolean; actions: string[] }>('/api/diagnostics/fix-windivert', { method: 'POST' }),

  clearDiscordCache: () =>
    request<{ ok: boolean; cleared: string[] }>('/api/diagnostics/clear-discord-cache', { method: 'POST' }),

  checkHosts: () => request<HostsCheckReport>('/api/diagnostics/check-hosts'),

  openZapretFolder: () => request<{ opened: boolean; path: string; note?: string }>('/api/system/open-folder', { method: 'POST' }),
};
