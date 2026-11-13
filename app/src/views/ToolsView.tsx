import React, { useCallback, useEffect, useState } from 'react';
import {
  Stethoscope,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Eraser,
  ShieldAlert,
  Globe,
  Copy,
} from 'lucide-react';
import { api } from '../api';
import type { DiagnosticCheck, HostsCheckReport } from '../types';

interface ToolsViewProps {
  onNotify: (msg: string, isError?: boolean) => void;
}

export const ToolsView: React.FC<ToolsViewProps> = ({ onNotify }) => {
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [loadingDiag, setLoadingDiag] = useState<boolean>(false);
  const [hostsReport, setHostsReport] = useState<HostsCheckReport | null>(null);
  const [loadingHosts, setLoadingHosts] = useState<boolean>(false);
  const [toolBusy, setToolBusy] = useState<boolean>(false);

  const loadDiag = useCallback(async () => {
    setLoadingDiag(true);
    try {
      const res = await api.getDiagnostics();
      setChecks(res.checks);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setLoadingDiag(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadDiag();
  }, [loadDiag]);

  const handleFixWinDivert = async () => {
    setToolBusy(true);
    try {
      const res = await api.fixWinDivert();
      onNotify(res.actions.join('; '));
      await loadDiag();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setToolBusy(false);
    }
  };

  const handleClearDiscord = async () => {
    setToolBusy(true);
    try {
      const res = await api.clearDiscordCache();
      onNotify(res.cleared.join('; '));
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setToolBusy(false);
    }
  };

  const handleCheckHosts = async () => {
    setLoadingHosts(true);
    try {
      const rep = await api.checkHosts();
      setHostsReport(rep);
      onNotify(
        rep.upToDate
          ? 'Все рекомендованные записи hosts уже присутствуют в системе'
          : `Найдено ${rep.missingCount} отсутствующих записей для файла hosts`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setLoadingHosts(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify('Записи hosts скопированы в буфер обмена');
    } catch {
      onNotify('Не удалось скопировать в буфер обмена', true);
    }
  };

  return (
    <div className="content-container">
      {/* Quick Maintenance Utilities */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: '14px' }}>
        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div className="brand-mark">
              <ShieldAlert size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Остановка процесса и сервисное меню</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '3px' }}>
                Завершает текущий процесс обхода и открывает штатный zapret/service.bat для удаления старых служб
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-tonal" disabled={toolBusy} onClick={handleFixWinDivert}>
            Остановить процесс и показать service.bat
          </button>
        </div>

        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div className="brand-mark">
              <Eraser size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Штатная очистка кэша Discord</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '3px' }}>
                Открывает проверенный сервисный скрипт zapret/service.bat для штатного сброса локального кэша при ошибках RTC
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-tonal" disabled={toolBusy} onClick={handleClearDiscord}>
            Открыть утилиту в папке zapret
          </button>
        </div>

        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div className="brand-mark">
              <Globe size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Актуальный список записей hosts</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '3px' }}>
                Загружает актуальный список записей hosts из репозитория Flowseal для обхода Geo-DNS блокировок
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-tonal" disabled={loadingHosts} onClick={handleCheckHosts}>
            {loadingHosts ? 'Загрузка с GitHub...' : 'Получить список hosts'}
          </button>
        </div>
      </div>

      {/* Hosts Diff Result */}
      {hostsReport && (
        <div className="m3-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14.5px' }}>
                Результат сверки hosts ({hostsReport.systemHostsPath})
              </div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                Всего записей в репозитории: {hostsReport.totalRemoteEntries} / Отсутствует локально: {hostsReport.missingCount}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-surface"
              onClick={() => copyText(hostsReport.missingLines.join('\r\n') || hostsReport.remoteRaw)}
            >
              <Copy size={14} />
              Скопировать записи
            </button>
          </div>
          {hostsReport.missingLines.length > 0 && (
            <textarea
              readOnly
              className="m3-textarea"
              style={{ minHeight: '150px' }}
              value={hostsReport.missingLines.join('\n')}
            />
          )}
        </div>
      )}

      {/* System & Integrity Diagnostics */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-mark">
              <Stethoscope size={18} />
            </div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>Диагностика системы и окружения Zapret</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                Автоматическая проверка конфликтующих служб, сетевого стека и целостности файлов
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-surface" disabled={loadingDiag} onClick={loadDiag}>
            <RefreshCw size={14} />
            Обновить проверку
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '9px' }}>
          {checks.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '11px 13px',
                borderRadius: '12px',
                background: 'var(--m3-surface-low)',
                border: '1px solid var(--m3-outline)',
              }}
            >
              <div style={{ marginTop: '1px', flexShrink: 0 }}>
                {c.status === 'ok' && <CheckCircle2 size={16} color="var(--m3-success)" />}
                {c.status === 'warn' && <AlertTriangle size={16} color="var(--m3-warn)" />}
                {c.status === 'error' && <XCircle size={16} color="var(--m3-danger)" />}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{c.title}</div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
