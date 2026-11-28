import React, { useEffect, useState } from 'react';
import { Gamepad2, Network, Binary, Check, RefreshCw, Save, ChevronDown } from 'lucide-react';
import type { FullAppState, GameFilterMode, IpsetFilterMode } from '../types';
import { SeamlessSelect } from '../components/SeamlessSelect';

interface FiltersViewProps {
  state: FullAppState;
  busy: boolean;
  onSaveGameFilter: (payload: { mode?: GameFilterMode; tcpRange?: string; udpRange?: string }) => void;
  onSetIpsetMode: (mode: IpsetFilterMode) => void;
  onUpdateRemoteIpset: () => void;
  onSetActiveFake: (target: 'discord' | 'game', binFileName: string) => void;
}

export const FiltersView: React.FC<FiltersViewProps> = ({
  state,
  busy,
  onSaveGameFilter,
  onSetIpsetMode,
  onUpdateRemoteIpset,
  onSetActiveFake,
}) => {
  const { gameFilter, ipsetFilter, activeFakes } = state.filters;
  const [tcpRange, setTcpRange] = useState(gameFilter.tcpRange);
  const [udpRange, setUdpRange] = useState(gameFilter.udpRange);
  const [portsExpanded, setPortsExpanded] = useState(false);

  useEffect(() => {
    setTcpRange(gameFilter.tcpRange);
    setUdpRange(gameFilter.udpRange);
  }, [gameFilter.tcpRange, gameFilter.udpRange]);

  const gameModes: Array<{ id: GameFilterMode; title: string }> = [
    { id: 'disabled', title: 'Выключен' },
    { id: 'all', title: 'TCP и UDP' },
    { id: 'tcp', title: 'Только TCP' },
    { id: 'udp', title: 'Только UDP' },
  ];

  const ipsetModes: Array<{ id: IpsetFilterMode; title: string; hint: string }> = [
    { id: 'none', title: 'None', hint: 'Выключен' },
    { id: 'loaded', title: 'Loaded', hint: 'По списку IP' },
    { id: 'any', title: 'Any', hint: 'Все подсети' },
  ];

  const portsDirty = tcpRange.trim() !== gameFilter.tcpRange || udpRange.trim() !== gameFilter.udpRange;

  return (
    <div className="content-container">
      {/* Game Filter Card */}
      <div className="m3-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-mark">
              <Gamepad2 size={18} />
            </div>
            <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Game Filter</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`score-pill ${gameFilter.mode !== 'disabled' ? 'good' : ''}`}>
              Режим: {gameFilter.mode.toUpperCase()}
            </span>
            <button
              type="button"
              className="btn-icon"
              title={portsExpanded ? 'Скрыть диапазоны портов' : 'Раскрыть диапазоны портов'}
              aria-expanded={portsExpanded}
              onClick={() => setPortsExpanded((v) => !v)}
            >
              <ChevronDown
                size={16}
                style={{
                  transform: portsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 160ms var(--ease-m3)',
                }}
              />
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '10px',
          }}
        >
          {gameModes.map((gm) => {
            const selected = gameFilter.mode === gm.id;
            return (
              <button
                key={gm.id}
                type="button"
                disabled={busy}
                onClick={() => onSaveGameFilter({ mode: gm.id })}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  borderRadius: '14px',
                  border: selected ? '1px solid rgba(168, 199, 250, 0.45)' : '1px solid var(--m3-outline)',
                  background: selected ? 'rgba(29, 52, 88, 0.45)' : 'var(--m3-surface-low)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  transition: 'background-color 140ms var(--ease-m3), border-color 140ms var(--ease-m3)',
                }}
              >
                <span style={{ fontSize: '15px', fontWeight: 600 }}>{gm.title}</span>
                {selected && <Check size={16} color="var(--m3-primary)" strokeWidth={2.3} />}
              </button>
            );
          })}
        </div>

        {portsExpanded && (
          <div
            style={{
              marginTop: '14px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '12px',
              alignItems: 'end',
              padding: '14px 16px',
              borderRadius: '14px',
              background: 'var(--m3-surface-low)',
              border: '1px solid var(--m3-outline)',
              animation: 'fadeSlideIn 160ms var(--ease-m3)',
            }}
          >
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '12px',
                  color: 'var(--m3-text-secondary)',
                  marginBottom: '6px',
                }}
              >
                Диапазон портов TCP (например, 1024-65535)
              </label>
              <input
                type="text"
                className="m3-input mono"
                style={{ width: '100%' }}
                value={tcpRange}
                onChange={(e) => setTcpRange(e.target.value)}
              />
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '12px',
                  color: 'var(--m3-text-secondary)',
                  marginBottom: '6px',
                }}
              >
                Диапазон портов UDP (например, 1024-65535)
              </label>
              <input
                type="text"
                className="m3-input mono"
                style={{ width: '100%' }}
                value={udpRange}
                onChange={(e) => setUdpRange(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-surface"
                disabled={busy}
                onClick={() => {
                  setTcpRange('1024-65535');
                  setUdpRange('1024-65535');
                  onSaveGameFilter({ tcpRange: '1024-65535', udpRange: '1024-65535' });
                }}
              >
                Сбросить
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !portsDirty}
                onClick={() => onSaveGameFilter({ tcpRange, udpRange })}
              >
                <Save size={14} />
                Сохранить порты
              </button>
            </div>
          </div>
        )}
      </div>

      {/* IPSet Filter Card */}
      <div className="m3-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-mark">
              <Network size={18} />
            </div>
            <div style={{ fontSize: '15.5px', fontWeight: 600 }}>IPSet Filter</div>
          </div>

          <button type="button" className="btn btn-tonal" disabled={busy} onClick={onUpdateRemoteIpset}>
            <RefreshCw size={14} />
            Обновить базу подсетей с GitHub
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '10px',
          }}
        >
          {ipsetModes.map((im) => {
            const selected = ipsetFilter.mode === im.id;
            return (
              <button
                key={im.id}
                type="button"
                disabled={busy}
                onClick={() => onSetIpsetMode(im.id)}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  borderRadius: '14px',
                  border: selected ? '1px solid rgba(168, 199, 250, 0.45)' : '1px solid var(--m3-outline)',
                  background: selected ? 'rgba(29, 52, 88, 0.45)' : 'var(--m3-surface-low)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  transition: 'background-color 140ms var(--ease-m3), border-color 140ms var(--ease-m3)',
                }}
              >
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 600 }}>{im.title}</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--m3-text-secondary)', marginTop: '1px' }}>
                    {im.hint}
                  </div>
                </div>
                {selected && <Check size={16} color="var(--m3-primary)" strokeWidth={2.3} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Replace Active Fakes Card */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <Binary size={18} />
          </div>
          <div style={{ fontSize: '15.5px', fontWeight: 600 }}>Пакеты маскировки (Fakes)</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontWeight: 600, marginBottom: '8px' }}>
              Голосовой чат Discord
              {state.settings.developerMode ? ' (ACTIVE_DISCORD_UDP.bin)' : ''}
            </div>
            <SeamlessSelect
              fullWidth
              mono
              disabled={busy}
              value={activeFakes.discordCurrent || ''}
              placeholder="Выберите .bin пакет"
              options={activeFakes.availableBins.map((b) => ({
                value: b.fileName,
                label: state.settings.developerMode ? `${b.fileName} (${b.sizeBytes} Б)` : b.fileName,
              }))}
              onChange={(val) => {
                if (val) onSetActiveFake('discord', val);
              }}
            />
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontWeight: 600, marginBottom: '8px' }}>
              Игровой трафик UDP
              {state.settings.developerMode ? ' (ACTIVE_GAME_UDP.bin)' : ''}
            </div>
            <SeamlessSelect
              fullWidth
              mono
              disabled={busy}
              value={activeFakes.gameCurrent || ''}
              placeholder="Выберите .bin пакет"
              options={activeFakes.availableBins.map((b) => ({
                value: b.fileName,
                label: state.settings.developerMode ? `${b.fileName} (${b.sizeBytes} Б)` : b.fileName,
              }))}
              onChange={(val) => {
                if (val) onSetActiveFake('game', val);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
