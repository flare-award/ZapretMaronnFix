import React, { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Gamepad2,
  Image,
  RefreshCw,
  ShieldCheck,
  Wifi,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import type { FullAppState, ProblemFixState } from '../types';

interface ProblemsViewProps {
  state: FullAppState;
  onStateUpdated: (state: FullAppState) => void;
  onNotify: (message: string, isError?: boolean) => void;
}

const CHECK_DOMAINS: Record<ProblemFixState['id'], string[]> = {
  'discord-media': ['media.discordapp.net'],
  'steam-web': [
    'cdn.akamai.steamstatic.com',
    'store.akamai.steamstatic.com',
    'community.akamai.steamstatic.com',
  ],
  'steam-workshop': [
    'steamusercontent-a.akamaihd.net',
    'steamuserimages-a.akamaihd.net',
    'images.steamusercontent.com',
    'shared.akamai.steamstatic.com',
  ],
};

export const ProblemsView: React.FC<ProblemsViewProps> = ({
  state,
  onStateUpdated,
  onNotify,
}) => {
  const [busyId, setBusyId] = useState<ProblemFixState['id'] | null>(null);
  const [checkingId, setCheckingId] = useState<ProblemFixState['id'] | null>(null);
  const [checkResults, setCheckResults] = useState<
    Partial<Record<ProblemFixState['id'], { passed: number; total: number }>>
  >({});

  const fixes = useMemo(() => state.problemFixes || [], [state.problemFixes]);

  const setFix = async (fix: ProblemFixState, enabled: boolean) => {
    setBusyId(fix.id);
    try {
      const result = await api.setProblemFix(fix.id, enabled);
      const nextState = result.state || await api.getState();
      onStateUpdated(nextState);
      setCheckResults((current) => ({ ...current, [fix.id]: undefined }));
      onNotify(
        enabled
          ? `Исправление "${fix.title}" применено`
          : `Исправление "${fix.title}" откачено`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusyId(null);
    }
  };

  const checkFix = async (fix: ProblemFixState) => {
    setCheckingId(fix.id);
    const domains = CHECK_DOMAINS[fix.id];
    let passed = 0;
    try {
      for (const domain of domains) {
        const report = await api.checkSite(domain);
        if (report.tls.ok) passed += 1;
      }
      setCheckResults((current) => ({
        ...current,
        [fix.id]: { passed, total: domains.length },
      }));
      onNotify(
        passed === domains.length
          ? `Проверка пройдена: ${passed} из ${domains.length}`
          : `Доступно ${passed} из ${domains.length}`,
        passed !== domains.length
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div className="content-container problems-container">
      <section className="m3-card problems-intro">
        <div className="problems-intro-icon">
          <ShieldCheck size={22} strokeWidth={1.9} />
        </div>
        <div>
          <h2>Исправления подключений</h2>
          <p>
            Готовые правила для сервисов, которые начали блокироваться или загружаться не полностью.
            Активная стратегия перезапускается автоматически. Steam использует выбранную стратегию, поэтому при неудачной проверке попробуйте другую.
          </p>
        </div>
      </section>

      <div className="problem-cards">
        {fixes.map((fix) => {
          const isDiscord = fix.id === 'discord-media';
          const isWorkshop = fix.id === 'steam-workshop';
          const check = checkResults[fix.id];
          return (
            <section key={fix.id} className={`m3-card problem-card ${fix.enabled ? 'enabled' : ''}`}>
              <div className="problem-card-head">
                <div className="problem-service-icon">
                  {isDiscord ? <Image size={20} /> : <Gamepad2 size={20} />}
                </div>
                <div className="problem-card-title">
                  <h3>{fix.title}</h3>
                  <span className={`problem-state ${fix.applied ? 'active' : ''}`}>
                    {fix.applied ? <Check size={13} /> : null}
                    {fix.applied ? 'Исправление активно' : 'Не применяется'}
                  </span>
                </div>
              </div>

              <p className="problem-description">{fix.description}</p>

              <div className="problem-detail-box">
                <strong>{isDiscord ? 'Что исправляется' : 'Затрагиваемые страницы'}</strong>
                <span>
                  {isDiscord
                    ? 'discord.com, media.discordapp.net и images-ext-1 через адреса Cloudflare в системном hosts.'
                    : isWorkshop
                      ? 'Проверяет адреса Akamai через публичный DNS и закрепляет доступные маршруты для Workshop. Загрузка игр не меняется.'
                      : 'Проверяет адреса трёх Akamai CDN и исключает заблокированные IP. Основные сайты и загрузка игр не меняются.'}
                </span>
              </div>

              <div className="problem-domains">
                {fix.domains.slice(0, isDiscord ? 3 : 4).map((domain) => (
                  <code key={domain}>{domain}</code>
                ))}
              </div>

              {fix.systemError && (
                <div className="problem-check-result error">
                  <XCircle size={15} />
                  {fix.systemError}
                </div>
              )}

              {check && (
                <div className={`problem-check-result ${check.passed === check.total ? 'ok' : 'error'}`}>
                  {check.passed === check.total ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  Доступно {check.passed} из {check.total}
                </div>
              )}

              <div className="problem-card-actions">
                <button
                  type="button"
                  className={`btn ${fix.enabled ? 'btn-danger-tonal' : 'btn-primary'}`}
                  disabled={busyId !== null || checkingId !== null || state.testJob.running || state.steamSpeedJob.running}
                  onClick={() => setFix(fix, !fix.enabled)}
                >
                  {busyId === fix.id ? <RefreshCw size={15} className="spin-icon" /> : <ShieldCheck size={15} />}
                  {fix.enabled ? 'Откатить исправление' : 'Применить исправление'}
                </button>
                {!isDiscord && fix.enabled && (
                  <button
                    type="button"
                    className="btn btn-surface"
                    disabled={busyId !== null || checkingId !== null}
                    onClick={() => setFix(fix, true)}
                  >
                    <RefreshCw size={15} className={busyId === fix.id ? 'spin-icon' : ''} />
                    Обновить адреса
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-surface"
                  disabled={!fix.enabled || busyId !== null || checkingId !== null}
                  onClick={() => checkFix(fix)}
                >
                  {checkingId === fix.id ? <RefreshCw size={15} className="spin-icon" /> : <Wifi size={15} />}
                  Проверить
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <div className="inline-notice">
        <ShieldCheck size={16} />
        <span>
          Исправления добавляют только точечные правила. При откате исходные списки и исключения восстанавливаются автоматически.
        </span>
      </div>
    </div>
  );
};
