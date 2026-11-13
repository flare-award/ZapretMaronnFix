import React, { useEffect, useMemo, useState } from 'react';
import {
  Power,
  Search,
  Gauge,
  ArrowUpDown,
  Gamepad2,
  Network,
  Terminal,
  X,
  Check,
  Bookmark,
  Star,
  Activity,
  RefreshCw,
  Plus,
  Copy,
  Pencil,
  Trash2,
  Save,
  Sliders,
  Code2,
} from 'lucide-react';
import { api } from '../api';
import type {
  CustomStrategyParams,
  FullAppState,
  GameFilterMode,
  IpsetFilterMode,
  QuickProbeResult,
  StrategyItem,
  TestRunReport,
} from '../types';
import {
  buildMetricsLookup,
  classifyPingSpeed,
  classifyScoreTone,
  formatDuration,
  getGoalLabel,
  getGoalMetrics,
  GoalFilter,
  SortOption,
  sortStrategiesWithMetrics,
  stripBatExtension,
} from '../utils/metrics';
import { SeamlessSelect } from '../components/SeamlessSelect';
import { ModalBackdrop } from '../components/ModalBackdrop';

interface ConnectViewProps {
  state: FullAppState;
  activeReport: TestRunReport | null;
  nowMs: number;
  busy: boolean;
  onTogglePower: () => void;
  onSelectStrategy: (fileName: string, runImmediately?: boolean) => void;
  onToggleFavorite: (fileName: string) => void;
  onSelectProfile: (profileId: string) => void;
  onQuickGameMode: (mode: GameFilterMode) => void;
  onQuickIpsetMode: (mode: IpsetFilterMode) => void;
  onRunQuickTest: (strategies?: string[]) => void;
  onStateUpdated: (next: FullAppState) => void;
  onNotify: (msg: string, isError?: boolean) => void;
  onNavigate: (tab: string) => void;
}

const DEFAULT_BUILDER_PARAMS: CustomStrategyParams = {
  tcpDesync: 'fake,multisplit',
  tcpRepeats: 6,
  fooling: 'ts',
  autottl: 'off',
  tlsFakeBin: 'tls_clienthello_www_google_com.bin',
  quicFakeBin: 'quic_initial_www_google_com.bin',
  quicRepeats: 8,
  includeDiscordVoice: true,
  includeGameFilter: true,
};

