import React, { useState } from 'react';
import {
  Plus,
  Check,
  Copy,
  Pencil,
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
import { ModalBackdrop } from '../components/ModalBackdrop';

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

const MAX_PROFILE_NAME_LENGTH = 28;
const MAX_PROFILE_DESC_LENGTH = 90;

function formatStrategyName(fileName: string): string {
  return fileName.replace(/\.bat$/i, '');
}

function getProfileTitleSizeClass(title: string): string {
  const len = title.trim().length;
  if (len > 21) return 'size-compact';
  if (len > 14) return 'size-medium';
  return '';
}

export const ProfilesView: React.FC<ProfilesViewProps> = ({
  state,
  busy,
  onActivateProfile,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
}) => {
  const { profiles, activeProfileId } = state;

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');

  const openCreateModal = () => {
    setModalMode('create');
    setEditingId(null);
    setName('');
    setDescription('');
  };

  const openEditModal = (prof: UserProfile) => {
    setModalMode('edit');
    setEditingId(prof.id);
    setName(prof.name.slice(0, MAX_PROFILE_NAME_LENGTH));
    setDescription((prof.description || '').slice(0, MAX_PROFILE_DESC_LENGTH));
  };

  const closeModal = () => {
    setModalMode(null);
    setEditingId(null);
  };

  const handleDuplicate = (prof: UserProfile) => {
    const suffix = ' (копия)';
    const trimmedBase = prof.name.slice(0, MAX_PROFILE_NAME_LENGTH - suffix.length).trimEnd();
    const baseCopyName = `${trimmedBase}${suffix}`;
    onCreateProfile({
      name: baseCopyName,
      description: prof.description || '',
      strategy: prof.strategy,
      gameFilterMode: prof.gameFilterMode,
      gameFilterTcp: prof.gameFilterTcp,
      gameFilterUdp: prof.gameFilterUdp,
      ipsetMode: prof.ipsetMode,
      discordFakeBin: prof.discordFakeBin,
      gameFakeBin: prof.gameFakeBin,
      activateNow: false,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    if (modalMode === 'create') {
      const ok = await onCreateProfile({
        name: name.trim(),
        description: description.trim(),
        activateNow: true,
      });
      if (ok) closeModal();
    } else if (modalMode === 'edit' && editingId) {
      const ok = await onUpdateProfile(editingId, {
        name: name.trim(),
        description: description.trim(),
      });
      if (ok) closeModal();
    }
  };

  return (
    <div className="content-container">
      <div className="profiles-grid">
        {profiles.map((prof) => {
          const isActive = prof.id === activeProfileId;
          const stratText = formatStrategyName(prof.strategy);

          return (
            <div
              key={prof.id}
              role="button"
              tabIndex={0}
              className={`profile-card ${isActive ? 'active' : ''}`}
              onClick={() => {
                if (!busy && !isActive) {
                  onActivateProfile(prof.id, false);
                }
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !busy && !isActive) {
                  e.preventDefault();
                  onActivateProfile(prof.id, false);
                }
              }}
            >
              {/* Top: Title, optional description & action buttons */}
              <div className="profile-card-top">
                <div className="profile-card-heading">
                  <div
                    className={`profile-card-title ${getProfileTitleSizeClass(prof.name)}`}
                    title={prof.name}
                  >
                    {prof.name}
                  </div>
                  {prof.description && (
                    <div className="profile-card-desc" title={prof.description}>
                      {prof.description}
                    </div>
                  )}
                </div>

                <div className="profile-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="btn-icon"
                    title="Дублировать профиль"
                    disabled={busy}
                    onClick={() => handleDuplicate(prof)}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    title="Изменить название и описание профиля"
                    disabled={busy}
                    onClick={() => openEditModal(prof)}
                  >
                    <Pencil size={14} />
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

              {/* Middle: Saved Strategy & Filter Badges */}
              <div className="profile-card-body">
                <div className="profile-strategy-row">
                  <Layers size={15} color="var(--m3-primary)" style={{ flexShrink: 0 }} />
                  <span className="profile-strategy-caption">Стратегия:</span>
                  <span className="profile-strategy-value mono" title={stratText}>
                    {stratText}
                  </span>
                </div>

                <div className="profile-badges-row">
                  <span className={`score-pill ${prof.gameFilterMode !== 'disabled' ? 'good' : ''}`}>
                    <Gamepad2 size={11.5} />
                    Game: {GAME_MODE_LABELS[prof.gameFilterMode]}
                  </span>
                  <span className={`score-pill ${prof.ipsetMode !== 'none' ? 'partial' : ''}`}>
                    <Network size={11.5} />
                    IPSet: {IPSET_MODE_LABELS[prof.ipsetMode]}
                  </span>
                </div>
              </div>

              {/* Bottom: Clean Status Footer ("Текущий" / "Не выбран") */}
              <div className="profile-card-footer">
                {isActive ? (
                  <span className="profile-status-pill current">
                    <Check size={12.5} strokeWidth={2.4} />
                    Текущий
                  </span>
                ) : (
                  <span className="profile-status-pill idle">
                    <span className="profile-status-dot" />
                    Не выбран
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {/* Add Profile Card matching larger profile card proportions */}
        <button
          type="button"
          className="profile-add-card"
          disabled={busy}
          onClick={openCreateModal}
        >
          <span className="profile-add-icon">
            <Plus size={21} strokeWidth={2.2} />
          </span>
          <span style={{ fontSize: '14px', fontWeight: 600 }}>Добавить профиль</span>
        </button>
      </div>

      {/* Create / Edit Profile Info Modal */}
      {modalMode && (
        <ModalBackdrop onClose={closeModal}>
          <form
            className="modal-panel"
            style={{ maxWidth: '460px' }}
            onSubmit={handleSubmit}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ fontSize: '15.5px', fontWeight: 600 }}>
                {modalMode === 'create' ? 'Новый профиль' : 'Информация о профиле'}
              </div>
              <button type="button" className="btn-icon" onClick={closeModal}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '5px',
                  }}
                >
                  <label style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                    Название профиля
                  </label>
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--m3-text-muted)' }}>
                    {name.length}/{MAX_PROFILE_NAME_LENGTH}
                  </span>
                </div>
                <input
                  type="text"
                  required
                  autoFocus
                  maxLength={MAX_PROFILE_NAME_LENGTH}
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Например: Для игры"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, MAX_PROFILE_NAME_LENGTH))}
                />
              </div>

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    color: 'var(--m3-text-secondary)',
                    marginBottom: '5px',
                  }}
                >
                  Описание (необязательно)
                </label>
                <input
                  type="text"
                  maxLength={MAX_PROFILE_DESC_LENGTH}
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Краткая заметка о профиле"
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, MAX_PROFILE_DESC_LENGTH))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button type="button" className="btn btn-surface" onClick={closeModal}>
                Отмена
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                <Save size={14} />
                {modalMode === 'create' ? 'Создать' : 'Сохранить'}
              </button>
            </div>
          </form>
        </ModalBackdrop>
      )}
    </div>
  );
};
