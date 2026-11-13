import React, { useState } from 'react';
import {
  Bookmark,
  Plus,
  Check,
  Play,
  Pencil,
  Copy,
  Trash2,
  X,
  Save,
  Gamepad2,
  Network,
  Layers,
} from 'lucide-react';
import type { CreateProfilePayload } from '../api';
import type {
  FullAppState,
  GameFilterMode,
  IpsetFilterMode,
  UserProfile,
} from '../types';

interface ProfilesViewProps {
  state: FullAppState;
  busy: boolean;
  onActivateProfile: (id: string, startRunnerAfter?: boolean) => void;
  onCreateProfile: (payload: CreateProfilePayload) => Promise<boolean>;
  onUpdateProfile: (id: string, patch: Partial<UserProfile>) => Promise<boolean>;
  onDeleteProfile: (id: string) => void;
}

const GAME_MODE_LABELS: Record<GameFilterMode, string> = {
  disabled: 'Выкл',
  all: 'TCP+UDP',
  tcp: 'TCP',
  udp: 'UDP',
};

const IPSET_MODE_LABELS: Record<IpsetFilterMode, string> = {
  none: 'None',
  loaded: 'Loaded',
  any: 'Any',
};

function formatStrategyName(fileName: string): string {
  return fileName.replace(/\.bat$/i, '');
}

