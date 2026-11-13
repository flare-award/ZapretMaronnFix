import React, { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { api } from '../api';
import type { AppSettings, FullAppState, UpdateCheckResult } from '../types';

interface UpdatesSettingsViewProps {
  state: FullAppState;
  updateInfo: UpdateCheckResult | null;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
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
  onUpdateSettings,
  onStateUpdated,
  onNotify,
}) => {
  const { settings, zapretInfo } = state;
  const [customDir, setCustomDir] = useState<string>(settings.zapretDir);
  const [backupBusy, setBackupBusy] = useState<boolean>(false);

  useEffect(() => {
    setCustomDir(settings.zapretDir);
  }, [settings.zapretDir]);

  const handleOpenExternal = (url: string) => {
    api.openExternalUrl(url);
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
      title: 'Автоматически проверять выход новых версий Zapret',
      desc: 'При запуске проверяет свежий релиз в официальном репозитории Flowseal на GitHub.',
    },
  ];

  const isClassicStackedLayout = settings.connectLayout === 'stacked';
  const showBestCards = settings.showBestStrategyCards !== false;

  return (
    <div className="content-container">
      {/* Interface & Display Settings */}
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
                По умолчанию список стратегий находится справа от кнопки подключения, а 4 плашки фильтров — под кнопкой. Включите, чтобы вернуть прежний вариант.
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
        </div>
      </div>

      {/* Program Startup & Auto-Enable Strategy Settings */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <Settings2 size={18} />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Автозапуск и поведение программы</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
              Настройки применяются мгновенно и сохраняются между перезапусками и обновлениями Zapret
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

      {/* Zapret Version & Update Checker */}
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

          <button type="button" className="btn btn-primary" disabled={checkingUpdate} onClick={onCheckUpdate}>
            <RefreshCw size={14} />
            {checkingUpdate ? 'Проверка релизов...' : 'Проверить наличие обновлений'}
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

        {/* External Links opened via OS Default Browser */}
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

      {/* Isolated Zapret Folder & User List Protection */}
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
    </div>
  );
};
