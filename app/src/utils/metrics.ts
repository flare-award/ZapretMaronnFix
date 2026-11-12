import type { StrategyItem, StrategyTestMetrics, TargetCategory, TestRunReport } from '../types';

export type SortOption = 'best' | 'latency' | 'name';
export type GoalFilter = 'all' | 'discord' | 'youtube' | 'google' | 'cloudflare' | 'github';

export const GOAL_LABELS: Record<GoalFilter, string> = {
  all: 'Все цели',
  discord: 'Discord',
  youtube: 'YouTube',
  google: 'Google',
  cloudflare: 'Cloudflare',
  github: 'GitHub',
};

export function formatDuration(startedAt: number | null, nowMs: number): string {
  if (!startedAt) return '00:00:00';
  const diffSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function classifyPingSpeed(pingMs: number | null | undefined): 'fast' | 'medium' | 'slow' | '' {
  if (pingMs === null || pingMs === undefined) return '';
  if (pingMs <= 65) return 'fast';
  if (pingMs <= 140) return 'medium';
  return 'slow';
}

export function classifyScoreTone(pct: number | undefined): 'good' | 'partial' | 'bad' | '' {
  if (pct === undefined) return '';
  if (pct >= 90) return 'good';
  if (pct >= 50) return 'partial';
  return 'bad';
}

export function buildMetricsLookup(report: TestRunReport | null): Map<string, StrategyTestMetrics> {
  const map = new Map<string, StrategyTestMetrics>();
  if (!report) return map;
  for (const s of report.strategies) {
    map.set(s.fileName.toLowerCase(), s);
  }
  return map;
}

export function getGoalMetrics(
  metrics: StrategyTestMetrics | undefined,
  goal: GoalFilter
): { scorePct: number | null; pingMs: number | null; okText: string | null } {
  if (!metrics) {
    return { scorePct: null, pingMs: null, okText: null };
  }
  if (goal === 'all') {
    return {
      scorePct: metrics.overallScore,
      pingMs: metrics.avgPingMs,
      okText: `${metrics.passedChecks}/${metrics.totalChecks}`,
    };
  }
  const cat = metrics.categoryScores[goal as TargetCategory];
  if (!cat || cat.total === 0) {
    return { scorePct: null, pingMs: metrics.avgPingMs, okText: null };
  }
  return {
    scorePct: cat.pct,
    pingMs: cat.avgPingMs ?? metrics.avgPingMs,
    okText: `${cat.ok}/${cat.total}`,
  };
}

export function sortStrategiesWithMetrics(
  strategies: StrategyItem[],
  lookup: Map<string, StrategyTestMetrics>,
  goal: GoalFilter,
  sortBy: SortOption
): StrategyItem[] {
  const copy = [...strategies];
  copy.sort((a, b) => {
    const ma = lookup.get(a.fileName.toLowerCase());
    const mb = lookup.get(b.fileName.toLowerCase());
    const ga = getGoalMetrics(ma, goal);
    const gb = getGoalMetrics(mb, goal);

    if (sortBy === 'name') {
      return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' });
    }

    if (sortBy === 'latency') {
      // Tested working strategies with lowest ping first, untested/broken last
      const pa = ga.pingMs !== null && (ga.scorePct === null || ga.scorePct > 0) ? ga.pingMs : 99999;
      const pb = gb.pingMs !== null && (gb.scorePct === null || gb.scorePct > 0) ? gb.pingMs : 99999;
      if (pa !== pb) return pa - pb;
      const sa = ga.scorePct ?? -1;
      const sb = gb.scorePct ?? -1;
      if (sa !== sb) return sb - sa;
      return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' });
    }

    // sortBy === 'best': highest pass score for the selected goal, tie-break by overall score then lowest ping
    const sa = ga.scorePct ?? -1;
    const sb = gb.scorePct ?? -1;
    if (sa !== sb) return sb - sa;

    const oa = ma?.overallScore ?? -1;
    const ob = mb?.overallScore ?? -1;
    if (oa !== ob) return ob - oa;

    const pa = ga.pingMs ?? 99999;
    const pb = gb.pingMs ?? 99999;
    if (pa !== pb) return pa - pb;

    return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' });
  });
  return copy;
}

export function findBestStrategyForGoal(
  strategies: StrategyItem[],
  lookup: Map<string, StrategyTestMetrics>,
  goal: GoalFilter
): { strategy: StrategyItem; scorePct: number; pingMs: number | null; okText: string } | null {
  const sorted = sortStrategiesWithMetrics(strategies, lookup, goal, 'best');
  for (const s of sorted) {
    const m = lookup.get(s.fileName.toLowerCase());
    const g = getGoalMetrics(m, goal);
    if (g.scorePct !== null && g.scorePct > 0 && g.okText) {
      return {
        strategy: s,
        scorePct: g.scorePct,
        pingMs: g.pingMs,
        okText: g.okText,
      };
    }
  }
  return null;
}
