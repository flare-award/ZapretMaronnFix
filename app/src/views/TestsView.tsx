import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Gauge,
  Zap,
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
  GitCompare,
  X,
} from 'lucide-react';
import { api } from '../api';
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
  onStartTests: (categories: string[], mode: 'standard' | 'express') => void;
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
  const favoritesSet = useMemo(
    () => new Set(settings.favoriteStrategies || []),
    [settings.favoriteStrategies]
  );

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

  // Comparison modal state (#10)
  const [compareOpen, setCompareOpen] = useState<boolean>(false);
  const [compareKind, setCompareKind] = useState<'strategies' | 'reports'>('strategies');
  const [compareStratA, setCompareStratA] = useState<string>('');
  const [compareStratB, setCompareStratB] = useState<string>('');
  const [compareOnlyDiff, setCompareOnlyDiff] = useState<boolean>(false);
  const [reportFileA, setReportFileA] = useState<string>('');
  const [reportFileB, setReportFileB] = useState<string>('');
  const [loadedReportA, setLoadedReportA] = useState<TestRunReport | null>(null);
  const [loadedReportB, setLoadedReportB] = useState<TestRunReport | null>(null);

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

  // Initialize default strategies/reports when comparison modal opens
  useEffect(() => {
    if (!compareOpen) return;
    const tested = activeReport?.strategies || [];
    if (tested.length >= 2) {
      if (!compareStratA || !tested.some((s) => s.fileName === compareStratA)) {
        setCompareStratA(tested[0].fileName);
      }
      if (!compareStratB || !tested.some((s) => s.fileName === compareStratB)) {
        setCompareStratB(tested[1].fileName);
      }
    } else if (tested.length === 1) {
      setCompareStratA(tested[0].fileName);
      setCompareStratB(tested[0].fileName);
    }
    if (testHistory.length >= 2) {
      if (!reportFileA) setReportFileA(testHistory[0].fileName);
      if (!reportFileB) setReportFileB(testHistory[1].fileName);
    }
  }, [compareOpen, activeReport, testHistory, compareStratA, compareStratB, reportFileA, reportFileB]);

  useEffect(() => {
    if (!compareOpen || compareKind !== 'reports') return;
    let cancelled = false;
    if (reportFileA) {
      api
        .getTestHistoryReport(reportFileA)
        .then((r) => {
          if (!cancelled) setLoadedReportA(r);
        })
        .catch(() => {});
    }
    if (reportFileB) {
      api
        .getTestHistoryReport(reportFileB)
        .then((r) => {
          if (!cancelled) setLoadedReportB(r);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [compareOpen, compareKind, reportFileA, reportFileB]);

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
        title: 'Discord',
        icon: <MessageSquare size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'discord'),
      },
      {
        key: 'youtube' as GoalFilter,
        title: 'YouTube',
        icon: <Tv size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'youtube'),
      },
      {
        key: 'cloudflare' as GoalFilter,
        title: 'Cloudflare',
        icon: <Cloud size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'cloudflare'),
      },
      {
        key: 'github' as GoalFilter,
        title: 'GitHub',
        icon: <GitBranch size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, 'github'),
      },
    ];

    const builtinSet = new Set(['discord', 'youtube', 'google', 'cloudflare', 'github', 'dns']);
    const customCards = availableCategories
      .filter((c) => !builtinSet.has(c.id))
      .map((c) => ({
        key: c.id,
        title: c.label,
        icon: <Globe size={15} strokeWidth={1.9} />,
        winner: findBestStrategyForGoal(strategies, lookup, c.id),
      }));

    return [...baseCards, ...customCards];
  }, [strategies, lookup, availableCategories]);

  const sortedStrategies = useMemo(() => {
    const ordered = sortStrategiesWithMetrics(strategies, lookup, goalFilter, sortBy, favoritesSet);
    if (!onlyPassing) return ordered;
    return ordered.filter((s) => {
      const m = lookup.get(s.fileName.toLowerCase());
      const g = getGoalMetrics(m, goalFilter);
      return g.scorePct !== null && g.scorePct >= 90;
    });
  }, [strategies, lookup, goalFilter, sortBy, onlyPassing, favoritesSet]);

  const currentHistoryLabel = useMemo(() => {
    if (selectedHistoryFile === 'latest') return 'Последний замер';
    const found = testHistory.find((h) => h.fileName === selectedHistoryFile);
    return found ? found.label : 'Последний замер';
  }, [selectedHistoryFile, testHistory]);

  // Computed Strategy A vs Strategy B rows (#10)
  const stratMetricsA = compareStratA ? lookup.get(compareStratA.toLowerCase()) : undefined;
  const stratMetricsB = compareStratB ? lookup.get(compareStratB.toLowerCase()) : undefined;

  const strategyCompareRows = useMemo(() => {
    if (!stratMetricsA && !stratMetricsB) return [];
    const targetIds = Array.from(
      new Set([
        ...(stratMetricsA?.targets.map((t) => t.id) || []),
        ...(stratMetricsB?.targets.map((t) => t.id) || []),
      ])
    );
    const rows = targetIds.map((id) => {
      const ta = stratMetricsA?.targets.find((t) => t.id === id);
      const tb = stratMetricsB?.targets.find((t) => t.id === id);
      const okA = ta ? (ta.isPingOnly ? ta.pingMs !== null : ta.http === 'OK' && ta.tls12 === 'OK') : null;
      const okB = tb ? (tb.isPingOnly ? tb.pingMs !== null : tb.http === 'OK' && tb.tls12 === 'OK') : null;
      const pingA = ta?.pingMs ?? null;
      const pingB = tb?.pingMs ?? null;
      const pingDiff = pingA !== null && pingB !== null ? pingB - pingA : null;
      const isDiff = okA !== okB || (pingDiff !== null && Math.abs(pingDiff) >= 12);
      return { id, okA, okB, pingA, pingB, pingDiff, isDiff };
    });
    return compareOnlyDiff ? rows.filter((r) => r.isDiff) : rows;
  }, [stratMetricsA, stratMetricsB, compareOnlyDiff]);

  const reportCompareRows = useMemo(() => {
    if (!loadedReportA || !loadedReportB) return [];
    const mapA = buildMetricsLookup(loadedReportA);
    const mapB = buildMetricsLookup(loadedReportB);
    const names = Array.from(
      new Set([
        ...loadedReportA.strategies.map((s) => s.fileName),
        ...loadedReportB.strategies.map((s) => s.fileName),
      ])
    );
    const rows = names.map((fn) => {
      const ma = mapA.get(fn.toLowerCase());
      const mb = mapB.get(fn.toLowerCase());
      const scoreA = ma?.overallScore ?? null;
      const scoreB = mb?.overallScore ?? null;
      const pingA = ma?.avgPingMs ?? null;
      const pingB = mb?.avgPingMs ?? null;
      const scoreDelta = scoreA !== null && scoreB !== null ? scoreA - scoreB : null;
      const isDiff = scoreA !== scoreB;
      return {
        fileName: fn,
        label: formatTestStrategyName(fn),
        scoreA,
        scoreB,
        pingA,
        pingB,
        scoreDelta,
        isDiff,
      };
    });
    return compareOnlyDiff ? rows.filter((r) => r.isDiff) : rows;
  }, [loadedReportA, loadedReportB, compareOnlyDiff]);

  const canCompare = Boolean(activeReport && activeReport.strategies.length >= 2) || testHistory.length >= 2;

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
          <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Подбор лучшей стратегии</div>

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
                          <span>{h.label}</span>
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
              <>
                <button
                  type="button"
                  className="btn btn-tonal"
                  disabled={strategies.length === 0}
                  title="Быстрый отсев по маркерам и детальная проверка лучших кандидатов"
                  onClick={() => {
                    onSelectHistoryFile('latest');
                    onStartTests(selectedCategories, 'express');
                  }}
                >
                  <Zap size={14} />
                  Экспресс-подбор
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={strategies.length === 0}
                  onClick={() => {
                    onSelectHistoryFile('latest');
                    onStartTests(selectedCategories, 'standard');
                  }}
                >
                  <Gauge size={15} />
                  Полный тест
                </button>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--m3-text-muted)', marginRight: '2px' }}>
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
                {testJob.phaseLabel ? `${testJob.phaseLabel} - ` : 'Проверка: '}
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
              Без потерь
            </button>

            {canCompare && (
              <button
                type="button"
                className="m3-chip"
                onClick={() => setCompareOpen(true)}
                title="Сравнить две стратегии или два отчёта"
              >
                <GitCompare size={13} />
                Сравнить
              </button>
            )}

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

                    <button
                      type="button"
                      className="m3-chip"
                      style={{ height: '26px', padding: '0 10px', fontSize: '11.5px' }}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        onApplyStrategy(s.fileName, false);
                      }}
                    >
                      {isSelected ? 'Выбрана' : 'Выбрать'}
                    </button>

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
              Нет подходящих стратегий по фильтру.
            </div>
          )}
        </div>
      </div>

      {/* Comparison Modal (#10) */}
      {compareOpen && (
        <div className="modal-backdrop" onClick={() => setCompareOpen(false)}>
          <div
            className="modal-panel"
            style={{ maxWidth: '680px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '15.5px', fontWeight: 600 }}>Сравнение результатов</span>
                <div className="chip-row">
                  <button
                    type="button"
                    className={`m3-chip ${compareKind === 'strategies' ? 'selected' : ''}`}
                    onClick={() => setCompareKind('strategies')}
                  >
                    Две стратегии
                  </button>
                  {testHistory.length >= 2 && (
                    <button
                      type="button"
                      className={`m3-chip ${compareKind === 'reports' ? 'selected' : ''}`}
                      onClick={() => setCompareKind('reports')}
                    >
                      Два замера
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  className={`m3-chip ${compareOnlyDiff ? 'selected' : ''}`}
                  onClick={() => setCompareOnlyDiff((v) => !v)}
                >
                  {compareOnlyDiff && <Check size={12} />}
                  Только различия
                </button>
                <button type="button" className="btn-icon" onClick={() => setCompareOpen(false)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            {compareKind === 'strategies' ? (
              <>
                <div className="compare-selectors-grid">
                  <SeamlessSelect
                    fullWidth
                    value={compareStratA}
                    options={(activeReport?.strategies || []).map((s) => ({
                      value: s.fileName,
                      label: `${formatTestStrategyName(s.fileName)} (${s.overallScore}%)`,
                    }))}
                    onChange={setCompareStratA}
                  />
                  <SeamlessSelect
                    fullWidth
                    value={compareStratB}
                    options={(activeReport?.strategies || []).map((s) => ({
                      value: s.fileName,
                      label: `${formatTestStrategyName(s.fileName)} (${s.overallScore}%)`,
                    }))}
                    onChange={setCompareStratB}
                  />
                </div>

                {(stratMetricsA || stratMetricsB) && (
                  <div className="compare-summary-grid">
                    <div className="compare-summary-box">
                      <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {stratMetricsA ? formatTestStrategyName(stratMetricsA.fileName) : '--'}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        {stratMetricsA && (
                          <span className={`score-pill ${classifyScoreTone(stratMetricsA.overallScore)}`}>
                            {stratMetricsA.overallScore}%
                          </span>
                        )}
                        <span className="mono" style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                          {stratMetricsA?.avgPingMs ? `${stratMetricsA.avgPingMs} мс` : '--'}
                        </span>
                      </div>
                    </div>

                    <div className="compare-summary-box">
                      <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {stratMetricsB ? formatTestStrategyName(stratMetricsB.fileName) : '--'}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        {stratMetricsB && (
                          <span className={`score-pill ${classifyScoreTone(stratMetricsB.overallScore)}`}>
                            {stratMetricsB.overallScore}%
                          </span>
                        )}
                        <span className="mono" style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                          {stratMetricsB?.avgPingMs ? `${stratMetricsB.avgPingMs} мс` : '--'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="compare-table-scroll">
                  <div className="compare-row head">
                    <span>Цель</span>
                    <span>Первая</span>
                    <span>Вторая</span>
                    <span>Разница</span>
                  </div>
                  {strategyCompareRows.map((row) => (
                    <div key={row.id} className={`compare-row ${row.isDiff ? 'diff-highlight' : ''}`}>
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.id}
                      </span>
                      <span className="mono" style={{ color: row.okA ? 'var(--m3-success)' : 'var(--m3-danger)' }}>
                        {row.okA === null ? '--' : row.okA ? `OK${row.pingA ? ` (${row.pingA}мс)` : ''}` : 'Ошибка'}
                      </span>
                      <span className="mono" style={{ color: row.okB ? 'var(--m3-success)' : 'var(--m3-danger)' }}>
                        {row.okB === null ? '--' : row.okB ? `OK${row.pingB ? ` (${row.pingB}мс)` : ''}` : 'Ошибка'}
                      </span>
                      <span className="mono" style={{ fontSize: '11.5px', color: 'var(--m3-text-secondary)' }}>
                        {row.pingDiff !== null
                          ? `${row.pingDiff > 0 ? '+' : ''}${row.pingDiff} мс`
                          : row.okA !== row.okB
                            ? 'Статус'
                            : 'Равно'}
                      </span>
                    </div>
                  ))}
                  {strategyCompareRows.length === 0 && (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--m3-text-muted)' }}>
                      Различий между выбранными стратегиями нет.
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="compare-selectors-grid">
                  <SeamlessSelect
                    fullWidth
                    value={reportFileA}
                    options={testHistory.map((h) => ({ value: h.fileName, label: `Новый: ${h.label}` }))}
                    onChange={setReportFileA}
                  />
                  <SeamlessSelect
                    fullWidth
                    value={reportFileB}
                    options={testHistory.map((h) => ({ value: h.fileName, label: `Предыдущий: ${h.label}` }))}
                    onChange={setReportFileB}
                  />
                </div>

                <div className="compare-table-scroll">
                  <div className="compare-row head">
                    <span>Стратегия</span>
                    <span>Новый замер</span>
                    <span>Предыдущий</span>
                    <span>Динамика</span>
                  </div>
                  {reportCompareRows.map((row) => (
                    <div key={row.fileName} className={`compare-row ${row.isDiff ? 'diff-highlight' : ''}`}>
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.label}
                      </span>
                      <span className="mono">
                        {row.scoreA !== null ? `${row.scoreA}%${row.pingA ? ` (${row.pingA}мс)` : ''}` : '--'}
                      </span>
                      <span className="mono">
                        {row.scoreB !== null ? `${row.scoreB}%${row.pingB ? ` (${row.pingB}мс)` : ''}` : '--'}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: '11.5px',
                          color:
                            row.scoreDelta && row.scoreDelta > 0
                              ? 'var(--m3-success)'
                              : row.scoreDelta && row.scoreDelta < 0
                                ? 'var(--m3-danger)'
                                : 'var(--m3-text-muted)',
                        }}
                      >
                        {row.scoreDelta !== null
                          ? row.scoreDelta === 0
                            ? 'Без изм.'
                            : `${row.scoreDelta > 0 ? '+' : ''}${row.scoreDelta}%`
                          : '--'}
                      </span>
                    </div>
                  ))}
                  {reportCompareRows.length === 0 && (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--m3-text-muted)' }}>
                      Изменений между выбранными отчётами нет.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
