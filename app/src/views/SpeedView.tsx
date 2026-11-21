import React, { useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Download,
  Gauge,
  Play,
  RotateCw,
  Server,
  Square,
  Timer,
  Trophy,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { FullAppState, SteamSpeedResult } from '../types';

interface SpeedViewProps {
  state: FullAppState;
  onStateUpdated: (state: FullAppState) => void;
  onApplyStrategy: (fileName: string, runNow: boolean) => void;
  onNotify: (message: string, isError?: boolean) => void;
}

function formatTraffic(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
  const megabytes = bytes / 1024 / 1024;
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} ГБ`;
  return `${Math.round(megabytes)} МБ`;
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return 'Нет завершённых замеров';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export const SpeedView: React.FC<SpeedViewProps> = ({
  state,
  onStateUpdated,
  onApplyStrategy,
  onNotify,
}) => {
  const [busy, setBusy] = useState(false);
  const { steamSpeedJob, steamSpeedHistory, strategies, platform } = state;
  const latestHistory = steamSpeedHistory[0] || null;
  const visibleResults = steamSpeedJob.results.length
    ? steamSpeedJob.results
    : latestHistory?.results || [];
  const resultTimestamp = steamSpeedJob.results.length
    ? steamSpeedJob.finishedAt || steamSpeedJob.startedAt
    : latestHistory?.finishedAt || null;

  const rankedResults = useMemo(
    () =>
      [...visibleResults].sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return b.megabytesPerSecond - a.megabytesPerSecond;
      }),
    [visibleResults]
  );
  const best = rankedResults.find((item) => item.ok) || null;
  const estimatedTraffic = strategies.length * steamSpeedJob.sampleBytesPerStrategy;
  const windowsReady = platform.os === 'win32';

  const refresh = async () => {
    const next = await api.getState();
    onStateUpdated(next);
  };

  const start = async () => {
    setBusy(true);
    try {
      await api.startSteamSpeedTest();
      await refresh();
      onNotify('Тест скорости Steam запущен');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.stopSteamSpeedTest();
      await refresh();
      onNotify('Остановка теста запрошена');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const applyBest = () => {
    if (!best) return;
    onApplyStrategy(best.fileName, true);
  };

  return (
    <div className="content-container speed-container">
      <section className="speed-hero m3-card">
        <div className="speed-hero-copy">
          <div className="speed-icon-box">
            <Download size={22} strokeWidth={1.9} />
          </div>
          <div>
            <h2>Скорость загрузки Steam</h2>
            <p>
              Каждая стратегия проверяется загрузкой 200 МБ с официальной CDN Steam.
              Лучшая определяется по фактической скорости четырёх параллельных потоков.
            </p>
          </div>
        </div>
        <div className="speed-actions">
          {steamSpeedJob.running ? (
            <button type="button" className="btn btn-danger-tonal" onClick={stop} disabled={busy}>
              <Square size={15} fill="currentColor" />
              Остановить
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={start}
              disabled={busy || !windowsReady || state.testJob.running || strategies.length === 0}
            >
              {busy ? <RotateCw size={16} className="spin-icon" /> : <Play size={16} fill="currentColor" />}
              Проверить все стратегии
            </button>
          )}
          <div className="speed-traffic-note">
            Около {formatTraffic(estimatedTraffic)} трафика
          </div>
        </div>
      </section>

      {!windowsReady && (
        <div className="inline-notice warn">
          <Server size={16} />
          <span>Реальный замер запускается в приложении Zapret Control на Windows.</span>
        </div>
      )}

      {steamSpeedJob.running && (
        <section className="speed-progress m3-card-compact">
          <div className="speed-progress-head">
            <div>
              <div className="section-kicker">Идёт замер</div>
              <strong>{steamSpeedJob.currentStrategy?.replace(/\.bat$/i, '')}</strong>
            </div>
            <div className="speed-progress-value mono">{steamSpeedJob.progressPct}%</div>
          </div>
          <div className="progress-track speed-progress-track">
            <div className="progress-fill" style={{ width: `${steamSpeedJob.progressPct}%` }} />
          </div>
          <div className="speed-progress-meta">
            Проверено {steamSpeedJob.completedCount} из {steamSpeedJob.totalCount}. Активная до теста
            стратегия будет восстановлена автоматически.
          </div>
        </section>
      )}

      {best && !steamSpeedJob.running && (
        <section className="speed-winner m3-card">
          <div className="speed-winner-mark">
            <Trophy size={20} strokeWidth={1.9} />
          </div>
          <div className="speed-winner-copy">
            <span>Лучшая стратегия для Steam</span>
            <strong>{best.fileName.replace(/\.bat$/i, '')}</strong>
            <small>Замер {formatDate(resultTimestamp)}</small>
          </div>
          <div className="speed-winner-rate">
            <strong className="mono">{best.megabytesPerSecond.toFixed(2)}</strong>
            <span>МБ/с</span>
            <small>{best.megabitsPerSecond.toFixed(1)} Мбит/с</small>
          </div>
          <button type="button" className="btn btn-primary" onClick={applyBest}>
            <Check size={16} />
            Применить
          </button>
        </section>
      )}

      <section className="m3-card speed-results-card">
        <div className="section-heading-row">
          <div>
            <h3>Результаты</h3>
            <p>Скорость выше, задержка первого ответа ниже.</p>
          </div>
          {resultTimestamp && <span className="section-date mono">{formatDate(resultTimestamp)}</span>}
        </div>

        {rankedResults.length === 0 ? (
          <div className="speed-empty">
            <Gauge size={30} strokeWidth={1.5} />
            <strong>Замеров пока нет</strong>
            <span>Запустите проверку, чтобы сравнить все стратегии на одном Steam CDN-маршруте.</span>
          </div>
        ) : (
          <div className="speed-table-wrap">
            <table className="speed-table">
              <thead>
                <tr>
                  <th>Место</th>
                  <th>Стратегия</th>
                  <th>Скорость</th>
                  <th>Задержка</th>
                  <th>Данные</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {rankedResults.map((result: SteamSpeedResult, index) => (
                  <tr key={result.fileName} className={index === 0 && result.ok ? 'is-best' : ''}>
                    <td><span className="speed-rank mono">{index + 1}</span></td>
                    <td>
                      <div className="speed-strategy-name">{result.fileName.replace(/\.bat$/i, '')}</div>
                      {result.endpointHost && <small className="mono">{result.endpointHost}</small>}
                    </td>
                    <td>
                      {result.ok ? (
                        <div className="speed-rate-cell">
                          <strong className="mono">{result.megabytesPerSecond.toFixed(2)} МБ/с</strong>
                          <span>{result.megabitsPerSecond.toFixed(1)} Мбит/с</span>
                        </div>
                      ) : <span className="muted">Нет данных</span>}
                    </td>
                    <td className="mono">{result.latencyMs !== null ? `${result.latencyMs} мс` : '-'}</td>
                    <td className="mono">{formatTraffic(result.bytesDownloaded)}</td>
                    <td>
                      <span className={`result-status ${result.ok ? 'ok' : 'error'}`} title={result.error || undefined}>
                        {result.ok ? <Check size={14} /> : <X size={14} />}
                        {result.ok ? 'Готово' : 'Ошибка'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="speed-method-grid">
        <div className="m3-card-compact speed-method-item">
          <Activity size={17} />
          <div><strong>Реальный трафик</strong><span>Четыре параллельных потока и 200 МБ на каждую стратегию.</span></div>
        </div>
        <div className="m3-card-compact speed-method-item">
          <Timer size={17} />
          <div><strong>Честное сравнение</strong><span>Одинаковый объём и CDN для каждой стратегии.</span></div>
        </div>
        <div className="m3-card-compact speed-method-item">
          <Server size={17} />
          <div><strong>Без файлов на диске</strong><span>Данные сразу отбрасываются после загрузки и не занимают место.</span></div>
        </div>
      </section>
    </div>
  );
};
