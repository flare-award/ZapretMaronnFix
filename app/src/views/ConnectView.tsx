import React, { useMemo, useState } from 'react';
import {
  Power,
  Search,
  Gauge,
  ArrowUpDown,
  Gamepad2,
  Network,
  Layers,
  Terminal,
  Play,
  RotateCw,
  X,
  Check,
  Activity,
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
  getGoalMetrics,
  GOAL_LABELS,
  GoalFilter,
  SortOption,
  sortStrategiesWithMetrics,
} from '../utils/metrics';

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

const GOALS: GoalFilter[] = ['all', 'discord', 'youtube', 'google', 'cloudflare', 'github'];

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
  const [sortBy, setSortBy] = useState<SortOption>('best');
  const [inspectStrategy, setInspectStrategy] = useState<StrategyItem | null>(null);

  const { runtime, settings, strategies, profiles, activeProfileId, filters, zapretInfo, testJob } = state;
  const metricsLookup = useMemo(() => buildMetricsLookup(activeReport), [activeReport]);

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
            s.displayName.toLowerCase().includes(q) ||
            s.fileName.toLowerCase().includes(q) ||
            s.engineSummary.toLowerCase().includes(q)
        )
      : strategies;
    return sortStrategiesWithMetrics(base, metricsLookup, goal, sortBy);
  }, [strategies, search, metricsLookup, goal, sortBy]);

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

  const selectedMetrics = currentStrategyObj
    ? metricsLookup.get(currentStrategyObj.fileName.toLowerCase())
    : undefined;

  const isSplitLayout = settings.connectLayout !== 'stacked';

  const powerPanelEl = (
    <div className={`power-panel ${runtime.running ? 'connected' : ''}`}>
      {/* Quick Profile Selector inside Power Card */}
      <div
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '2px',
        }}
      >
        <div className="input-wrap" style={{ flex: 1 }}>
          <Bookmark size={13} className="input-icon" />
          <select
            className="m3-select"
            style={{ width: '100%', height: '31px', paddingLeft: '30px', fontSize: '12.5px' }}
            disabled={busy}
            value={activeProfileId}
            onChange={(e) => onSelectProfile(e.target.value)}
            title="Быстрое переключение профиля настроек"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                Профиль: {p.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="m3-chip"
          style={{ height: '31px', padding: '0 10px', fontSize: '12px' }}
          onClick={() => onNavigate('profiles')}
        >
          Профили
        </button>
      </div>

      <div className="power-button-ring">
        <button
          type="button"
          className="power-button"
          disabled={busy || testJob.running || !currentStrategyObj}
          onClick={onTogglePower}
          title={runtime.running ? 'Остановить стратегию' : 'Запустить выбранную стратегию'}
        >
          <Power size={34} strokeWidth={2} />
        </button>
      </div>

      <div>
        <div className="power-state-label">
          {testJob.running
            ? 'Выполняется тест...'
            : runtime.running
              ? 'Обход активен'
              : 'Обход остановлен'}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '3px' }}>
          {currentStrategyObj ? currentStrategyObj.displayName : 'Стратегии не найдены'}
        </div>
      </div>

      <div className="power-timer">
        {runtime.running ? formatDuration(runtime.startedAt, nowMs) : 'Прямой запуск без службы'}
      </div>
    </div>
  );

  const fourTilesEl = (
    <div className={isSplitLayout ? 'quick-tiles-stack' : 'quick-tiles-grid'}>
      {/* 1. Selected Strategy Tile */}
      <div className="quick-tile">
        <div className="tile-head">
          <span className="tile-label">
            <Layers size={15} strokeWidth={1.85} />
            Выбранная стратегия
          </span>
          {currentStrategyObj && (
            <button
              type="button"
              className="btn-icon"
              title="Просмотреть параметры запуска winws.exe"
              onClick={() => setInspectStrategy(currentStrategyObj)}
            >
              <Terminal size={14} strokeWidth={1.85} />
            </button>
          )}
        </div>
        <div>
          <div className="tile-value">
            {currentStrategyObj ? currentStrategyObj.displayName : 'Не выбрана'}
          </div>
          <div className="tile-sub mono">
            {currentStrategyObj ? currentStrategyObj.engineSummary : 'Проверьте путь к папке zapret'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {selectedMetrics ? (
            <>
              <span className={`score-pill ${classifyScoreTone(selectedMetrics.overallScore)}`}>
                Соединение {selectedMetrics.overallScore}%
              </span>
              {selectedMetrics.avgPingMs !== null && (
                <span className="score-pill">Средний пинг {selectedMetrics.avgPingMs} мс</span>
              )}
            </>
          ) : (
            <span className="tile-sub">Нажмите "Проверить все" для замера задержки</span>
          )}
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
              style={{ height: '28px', padding: '0 10px', fontSize: '12px' }}
              onClick={() => onQuickGameMode(gm.value)}
            >
              {gm.label}
            </button>
          ))}
        </div>
        <div className="tile-sub mono">
          TCP: {filters.gameFilter.tcpRange} / UDP: {filters.gameFilter.udpRange}
        </div>
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
              style={{ height: '28px', padding: '0 11px', fontSize: '12px' }}
              onClick={() => onQuickIpsetMode(im.value)}
            >
              {im.label}
            </button>
          ))}
        </div>
        <div className="tile-sub">
          {filters.ipsetFilter.mode === 'none' && 'Только по спискам доменов (рекомендуется для игр)'}
          {filters.ipsetFilter.mode === 'loaded' &&
            `Активна база подсетей (${filters.ipsetFilter.entriesCount} CIDR)`}
          {filters.ipsetFilter.mode === 'any' && 'Перехват всех IP-адресов по целевым портам'}
        </div>
      </div>

      {/* 4. Isolated Zapret Tile */}
      <div className="quick-tile">
        <div className="tile-head">
          <span className="tile-label">
            <Activity size={15} strokeWidth={1.85} />
            Zapret (изолированная папка)
          </span>
          <button
            type="button"
            className="m3-chip"
            style={{ height: '25px', fontSize: '11.5px', padding: '0 9px' }}
            onClick={() => onNavigate('settings')}
          >
            Настройки
          </button>
        </div>
        <div>
          <div className="tile-value mono">v{zapretInfo.localVersion}</div>
          <div className="tile-sub">
            {zapretInfo.strategyCount} стратегий / {zapretInfo.binCount} бинарных фейков
          </div>
        </div>
        <div className="tile-sub mono" title={zapretInfo.zapretPath}>
          Папка: {zapretInfo.zapretPath}
        </div>
      </div>
    </div>
  );

  const strategiesCardEl = (
    <div className="m3-card">
      <div className="toolbar-bar">
        <div className="chip-row">
          {GOALS.map((g) => (
            <button
              key={g}
              type="button"
              className={`m3-chip ${goal === g ? 'selected' : ''}`}
              onClick={() => setGoal(g)}
            >
              {GOAL_LABELS[g]}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div className="input-wrap">
            <Search size={14} className="input-icon" />
            <input
              type="text"
              className="m3-input with-icon"
              placeholder="Поиск стратегии..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '175px' }}
            />
          </div>

          <div className="input-wrap">
            <ArrowUpDown size={14} className="input-icon" />
            <select
              className="m3-select"
              style={{ paddingLeft: '32px' }}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
            >
              <option value="best">Сначала лучшее соединение</option>
              <option value="latency">По задержке (мс)</option>
              <option value="name">По названию (А-Я)</option>
            </select>
          </div>

          <button
            type="button"
            className="btn btn-tonal"
            disabled={testJob.running || strategies.length === 0}
            onClick={() => onRunQuickTest()}
          >
            {testJob.running ? <RotateCw size={15} /> : <Gauge size={15} />}
            {testJob.running ? `Тест ${testJob.progressPct}%` : 'Проверить все'}
          </button>
        </div>
      </div>

      {testJob.running && (
        <div style={{ marginBottom: '14px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--m3-text-secondary)',
              marginBottom: '6px',
            }}
          >
            <span>Проверка стратегии: {testJob.currentStrategy || 'подготовка...'}</span>
            <span className="mono">
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

      <div className="strategy-list">
        {filteredStrategies.map((s) => {
          const isSelected = settings.selectedStrategy === s.fileName;
          const isRunningThis = runtime.running && runtime.activeStrategy === s.fileName;
          const m = metricsLookup.get(s.fileName.toLowerCase());
          const goalStat = getGoalMetrics(m, goal);

          const catOrder: Array<{ key: 'discord' | 'youtube' | 'cloudflare' | 'github'; short: string }> = [
            { key: 'discord', short: 'Discord' },
            { key: 'youtube', short: 'YT' },
            { key: 'cloudflare', short: 'CF' },
            { key: 'github', short: 'GH' },
          ];

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
                  <span className="strategy-title">{s.displayName}</span>
                  {isRunningThis && (
                    <span className="score-pill good" style={{ fontSize: '10.5px' }}>
                      Активна
                    </span>
                  )}
                  {goal !== 'all' && goalStat.scorePct === 100 && (
                    <span className="score-pill good" style={{ fontSize: '10.5px' }}>
                      <Check size={11} strokeWidth={2.3} />
                      {GOAL_LABELS[goal]}
                    </span>
                  )}
                </div>
                <div className="strategy-engine">{s.engineSummary}</div>
              </div>

              <div className="category-pills">
                {m ? (
                  catOrder.map(({ key, short }) => {
                    const cs = m.categoryScores[key];
                    if (!cs || cs.total === 0) return null;
                    return (
                      <span key={key} className={`score-pill ${classifyScoreTone(cs.pct)}`}>
                        {short} {cs.ok}/{cs.total}
                      </span>
                    );
                  })
                ) : (
                  <span className="score-pill">Нет данных замера</span>
                )}
              </div>

              <div className={`ping-badge ${classifyPingSpeed(goalStat.pingMs)}`}>
                {goalStat.pingMs !== null ? `${goalStat.pingMs} мс` : '-- мс'}
              </div>

              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="btn-icon"
                  title="Запустить эту стратегию сейчас"
                  disabled={busy || testJob.running}
                  onClick={() => onSelectStrategy(s.fileName, true)}
                >
                  <Play size={14} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title="Проверить только эту стратегию"
                  disabled={testJob.running}
                  onClick={() => onRunQuickTest([s.fileName])}
                >
                  <Gauge size={14} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title="Команда запуска .bat"
                  onClick={() => setInspectStrategy(s)}
                >
                  <Terminal size={14} strokeWidth={1.9} />
                </button>
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
  );

  return (
    <div className="content-container">
      {isSplitLayout ? (
        <div className="connect-split-layout">
          <div className="connect-left-col">
            {powerPanelEl}
            {fourTilesEl}
          </div>
          <div className="connect-right-col">{strategiesCardEl}</div>
        </div>
      ) : (
        <>
          <div className="connect-hero">
            {powerPanelEl}
            {fourTilesEl}
          </div>
          {strategiesCardEl}
        </>
      )}

      {/* Modal: Inspect exact .bat winws command */}
      {inspectStrategy && (
        <div className="modal-backdrop" onClick={() => setInspectStrategy(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '15.5px', fontWeight: 600 }}>{inspectStrategy.fileName}</div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                  Развёрнутая команда прямого запуска процесса winws.exe (без установки системной службы)
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={() => setInspectStrategy(null)}>
                <X size={16} />
              </button>
            </div>

            <textarea
              readOnly
              className="m3-textarea"
              style={{ minHeight: '220px' }}
              value={inspectStrategy.commandPreview}
            />

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
                  onSelectStrategy(target, true);
                }}
              >
                <Play size={14} />
                Выбрать и запустить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
