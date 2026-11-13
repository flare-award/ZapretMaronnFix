import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Shield,
  Bookmark,
  Gauge,
  SlidersHorizontal,
  ListFilter,
  Wrench,
  Settings,
  Power,
  RotateCw,
  AlertCircle,
  CheckCircle2,
  ArrowUpCircle,
} from 'lucide-react';
import { api, type CreateProfilePayload } from './api';
import type {
  AppSettings,
  FullAppState,
  GameFilterMode,
  IpsetFilterMode,
  TestRunReport,
  UpdateCheckResult,
  UserProfile,
} from './types';
import { ConnectView } from './views/ConnectView';
import { ProfilesView } from './views/ProfilesView';
import { TestsView } from './views/TestsView';
import { FiltersView } from './views/FiltersView';
import { ListsView } from './views/ListsView';
import { ToolsView } from './views/ToolsView';
import { UpdatesSettingsView } from './views/UpdatesSettingsView';
import { formatDuration } from './utils/metrics';

type NavTab = 'connect' | 'profiles' | 'tests' | 'filters' | 'lists' | 'tools' | 'settings';

const TAB_LABELS: Record<NavTab, string> = {
  connect: 'Подключение',
  profiles: 'Профили',
  tests: 'Тесты и цели',
  filters: 'Фильтры и фейки',
  lists: 'Списки доменов',
  tools: 'Инструменты',
  settings: 'Настройки',
};

