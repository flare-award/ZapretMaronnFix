import React, { useState } from 'react';
import {
  Plus,
  Check,
  Play,
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
  const { profiles, activeProfileId, runtime } = state;

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
    setName(prof.name);
    setDescription(prof.description || '');
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
          return (
            <div key={prof.id} className={`profile-card ${isActive ? 'active' : ''}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '15px', fontWeight: 600 }}>{prof.name}</span>
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

                {/* Live Saved State Summary */}
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
                    Выбрать профиль
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

        {/* Compact Add Profile Card right inside the grid */}
        <button
          type="button"
          className="profile-add-card"
          disabled={busy}
          onClick={openCreateModal}
        >
          <span className="profile-add-icon">
            <Plus size={19} strokeWidth={2.2} />
          </span>
          <span style={{ fontSize: '13.5px', fontWeight: 600 }}>Добавить профиль</span>
        </button>
      </div>

      {/* Create / Edit Profile Info Modal (Name & Description only) */}
      {modalMode && (
        <div className="modal-backdrop" onClick={closeModal}>
          <form
            className="modal-panel"
            style={{ maxWidth: '460px' }}
            onClick={(e) => e.stopPropagation()}
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
                <label
                  style={{
                    display: 'block',
                    fontSize: '12px',
                    color: 'var(--m3-text-secondary)',
                    marginBottom: '5px',
                  }}
                >
                  Название профиля
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Например: Для игры"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
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
                  className="m3-input"
                  style={{ width: '100%' }}
                  placeholder="Краткая заметка о профиле"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
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
        </div>
      )}
    </div>
  );
};
