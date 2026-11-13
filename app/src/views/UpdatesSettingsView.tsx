import React, { useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  FolderOpen,
  ExternalLink,
  Download,
  Upload,
  Archive,
  RotateCcw,
  Settings2,
  CheckCircle2,
  ArrowUpCircle,
  Calendar,
  Save,
  LayoutPanelLeft,
  Sparkles,
} from 'lucide-react';
import { api } from '../api';
import type {
  AppProgramUpdateResult,
  AppSettings,
  FullAppState,
  UpdateCheckResult,
} from '../types';

interface UpdatesSettingsViewProps {
  state: FullAppState;
  updateInfo: UpdateCheckResult | null;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
  appUpdateInfo: AppProgramUpdateResult | null;
  checkingAppUpdate: boolean;
  onCheckAppUpdate: () => void;
  onUpdateInfoLoaded: (info: UpdateCheckResult) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onStateUpdated: (nextState: FullAppState) => void;
  onNotify: (msg: string, isError?: boolean) => void;
}

function formatRuDate(iso: string | null): string {
  if (!iso) return 'Неизвестно';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const UpdatesSettingsView: React.FC<UpdatesSettingsViewProps> = ({
  state,
  updateInfo,
  checkingUpdate,
  onCheckUpdate,
  appUpdateInfo,
  checkingAppUpdate,
  onCheckAppUpdate,
  onUpdateInfoLoaded,
  onUpdateSettings,
  onStateUpdated,
  onNotify,
}) => {
  const { settings, zapretInfo, appUpdateState } = state;
  const [customDir, setCustomDir] = useState<string>(settings.zapretDir);
  const [backupBusy, setBackupBusy] = useState<boolean>(false);
  const [downloadingZapretZip, setDownloadingZapretZip] = useState<boolean>(false);
  const [installingAppUpdate, setInstallingAppUpdate] = useState<boolean>(false);
  const [installPhaseText, setInstallPhaseText] = useState<string>('');
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const configImportRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCustomDir(settings.zapretDir);
  }, [settings.zapretDir]);

  const handleOpenExternal = (url: string) => {
    api.openExternalUrl(url);
  };

  const handleDownloadLatestZapret = async () => {
    if (state.platform.os !== 'win32') {
      window.open('/api/updates/download-latest', '_blank', 'noopener,noreferrer');
    }
    setDownloadingZapretZip(true);
    try {
      const res = await api.downloadLatestZapretZip();
      if (res.updateInfo) {
        onUpdateInfoLoaded(res.updateInfo);
      }
      onNotify(`Запущено скачивание ${res.assetName || 'Zapret (.zip)'}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setDownloadingZapretZip(false);
    }
  };

  const waitForRestartAndReload = (previousBootId?: string) => {
    let attempts = 0;
    let sawServerDown = false;
    const timer = setInterval(async () => {
      attempts++;
      if (attempts < 2) return;
      try {
        const nextState = await api.getState();
        const bootChanged =
          Boolean(previousBootId && nextState.serverBootId && nextState.serverBootId !== previousBootId);
        if (bootChanged || (!previousBootId && sawServerDown)) {
          clearInterval(timer);
          window.location.replace(`${window.location.pathname}?updated=${Date.now()}`);
        }
      } catch {
        sawServerDown = true;
        if (attempts > 65) {
          clearInterval(timer);
          setInstallingAppUpdate(false);
        }
      }
    }, 650);
  };

  const handleInstallFromGitHub = async () => {
    const prevBootId = state.serverBootId;
    setInstallingAppUpdate(true);
    setInstallPhaseText('Скачивание сборки с GitHub и сохранение ваших данных...');
    try {
      const res = await api.installAppUpdate();
      if (res.restarting) {
        setInstallPhaseText('Установка файлов и автоматический перезапуск...');
        waitForRestartAndReload(prevBootId);
      } else {
        setInstallPhaseText('Обновление установлено. Перезагрузка интерфейса...');
        setTimeout(() => {
          window.location.replace(`${window.location.pathname}?updated=${Date.now()}`);
        }, 600);
      }
    } catch (err) {
      setInstallingAppUpdate(false);
      onNotify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleZipFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const prevBootId = state.serverBootId;
    setInstallingAppUpdate(true);
    setInstallPhaseText(`Чтение архива ${file.name}...`);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Не удалось прочитать выбранный ZIP-файл'));
        reader.readAsDataURL(file);
      });

      const res = await api.installAppUpdate(base64);
      if (res.restarting) {
        setInstallPhaseText('Установка файлов и автоматический перезапуск...');
        waitForRestartAndReload(prevBootId);
      } else {
        setInstallPhaseText('Обновление установлено. Перезагрузка интерфейса...');
        setTimeout(() => {
          window.location.replace(`${window.location.pathname}?updated=${Date.now()}`);
        }, 600);
      }
    } catch (err) {
      setInstallingAppUpdate(false);
      onNotify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleExportConfig = async () => {
    setBackupBusy(true);
    try {
      const bundle = await api.exportConfig();
      const jsonStr = JSON.stringify(bundle, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const dateTag = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zapret-control-config-${dateTag}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onNotify('Конфигурация экспортирована в файл .json');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportConfigFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBackupBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const res = await api.importConfig(parsed);
      onStateUpdated(res.state);
      onNotify(`Конфигурация восстановлена (профилей: ${res.profilesCount})`);
    } catch (err) {
      onNotify(
        err instanceof SyntaxError
          ? 'Выбранный файл не является корректным JSON'
          : err instanceof Error
            ? err.message
            : String(err),
        true
      );
    } finally {
      setBackupBusy(false);
    }
  };

  const handleSaveBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await api.saveBackups();
      onStateUpdated(res.state);
      onNotify(`Резервная копия списков сохранена (${res.saved.length})`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await api.restoreBackups();
      onStateUpdated(res.state);
      onNotify(
        res.restored.length > 0
          ? `Восстановлено списков: ${res.restored.length}`
          : 'Резервные копии пока отсутствуют'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      const res = await api.openZapretFolder();
      if (res.note) onNotify(res.note);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const startupSwitches: Array<{
    key: keyof AppSettings;
    title: string;
    desc: string;
  }> = [
    {
      key: 'autoStartStrategyOnLaunch',
      title: 'Включать стратегию при запуске программы',
      desc: 'Сразу запускает стратегию текущего профиля при открытии',
    },
    {
      key: 'launchOnWindowsStartup',
      title: 'Запускать при старте Windows',
      desc: 'Автозагрузка при входе в систему без установки службы',
    },
    {
      key: 'startMinimizedToTray',
      title: 'Запускать свёрнутой в трей',
      desc: 'При старте с Windows не открывать главное окно на экране',
    },
    {
      key: 'minimizeToTrayOnClose',
      title: 'Сворачивать в трей при закрытии окна',
      desc: 'Крестик скрывает окно в трей, обход продолжает работать',
    },
    {
      key: 'autoRestartOnCrash',
      title: 'Перезапускать при неожиданном сбое winws.exe',
      desc: 'Автоматически поднимает обход после сна ПК или сброса сети',
    },
    {
      key: 'autoRestartOnFilterChange',
      title: 'Сразу применять изменения фильтров и списков',
      desc: 'Перезапускает активный обход при смене профиля или списков',
    },
    {
      key: 'autoCheckUpdates',
      title: 'Проверять обновления при запуске',
      desc: 'Фоновая проверка новых версий программы и Zapret',
    },
  ];

  const isClassicStackedLayout = settings.connectLayout === 'stacked';
  const showBestCards = settings.showBestStrategyCards !== false;
  const developerMode = Boolean(settings.developerMode);

  const localBuildLabel =
    appUpdateInfo?.currentShortSha || appUpdateState?.installedShortSha
      ? `#${appUpdateInfo?.currentShortSha || appUpdateState?.installedShortSha}`
      : 'Локальная';

  return (
    <div className="content-container">
      {/* 1. Self-Update Card for Zapret Control Program */}
      <div className="m3-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
            <div className="brand-mark">
              {appUpdateInfo?.updateAvailable ? (
                <ArrowUpCircle size={19} />
              ) : (
                <Sparkles size={18} />
              )}
            </div>
            <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Обновление программы Zapret Control</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {appUpdateInfo?.updateAvailable && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={installingAppUpdate || checkingAppUpdate}
                onClick={handleInstallFromGitHub}
              >
                <Download size={14} />
                Скачать, обновить и перезапустить
              </button>
            )}

            <button
              type="button"
              className={appUpdateInfo?.updateAvailable ? 'btn btn-surface' : 'btn btn-primary'}
              disabled={checkingAppUpdate || installingAppUpdate}
              onClick={onCheckAppUpdate}
            >
              <RefreshCw size={14} className={checkingAppUpdate ? 'spin-icon' : ''} />
              {checkingAppUpdate ? 'Проверка...' : 'Проверить обновление'}
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Установленная сборка</div>
            <div className="mono" style={{ fontSize: '19px', fontWeight: 700, marginTop: '4px' }}>
              {localBuildLabel}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              Профили и списки сохраняются
            </div>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>На GitHub</div>
            <div
              className="mono"
              style={{
                fontSize: '19px',
                fontWeight: 700,
                marginTop: '4px',
                color: appUpdateInfo
                  ? appUpdateInfo.updateAvailable
                    ? 'var(--m3-warn)'
                    : 'var(--m3-success)'
                  : 'var(--m3-text)',
              }}
            >
              {appUpdateInfo ? `#${appUpdateInfo.latestShortSha}` : 'Не проверено'}
            </div>
            <div
              style={{
                fontSize: '11.5px',
                color: 'var(--m3-text-muted)',
                marginTop: '4px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {appUpdateInfo
                ? appUpdateInfo.updateAvailable
                  ? `Доступно обновление (${appUpdateInfo.changedFilesCount})`
                  : 'Актуальная версия'
                : 'flare-award/ZapretMaronnFix'}
            </div>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--m3-text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              <Calendar size={13} />
              Дата сборки
            </div>
            <div style={{ fontSize: '14.5px', fontWeight: 600, marginTop: '7px' }}>
              {appUpdateInfo
                ? formatRuDate(appUpdateInfo.publishedAt)
                : appUpdateState?.commitDate
                  ? formatRuDate(appUpdateState.commitDate)
                  : 'Не проверено'}
            </div>
            <div
              style={{
                fontSize: '11.5px',
                color: 'var(--m3-text-muted)',
                marginTop: '5px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={appUpdateInfo?.commitMessage || appUpdateState?.commitMessage || ''}
            >
              {appUpdateInfo?.commitMessage || appUpdateState?.commitMessage || 'Готово к проверке'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {!appUpdateInfo?.updateAvailable && (
            <button
              type="button"
              className="btn btn-tonal"
              disabled={installingAppUpdate || checkingAppUpdate}
              onClick={handleInstallFromGitHub}
            >
              <Download size={14} />
              Переустановить с GitHub
            </button>
          )}

          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={handleZipFileSelected}
          />
          <button
            type="button"
            className="btn btn-surface"
            disabled={installingAppUpdate}
            onClick={() => zipInputRef.current?.click()}
          >
            <Archive size={14} />
            Обновить из ZIP
          </button>

          <button
            type="button"
            className="btn btn-surface"
            onClick={() =>
              handleOpenExternal(
                'https://github.com/flare-award/ZapretMaronnFix/tree/arena/9383b414-zapretmaronnfix'
              )
            }
          >
            <ExternalLink size={14} />
            GitHub
          </button>
        </div>
      </div>

      {/* 2. Zapret Versions & Update Checker */}
      <div className="m3-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
            <div className="brand-mark">
              {updateInfo?.updateAvailable ? <ArrowUpCircle size={19} /> : <CheckCircle2 size={19} />}
            </div>
            <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Версии Zapret и проверка обновлений</div>
          </div>

          <button type="button" className="btn btn-tonal" disabled={checkingUpdate} onClick={onCheckUpdate}>
            <RefreshCw size={14} className={checkingUpdate ? 'spin-icon' : ''} />
            {checkingUpdate ? 'Проверка...' : 'Проверить обновление'}
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Текущая версия</div>
            <div className="mono" style={{ fontSize: '20px', fontWeight: 700, marginTop: '4px' }}>
              v{zapretInfo.localVersion}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              Стратегий: {zapretInfo.strategyCount}
            </div>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Последний релиз</div>
            <div
              className="mono"
              style={{
                fontSize: '20px',
                fontWeight: 700,
                marginTop: '4px',
                color: updateInfo?.updateAvailable ? 'var(--m3-warn)' : 'var(--m3-success)',
              }}
            >
              {updateInfo ? `v${updateInfo.latestVersion}` : 'Не проверено'}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              {updateInfo
                ? updateInfo.updateAvailable
                  ? 'Доступна новая версия'
                  : 'Установлена свежая сборка'
                : 'Flowseal/zapret-discord-youtube'}
            </div>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--m3-text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              <Calendar size={13} />
              Дата релиза
            </div>
            <div style={{ fontSize: '14.5px', fontWeight: 600, marginTop: '7px' }}>
              {updateInfo ? formatRuDate(updateInfo.publishedAt) : 'Не проверено'}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '5px' }}>
              {updateInfo?.assetName || 'Официальный релиз'}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: updateInfo?.releaseNotes ? '12px' : 0,
          }}
        >
          <button
            type="button"
            className="btn btn-tonal"
            disabled={downloadingZapretZip}
            onClick={handleDownloadLatestZapret}
          >
            <Download size={14} />
            {downloadingZapretZip ? 'Загрузка...' : 'Скачать релиз Zapret'}
          </button>

          <button
            type="button"
            className="btn btn-surface"
            onClick={() => handleOpenExternal('https://github.com/Flowseal/zapret-discord-youtube/releases')}
          >
            <ExternalLink size={14} />
            Релизы на GitHub
          </button>
        </div>

        {updateInfo?.releaseNotes && (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '12px',
              background: 'var(--m3-surface-lowest)',
              border: '1px solid var(--m3-outline)',
              fontSize: '12px',
              color: 'var(--m3-text-secondary)',
              whiteSpace: 'pre-wrap',
              maxHeight: '150px',
              overflowY: 'auto',
              userSelect: 'text',
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--m3-text)', marginBottom: '4px' }}>
              {updateInfo.releaseName}:
            </div>
            {updateInfo.releaseNotes}
          </div>
        )}
      </div>

      {/* 3. Interface & Display Settings */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <LayoutPanelLeft size={18} />
          </div>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>Интерфейс</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="m3-switch-row">
            <div className="m3-switch-info">
              <div className="m3-switch-title">Карточки лучших стратегий во вкладке "Тесты"</div>
              <div className="m3-switch-desc">Быстрые рекомендации для Discord, YouTube и других сервисов</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showBestCards}
              className={`m3-switch ${showBestCards ? 'checked' : ''}`}
              onClick={() => onUpdateSettings({ showBestStrategyCards: !showBestCards })}
            >
              <span className="m3-switch-thumb" />
            </button>
          </div>

          <div className="m3-switch-row">
            <div className="m3-switch-info">
              <div className="m3-switch-title">Список стратегий под кнопкой подключения</div>
              <div className="m3-switch-desc">Вертикальная раскладка главного экрана вместо двух колонок</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isClassicStackedLayout}
              className={`m3-switch ${isClassicStackedLayout ? 'checked' : ''}`}
              onClick={() =>
                onUpdateSettings({
                  connectLayout: isClassicStackedLayout ? 'split' : 'stacked',
                })
              }
            >
              <span className="m3-switch-thumb" />
            </button>
          </div>

          <div className="m3-switch-row">
            <div className="m3-switch-info">
              <div className="m3-switch-title">Режим разработчика</div>
              <div className="m3-switch-desc">
                Конструктор своих стратегий, параметры движка winws и протоколы HTTP/TLS
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={developerMode}
              className={`m3-switch ${developerMode ? 'checked' : ''}`}
              onClick={() => onUpdateSettings({ developerMode: !developerMode })}
            >
              <span className="m3-switch-thumb" />
            </button>
          </div>
        </div>
      </div>

      {/* 4. Program Startup & Behavior Settings */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <Settings2 size={18} />
          </div>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>Автозапуск и поведение</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {startupSwitches.map((sw) => {
            const checked = Boolean(settings[sw.key]);
            return (
              <div key={sw.key} className="m3-switch-row">
                <div className="m3-switch-info">
                  <div className="m3-switch-title">{sw.title}</div>
                  <div className="m3-switch-desc">{sw.desc}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  className={`m3-switch ${checked ? 'checked' : ''}`}
                  onClick={() => onUpdateSettings({ [sw.key]: !checked })}
                >
                  <span className="m3-switch-thumb" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 5. Zapret Folder & Full Configuration Backup / Restore (#11) */}
      <div className="m3-card">
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '4px' }}>
          Папка Zapret и резервные копии
        </div>
        <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '12px' }}>
          Сохраните все свои профили, настройки, списки и стратегии в один файл или перенесите их на другой ПК.
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <input
            type="text"
            className="m3-input mono"
            style={{ flex: '1 1 300px' }}
            value={customDir}
            onChange={(e) => setCustomDir(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-tonal"
            disabled={customDir.trim() === settings.zapretDir}
            onClick={() => onUpdateSettings({ zapretDir: customDir.trim() })}
          >
            <Save size={14} />
            Сменить папку
          </button>
          <button type="button" className="btn btn-surface" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            Открыть папку
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={backupBusy} onClick={handleExportConfig}>
            <Download size={14} />
            Экспорт конфигурации
          </button>

          <input
            ref={configImportRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleImportConfigFile}
          />
          <button
            type="button"
            className="btn btn-tonal"
            disabled={backupBusy}
            onClick={() => configImportRef.current?.click()}
          >
            <Upload size={14} />
            Импорт конфигурации
          </button>

          <button type="button" className="btn btn-surface" disabled={backupBusy} onClick={handleSaveBackup}>
            <Archive size={14} />
            Бэкап списков
          </button>

          <button type="button" className="btn btn-surface" disabled={backupBusy} onClick={handleRestoreBackup}>
            <RotateCcw size={14} />
            Восстановить списки
          </button>
        </div>
      </div>

      {/* Modal Overlay while Installing Self-Update */}
      {installingAppUpdate && (
        <div className="modal-backdrop">
          <div
            className="modal-panel"
            style={{
              maxWidth: '430px',
              alignItems: 'center',
              textAlign: 'center',
              padding: '28px 24px',
            }}
          >
            <div className="brand-mark" style={{ width: '46px', height: '46px', borderRadius: '14px' }}>
              <RefreshCw size={22} className="spin-icon" />
            </div>
            <div style={{ fontSize: '16px', fontWeight: 600 }}>Обновление Zapret Control</div>
            <div style={{ fontSize: '13px', color: 'var(--m3-text-secondary)', lineHeight: 1.5 }}>
              {installPhaseText}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