export const App: React.FC = () => {
  const [tab, setTab] = useState<NavTab>('connect');
  const [state, setState] = useState<FullAppState | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);

  // Lifted test history state so switching tabs never resets test results
  const [selectedHistoryFile, setSelectedHistoryFile] = useState<string>('latest');
  const [customHistoryReport, setCustomHistoryReport] = useState<TestRunReport | null>(null);

  const notify = useCallback((msg: string, isError = false) => {
    setToast({ msg, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshState = useCallback(
    async (silent = false) => {
      try {
        const next = await api.getState();
        setState(next);
        return next;
      } catch (err) {
        if (!silent) {
          notify(err instanceof Error ? err.message : String(err), true);
        }
        return null;
      }
    },
    [notify]
  );

  const handleCheckUpdate = useCallback(
    async (silent = false) => {
      setCheckingUpdate(true);
      try {
        const res = await api.checkUpdates();
        setUpdateInfo(res);
        if (!silent) {
          notify(
            res.updateAvailable
              ? `Доступна новая версия Zapret v${res.latestVersion}`
              : `Установлена актуальная версия Zapret v${res.localVersion}`
          );
        }
      } catch (err) {
        if (!silent) notify(err instanceof Error ? err.message : String(err), true);
      } finally {
        setCheckingUpdate(false);
      }
    },
    [notify]
  );

  // Initial load + optional background update check
  useEffect(() => {
    refreshState().then((initial) => {
      if (initial?.settings.autoCheckUpdates) {
        handleCheckUpdate(true);
      }
    });
  }, [refreshState, handleCheckUpdate]);

  // Live SSE subscription to /api/events for instant UI updates when files in zapret/ or tray actions change state
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events');
      const onStatePush = (evt: MessageEvent) => {
        try {
          const nextState = JSON.parse(evt.data) as FullAppState;
          if (nextState && nextState.settings) {
            setState(nextState);
          }
        } catch {
          refreshState(true);
        }
      };
      es.addEventListener('state', onStatePush as EventListener);
      es.onmessage = onStatePush;
    } catch {
      // fallback if EventSource is unavailable
    }
    return () => {
      if (es) es.close();
    };
  }, [refreshState]);

  // Load selected historical report and preserve across tab navigation
  useEffect(() => {
    if (selectedHistoryFile === 'latest') {
      setCustomHistoryReport(null);
      return;
    }
    let cancelled = false;
    api
      .getTestHistoryReport(selectedHistoryFile)
      .then((rep) => {
        if (!cancelled) setCustomHistoryReport(rep);
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedHistoryFile('latest');
          setCustomHistoryReport(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHistoryFile, state?.zapretFingerprint]);

  const activeReport: TestRunReport | null = useMemo(() => {
    if (!state) return null;
    if (state.testJob.running && state.testJob.results.length > 0) {
      return {
        fileName: 'live-run',
        timestamp: state.testJob.startedAt ? new Date(state.testJob.startedAt).toISOString() : null,
        strategies: state.testJob.results,
      };
    }
    if (selectedHistoryFile !== 'latest' && customHistoryReport) {
      return customHistoryReport;
    }
    return state.latestTestRun || null;
  }, [state, selectedHistoryFile, customHistoryReport]);

  // Uptime clock tick only when running
  useEffect(() => {
    if (!state?.runtime.running) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state?.runtime.running]);

  // Poll test progress only while test suite is active
  useEffect(() => {
    if (!state?.testJob.running) return;
    const id = setInterval(() => {
      api
        .getState()
        .then((next) => setState(next))
        .catch(() => {});
    }, 550);
    return () => clearInterval(id);
  }, [state?.testJob.running]);

  const handleTogglePower = async () => {
    if (!state) return;
    setBusy(true);
    try {
      if (state.runtime.running) {
        const next = await api.stopRunner();
        setState(next);
        notify('Обход остановлен');
      } else {
        const next = await api.startRunner(state.settings.selectedStrategy);
        setState(next);
        setNowMs(Date.now());
        notify(`Стратегия "${state.settings.selectedStrategy.replace(/\.bat$/i, '')}" запущена`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectStrategy = async (fileName: string, runImmediately = false) => {
    if (!state) return;
    setBusy(true);
    try {
      if (runImmediately) {
        const next = await api.startRunner(fileName);
        setState(next);
        setNowMs(Date.now());
        notify(`Запущена стратегия "${fileName.replace(/\.bat$/i, '')}"`);
      } else {
        const next = await api.updateSettings({ selectedStrategy: fileName });
        setState(next);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleActivateProfile = async (profileId: string, startNow = false) => {
    if (!state) return;
    setBusy(true);
    try {
      const next = await api.activateProfile(profileId, startNow);
      setState(next);
      if (startNow) setNowMs(Date.now());
      const found = next.profiles.find((p) => p.id === profileId);
      notify(
        startNow
          ? `Профиль «${found?.name || profileId}» применён и запущен`
          : `Активирован профиль «${found?.name || profileId}»`
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateProfile = async (payload: CreateProfilePayload): Promise<boolean> => {
    setBusy(true);
    try {
      const next = await api.createProfile(payload);
      setState(next);
      notify(`Профиль «${payload.name}» сохранён`);
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateProfile = async (id: string, payload: Partial<UserProfile>): Promise<boolean> => {
    setBusy(true);
    try {
      const next = await api.updateProfile(id, payload);
      setState(next);
      notify('Профиль обновлён');
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProfile = async (id: string) => {
    setBusy(true);
    try {
      const next = await api.deleteProfile(id);
      setState(next);
      notify('Профиль удалён');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveGameFilter = async (payload: {
    mode?: GameFilterMode;
    tcpRange?: string;
    udpRange?: string;
  }) => {
    setBusy(true);
    try {
      const next = await api.setGameFilter(payload);
      setState(next);
      notify('Параметры Game Filter обновлены');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleSetIpsetMode = async (mode: IpsetFilterMode) => {
    setBusy(true);
    try {
      const next = await api.setIpsetMode(mode);
      setState(next);
      notify(`Режим IPSet переключён на ${mode.toUpperCase()}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateRemoteIpset = async () => {
    setBusy(true);
    try {
      const res = await api.updateRemoteIpset();
      setState(res.state);
      notify(`База подсетей IPSet обновлена (${res.updatedEntries} записей)`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleSetActiveFake = async (target: 'discord' | 'game', binFileName: string) => {
    setBusy(true);
    try {
      const next = await api.setActiveFake(target, binFileName);
      setState(next);
      notify(`Активный пакет ${target === 'discord' ? 'Discord' : 'Game'} заменён на ${binFileName}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleStartTests = async (strategiesList?: string[], categories?: string[]) => {
    try {
      setSelectedHistoryFile('latest');
      await api.startTests({ strategies: strategiesList, categories });
      await refreshState();
      notify('Запущено тестирование стратегий');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleStopTests = async () => {
    try {
      await api.stopTests();
      await refreshState();
      notify('Тестирование остановлено');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleUpdateSettings = async (patch: Partial<AppSettings>) => {
    setBusy(true);
    try {
      const next = await api.updateSettings(patch);
      setState(next);
      notify('Настройки сохранены');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--m3-text-secondary)',
          gap: '10px',
        }}
      >
        <RotateCw size={18} />
        <span>Инициализация Zapret Control...</span>
      </div>
    );
  }

  const activeProfile =
    state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0] || null;

  const navItems: Array<{
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: string;
    showUpdateIcon?: boolean;
  }> = [
    {
      id: 'connect',
      label: TAB_LABELS.connect,
      icon: <Shield size={17} strokeWidth={1.9} />,
      badge: String(state.strategies.length),
    },
    {
      id: 'profiles',
      label: TAB_LABELS.profiles,
      icon: <Bookmark size={17} strokeWidth={1.9} />,
      badge: String(state.profiles.length),
    },
    {
      id: 'tests',
      label: TAB_LABELS.tests,
      icon: <Gauge size={17} strokeWidth={1.9} />,
      badge: state.testJob.running ? `${state.testJob.progressPct}%` : undefined,
    },
    {
      id: 'filters',
      label: TAB_LABELS.filters,
      icon: <SlidersHorizontal size={17} strokeWidth={1.9} />,
    },
    {
      id: 'lists',
      label: TAB_LABELS.lists,
      icon: <ListFilter size={17} strokeWidth={1.9} />,
      badge: String(state.listsMeta.length),
    },
    {
      id: 'tools',
      label: TAB_LABELS.tools,
      icon: <Wrench size={17} strokeWidth={1.9} />,
    },
    {
      id: 'settings',
      label: TAB_LABELS.settings,
      icon: <Settings size={17} strokeWidth={1.9} />,
      showUpdateIcon: Boolean(updateInfo?.updateAvailable),
    },
  ];

  return (
    <div className="app-shell">
      {/* Left Navigation Drawer */}
      <aside className="sidebar">
        <div className="brand-header">
          <div className="brand-mark">
            <Shield size={18} strokeWidth={2} />
          </div>
          <div className="brand-meta">
            <div className="brand-title">Zapret Control</div>
            <div className="brand-sub">v{state.zapretInfo.localVersion}</div>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.icon}
              <span className="nav-item-label">{item.label}</span>
              {item.badge && <span className="nav-badge">{item.badge}</span>}
              {item.showUpdateIcon && (
                <span
                  className="nav-update-icon"
                  title={
                    updateInfo
                      ? `Доступна новая версия Zapret v${updateInfo.latestVersion}`
                      : 'Доступно обновление Zapret'
                  }
                >
                  <ArrowUpCircle size={14} strokeWidth={2.1} />
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="status-inline">
            <span
              className={`status-dot ${
                state.testJob.running ? 'testing' : state.runtime.running ? 'active' : ''
              }`}
            />
            <span
              style={{
                fontWeight: 600,
                fontSize: '12.5px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {state.testJob.running
                ? 'Идёт проверка'
                : state.runtime.running
                  ? 'Запущен'
                  : 'Остановлен'}
            </span>
          </div>
          <div
            style={{
              fontSize: '11.5px',
              color: 'var(--m3-text-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Профиль: {activeProfile ? activeProfile.name : 'Основной'}
          </div>
          <div
            className="mono"
            style={{
              fontSize: '11px',
              color: 'var(--m3-text-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {state.runtime.running && state.runtime.activeStrategy
              ? `${state.runtime.activeStrategy.replace(/\.bat$/i, '')} / ${formatDuration(state.runtime.startedAt, nowMs)}`
              : state.settings.selectedStrategy.replace(/\.bat$/i, '')}
          </div>
        </div>
      </aside>

      {/* Right Main Area */}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-titles">
            <h1 className="page-title">{TAB_LABELS[tab]}</h1>
          </div>

          <div className="topbar-actions">
            {tab !== 'connect' && (
              <button
                type="button"
                className={`btn ${state.runtime.running ? 'btn-danger-tonal' : 'btn-primary'}`}
                disabled={busy || state.testJob.running}
                onClick={handleTogglePower}
              >
                <Power size={14} />
                {state.runtime.running ? 'Остановить' : 'Включить обход'}
              </button>
            )}
          </div>
        </header>

        <div className="scroll-content">
          {tab === 'connect' && (
            <ConnectView
              state={state}
              activeReport={activeReport}
              nowMs={nowMs}
              busy={busy}
              onTogglePower={handleTogglePower}
              onSelectStrategy={handleSelectStrategy}
              onSelectProfile={(profileId) => handleActivateProfile(profileId, false)}
              onQuickGameMode={(mode) => handleSaveGameFilter({ mode })}
              onQuickIpsetMode={handleSetIpsetMode}
              onRunQuickTest={(strats) => handleStartTests(strats)}
              onNavigate={(nextTab) => setTab(nextTab as NavTab)}
            />
          )}

          {tab === 'profiles' && (
            <ProfilesView
              state={state}
              busy={busy}
              onActivateProfile={handleActivateProfile}
              onCreateProfile={handleCreateProfile}
              onUpdateProfile={handleUpdateProfile}
              onDeleteProfile={handleDeleteProfile}
            />
          )}

          {tab === 'tests' && (
            <TestsView
              state={state}
              activeReport={activeReport}
              selectedHistoryFile={selectedHistoryFile}
              onSelectHistoryFile={setSelectedHistoryFile}
              busy={busy}
              onStartTests={(cats) => handleStartTests(undefined, cats)}
              onStopTests={handleStopTests}
              onApplyStrategy={handleSelectStrategy}
            />
          )}

          {tab === 'filters' && (
            <FiltersView
              state={state}
              busy={busy}
              onSaveGameFilter={handleSaveGameFilter}
              onSetIpsetMode={handleSetIpsetMode}
              onUpdateRemoteIpset={handleUpdateRemoteIpset}
              onSetActiveFake={handleSetActiveFake}
            />
          )}

          {tab === 'lists' && (
            <ListsView state={state} onStateUpdated={setState} onNotify={notify} />
          )}

          {tab === 'tools' && <ToolsView onNotify={notify} />}

          {tab === 'settings' && (
            <UpdatesSettingsView
              state={state}
              updateInfo={updateInfo}
              checkingUpdate={checkingUpdate}
              onCheckUpdate={() => handleCheckUpdate(false)}
              onUpdateSettings={handleUpdateSettings}
              onStateUpdated={setState}
              onNotify={notify}
            />
          )}
        </div>
      </main>

      {toast && (
        <div className={`toast-banner ${toast.isError ? 'error' : ''}`}>
          {toast.isError ? (
            <AlertCircle size={16} />
          ) : (
            <CheckCircle2 size={16} color="var(--m3-success)" />
          )}
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
};
