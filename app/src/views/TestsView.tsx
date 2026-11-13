import React, { useMemo, useState } from 'react';
import {
  Gauge,
  Square,
  Trophy,
  MessageSquare,
  Tv,
  Cloud,
  GitBranch,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Check,
  Play,
  History,
} from 'lucide-react';
import type { FullAppState, TargetCategory, TestRunReport } from '../types';
import {
  buildMetricsLookup,
  classifyPingSpeed,
  classifyScoreTone,
  findBestStrategyForGoal,
  getGoalMetrics,
  GOAL_LABELS,
  GoalFilter,
  SortOption,
  sortStrategiesWithMetrics,
} from '../utils/metrics';

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

const GOALS: GoalFilter[] = ['all', 'discord', 'youtube', 'google', 'cloudflare', 'github'];

const TARGET_CATEGORY_OPTIONS: Array<{ id: TargetCategory; label: string }> = [
  { id: 'discord', label: 'Discord' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'google', label: 'Google' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'github', label: 'GitHub' },
  { id: 'dns', label: 'DNS Ping' },
];

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
  const { strategies, testHistory, testJob, settings, runtime } = state;

  const [selectedCategories, setSelectedCategories] = useState<string[]>([
    'discord',
    'youtube',
    'google',
    'cloudflare',
    'github',
    'dns',
  ]);
  const [goalFilter, setGoalFilter] = useState<GoalFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('best');
  const [onlyPassing, setOnlyPassing] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const lookup = useMemo(() => buildMetricsLookup(activeReport), [activeReport]);

  const toggleCategoryForRun = (catId: string) => {
    setSelectedCategories((prev) =>
      prev.includes(catId) ? (prev.length > 1 ? prev.filter((c) => c !== catId) : prev) : [...prev, catId]
    );
  };

  const leaderCards = useMemo(
    () => [
      {
        key: 'all' as GoalFilter,
        title: 'Лучшая универсальная',
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
    ],
    [strategies, lookup]
  );

  const sortedStrategies = useMemo(() => {
    const ordered = sortStrategiesWithMetrics(strategies, lookup, goalFilter, sortBy);
    if (!onlyPassing) return ordered;
    return ordered.filter((s) => {
      const m = lookup.get(s.fileName.toLowerCase());
      const g = getGoalMetrics(m, goalFilter);
      return g.scorePct !== null && g.scorePct >= 90;
    });
  }, [strategies, lookup, goalFilter, sortBy, onlyPassing]);

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
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Проверка задержки и доступности целей</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
              Выберите сервисы для проверки и запустите замер соединения по стратегиям из папки zapret
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {testHistory.length > 0 && (
              <div className="input-wrap">
                <History size={14} className="input-icon" />
                <select
                  className="m3-select"
                  style={{ paddingLeft: '32px', maxWidth: '245px' }}
                  value={selectedHistoryFile}
                  disabled={testJob.running}
                  onChange={(e) => onSelectHistoryFile(e.target.value)}
                >
                  <option value="latest">Последний замер</option>
                  {testHistory.map((h) => (
                    <option key={h.fileName} value={h.fileName}>
                      Отчёт: {h.label}
                    </option>
                  ))}
                </select>
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
                Запустить тестирование
              </button>
            )}
          </div>
        </div>

        <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--m3-text-muted)', marginRight: '4px' }}>
            Проверяемые категории:
          </span>
          {TARGET_CATEGORY_OPTIONS.map((cat) => {
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
                fontSize: '12px',
                color: 'var(--m3-text-secondary)',
                marginBottom: '6px',
              }}
            >
              <span>Тестируется стратегия: {testJob.currentStrategy || 'запуск...'}</span>
              <span className="mono">{testJob.progressPct}%</span>
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

      {/* Optional Best Strategy Recommendations per Target (toggleable in Settings) */}
      {settings.showBestStrategyCards !== false && (
        <div className="leaders-grid">
          {leaderCards.map((card) => (
            <div key={card.key} className="leader-card">
              <div className="leader-card-top">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  {card.icon}
                  {card.title}
                </span>
                {card.winner && (
                  <span className={`score-pill ${classifyScoreTone(card.winner.scorePct)}`}>
                    {card.winner.scorePct}%
                  </span>
                )}
              </div>

              <div className="leader-strat-name">
                {card.winner ? card.winner.strategy.displayName : 'Нет данных'}
              </div>

              <div className="leader-meta">
                <span>
                  {card.winner
                    ? `${card.winner.okText} OK / ${card.winner.pingMs !== null ? `${card.winner.pingMs} мс` : '-- мс'}`
                    : 'Запустите тест'}
                </span>
                {card.winner && (
                  <button
                    type="button"
                    className="m3-chip"
                    style={{ height: '24px', padding: '0 9px', fontSize: '11.5px' }}
                    disabled={busy}
                    onClick={() => onApplyStrategy(card.winner!.strategy.fileName, runtime.running)}
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
            {GOALS.map((g) => (
              <button
                key={g}
                type="button"
                className={`m3-chip ${goalFilter === g ? 'selected' : ''}`}
                onClick={() => setGoalFilter(g)}
              >
                {GOAL_LABELS[g]}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`m3-chip ${onlyPassing ? 'selected' : ''}`}
              onClick={() => setOnlyPassing((v) => !v)}
            >
              {onlyPassing && <Check size={12} strokeWidth={2.3} />}
              Только без потерь (90%+)
            </button>

            <div className="input-wrap">
              <ArrowUpDown size={14} className="input-icon" />
              <select
                className="m3-select"
                style={{ paddingLeft: '32px' }}
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
              >
                <option value="best">По качеству соединения ({GOAL_LABELS[goalFilter]})</option>
                <option value="latency">По минимальной задержке (мс)</option>
                <option value="name">По названию (А-Я)</option>
              </select>
            </div>
          </div>
        </div>

        <div className="strategy-list">
          {sortedStrategies.map((s) => {
            const m = lookup.get(s.fileName.toLowerCase());
            const gStat = getGoalMetrics(m, goalFilter);
            const isExpanded = expandedRow === s.fileName;
            const isSelected = settings.selectedStrategy === s.fileName;
            const isRunningThis = runtime.running && runtime.activeStrategy === s.fileName;

            const filteredTargets = m
              ? goalFilter === 'all'
                ? m.targets
                : m.targets.filter((t) => t.category === goalFilter)
              : [];

            return (
              <div
                key={s.fileName}
                style={{
                  borderRadius: '14px',
                  background: isRunningThis
                    ? 'rgba(23, 53, 37, 0.36)'
                    : isSelected
                      ? 'rgba(29, 52, 88, 0.34)'
                      : 'var(--m3-surface-low)',
                  border: '1px solid var(--m3-outline)',
                  padding: '11px 14px',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(170px, 1.2fr) minmax(210px, 1.7fr) 96px auto',
                    alignItems: 'center',
                    gap: '12px',
                    cursor: 'pointer',
                  }}
                  onClick={() => setExpandedRow(isExpanded ? null : s.fileName)}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <span className="strategy-title">{s.displayName}</span>
                      {gStat.scorePct !== null && (
                        <span className={`score-pill ${classifyScoreTone(gStat.scorePct)}`}>
                          {gStat.scorePct}% ({gStat.okText})
                        </span>
                      )}
                    </div>
                    <div className="strategy-engine">{s.engineSummary}</div>
                  </div>

                  <div className="category-pills">
                    {m ? (
                      (['discord', 'youtube', 'google', 'cloudflare', 'github'] as const).map((catKey) => {
                        const cs = m.categoryScores[catKey];
                        if (!cs || cs.total === 0) return null;
                        const labelMap: Record<string, string> = {
                          discord: 'Discord',
                          youtube: 'YouTube',
                          google: 'Google',
                          cloudflare: 'CF',
                          github: 'GitHub',
                        };
                        return (
                          <span key={catKey} className={`score-pill ${classifyScoreTone(cs.pct)}`}>
                            {labelMap[catKey]} {cs.ok}/{cs.total}
                          </span>
                        );
                      })
                    ) : (
                      <span className="score-pill">Ожидает тестирования</span>
                    )}
                  </div>

                  <div className={`ping-badge ${classifyPingSpeed(gStat.pingMs)}`}>
                    {gStat.pingMs !== null ? `${gStat.pingMs} мс` : '-- мс'}
                  </div>

                  <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="btn btn-tonal"
                      style={{ height: '30px', padding: '0 11px', fontSize: '12px' }}
                      disabled={busy || testJob.running}
                      onClick={() => onApplyStrategy(s.fileName, true)}
                    >
                      <Play size={12} />
                      Запустить
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Показать детальный отчёт по хостам"
                      onClick={() => setExpandedRow(isExpanded ? null : s.fileName)}
                    >
                      {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </button>
                  </div>
                </div>

                {isExpanded && m && (
                  <div className="targets-detail-grid">
                    {filteredTargets.map((t) => {
                      const passed = t.isPingOnly ? t.pingMs !== null : t.http === 'OK' && t.tls12 === 'OK';
                      return (
                        <div key={t.id} className="target-detail-card">
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontWeight: 600, fontSize: '12.5px' }}>{t.id}</span>
                            <span className="mono" style={{ fontSize: '11.5px', color: 'var(--m3-text-secondary)' }}>
                              {t.pingMs !== null ? `${t.pingMs} мс` : 'таймаут'}
                            </span>
                          </div>
                          {t.isPingOnly ? (
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
