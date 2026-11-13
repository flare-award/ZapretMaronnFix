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
} from 'lucide-react';
import type {
  FullAppState,
  GameFilterMode,
  IpsetFilterMode,
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

interface ConnectViewProps {
  state: FullAppState;
  activeReport: TestRunReport | null;
  nowMs: number;
  busy: boolean;
  onTogglePower: () => void;
  onSelectStrategy: (fileName: string, runImmediately?: boolean) => void;
  onSelectProfile: (profileId: string) => void;
  onQuickGameMode: (mode: GameFilterMode) => void;
  onQuickIpsetMode: (mode: IpsetFilterMode) => void;
  onRunQuickTest: (strategies?: string[]) => void;
  onNavigate: (tab: string) => void;
}

export const ConnectView: React.FC<ConnectViewProps> = ({
  state,
  activeReport,
  nowMs,
  busy,
  onTogglePower,
  onSelectStrategy,
  onSelectProfile,
  onQuickGameMode,
  onQuickIpsetMode,
  onRunQuickTest,
  onNavigate,
}) => {
  const [search, setSearch] = useState('');
  const [goal, setGoal] = useState<GoalFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [inspectStrategy, setInspectStrategy] = useState<StrategyItem | null>(null);

  const { runtime, settings, strategies, profiles, activeProfileId, filters, targetCategories, testJob } = state;
  const devMode = Boolean(settings.developerMode);
  const metricsLookup = useMemo(() => buildMetricsLookup(activeReport), [activeReport]);

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
    const base = q
      ? strategies.filter(
          (s) =>
            stripBatExtension(s.fileName).toLowerCase().includes(q) ||
            s.displayName.toLowerCase().includes(q) ||
            (devMode && s.engineSummary.toLowerCase().includes(q))
        )
      : strategies;
    return sortStrategiesWithMetrics(base, metricsLookup, goal, sortBy);
  }, [strategies, search, metricsLookup, goal, sortBy, devMode]);

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
            ? 'Выполняется тест...'
            : runtime.running
              ? 'Обход активен'
              : 'Обход остановлен'}
        </div>
        <div className="power-strategy-label mono">
          {currentStrategyObj ? stripBatExtension(currentStrategyObj.fileName) : 'Стратегии не найдены'}
        </div>
      </div>

      {runtime.running && (
        <div className="power-timer">{formatDuration(runtime.startedAt, nowMs)}</div>
      )}
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
            Профили
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
            Настроить
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
              { value: 'best', label: 'Сначала лучшее соединение' },
              { value: 'latency', label: 'По задержке (мс)' },
              { value: 'name', label: 'По названию (А-Я)' },
            ]}
            onChange={(val) => setSortBy(val as SortOption)}
          />
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
              Проверка:{' '}
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
                  className="btn-icon"
                  title="Проверить эту стратегию"
                  disabled={testJob.running}
                  onClick={() => onRunQuickTest([s.fileName])}
                >
                  <Gauge size={14} strokeWidth={1.9} />
                </button>

                {devMode && (
                  <button
                    type="button"
                    className="btn-icon"
                    title="Команда запуска .bat"
                    onClick={() => setInspectStrategy(s)}
                  >
                    <Terminal size={14} strokeWidth={1.9} />
                  </button>
                )}
              </div>
            </div>
          );
        })}

          {filteredStrategies.length === 0 && (
            <div style={{ padding: '28px', textAlign: 'center', color: 'var(--m3-text-muted)' }}>
              Ни одной стратегии по запросу не найдено.
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
        <div className="modal-backdrop" onClick={() => setInspectStrategy(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '15.5px', fontWeight: 600 }}>
                  {stripBatExtension(inspectStrategy.fileName)}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                  Развёрнутая команда запуска процесса winws.exe
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
                className="btn btn-primary"
                onClick={() => {
                  const target = inspectStrategy.fileName;
                  setInspectStrategy(null);
                  onSelectStrategy(target, false);
                }}
              >
                Выбрать стратегию
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