export const ProfilesView: React.FC<ProfilesViewProps> = ({
  state,
  busy,
  onActivateProfile,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
}) => {
  const { profiles, activeProfileId, strategies, filters, runtime } = state;

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [strategy, setStrategy] = useState('');
  const [gameFilterMode, setGameFilterMode] = useState<GameFilterMode>('disabled');
  const [gameFilterTcp, setGameFilterTcp] = useState('1024-65535');
  const [gameFilterUdp, setGameFilterUdp] = useState('1024-65535');
  const [ipsetMode, setIpsetMode] = useState<IpsetFilterMode>('none');
  const [discordFakeBin, setDiscordFakeBin] = useState<string>('');
  const [gameFakeBin, setGameFakeBin] = useState<string>('');
  const [activateNow, setActivateNow] = useState<boolean>(true);

  const openCreateModal = (source?: UserProfile) => {
    setModalMode('create');
    setEditingId(null);
    setName(source ? `${source.name} (копия)` : '');
    setDescription(source ? source.description : '');
    setStrategy(source ? source.strategy : state.settings.selectedStrategy);
    setGameFilterMode(source ? source.gameFilterMode : filters.gameFilter.mode);
    setGameFilterTcp(source ? source.gameFilterTcp : filters.gameFilter.tcpRange);
    setGameFilterUdp(source ? source.gameFilterUdp : filters.gameFilter.udpRange);
    setIpsetMode(source ? source.ipsetMode : filters.ipsetFilter.mode);
    setDiscordFakeBin(source?.discordFakeBin || filters.activeFakes.discordCurrent || '');
    setGameFakeBin(source?.gameFakeBin || filters.activeFakes.gameCurrent || '');
    setActivateNow(true);
  };

  const openEditModal = (prof: UserProfile) => {
    setModalMode('edit');
    setEditingId(prof.id);
    setName(prof.name);
    setDescription(prof.description || '');
    setStrategy(prof.strategy);
    setGameFilterMode(prof.gameFilterMode);
    setGameFilterTcp(prof.gameFilterTcp);
    setGameFilterUdp(prof.gameFilterUdp);
    setIpsetMode(prof.ipsetMode);
    setDiscordFakeBin(prof.discordFakeBin || '');
    setGameFakeBin(prof.gameFakeBin || '');
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (modalMode === 'create') {
      const ok = await onCreateProfile({
        name: name.trim(),
        description: description.trim(),
        strategy,
        gameFilterMode,
        gameFilterTcp: gameFilterTcp.trim(),
        gameFilterUdp: gameFilterUdp.trim(),
        ipsetMode,
        discordFakeBin: discordFakeBin || null,
        gameFakeBin: gameFakeBin || null,
        activateNow,
      });
      if (ok) closeModal();
    } else if (modalMode === 'edit' && editingId) {
      const ok = await onUpdateProfile(editingId, {
        name: name.trim(),
        description: description.trim(),
        strategy,
        gameFilterMode,
        gameFilterTcp: gameFilterTcp.trim(),
        gameFilterUdp: gameFilterUdp.trim(),
        ipsetMode,
        discordFakeBin: discordFakeBin || null,
        gameFakeBin: gameFakeBin || null,
      });
      if (ok) closeModal();
    }
  };

  return (
    <div className="content-container">
      {/* Header Toolbar */}
      <div
        className="m3-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
          <div className="brand-mark">
            <Bookmark size={18} />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Профили под игры и задачи</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
              Каждый профиль хранит выбранную стратегию, режим и порты Game Filter, режим IPSet и UDP-фейки
            </div>
          </div>
        </div>

        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => openCreateModal()}>
          <Plus size={15} />
          Создать профиль
        </button>
      </div>

      {/* Profiles Grid */}
      <div className="profiles-grid">
        {profiles.map((prof) => {
          const isActive = prof.id === activeProfileId;
          return (
            <div key={prof.id} className={`profile-card ${isActive ? 'active' : ''}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '15px', fontWeight: 600 }}>{prof.name}</span>
                      {prof.isDefault && (
                        <span className="score-pill">По умолчанию</span>
                      )}
                      {isActive && (
                        <span className="score-pill good">
                          <Check size={11} strokeWidth={2.3} />
                          Выбран
                        </span>
                      )}
                    </div>
                    {prof.description && (
                      <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '3px' }}>
                        {prof.description}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Изменить параметры профиля"
                      disabled={busy}
                      onClick={() => openEditModal(prof)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Дублировать профиль"
                      disabled={busy}
                      onClick={() => openCreateModal(prof)}
                    >
                      <Copy size={14} />
                    </button>
                    {!prof.isDefault && (
                      <button
                        type="button"
                        className="btn-icon"
                        title="Удалить профиль"
                        disabled={busy}
                        onClick={() => onDeleteProfile(prof.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Configuration Summary Pills */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      fontSize: '12.5px',
                      color: 'var(--m3-text)',
                    }}
                  >
                    <Layers size={14} color="var(--m3-primary)" />
                    <span style={{ color: 'var(--m3-text-secondary)' }}>Стратегия:</span>
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {formatStrategyName(prof.strategy)}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span className={`score-pill ${prof.gameFilterMode !== 'disabled' ? 'good' : ''}`}>
                      <Gamepad2 size={11} />
                      Game: {GAME_MODE_LABELS[prof.gameFilterMode]}
                    </span>
                    <span className={`score-pill ${prof.ipsetMode !== 'none' ? 'partial' : ''}`}>
                      <Network size={11} />
                      IPSet: {IPSET_MODE_LABELS[prof.ipsetMode]}
                    </span>
                    {prof.gameFilterMode !== 'disabled' && (
                      <span className="score-pill">
                        TCP {prof.gameFilterTcp} / UDP {prof.gameFilterUdp}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', paddingTop: '4px' }}>
                {!isActive ? (
                  <button
                    type="button"
                    className="btn btn-tonal"
                    style={{ flex: 1, height: '33px' }}
                    disabled={busy}
                    onClick={() => onActivateProfile(prof.id, false)}
                  >
                    Переключить профиль
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-surface"
                    style={{ flex: 1, height: '33px' }}
                    disabled
                  >
                    <Check size={14} />
                    Активный профиль
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ height: '33px' }}
                  disabled={busy}
                  title="Применить этот профиль и запустить обход"
                  onClick={() => onActivateProfile(prof.id, true)}
                >
                  <Play size={13} />
                  {isActive && runtime.running ? 'Перезапустить' : 'Запустить'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Edit Profile Modal */}
      {modalMode && (
        <div className="modal-backdrop" onClick={closeModal}>
          <form className="modal-panel" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ fontSize: '15.5px', fontWeight: 600 }}>
                {modalMode === 'create' ? 'Создание нового профиля' : 'Редактирование профиля'}
              </div>
              <button type="button" className="btn-icon" onClick={closeModal}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', overflowY: 'auto', paddingRight: '2px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  Название профиля
                </label>
                <input
                  type="text"
                  required
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Например: Для игры REMATCH"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  Описание (необязательно)
                </label>
                <input
                  type="text"
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Например: Game TCP + IPSet Any"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  Стратегия Zapret
                </label>
                <select
                  className="m3-select"
                  style={{ width: '100%' }}
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                >
                  {strategies.map((s) => (
                    <option key={s.fileName} value={s.fileName}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  Режим IPSet Filter
                </label>
                <select
                  className="m3-select"
                  style={{ width: '100%' }}
                  value={ipsetMode}
                  onChange={(e) => setIpsetMode(e.target.value as IpsetFilterMode)}
                >
                  <option value="none">None (Только списки доменов)</option>
                  <option value="loaded">Loaded (База подсетей ipset-all)</option>
                  <option value="any">Any (Все IP-адреса)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  Режим Game Filter
                </label>
                <select
                  className="m3-select"
                  style={{ width: '100%' }}
                  value={gameFilterMode}
                  onChange={(e) => setGameFilterMode(e.target.value as GameFilterMode)}
                >
                  <option value="disabled">Выключен</option>
                  <option value="all">TCP и UDP</option>
                  <option value="tcp">Только TCP</option>
                  <option value="udp">Только UDP</option>
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    Порты TCP
                  </label>
                  <input
                    type="text"
                    className="m3-input mono"
                    style={{ width: '100%' }}
                    value={gameFilterTcp}
                    onChange={(e) => setGameFilterTcp(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                    Порты UDP
                  </label>
                  <input
                    type="text"
                    className="m3-input mono"
                    style={{ width: '100%' }}
                    value={gameFilterUdp}
                    onChange={(e) => setGameFilterUdp(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  UDP-фейк для Discord Voice
                </label>
                <select
                  className="m3-select mono"
                  style={{ width: '100%' }}
                  value={discordFakeBin}
                  onChange={(e) => setDiscordFakeBin(e.target.value)}
                >
                  <option value="">Оставить текущий</option>
                  {filters.activeFakes.availableBins.map((b) => (
                    <option key={b.fileName} value={b.fileName}>
                      {b.fileName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '5px' }}>
                  UDP-фейк для Game Filter
                </label>
                <select
                  className="m3-select mono"
                  style={{ width: '100%' }}
                  value={gameFakeBin}
                  onChange={(e) => setGameFakeBin(e.target.value)}
                >
                  <option value="">Оставить текущий</option>
                  {filters.activeFakes.availableBins.map((b) => (
                    <option key={b.fileName} value={b.fileName}>
                      {b.fileName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {modalMode === 'create' && (
              <div className="m3-switch-row" style={{ padding: '10px 14px' }}>
                <div className="m3-switch-info">
                  <div className="m3-switch-title">Сразу переключиться на созданный профиль</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={activateNow}
                  className={`m3-switch ${activateNow ? 'checked' : ''}`}
                  onClick={() => setActivateNow((v) => !v)}
                >
                  <span className="m3-switch-thumb" />
                </button>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button type="button" className="btn btn-surface" onClick={closeModal}>
                Отмена
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                <Save size={14} />
                Сохранить профиль
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
