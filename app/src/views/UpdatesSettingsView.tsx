import React, { useEffect, useRef, useState } from 'react';
import {
  RefreshCw,
  FolderOpen,
  ExternalLink,
  Download,
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
  onUpdateSettings,
  onStateUpdated,
  onNotify,
}) => {
  const { settings, zapretInfo, appUpdateState } = state;
  const [customDir, setCustomDir] = useState<string>(settings.zapretDir);
  const [backupBusy, setBackupBusy] = useState<boolean>(false);
  const [installingAppUpdate, setInstallingAppUpdate] = useState<boolean>(false);
  const [installPhaseText, setInstallPhaseText] = useState<string>('');
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCustomDir(settings.zapretDir);
  }, [settings.zapretDir]);

  const handleOpenExternal = (url: string) => {
    api.openExternalUrl(url);
  };

  const waitForRestartAndReload = (previousBootId?: string) => {
    let attempts = 0;
    let sawServerDown = false;
    const timer = setInterval(async () => {
      attempts++;
      if (attempts < 3) return;
      try {
        const nextState = await api.getState();
        const bootChanged =
          Boolean(previousBootId && nextState.serverBootId && nextState.serverBootId !== previousBootId);
        if (bootChanged || sawServerDown || (!previousBootId && attempts >= 6)) {
          clearInterval(timer);
          window.location.replace(`${window.location.pathname}?updated=${Date.now()}`);
        }
      } catch {
        sawServerDown = true;
        if (attempts > 55) {
          clearInterval(timer);
          setInstallingAppUpdate(false);
        }
      }
    }, 850);
  };

  const handleInstallFromGitHub = async () => {
    const prevBootId = state.serverBootId;
    setInstallingAppUpdate(true);
    setInstallPhaseText('Скачивание свежей сборки с GitHub и сохранение ваших профилей и списков...');
    try {
      const res = await api.installAppUpdate();
      if (res.restarting) {
        setInstallPhaseText('Установка файлов и автоматический перезапуск Zapret Control...');
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
    setInstallPhaseText(`Чтение архива ${file.name} и сохранение ваших профилей и списков...`);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Не удалось прочитать выбранный ZIP-файл'));
        reader.readAsDataURL(file);
      });

      const res = await api.installAppUpdate(base64);
      if (res.restarting) {
        setInstallPhaseText('Установка файлов и автоматический перезапуск Zapret Control...');
        waitForRestartAndReload(prevBootId);
      } else {
        setInstallPhaseText('Обновление из ZIP установлено. Перезагрузка интерфейса...');
        setTimeout(() => {
          window.location.replace(`${window.location.pathname}?updated=${Date.now()}`);
        }, 600);
      }
    } catch (err) {
      setInstallingAppUpdate(false);
      onNotify(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleSaveBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await api.saveBackups();
      onStateUpdated(res.state);
      onNotify(`Резервная копия создана (${res.saved.length} пользовательских файлов защищено)`);
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
          ? `Восстановлено файлов списков: ${res.restored.length}`
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
      desc: 'При открытии программы автоматически запускает выбранную стратегию активного профиля со всеми фильтрами.',
    },
    {
      key: 'launchOnWindowsStartup',
      title: 'Запускать программу при старте компьютера',
      desc: 'Добавляет Zapret Control в автозагрузку входа Windows (без установки постоянной фоновой службы winws).',
    },
    {
      key: 'startMinimizedToTray',
      title: 'Запускать свёрнутой в системный трей при старте ПК',
      desc: 'При автоматическом старте вместе с Windows программа сразу сворачивается в область уведомлений.',
    },
    {
      key: 'minimizeToTrayOnClose',
      title: 'Сворачивать в трей при закрытии окна',
      desc: 'При нажатии на крестик окна программа остаётся в трее и продолжает удерживать активную стратегию.',
    },
    {
      key: 'autoRestartOnFilterChange',
      title: 'Мгновенно применять изменения фильтров и списков',
      desc: 'Автоматически перезапускает активный процесс winws.exe при переключении профиля, Game Filter, IPSet или сохранении списков.',
    },
    {
      key: 'autoCheckUpdates',
      title: 'Автоматически проверять выход обновлений',
      desc: 'При запуске проверяет наличие обновлений самой программы и новых релизов Zapret на GitHub.',
    },
  ];

  const isClassicStackedLayout = settings.connectLayout === 'stacked';
  const showBestCards = settings.showBestStrategyCards !== false;
  const developerMode = Boolean(settings.developerMode);

  const localBuildLabel =
    appUpdateInfo?.currentShortSha || appUpdateState?.installedShortSha
      ? `#${appUpdateInfo?.currentShortSha || appUpdateState?.installedShortSha}`
      : 'Локальная сборка';

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
            <div>
              <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Обновление программы Zapret Control</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                Автоматическая загрузка, замена файлов программы и перезапуск с сохранением ваших профилей, настроек и списков
              </div>
            </div>
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
              {checkingAppUpdate ? 'Проверка GitHub...' : 'Проверить обновление программы'}
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Текущая ревизия программы</div>
            <div className="mono" style={{ fontSize: '19px', fontWeight: 700, marginTop: '4px' }}>
              {localBuildLabel}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              {appUpdateState?.installedBranch
                ? `Ветка: ${appUpdateState.installedBranch}`
                : 'Профили и списки защищены'}
            </div>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Сборка на GitHub</div>
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
              {appUpdateInfo ? `#${appUpdateInfo.latestShortSha}` : 'Нажмите проверить'}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              {appUpdateInfo
                ? appUpdateInfo.updateAvailable
                  ? `Доступно обновление (файлов: ${appUpdateInfo.changedFilesCount})`
                  : 'Установлена последняя версия программы'
                : `Источник: ${zapretInfo.links.userRepo.replace('https://github.com/', '')}`}
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
              Дата последнего обновления
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
              {appUpdateInfo?.commitMessage || appUpdateState?.commitMessage || 'Автоматическая пересборка лаунчера'}
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
              title="Скачать свежий архив с GitHub и переустановить файлы программы поверх текущих"
            >
              <Download size={14} />
              Переустановить свежую сборку с GitHub
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
            title="Обновить программу из скачанного вручную ZIP-архива репозитория без потери настроек"
          >
            <Archive size={14} />
            Обновить из ZIP-файла
          </button>

          <button
            type="button"
            className="btn btn-surface"
            onClick={() => handleOpenExternal(appUpdateInfo?.htmlUrl || zapretInfo.links.userRepo)}
          >
            <ExternalLink size={14} />
            Репозиторий программы на GitHub
          </button>
        </div>
      </div>

      {/* 2. Interface & Display Settings */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <LayoutPanelLeft size={18} />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Отображение и интерфейс</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
              Настройка расположения панелей на главном экране и карточек рекомендаций в тестах
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="m3-switch-row">
            <div className="m3-switch-info">
              <div className="m3-switch-title">
                Показывать плашки лучших стратегий во вкладке «Тесты и цели»
              </div>
              <div className="m3-switch-desc">
                Отображает карточки «Лучшая для всего», «Лучшая для Discord», «Лучшая для YouTube», «Лучшая для Cloudflare» и «Лучшая для GitHub».
              </div>
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
              <div className="m3-switch-title">
                Классическое расположение вкладки «Подключение» (список стратегий снизу)
              </div>
              <div className="m3-switch-desc">
                По умолчанию список стратегий находится справа от кнопки подключения, а плашки фильтров и профиля — под кнопкой. Включите, чтобы вернуть прежний вариант.
              </div>
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
                Отображает технические параметры движка winws, команды запуска .bat, счётчики проверок и протоколы HTTP/TLS во вкладках «Подключение» и «Тесты и цели».
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

      {/* 3. Program Startup & Auto-Enable Strategy Settings */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <Settings2 size={18} />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Автозапуск и поведение программы</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
              Настройки применяются мгновенно и сохраняются между перезапусками и обновлениями
            </div>
          </div>
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

      {/* 4. Zapret Version & Update Checker */}
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
            <div>
              <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Версия Zapret и проверка обновлений</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                Все файлы Zapret вынесены в отдельную папку zapret для обновления простой заменой файлов
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-tonal" disabled={checkingUpdate} onClick={onCheckUpdate}>
            <RefreshCw size={14} className={checkingUpdate ? 'spin-icon' : ''} />
            {checkingUpdate ? 'Проверка релизов...' : 'Проверить релизы Zapret'}
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Текущая локальная версия</div>
            <div className="mono" style={{ fontSize: '20px', fontWeight: 700, marginTop: '4px' }}>
              v{zapretInfo.localVersion}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              Стратегий: {zapretInfo.strategyCount} / бинарных пакетов: {zapretInfo.binCount}
            </div>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>Последний релиз на GitHub</div>
            <div
              className="mono"
              style={{
                fontSize: '20px',
                fontWeight: 700,
                marginTop: '4px',
                color: updateInfo?.updateAvailable ? 'var(--m3-warn)' : 'var(--m3-success)',
              }}
            >
              {updateInfo ? `v${updateInfo.latestVersion}` : 'Нажмите проверить'}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '4px' }}>
              {updateInfo
                ? updateInfo.updateAvailable
                  ? 'Доступна более новая версия'
                  : 'У вас установлена актуальная сборка'
                : 'Источник: Flowseal/zapret-discord-youtube'}
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
              Дата выхода релиза
            </div>
            <div style={{ fontSize: '14.5px', fontWeight: 600, marginTop: '7px' }}>
              {updateInfo ? formatRuDate(updateInfo.publishedAt) : 'Не проверено'}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--m3-text-muted)', marginTop: '5px' }}>
              {updateInfo?.assetName ? `Архив: ${updateInfo.assetName}` : 'Официальный пакет релизов'}
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
          {updateInfo?.downloadUrl && (
            <button
              type="button"
              className="btn btn-tonal"
              onClick={() => handleOpenExternal(updateInfo.downloadUrl!)}
            >
              <Download size={14} />
              Скачать архив релиза {updateInfo.assetName || ''}
            </button>
          )}

          <button
            type="button"
            className="btn btn-surface"
            onClick={() => handleOpenExternal(updateInfo?.htmlUrl || zapretInfo.links.latestRelease)}
          >
            <ExternalLink size={14} />
            Страница релиза GitHub
          </button>

          <button
            type="button"
            className="btn btn-surface"
            onClick={() => handleOpenExternal(zapretInfo.links.upstreamRepo)}
          >
            <ExternalLink size={14} />
            Репозиторий Flowseal
          </button>

          <button
            type="button"
            className="btn btn-surface"
            onClick={() => handleOpenExternal(zapretInfo.links.coreRepo)}
          >
            <ExternalLink size={14} />
            Репозиторий bol-van/zapret
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
              maxHeight: '160px',
              overflowY: 'auto',
              userSelect: 'text',
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--m3-text)', marginBottom: '4px' }}>
              Описание релиза {updateInfo.releaseName}:
            </div>
            {updateInfo.releaseNotes}
          </div>
        )}
      </div>

      {/* 5. Isolated Zapret Folder & User List Protection */}
      <div className="m3-card">
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '4px' }}>
          Изолированная папка файлов Zapret и сохранность ваших списков
        </div>
        <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '14px' }}>
          Чтобы обновить Zapret вручную, просто распакуйте новые файлы в папку ниже с заменой. Настройки, профили и резервные копии пользовательских списков хранятся отдельно в app/data и не затираются. Файлы в папке отслеживаются автоматически в реальном времени.
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <input
            type="text"
            className="m3-input mono"
            style={{ flex: '1 1 320px' }}
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
            Открыть папку zapret
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-tonal" disabled={backupBusy} onClick={handleSaveBackup}>
            <Archive size={14} />
            Сохранить резервную копию моих списков
          </button>
          <button type="button" className="btn btn-surface" disabled={backupBusy} onClick={handleRestoreBackup}>
            <RotateCcw size={14} />
            Восстановить мои списки после обновления
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