export const ConnectView: React.FC<ConnectViewProps> = ({
  state,
  activeReport,
  nowMs,
  busy,
  onTogglePower,
  onSelectStrategy,
  onToggleFavorite,
  onSelectProfile,
  onQuickGameMode,
  onQuickIpsetMode,
  onRunQuickTest,
  onStateUpdated,
  onNotify,
  onNavigate,
}) => {
  const [search, setSearch] = useState('');
  const [goal, setGoal] = useState<GoalFilter>('all');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [inspectStrategy, setInspectStrategy] = useState<StrategyItem | null>(null);

  // Quick Live Availability Probe (#1)
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<QuickProbeResult | null>(null);

  // Safe Custom Strategy Builder (#12 - Developer Mode)
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderSaving, setBuilderSaving] = useState(false);
  const [builderEditFile, setBuilderEditFile] = useState<string | null>(null);
  const [builderTitle, setBuilderTitle] = useState('');
  const [builderMode, setBuilderMode] = useState<'visual' | 'raw'>('visual');
  const [builderParams, setBuilderParams] = useState<CustomStrategyParams>(DEFAULT_BUILDER_PARAMS);
  const [builderRawArgs, setBuilderRawArgs] = useState('');

  const { runtime, settings, strategies, profiles, activeProfileId, filters, targetCategories, testJob } = state;
  const devMode = Boolean(settings.developerMode);
  const favoritesSet = useMemo(
    () => new Set(settings.favoriteStrategies || []),
    [settings.favoriteStrategies]
  );
  const metricsLookup = useMemo(() => buildMetricsLookup(activeReport), [activeReport]);

  useEffect(() => {
    if (onlyFavorites && favoritesSet.size === 0) {
      setOnlyFavorites(false);
    }
  }, [onlyFavorites, favoritesSet.size]);

  const goalOptions = useMemo(() => {
    const serviceCats = targetCategories.filter((c) => c.id !== 'dns');
    return ['all', ...serviceCats.map((c) => c.id)];
  }, [targetCategories]);

  useEffect(() => {
    if (goal !== 'all' && !goalOptions.includes(goal)) {
      setGoal('all');
    }
  }, [goal, goalOptions]);

  const pillCategories = useMemo(() => {
    const base = targetCategories.filter((c) => c.id !== 'dns' && c.id !== 'google');
    return base.length > 0
      ? base
      : [
          { id: 'discord', label: 'Discord', shortLabel: 'Discord', count: 0, isPingOnlyGroup: false },
          { id: 'youtube', label: 'YouTube', shortLabel: 'YT', count: 0, isPingOnlyGroup: false },
          { id: 'cloudflare', label: 'Cloudflare', shortLabel: 'CF', count: 0, isPingOnlyGroup: false },
          { id: 'github', label: 'GitHub', shortLabel: 'GH', count: 0, isPingOnlyGroup: false },
        ];
  }, [targetCategories]);

  const currentStrategyObj = useMemo(
    () =>
      strategies.find((s) => s.fileName === (runtime.activeStrategy || settings.selectedStrategy)) ||
      strategies[0] ||
      null,
    [strategies, runtime.activeStrategy, settings.selectedStrategy]
  );

  const filteredStrategies = useMemo(() => {
    const q = search.trim().toLowerCase();
    let base = q
      ? strategies.filter(
          (s) =>
            stripBatExtension(s.fileName).toLowerCase().includes(q) ||
            s.displayName.toLowerCase().includes(q) ||
            (devMode && s.engineSummary.toLowerCase().includes(q))
        )
      : strategies;
    if (onlyFavorites) {
      base = base.filter((s) => favoritesSet.has(s.fileName));
    }
    return sortStrategiesWithMetrics(base, metricsLookup, goal, sortBy, favoritesSet);
  }, [strategies, search, metricsLookup, goal, sortBy, devMode, onlyFavorites, favoritesSet]);

  const tlsBinOptions = useMemo(() => {
    const bins = filters.activeFakes.availableBins.filter((b) =>
      b.fileName.toLowerCase().startsWith('tls_clienthello')
    );
    const source = bins.length > 0 ? bins : filters.activeFakes.availableBins;
    return source.map((b) => ({ value: b.fileName, label: b.fileName }));
  }, [filters.activeFakes.availableBins]);

  const quicBinOptions = useMemo(() => {
    const bins = filters.activeFakes.availableBins.filter((b) =>
      b.fileName.toLowerCase().startsWith('quic_initial')
    );
    const source = bins.length > 0 ? bins : filters.activeFakes.availableBins;
    return source.map((b) => ({ value: b.fileName, label: b.fileName }));
  }, [filters.activeFakes.availableBins]);

  const handleQuickProbe = async () => {
    setProbing(true);
    try {
      const res = await api.runQuickProbe();
      setProbeResult(res);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setProbing(false);
    }
  };

  const openNewBuilder = () => {
    setBuilderEditFile(null);
    setBuilderTitle('Моя стратегия');
    setBuilderMode('visual');
    setBuilderParams({
      ...DEFAULT_BUILDER_PARAMS,
      tlsFakeBin: tlsBinOptions[0]?.value || DEFAULT_BUILDER_PARAMS.tlsFakeBin,
      quicFakeBin: quicBinOptions[0]?.value || DEFAULT_BUILDER_PARAMS.quicFakeBin,
    });
    setBuilderRawArgs('');
    setBuilderOpen(true);
  };

  const openCloneOrEditInBuilder = async (strat: StrategyItem) => {
    try {
      const src = await api.getCustomStrategySource(strat.fileName);
      if (strat.isCustom) {
        setBuilderEditFile(strat.fileName);
        setBuilderTitle(src.cleanTitle);
      } else {
        setBuilderEditFile(null);
        setBuilderTitle(`${src.cleanTitle} (моя)`.slice(0, 40));
      }
      setBuilderMode('raw');
      setBuilderRawArgs(src.winwsArgsText);
      setBuilderOpen(true);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleSaveCustomStrategy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!builderTitle.trim()) return;
    setBuilderSaving(true);
    try {
      const res = await api.saveCustomStrategy({
        title: builderTitle.trim(),
        previousFileName: builderEditFile,
        mode: builderMode,
        params: builderMode === 'visual' ? builderParams : undefined,
        winwsArgsText: builderMode === 'raw' ? builderRawArgs : undefined,
        selectAfterSave: true,
      });
      onStateUpdated(res.state);
      setBuilderOpen(false);
      onNotify(`Сохранена стратегия ${stripBatExtension(res.fileName)}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBuilderSaving(false);
    }
  };

  const handleDeleteCustomStrategy = async (fileName: string) => {
    try {
      const res = await api.deleteCustomStrategy(fileName);
      onStateUpdated(res.state);
      onNotify(`Удалена стратегия ${stripBatExtension(res.deleted)}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const gameModes: Array<{ value: GameFilterMode; label: string }> = [
    { value: 'disabled', label: 'Выкл' },
    { value: 'all', label: 'TCP+UDP' },
    { value: 'tcp', label: 'TCP' },
    { value: 'udp', label: 'UDP' },
  ];

  const ipsetModes: Array<{ value: IpsetFilterMode; label: string }> = [
    { value: 'none', label: 'None' },
    { value: 'loaded', label: 'Loaded' },
    { value: 'any', label: 'Any' },
  ];

  const isSplitLayout = settings.connectLayout !== 'stacked';

  const powerPanelEl = (
    <div className={`power-panel ${runtime.running ? 'connected' : ''}`}>
      <div className="power-button-ring">
        <button
          type="button"
          className="power-button"
          disabled={busy || testJob.running || !currentStrategyObj}
          onClick={onTogglePower}
          title={runtime.running ? 'Остановить обход' : 'Запустить обход'}
        >
          <Power size={40} strokeWidth={2.05} />
        </button>
      </div>

      <div className="power-text-group">
        <div className="power-state-label">
          {testJob.running
            ? 'Идёт проверка...'
            : runtime.running
              ? 'Обход активен'
              : 'Обход остановлен'}
        </div>
        <div className="power-strategy-label mono">
          {currentStrategyObj ? stripBatExtension(currentStrategyObj.fileName) : 'Стратегии не найдены'}
        </div>
        {runtime.lastExitReason && !runtime.running && (
          <div style={{ fontSize: '11.5px', color: 'var(--m3-warn)', marginTop: '4px' }}>
            {runtime.lastExitReason}
          </div>
        )}
      </div>

      <div className="power-probe-wrap">
        <div className="power-meta-row">
          {runtime.running && (
            <div className="power-timer">{formatDuration(runtime.startedAt, nowMs)}</div>
          )}

          <button
            type="button"
            className="m3-chip"
            style={{ height: '27px', padding: '0 11px', fontSize: '12px' }}
            disabled={probing || testJob.running}
            onClick={handleQuickProbe}
            title="Быстро проверить доступность основных сервисов прямо сейчас"
          >
            {probing ? (
              <RefreshCw size={12.5} className="spin-icon" />
            ) : (
              <Activity size={13} strokeWidth={2} />
            )}
            <span>{probing ? 'Проверка...' : 'Проверить связь'}</span>
          </button>
        </div>

        {probeResult && probeResult.items.length > 0 && (
          <div className="power-probe-pills">
            {probeResult.items.map((item) => (
              <span
                key={item.category}
                className={`probe-pill ${item.ok ? 'ok' : 'fail'}`}
                title={`${item.label}: ${item.ok ? 'доступен' : 'недоступен'}`}
              >
                <span>{item.shortLabel}</span>
                <span className="probe-pill-ms">
                  {item.ok && item.pingMs !== null ? `${item.pingMs} мс` : item.ok ? 'OK' : 'Нет'}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const quickTilesEl = (
    <div className={isSplitLayout ? 'quick-tiles-stack' : 'quick-tiles-grid'}>
      {/* 1. Profile Switcher Tile */}
      <div className="quick-tile">
        <div className="tile-head">
          <span className="tile-label">
            <Bookmark size={15} strokeWidth={1.85} />
            Профиль
          </span>
          <button
            type="button"
            className="m3-chip"
            style={{ height: '25px', fontSize: '11.5px', padding: '0 9px' }}
            onClick={() => onNavigate('profiles')}
          >
            Все
          </button>
        </div>
        <div className="chip-row">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              className={`m3-chip ${activeProfileId === p.id ? 'selected' : ''}`}
              style={{ height: '29px', padding: '0 11px', fontSize: '12.5px' }}
              onClick={() => onSelectProfile(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* 2. Game Filter Quick Tile */}
      <div className="quick-tile">
        <div className="tile-head">
          <span className="tile-label">
            <Gamepad2 size={15} strokeWidth={1.85} />
            Game Filter
          </span>
          <button
            type="button"
            className="m3-chip"
            style={{ height: '25px', fontSize: '11.5px', padding: '0 9px' }}
            onClick={() => onNavigate('filters')}
          >
            Порты
          </button>
        </div>
        <div className="chip-row">
          {gameModes.map((gm) => (
            <button
              key={gm.value}
              type="button"
              disabled={busy}
              className={`m3-chip ${filters.gameFilter.mode === gm.value ? 'selected' : ''}`}
              style={{ height: '29px', padding: '0 11px', fontSize: '12.5px' }}
              onClick={() => onQuickGameMode(gm.value)}
            >
              {gm.label}
            </button>
          ))}
        </div>
        {devMode && (
          <div className="tile-sub mono">
            TCP: {filters.gameFilter.tcpRange} / UDP: {filters.gameFilter.udpRange}
          </div>
        )}
      </div>

      {/* 3. IPSet Filter Quick Tile */}
      <div className="quick-tile">
        <div className="tile-head">
          <span className="tile-label">
            <Network size={15} strokeWidth={1.85} />
            IPSet Filter
          </span>
          <button
            type="button"
            className="m3-chip"
            style={{ height: '25px', fontSize: '11.5px', padding: '0 9px' }}
            onClick={() => onNavigate('filters')}
          >
            База
          </button>
        </div>
        <div className="chip-row">
          {ipsetModes.map((im) => (
            <button
              key={im.value}
              type="button"
              disabled={busy}
              className={`m3-chip ${filters.ipsetFilter.mode === im.value ? 'selected' : ''}`}
              style={{ height: '29px', padding: '0 12px', fontSize: '12.5px' }}
              onClick={() => onQuickIpsetMode(im.value)}
            >
              {im.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const strategiesCardEl = (
    <div className="m3-card connect-strategies-card">
      <div className="toolbar-bar">
        <div className="chip-row">
          {favoritesSet.size > 0 && (
            <button
              type="button"
              className={`m3-chip ${onlyFavorites ? 'selected' : ''}`}
              onClick={() => setOnlyFavorites((v) => !v)}
              title="Показать только избранные стратегии"
            >
              <Star size={12.5} fill={onlyFavorites ? 'currentColor' : 'none'} />
              Избранные
            </button>
          )}
          {goalOptions.map((g) => (
            <button
              key={g}
              type="button"
              className={`m3-chip ${goal === g ? 'selected' : ''}`}
              onClick={() => setGoal(g)}
            >
              {getGoalLabel(g, targetCategories)}
            </button>
          ))}
        </div>

        <div className="toolbar-controls">
          <div className="input-wrap toolbar-search-wrap">
            <Search size={14} className="input-icon" />
            <input
              type="text"
              className="m3-input with-icon toolbar-search-input"
              placeholder="Поиск стратегии..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <SeamlessSelect
            className="toolbar-sort-dropdown"
            value={sortBy}
            icon={<ArrowUpDown size={14} />}
            options={[
              { value: 'best', label: 'Лучший результат' },
              { value: 'latency', label: 'По задержке (мс)' },
              { value: 'name', label: 'По названию (А-Я)' },
            ]}
            onChange={(val) => setSortBy(val as SortOption)}
          />

          {devMode && (
            <button
              type="button"
              className="btn btn-tonal"
              style={{ height: '34px', padding: '0 12px' }}
              title="Создать свою пользовательскую стратегию"
              onClick={openNewBuilder}
            >
              <Plus size={14} />
              Своя
            </button>
          )}
        </div>
      </div>

      {testJob.running && (
        <div style={{ marginBottom: '12px', flexShrink: 0, paddingRight: '6px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '8px',
              fontSize: '12px',
              color: 'var(--m3-text-secondary)',
              marginBottom: '6px',
            }}
          >
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {testJob.phaseLabel ? `${testJob.phaseLabel} - ` : 'Проверка: '}
              {testJob.currentStrategy ? stripBatExtension(testJob.currentStrategy) : 'подготовка...'}
            </span>
            <span className="mono" style={{ flexShrink: 0 }}>
              {testJob.completedCount} / {testJob.totalCount}
            </span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ transform: `scaleX(${Math.max(0.02, testJob.progressPct / 100)})` }}
            />
          </div>
        </div>
      )}

      <div className="connect-strategy-scroll">
        <div className="strategy-list">
          {filteredStrategies.map((s) => {
            const isSelected = settings.selectedStrategy === s.fileName;
            const isRunningThis = runtime.running && runtime.activeStrategy === s.fileName;
            const isFav = favoritesSet.has(s.fileName);
            const m = metricsLookup.get(s.fileName.toLowerCase());
            const goalStat = getGoalMetrics(m, goal);
            const fullStrategyName = stripBatExtension(s.fileName);

            return (
              <div
                key={s.fileName}
                className={`strategy-row ${isRunningThis ? 'running' : isSelected ? 'selected' : ''}`}
                onClick={() => onSelectStrategy(s.fileName, false)}
              >
                <div className="radio-circle">
                  <div className="radio-inner" />
                </div>

                <div className="strategy-main">
                  <div className="strategy-name-line">
                    <span className="strategy-title" title={fullStrategyName}>
                      {fullStrategyName}
                    </span>
                    {s.isCustom && (
                      <span className="score-pill" style={{ fontSize: '10.5px', flexShrink: 0 }}>
                        Своя
                      </span>
                    )}
                    {isRunningThis && (
                      <span className="score-pill good" style={{ fontSize: '10.5px', flexShrink: 0 }}>
                        Активна
                      </span>
                    )}
                    {goal !== 'all' && goalStat.scorePct === 100 && (
                      <span className="score-pill good" style={{ fontSize: '10.5px', flexShrink: 0 }}>
                        <Check size={11} strokeWidth={2.3} />
                        {getGoalLabel(goal, targetCategories)}
                      </span>
                    )}
                  </div>
                  {devMode && <div className="strategy-engine">{s.engineSummary}</div>}
                </div>

                {devMode && m && (
                  <div className="category-pills">
                    {pillCategories.map((cat) => {
                      const cs = m.categoryScores[cat.id];
                      if (!cs || cs.total === 0) return null;
                      return (
                        <span key={cat.id} className={`score-pill ${classifyScoreTone(cs.pct)}`}>
                          {cat.shortLabel} {cs.ok}/{cs.total}
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="strategy-right" onClick={(e) => e.stopPropagation()}>
                  {(goalStat.pingMs !== null || devMode) && (
                    <div
                      className={`ping-badge ${classifyPingSpeed(goalStat.pingMs)}`}
                      onClick={() => onSelectStrategy(s.fileName, false)}
                    >
                      {goalStat.pingMs !== null ? `${goalStat.pingMs} мс` : '-- мс'}
                    </div>
                  )}

                  <button
                    type="button"
                    className={`btn-icon ${isFav ? 'fav-active' : ''}`}
                    title={isFav ? 'Убрать из избранного' : 'Закрепить в избранном'}
                    onClick={() => onToggleFavorite(s.fileName)}
                  >
                    <Star size={14} strokeWidth={1.9} fill={isFav ? 'currentColor' : 'none'} />
                  </button>

                  <button
                    type="button"
                    className="btn-icon"
                    title="Проверить эту стратегию"
                    disabled={testJob.running}
                    onClick={() => onRunQuickTest([s.fileName])}
                  >
                    <Gauge size={14} strokeWidth={1.9} />
                  </button>

                  {devMode && (
                    <>
                      <button
                        type="button"
                        className="btn-icon"
                        title={s.isCustom ? 'Изменить стратегию' : 'Создать свою копию в конструкторе'}
                        onClick={() => openCloneOrEditInBuilder(s)}
                      >
                        {s.isCustom ? <Pencil size={13.5} /> : <Copy size={13.5} />}
                      </button>

                      {s.isCustom && (
                        <button
                          type="button"
                          className="btn-icon"
                          title="Удалить пользовательскую стратегию"
                          onClick={() => handleDeleteCustomStrategy(s.fileName)}
                        >
                          <Trash2 size={13.5} />
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn-icon"
                        title="Команда запуска .bat"
                        onClick={() => setInspectStrategy(s)}
                      >
                        <Terminal size={14} strokeWidth={1.9} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {filteredStrategies.length === 0 && (
            <div style={{ padding: '28px', textAlign: 'center', color: 'var(--m3-text-muted)' }}>
              Стратегии не найдены.
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="content-container connect-container">
      {isSplitLayout ? (
        <div className="connect-split-layout">
          <div className="connect-left-col">
            {powerPanelEl}
            {quickTilesEl}
          </div>
          <div className="connect-right-col">{strategiesCardEl}</div>
        </div>
      ) : (
        <>
          <div className="connect-hero">
            {powerPanelEl}
            {quickTilesEl}
          </div>
          {strategiesCardEl}
        </>
      )}

      {/* Developer Mode Modal: Inspect exact .bat winws command */}
      {inspectStrategy && (
        <ModalBackdrop onClose={() => setInspectStrategy(null)}>
          <div className="modal-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '15.5px', fontWeight: 600 }}>
                  {stripBatExtension(inspectStrategy.fileName)}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                  Команда запуска winws.exe
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={() => setInspectStrategy(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="m3-textarea-shell">
              <textarea
                readOnly
                className="m3-textarea"
                style={{ minHeight: '220px', height: '240px' }}
                value={inspectStrategy.commandPreview}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button type="button" className="btn btn-surface" onClick={() => setInspectStrategy(null)}>
                Закрыть
              </button>
              <button
                type="button"
                className="btn btn-surface"
                onClick={() => {
                  const target = inspectStrategy;
                  setInspectStrategy(null);
                  openCloneOrEditInBuilder(target);
                }}
              >
                <Copy size={14} />
                Клонировать в конструктор
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const target = inspectStrategy.fileName;
                  setInspectStrategy(null);
                  onSelectStrategy(target, false);
                }}
              >
                Выбрать
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}

      {/* Developer Mode Modal: Safe Custom Strategy Builder (#12) */}
      {builderOpen && (
        <ModalBackdrop onClose={() => setBuilderOpen(false)}>
          <form
            className="modal-panel"
            style={{ maxWidth: '640px' }}
            onSubmit={handleSaveCustomStrategy}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '15.5px', fontWeight: 600 }}>
                  {builderEditFile ? 'Редактирование своей стратегии' : 'Конструктор своей стратегии'}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                  Сохраняется отдельно как <span className="mono">custom - {builderTitle || 'имя'}.bat</span> без изменения штатных файлов
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={() => setBuilderOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px' }}>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  Название
                </label>
                <input
                  type="text"
                  required
                  maxLength={42}
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Например: Мой провайдер"
                  value={builderTitle}
                  onChange={(e) => setBuilderTitle(e.target.value)}
                />
              </div>

              <div style={{ alignSelf: 'flex-end' }} className="chip-row">
                <button
                  type="button"
                  className={`m3-chip ${builderMode === 'visual' ? 'selected' : ''}`}
                  onClick={() => setBuilderMode('visual')}
                >
                  <Sliders size={13} />
                  Параметры
                </button>
                <button
                  type="button"
                  className={`m3-chip ${builderMode === 'raw' ? 'selected' : ''}`}
                  onClick={() => setBuilderMode('raw')}
                >
                  <Code2 size={13} />
                  Аргументы winws
                </button>
              </div>
            </div>

            {builderMode === 'visual' ? (
              <div className="builder-form-grid">
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    Метод TCP десинка
                  </label>
                  <SeamlessSelect
                    fullWidth
                    mono
                    value={builderParams.tcpDesync}
                    options={[
                      { value: 'fake,multisplit', label: 'fake,multisplit' },
                      { value: 'multisplit', label: 'multisplit' },
                      { value: 'fake,fakedsplit', label: 'fake,fakedsplit' },
                      { value: 'fake,multidisorder', label: 'fake,multidisorder' },
                      { value: 'multidisorder', label: 'multidisorder' },
                      { value: 'hostfakesplit', label: 'hostfakesplit' },
                      { value: 'fake', label: 'fake' },
                    ]}
                    onChange={(val) => setBuilderParams((p) => ({ ...p, tcpDesync: val }))}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    Fooling (обман DPI)
                  </label>
                  <SeamlessSelect
                    fullWidth
                    mono
                    value={builderParams.fooling}
                    options={[
                      { value: 'ts', label: 'ts (TCP Timestamps)' },
                      { value: 'md5sig', label: 'md5sig' },
                      { value: 'badseq', label: 'badseq' },
                      { value: 'ts,md5sig', label: 'ts,md5sig' },
                      { value: 'none', label: 'Выключен' },
                    ]}
                    onChange={(val) => setBuilderParams((p) => ({ ...p, fooling: val }))}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    AutoTTL
                  </label>
                  <SeamlessSelect
                    fullWidth
                    mono
                    value={builderParams.autottl}
                    options={[
                      { value: 'off', label: 'Выключен' },
                      { value: '2', label: 'autottl=2' },
                      { value: '1:3-20', label: 'autottl=1:3-20' },
                    ]}
                    onChange={(val) => setBuilderParams((p) => ({ ...p, autottl: val }))}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                      TCP repeats
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      className="m3-input mono"
                      style={{ width: '100%' }}
                      value={builderParams.tcpRepeats}
                      onChange={(e) =>
                        setBuilderParams((p) => ({ ...p, tcpRepeats: Math.max(1, Math.min(16, Number(e.target.value) || 6)) }))
                      }
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                      QUIC repeats
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      className="m3-input mono"
                      style={{ width: '100%' }}
                      value={builderParams.quicRepeats}
                      onChange={(e) =>
                        setBuilderParams((p) => ({ ...p, quicRepeats: Math.max(1, Math.min(16, Number(e.target.value) || 8)) }))
                      }
                    />
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    Пакет TLS ClientHello
                  </label>
                  <SeamlessSelect
                    fullWidth
                    mono
                    value={builderParams.tlsFakeBin}
                    options={tlsBinOptions}
                    onChange={(val) => setBuilderParams((p) => ({ ...p, tlsFakeBin: val }))}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    Пакет QUIC Initial
                  </label>
                  <SeamlessSelect
                    fullWidth
                    mono
                    value={builderParams.quicFakeBin}
                    options={quicBinOptions}
                    onChange={(val) => setBuilderParams((p) => ({ ...p, quicFakeBin: val }))}
                  />
                </div>

                <div className="m3-switch-row" style={{ padding: '9px 12px' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 500 }}>Discord Voice (UDP)</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={builderParams.includeDiscordVoice}
                    className={`m3-switch ${builderParams.includeDiscordVoice ? 'checked' : ''}`}
                    onClick={() =>
                      setBuilderParams((p) => ({ ...p, includeDiscordVoice: !p.includeDiscordVoice }))
                    }
                  >
                    <span className="m3-switch-thumb" />
                  </button>
                </div>

                <div className="m3-switch-row" style={{ padding: '9px 12px' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 500 }}>Поддержка Game Filter</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={builderParams.includeGameFilter}
                    className={`m3-switch ${builderParams.includeGameFilter ? 'checked' : ''}`}
                    onClick={() =>
                      setBuilderParams((p) => ({ ...p, includeGameFilter: !p.includeGameFilter }))
                    }
                  >
                    <span className="m3-switch-thumb" />
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '6px' }}>
                  Аргументы после <span className="mono">&quot;%BIN%winws.exe&quot;</span> (по одному правилу на строке)
                </div>
                <div className="m3-textarea-shell">
                  <textarea
                    className="m3-textarea"
                    style={{ minHeight: '220px', height: '240px' }}
                    placeholder="--wf-tcp=80,443 ...&#10;--filter-tcp=443 ..."
                    value={builderRawArgs}
                    onChange={(e) => setBuilderRawArgs(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button type="button" className="btn btn-surface" onClick={() => setBuilderOpen(false)}>
                Отмена
              </button>
              <button type="submit" className="btn btn-primary" disabled={builderSaving || !builderTitle.trim()}>
                <Save size={14} />
                {builderSaving ? 'Сохранение...' : 'Сохранить стратегию'}
              </button>
            </div>
          </form>
        </ModalBackdrop>
      )}
    </div>
  );
};
