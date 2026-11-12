import React, { useCallback, useEffect, useState } from 'react';
import {
  Shield,
  Gauge,
  SlidersHorizontal,
  ListFilter,
  Wrench,
  Settings,
  Power,
  RotateCw,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { api } from './api';
import type {
  AppSettings,
  FullAppState,
  GameFilterMode,
  IpsetFilterMode,
  UpdateCheckResult,
} from './types';
import { ConnectView } from './views/ConnectView';
import { TestsView } from './views/TestsView';
import { FiltersView } from './views/FiltersView';
import { ListsView } from './views/ListsView';
import { ToolsView } from './views/ToolsView';
import { UpdatesSettingsView } from './views/UpdatesSettingsView';
import { formatDuration } from './utils/metrics';

type NavTab = 'connect' | 'tests' | 'filters' | 'lists' | 'tools' | 'settings';

const PAGE_HEADERS: Record<NavTab, { title: string; subtitle: string }> = {
  connect: {
    title: 'Подключение и профили',
    subtitle: 'Прямой запуск стратегий Zapret без установки системной службы Windows',
  },
  tests: {
    title: 'Тестирование и подбор по целям',
    subtitle: 'Замер задержки и автоматический выбор лучших стратегий для Discord, YouTube, Cloudflare и GitHub',
  },
  filters: {
    title: 'Фильтры портов, IPSet и UDP-фейки',
    subtitle: 'Управление Game Filter, базой подсетей ipset-all и активными бинарными профилями',
  },
  lists: {
    title: 'Редактор списков доменов и IP',
    subtitle: 'Настройка пользовательских списков обхода и исключений с автоматическим резервным копированием',
  },
  tools: {
    title: 'Диагностика и обслуживание',
    subtitle: 'Проверка сетевого стека, очистка кэша Discord, сверка hosts и освобождение WinDivert',
  },
  settings: {
    title: 'Обновление Zapret и настройки',
    subtitle: 'Проверка новых релизов на GitHub, управление папкой zapret и параметрами автозапуска',
  },
};

export const App: React.FC = () => {
  const [tab, setTab] = useState<NavTab>('connect');
  const [state, setState] = useState<FullAppState | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState<boolean>(false);
  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);

  const notify = useCallback((msg: string, isError = false) => {
    setToast({ msg, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshState = useCallback(async () => {
    try {
      const next = await api.getState();
      setState(next);
      return next;
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
      return null;
    }
  }, [notify]);

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

  const navItems: Array<{
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: string;
    badgeTone?: 'update';
  }> = [
    {
      id: 'connect',
      label: 'Подключение',
      icon: <Shield size={17} strokeWidth={1.9} />,
      badge: String(state.strategies.length),
    },
    {
      id: 'tests',
      label: 'Тесты и цели',
      icon: <Gauge size={17} strokeWidth={1.9} />,
      badge: state.testJob.running ? `${state.testJob.progressPct}%` : undefined,
    },
    {
      id: 'filters',
      label: 'Фильтры и фейки',
      icon: <SlidersHorizontal size={17} strokeWidth={1.9} />,
    },
    {
      id: 'lists',
      label: 'Списки доменов',
      icon: <ListFilter size={17} strokeWidth={1.9} />,
      badge: String(state.listsMeta.length),
    },
    {
      id: 'tools',
      label: 'Инструменты',
      icon: <Wrench size={17} strokeWidth={1.9} />,
    },
    {
      id: 'settings',
      label: 'Обновления',
      icon: <Settings size={17} strokeWidth={1.9} />,
      badge: updateInfo?.updateAvailable ? `v${updateInfo.latestVersion}` : `v${state.zapretInfo.localVersion}`,
      badgeTone: updateInfo?.updateAvailable ? 'update' : undefined,
    },
  ];

  const headerMeta = PAGE_HEADERS[tab];

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
            <div className="brand-sub">Ядро v{state.zapretInfo.localVersion}</div>
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
              {item.badge && (
                <span className={`nav-badge ${item.badgeTone === 'update' ? 'update' : ''}`}>
                  {item.badge}
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
            <h1 className="page-title">{headerMeta.title}</h1>
            <p className="page-subtitle">{headerMeta.subtitle}</p>
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
              nowMs={nowMs}
              busy={busy}
              onTogglePower={handleTogglePower}
              onSelectStrategy={handleSelectStrategy}
              onQuickGameMode={(mode) => handleSaveGameFilter({ mode })}
              onQuickIpsetMode={handleSetIpsetMode}
              onRunQuickTest={(strats) => handleStartTests(strats)}
              onNavigate={(nextTab) => setTab(nextTab as NavTab)}
            />
          )}

          {tab === 'tests' && (
            <TestsView
              state={state}
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
