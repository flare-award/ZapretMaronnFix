import React, { useEffect, useState } from 'react';
import { Gamepad2, Network, Binary, Check, RefreshCw, Save } from 'lucide-react';
import type { FullAppState, GameFilterMode, IpsetFilterMode } from '../types';

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

  useEffect(() => {
    setTcpRange(gameFilter.tcpRange);
    setUdpRange(gameFilter.udpRange);
  }, [gameFilter.tcpRange, gameFilter.udpRange]);

  const gameModes: Array<{ id: GameFilterMode; title: string; desc: string }> = [
    { id: 'disabled', title: 'Выключен', desc: 'Обход не затрагивает высокие игровые порты (минимальный пинг в играх)' },
    { id: 'all', title: 'TCP и UDP', desc: 'Перехватывает как TCP, так и UDP порты из указанного ниже диапазона' },
    { id: 'tcp', title: 'Только TCP', desc: 'Применяет десинк только к игровым TCP-соединениям (авторизация, лобби)' },
    { id: 'udp', title: 'Только UDP', desc: 'Отправляет UDP-фейки только на игровые UDP-порты' },
  ];

  const ipsetModes: Array<{ id: IpsetFilterMode; title: string; desc: string }> = [
    {
      id: 'none',
      title: 'None (Отключён)',
      desc: 'В ipset-all.txt записана заглушка 203.0.113.113/32. Обход работает строго по доменным спискам без задевания игр на AWS/Cloudflare.',
    },
    {
      id: 'loaded',
      title: 'Loaded (По базе подсетей)',
      desc: `Фильтрация по загруженному списку подсетей (${ipsetFilter.entriesCount || ipsetFilter.backupEntriesCount} CIDR записей).`,
    },
    {
      id: 'any',
      title: 'Any (Все IP-адреса)',
      desc: 'Файл ipset-all.txt пуст - правила без hostlist применяются ко всем IP-адресам на целевых портах.',
    },
  ];

  const portsDirty = tcpRange.trim() !== gameFilter.tcpRange || udpRange.trim() !== gameFilter.udpRange;

  return (
    <div className="content-container">
      {/* Game Filter Card */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-mark">
              <Gamepad2 size={18} />
            </div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>Game Filter (Игровой фильтр портов)</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                Управляет файлом zapret/utils/game_filter.enabled и переменными GameFilterTCP / GameFilterUDP
              </div>
            </div>
          </div>
          <span className={`score-pill ${gameFilter.mode !== 'disabled' ? 'good' : ''}`}>
            Режим: {gameFilter.mode.toUpperCase()}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', marginBottom: '16px' }}>
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
                  padding: '13px 15px',
                  borderRadius: '14px',
                  border: selected ? '1px solid rgba(168, 199, 250, 0.45)' : '1px solid var(--m3-outline)',
                  background: selected ? 'rgba(29, 52, 88, 0.45)' : 'var(--m3-surface-low)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span>{gm.title}</span>
                  {selected && <Check size={15} color="var(--m3-primary)" />}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', lineHeight: 1.4 }}>{gm.desc}</div>
              </button>
            );
          })}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: '12px',
            alignItems: 'end',
            padding: '14px 16px',
            borderRadius: '14px',
            background: 'var(--m3-surface-low)',
            border: '1px solid var(--m3-outline)',
          }}
        >
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '6px' }}>
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
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '6px' }}>
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
              className="btn btn-primary"
              disabled={busy || !portsDirty}
              onClick={() => onSaveGameFilter({ tcpRange, udpRange })}
            >
              <Save size={14} />
              Сохранить порты
            </button>
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
              Сбросить 1024-65535
            </button>
          </div>
        </div>
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
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>IPSet Filter (Фильтрация по IP-подсетям)</div>
              <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
                Управляет режимом zapret/lists/ipset-all.txt и резервной базой ipset-all.txt.backup
              </div>
            </div>
          </div>

          <button type="button" className="btn btn-tonal" disabled={busy} onClick={onUpdateRemoteIpset}>
            <RefreshCw size={14} />
            Обновить базу подсетей с GitHub
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
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
                  padding: '13px 15px',
                  borderRadius: '14px',
                  border: selected ? '1px solid rgba(168, 199, 250, 0.45)' : '1px solid var(--m3-outline)',
                  background: selected ? 'rgba(29, 52, 88, 0.45)' : 'var(--m3-surface-low)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span>{im.title}</span>
                  {selected && <Check size={15} color="var(--m3-primary)" />}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', lineHeight: 1.4 }}>{im.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Active UDP Fake Payloads Replacement */}
      <div className="m3-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <div className="brand-mark">
            <Binary size={18} />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Активные UDP-фейки (Replace Active Fakes)</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)' }}>
              Подмена бинарных пакетов ACTIVE_DISCORD_UDP.bin и ACTIVE_GAME_UDP.bin для голосовых каналов и игр
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>Пакет для Discord Voice (ACTIVE_DISCORD_UDP.bin)</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '10px' }}>
              Текущий образец:{' '}
              <span className="mono" style={{ color: 'var(--m3-text)' }}>
                {activeFakes.discordCurrent || 'пользовательский / не задан'}
              </span>
            </div>
            <select
              className="m3-select mono"
              style={{ width: '100%' }}
              disabled={busy}
              value={activeFakes.discordCurrent || ''}
              onChange={(e) => {
                if (e.target.value) onSetActiveFake('discord', e.target.value);
              }}
            >
              <option value="" disabled>
                Выберите .bin файл из папки zapret/bin
              </option>
              {activeFakes.availableBins.map((b) => (
                <option key={b.fileName} value={b.fileName}>
                  {b.fileName} ({b.sizeBytes} байт)
                </option>
              ))}
            </select>
          </div>

          <div className="m3-card-compact" style={{ background: 'var(--m3-surface-low)' }}>
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>Пакет для Game Filter UDP (ACTIVE_GAME_UDP.bin)</div>
            <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginBottom: '10px' }}>
              Текущий образец:{' '}
              <span className="mono" style={{ color: 'var(--m3-text)' }}>
                {activeFakes.gameCurrent || 'пользовательский / не задан'}
              </span>
            </div>
            <select
              className="m3-select mono"
              style={{ width: '100%' }}
              disabled={busy}
              value={activeFakes.gameCurrent || ''}
              onChange={(e) => {
                if (e.target.value) onSetActiveFake('game', e.target.value);
              }}
            >
              <option value="" disabled>
                Выберите .bin файл из папки zapret/bin
              </option>
              {activeFakes.availableBins.map((b) => (
                <option key={b.fileName} value={b.fileName}>
                  {b.fileName} ({b.sizeBytes} байт)
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
