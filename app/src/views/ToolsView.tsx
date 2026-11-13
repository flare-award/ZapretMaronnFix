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
  Search,
  Plus,
} from 'lucide-react';
import { api } from '../api';
import type {
  DiagnosticCheck,
  FullAppState,
  HostsCheckReport,
  SiteDiagnosisReport,
} from '../types';

interface ToolsViewProps {
  state: FullAppState;
  onStateUpdated: (next: FullAppState) => void;
  onNotify: (msg: string, isError?: boolean) => void;
}

export const ToolsView: React.FC<ToolsViewProps> = ({ onStateUpdated, onNotify }) => {
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [loadingDiag, setLoadingDiag] = useState<boolean>(false);
  const [hostsReport, setHostsReport] = useState<HostsCheckReport | null>(null);
  const [loadingHosts, setLoadingHosts] = useState<boolean>(false);
  const [toolBusy, setToolBusy] = useState<boolean>(false);

  // Site availability & list check (#5)
  const [siteInput, setSiteInput] = useState<string>('');
  const [checkingSite, setCheckingSite] = useState<boolean>(false);
  const [siteReport, setSiteReport] = useState<SiteDiagnosisReport | null>(null);

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

  const handleCheckSite = async (e?: React.FormEvent, overrideDomain?: string) => {
    if (e) e.preventDefault();
    const target = (overrideDomain ?? siteInput).trim();
    if (!target) return;
    setCheckingSite(true);
    try {
      const rep = await api.checkSite(target);
      setSiteReport(rep);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setCheckingSite(false);
    }
  };

  const handleQuickAddSiteToList = async (listId: 'list-general-user' | 'list-exclude-user') => {
    if (!siteReport) return;
    setToolBusy(true);
    try {
      const res = await api.smartAddListEntries(listId, siteReport.domain);
      onStateUpdated(res.state);
      onNotify(res.message);
      await handleCheckSite(undefined, siteReport.domain);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setToolBusy(false);
    }
  };

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

  const handleInlineDiagnosticFix = async (action: NonNullable<DiagnosticCheck['fixAction']>) => {
    setToolBusy(true);
    try {
      if (action === 'fix-windivert') {
        const res = await api.fixWinDivert();
        onNotify(res.actions.join('; '));
      } else if (action === 'clean-lists') {
        const res = await api.cleanDomainLists();
        onStateUpdated(res.state);
        onNotify(`Списки доменов очищены (${res.cleanedFiles})`);
      } else if (action === 'enable-timestamps') {
        const res = await api.enableTcpTimestamps();
        onNotify(res.message);
      }
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
          ? 'Файл hosts актуален'
          : `Не хватает записей в hosts: ${rep.missingCount}`
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
      onNotify('Скопировано в буфер обмена');
    } catch {
      onNotify('Не удалось скопировать', true);
    }
  };

  return (
    <div className="content-container">
      {/* 1. Site Availability & Bypass List Diagnostic (#5) */}
      <div className="m3-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-mark">
              <Search size={17} />
            </div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>Проверка сайта</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                Проверяет DNS, наличие в списках обхода и соединение HTTPS
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={(e) => handleCheckSite(e)} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="m3-input mono"
            style={{ flex: '1 1 260px' }}
            placeholder="Ссылка или домен (например, youtube.com)..."
            value={siteInput}
            onChange={(e) => setSiteInput(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={checkingSite || !siteInput.trim()}
          >
            {checkingSite ? <RefreshCw size={14} className="spin-icon" /> : <Search size={14} />}
            {checkingSite ? 'Проверка...' : 'Проверить'}
          </button>
        </form>

        {siteReport && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', animation: 'fadeSlideIn 160ms var(--ease-m3)' }}>
            <div className="site-check-steps">
              <div className="site-step-card">
                <div className="site-step-head">
                  <span>DNS</span>
                  {siteReport.dns.ok ? (
                    <CheckCircle2 size={14} color="var(--m3-success)" />
                  ) : (
                    <XCircle size={14} color="var(--m3-danger)" />
                  )}
                </div>
                <div className="site-step-val mono" title={siteReport.dns.systemIps.join(', ')}>
                  {siteReport.dns.hasStubIp
                    ? 'Подмена IP'
                    : siteReport.dns.systemIps[0] || 'Не найден'}
                </div>
              </div>

              <div className="site-step-card">
                <div className="site-step-head">
                  <span>Списки</span>
                  {siteReport.lists.inBypassList ? (
                    <CheckCircle2 size={14} color="var(--m3-success)" />
                  ) : siteReport.lists.inExcludeList ? (
                    <AlertTriangle size={14} color="var(--m3-warn)" />
                  ) : (
                    <AlertTriangle size={14} color="var(--m3-text-muted)" />
                  )}
                </div>
                <div className="site-step-val" title={siteReport.lists.matchedRule || ''}>
                  {siteReport.lists.label}
                </div>
              </div>

              <div className="site-step-card">
                <div className="site-step-head">
                  <span>TCP 443</span>
                  {siteReport.tcp.ok ? (
                    <CheckCircle2 size={14} color="var(--m3-success)" />
                  ) : (
                    <XCircle size={14} color="var(--m3-danger)" />
                  )}
                </div>
                <div className="site-step-val mono">
                  {siteReport.tcp.pingMs !== null ? `${siteReport.tcp.pingMs} мс` : 'Таймаут'}
                </div>
              </div>

              <div className="site-step-card">
                <div className="site-step-head">
                  <span>HTTPS / TLS</span>
                  {siteReport.tls.ok ? (
                    <CheckCircle2 size={14} color="var(--m3-success)" />
                  ) : (
                    <XCircle size={14} color="var(--m3-danger)" />
                  )}
                </div>
                <div className="site-step-val">
                  {siteReport.tls.ok ? 'Доступен' : 'Блокируется'}
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '10px',
                padding: '10px 13px',
                borderRadius: '12px',
                background: 'var(--m3-surface-low)',
                border: '1px solid var(--m3-outline)',
              }}
            >
              <div style={{ fontSize: '12.5px', color: 'var(--m3-text)', flex: '1 1 260px' }}>
                <span className="mono" style={{ fontWeight: 600, marginRight: '6px' }}>
                  {siteReport.domain}:
                </span>
                <span style={{ color: 'var(--m3-text-secondary)' }}>{siteReport.summary}</span>
              </div>

              <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                {!siteReport.lists.inBypassList && (
                  <button
                    type="button"
                    className="btn btn-tonal"
                    style={{ height: '30px', padding: '0 11px', fontSize: '12px' }}
                    disabled={toolBusy}
                    onClick={() => handleQuickAddSiteToList('list-general-user')}
                  >
                    <Plus size={13} />
                    В список обхода
                  </button>
                )}
                {!siteReport.lists.inExcludeList && (
                  <button
                    type="button"
                    className="btn btn-surface"
                    style={{ height: '30px', padding: '0 11px', fontSize: '12px' }}
                    disabled={toolBusy}
                    onClick={() => handleQuickAddSiteToList('list-exclude-user')}
                  >
                    <Plus size={13} />
                    В исключения
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Quick Maintenance Utilities */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: '14px' }}>
        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div className="brand-mark">
              <ShieldAlert size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Сброс служб и драйвера</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                Останавливает чужие службы GoodbyeDPI / zapret и выгружает WinDivert
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-tonal" disabled={toolBusy} onClick={handleFixWinDivert}>
            Сбросить конфликты
          </button>
        </div>

        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div className="brand-mark">
              <Eraser size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Очистка кэша Discord</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                Помогает при зависании голосового канала (RTC Connecting)
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-tonal" disabled={toolBusy} onClick={handleClearDiscord}>
            Очистить кэш
          </button>
        </div>

        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div className="brand-mark">
              <Globe size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Сверка файла hosts</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                Проверяет записи для сервисов с региональным блоком
              </div>
            </div>
          </div>
          <button type="button" className="btn btn-tonal" disabled={loadingHosts} onClick={handleCheckHosts}>
            {loadingHosts ? 'Проверка...' : 'Проверить hosts'}
          </button>
        </div>
      </div>

      {/* Hosts Diff Result */}
      {hostsReport && (
        <div className="m3-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: hostsReport.missingLines.length > 0 ? '10px' : 0 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: '14.5px' }}>
                Файл hosts ({hostsReport.systemHostsPath})
              </div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                Всего записей: {hostsReport.totalRemoteEntries} / Не хватает: {hostsReport.missingCount}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-surface"
              onClick={() => copyText(hostsReport.missingLines.join('\r\n') || hostsReport.remoteRaw)}
            >
              <Copy size={14} />
              Скопировать
            </button>
          </div>
          {hostsReport.missingLines.length > 0 && (
            <div className="m3-textarea-shell">
              <textarea
                readOnly
                className="m3-textarea"
                style={{ minHeight: '140px', height: '165px' }}
                value={hostsReport.missingLines.join('\n')}
              />
            </div>
          )}
        </div>
      )}

      {/* 3. System & Conflict Diagnostics (#13) */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-mark">
              <Stethoscope size={18} />
            </div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Проверка системы</div>
          </div>

          <button type="button" className="btn btn-surface" disabled={loadingDiag} onClick={loadDiag}>
            <RefreshCw size={14} className={loadingDiag ? 'spin-icon' : ''} />
            Обновить
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: '9px' }}>
          {checks.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                padding: '11px 13px',
                borderRadius: '12px',
                background: 'var(--m3-surface-low)',
                border: '1px solid var(--m3-outline)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minWidth: 0 }}>
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

              {c.fixAction && (
                <button
                  type="button"
                  className="btn btn-tonal"
                  style={{ height: '28px', padding: '0 10px', fontSize: '11.5px', flexShrink: 0 }}
                  disabled={toolBusy}
                  onClick={() => handleInlineDiagnosticFix(c.fixAction!)}
                >
                  Исправить
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
