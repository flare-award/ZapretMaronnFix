import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Gauge,
  Square,
  Trophy,
  MessageSquare,
  Tv,
  Cloud,
  GitBranch,
  Globe,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Check,
  History,
} from 'lucide-react';
import type { FullAppState, TestRunReport } from '../types';
import {
  buildMetricsLookup,
  classifyPingSpeed,
  classifyScoreTone,
  findBestStrategyForGoal,
  formatTestStrategyName,
  getGoalLabel,
  getGoalMetrics,
  GoalFilter,
  SortOption,
  sortStrategiesWithMetrics,
} from '../utils/metrics';
import { SeamlessSelect } from '../components/SeamlessSelect';

interface TestsViewProps {
  state: FullAppState;
  activeReport: TestRunReport | null;
  selectedHistoryFile: string;
  onSelectHistoryFile: (fileName: string) => void;
  busy: boolean;
  onStartTests: (categories: string[]) => void;
  onStopTests: () => void;
  onApplyStrategy: (fileName: string, runNow: boolean) => void;
}

const DEFAULT_CAT_IDS = ['discord', 'youtube', 'google', 'cloudflare', 'github', 'dns'];

export const TestsView: React.FC<TestsViewProps> = ({
  state,
  activeReport,
  selectedHistoryFile,
  onSelectHistoryFile,
  busy,
  onStartTests,
  onStopTests,
  onApplyStrategy,
}) => {
  const { strategies, targetCategories, testHistory, testJob, settings, runtime } = state;
  const devMode = Boolean(settings.developerMode);

  const availableCategories = useMemo(() => {
    if (targetCategories && targetCategories.length > 0) {
      return targetCategories;
    }
    return [
      { id: 'discord', label: 'Discord', shortLabel: 'Discord', count: 0, isPingOnlyGroup: false },
      { id: 'youtube', label: 'YouTube', shortLabel: 'YT', count: 0, isPingOnlyGroup: false },
      { id: 'google', label: 'Google', shortLabel: 'Google', count: 0, isPingOnlyGroup: false },
      { id: 'cloudflare', label: 'Cloudflare', shortLabel: 'CF', count: 0, isPingOnlyGroup: false },
      { id: 'github', label: 'GitHub', shortLabel: 'GH', count: 0, isPingOnlyGroup: false },
      { id: 'dns', label: 'DNS Ping', shortLabel: 'DNS', count: 0, isPingOnlyGroup: true },
    ];
  }, [targetCategories]);

  const [selectedCategories, setSelectedCategories] = useState<string[]>(() =>
    availableCategories.length > 0 ? availableCategories.map((c) => c.id) : DEFAULT_CAT_IDS
  );
  const knownCatsRef = useRef<Set<string>>(new Set(availableCategories.map((c) => c.id)));

  // Custom seamless history dropdown state
  const [historyMenuOpen, setHistoryMenuOpen] = useState<boolean>(false);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!historyMenuOpen) return;
    const onDocMouseDown = (evt: MouseEvent) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(evt.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') setHistoryMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [historyMenuOpen]);

  useEffect(() => {
    const currentIds = availableCategories.map((c) => c.id);
    setSelectedCategories((prev) => {
      const added = currentIds.filter((id) => !knownCatsRef.current.has(id));
      knownCatsRef.current = new Set(currentIds);
      const kept = prev.filter((id) => currentIds.includes(id));
      const merged = [...kept, ...added.filter((id) => !kept.includes(id))];
      return merged.length > 0 ? merged : currentIds;
    });
  }, [availableCategories]);

  const [goalFilter, setGoalFilter] = useState<GoalFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('best');
  const [onlyPassing, setOnlyPassing] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const lookup = useMemo(() => buildMetricsLookup(activeReport), [activeReport]);

  const goalOptions = useMemo(() => {
    const serviceCats = availableCategories.filter((c) => c.id !== 'dns');
    return ['all', ...serviceCats.map((c) => c.id)];
  }, [availableCategories]);

  useEffect(() => {
    if (goalFilter !== 'all' && !goalOptions.includes(goalFilter)) {
      setGoalFilter('all');
    }
  }, [goalFilter, goalOptions]);

  const rowPillCategories = useMemo(
    () => availableCategories.filter((c) => c.id !== 'dns'),
    [availableCategories]
  );

  const toggleCategoryForRun = (catId: string) => {
    setSelectedCategories((prev) =>
      prev.includes(catId) ? (prev.length > 1 ? prev.filter((c) => c !== catId) : prev) : [...prev, catId]
    );
  };

  const leaderCards = useMemo(() => {
    const baseCards = [
      {
        key: 'all' as GoalFilter,
        title: 'Лучшая для всего',
        icon: <Trophy size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'all'),
      },
      {
        key: 'discord' as GoalFilter,
        title: 'Лучшая для Discord',
        icon: <MessageSquare size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'discord'),
      },
      {
        key: 'youtube' as GoalFilter,
        title: 'Лучшая для YouTube',
        icon: <Tv size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'youtube'),
      },
      {
        key: 'cloudflare' as GoalFilter,
        title: 'Лучшая для Cloudflare',
        icon: <Cloud size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'cloudflare'),
      },
      {
        key: 'github' as GoalFilter,
        title: 'Лучшая для GitHub',
        icon: <GitBranch size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'github'),
      },
    ];

    const builtinSet = new Set(['discord', 'youtube', 'google', 'cloudflare', 'github', 'dns']);
    const customCards = availableCategories
      .filter((c) => !builtinSet.has(c.id))
      .map((c) => ({
        key: c.id,
        title: `Лучшая для ${c.label}`,
        icon: <Globe size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, c.id),
      }));

    return [...baseCards, ...customCards];
  }, [strategies, lookup, availableCategories]);

  const sortedStrategies = useMemo(() => {
    const ordered = sortStrategiesWithMetrics(strategies, lookup, goalFilter, sortBy);
    if (!onlyPassing) return ordered;
    return ordered.filter((s) => {
      const m = lookup.get(s.fileName.toLowerCase());
      const g = getGoalMetrics(m, goalFilter);
      return g.scorePct !== null && g.scorePct >= 90;
    });
  }, [strategies, lookup, goalFilter, sortBy, onlyPassing]);

  const currentHistoryLabel = useMemo(() => {
    if (selectedHistoryFile === 'latest') return 'Последний замер';
    const found = testHistory.find((h) => h.fileName === selectedHistoryFile);
    return found ? (devMode ? `Отчёт: ${found.label}` : found.label) : 'Последний замер';
  }, [selectedHistoryFile, testHistory, devMode]);

  return (
    <div className="content-container">
      {/* Test Launcher Control Panel */}
      <div className="m3-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ fontSize: '15.5px', fontWeight: 600 }}>
            Проверка стратегий
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {testHistory.length > 0 && (
              <div
                ref={historyDropdownRef}
                className={`m3-seamless-dropdown ${historyMenuOpen ? 'open' : ''}`}
              >
                <button
                  type="button"
                  className="m3-seamless-trigger"
                  disabled={testJob.running}
                  onClick={() => setHistoryMenuOpen((o) => !o)}
                >
                  <History size={14} className="m3-seamless-icon" />
                  <span className="m3-seamless-label">{currentHistoryLabel}</span>
                  <ChevronDown
                    size={15}
                    className={`m3-seamless-chevron ${historyMenuOpen ? 'rotated' : ''}`}
                  />
                </button>

                {historyMenuOpen && (
                  <div className="m3-seamless-menu">
                    <button
                      type="button"
                      className={`m3-seamless-option ${selectedHistoryFile === 'latest' ? 'active' : ''}`}
                      onClick={() => {
                        onSelectHistoryFile('latest');
                        setHistoryMenuOpen(false);
                      }}
                    >
                      <span>Последний замер</span>
                      {selectedHistoryFile === 'latest' && <Check size={13} />}
                    </button>
                    {testHistory.map((h) => {
                      const active = selectedHistoryFile === h.fileName;
                      return (
                        <button
                          key={h.fileName}
                          type="button"
                          className={`m3-seamless-option ${active ? 'active' : ''}`}
                          onClick={() => {
                            onSelectHistoryFile(h.fileName);
                            setHistoryMenuOpen(false);
                          }}
                        >
                          <span>{devMode ? `Отчёт: ${h.label}` : h.label}</span>
                          {active && <Check size={13} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {testJob.running ? (
              <button type="button" className="btn btn-danger-tonal" onClick={onStopTests}>
                <Square size={14} />
                Остановить ({testJob.completedCount}/{testJob.totalCount})
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={strategies.length === 0}
                onClick={() => {
                  onSelectHistoryFile('latest');
                  onStartTests(selectedCategories);
                }}
              >
                <Gauge size={15} />
                Запустить тесты
              </button>
            )}
          </div>
        </div>

        <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12.5px', color: 'var(--m3-text-muted)', marginRight: '2px' }}>
            Сервисы:
          </span>
          {availableCategories.map((cat) => {
            const active = selectedCategories.includes(cat.id);
            return (
              <button
                key={cat.id}
                type="button"
                disabled={testJob.running}
                className={`m3-chip ${active ? 'selected' : ''}`}
                onClick={() => toggleCategoryForRun(cat.id)}
              >
                {active && <Check size={12} strokeWidth={2.3} />}
                {cat.label}
              </button>
            );
          })}
        </div>

        {testJob.running && (
          <div style={{ marginTop: '14px' }}>
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
                {testJob.currentStrategy ? formatTestStrategyName(testJob.currentStrategy) : 'запуск...'}
              </span>
              <span className="mono" style={{ flexShrink: 0 }}>{testJob.progressPct}%</span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ transform: `scaleX(${Math.max(0.02, testJob.progressPct / 100)})` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Best Strategy Recommendations per Target */}
      {settings.showBestStrategyCards !== false && (
        <div className="leaders-grid">
          {leaderCards.map((card) => (
            <div key={card.key} className="leader-card">
              <div className="leader-card-top">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                  {card.icon}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {card.title}
                  </span>
                </span>
                {card.winner && (
                  <span className={`score-pill ${classifyScoreTone(card.winner.scorePct)}`}>
                    {card.winner.scorePct}%
                  </span>
                )}
              </div>

              <div className="leader-strat-name">
                {card.winner ? formatTestStrategyName(card.winner.strategy.fileName) : 'Нет данных'}
              </div>

              <div className="leader-meta">
                <span>
                  {card.winner
                    ? devMode
                      ? `${card.winner.okText} OK / ${card.winner.pingMs !== null ? `${card.winner.pingMs} мс` : '-- мс'}`
                      : card.winner.pingMs !== null
                        ? `${card.winner.pingMs} мс`
                        : 'Готово'
                    : 'Нет замера'}
                </span>
                {card.winner && (
                  <button
                    type="button"
                    className="m3-chip"
                    style={{ height: '24px', padding: '0 9px', fontSize: '11.5px' }}
                    disabled={busy}
                    onClick={() => onApplyStrategy(card.winner!.strategy.fileName, false)}
                  >
                    Выбрать
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-Target Filter & Sort Matrix */}
      <div className="m3-card">
        <div className="toolbar-bar">
          <div className="chip-row">
            {goalOptions.map((g) => (
              <button
                key={g}
                type="button"
                className={`m3-chip ${goalFilter === g ? 'selected' : ''}`}
                onClick={() => setGoalFilter(g)}
              >
                {getGoalLabel(g, availableCategories)}
              </button>
            ))}
          </div>

          <div className="toolbar-controls">
            <button
              type="button"
              className={`m3-chip ${onlyPassing ? 'selected' : ''}`}
              onClick={() => setOnlyPassing((v) => !v)}
            >
              {onlyPassing && <Check size={12} strokeWidth={2.3} />}
              {devMode ? 'Только без потерь (90%+)' : 'Без потерь'}
            </button>

            <SeamlessSelect
              className="toolbar-sort-dropdown"
              value={sortBy}
              icon={<ArrowUpDown size={14} />}
              options={[
                {
                  value: 'best',
                  label: devMode
                    ? `По качеству соединения (${getGoalLabel(goalFilter, availableCategories)})`
                    : 'По лучшему результату',
                },
                { value: 'latency', label: 'По задержке (мс)' },
                { value: 'name', label: 'По названию (А-Я)' },
              ]}
              onChange={(val) => setSortBy(val as SortOption)}
            />
          </div>
        </div>

        <div className="strategy-list">
          {sortedStrategies.map((s) => {
            const m = lookup.get(s.fileName.toLowerCase());
            const gStat = getGoalMetrics(m, goalFilter);
            const isExpanded = expandedRow === s.fileName;
            const isSelected = settings.selectedStrategy === s.fileName;
            const isRunningThis = runtime.running && runtime.activeStrategy === s.fileName;
            const cleanTestName = formatTestStrategyName(s.fileName);

            const filteredTargets = m
              ? goalFilter === 'all'
                ? m.targets
                : m.targets.filter((t) => t.category === goalFilter)
              : [];

            return (
              <div
                key={s.fileName}
                className={`test-strategy-card ${isRunningThis ? 'running' : isSelected ? 'selected' : ''}`}
              >
                <div
                  className="test-strategy-row"
                  onClick={() => {
                    if (m) {
                      setExpandedRow(isExpanded ? null : s.fileName);
                    }
                  }}
                >
                  <div className="strategy-main">
                    <div className="strategy-name-line">
                      <span className="strategy-title" title={devMode ? s.fileName : cleanTestName}>
                        {cleanTestName}
                      </span>
                      {gStat.scorePct !== null && (
                        <span className={`score-pill ${classifyScoreTone(gStat.scorePct)}`}>
                          {devMode ? `${gStat.scorePct}% (${gStat.okText})` : `${gStat.scorePct}%`}
                        </span>
                      )}
                    </div>
                    {devMode && <div className="strategy-engine">{s.engineSummary}</div>}
                  </div>

                  {m && (
                    <div className="category-pills">
                      {rowPillCategories.map((cat) => {
                        const cs = m.categoryScores[cat.id];
                        if (!cs || cs.total === 0) return null;
                        return (
                          <span key={cat.id} className={`score-pill ${classifyScoreTone(cs.pct)}`}>
                            {devMode ? `${cat.shortLabel} ${cs.ok}/${cs.total}` : cat.shortLabel}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="strategy-right">
                    {(gStat.pingMs !== null || devMode) && (
                      <div className={`ping-badge ${classifyPingSpeed(gStat.pingMs)}`}>
                        {gStat.pingMs !== null ? `${gStat.pingMs} мс` : '-- мс'}
                      </div>
                    )}

                    {m && (
                      <button
                        type="button"
                        className="btn-icon"
                        title="Подробности проверки"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedRow(isExpanded ? null : s.fileName);
                        }}
                      >
                        {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                      </button>
                    )}
                  </div>
                </div>

                {isExpanded && m && (
                  <div className="targets-detail-grid">
                    {filteredTargets.map((t) => {
                      const passed = t.isPingOnly ? t.pingMs !== null : t.http === 'OK' && t.tls12 === 'OK';
                      return (
                        <div key={t.id} className="target-detail-card">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 600, fontSize: '12.5px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.id}
                            </span>
                            <span className="mono" style={{ fontSize: '11.5px', color: 'var(--m3-text-secondary)', flexShrink: 0 }}>
                              {t.pingMs !== null ? `${t.pingMs} мс` : 'таймаут'}
                            </span>
                          </div>
                          {devMode ? (
                            t.isPingOnly ? (
                              <div style={{ display: 'flex', gap: '5px' }}>
                                <span className={`score-pill ${passed ? 'good' : 'bad'}`}>
                                  ICMP Ping: {passed ? 'OK' : 'TIMEOUT'}
                                </span>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                                <span className={`score-pill ${t.http === 'OK' ? 'good' : 'bad'}`}>
                                  HTTP: {t.http}
                                </span>
                                <span className={`score-pill ${t.tls12 === 'OK' ? 'good' : 'bad'}`}>
                                  TLS1.2: {t.tls12}
                                </span>
                                <span
                                  className={`score-pill ${
                                    t.tls13 === 'OK' ? 'good' : t.tls13 === 'UNSUP' ? '' : 'bad'
                                  }`}
                                >
                                  TLS1.3: {t.tls13}
                                </span>
                              </div>
                            )
                          ) : (
                            <div style={{ display: 'flex', gap: '5px' }}>
                              <span className={`score-pill ${passed ? 'good' : 'bad'}`}>
                                {passed ? 'Доступен' : 'Недоступен'}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {sortedStrategies.length === 0 && (
            <div style={{ padding: '26px', textAlign: 'center', color: 'var(--m3-text-muted)' }}>
              Нет стратегий, соответствующих выбранному фильтру.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
