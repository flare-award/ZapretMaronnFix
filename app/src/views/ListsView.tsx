import React, { useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Plus,
  Search,
  Save,
  Trash2,
  Sparkles,
  Code2,
  LayoutGrid,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api';
import type { FullAppState, ListDocument } from '../types';

interface ListsViewProps {
  state: FullAppState;
  onStateUpdated: (nextState: FullAppState) => void;
  onNotify: (msg: string, isError?: boolean) => void;
}

export const ListsView: React.FC<ListsViewProps> = ({ state, onStateUpdated, onNotify }) => {
  const [selectedId, setSelectedId] = useState<string>('list-general-user');
  const [doc, setDoc] = useState<ListDocument | null>(null);
  const [rawText, setRawText] = useState<string>('');
  const [editorMode, setEditorMode] = useState<'visual' | 'raw'>('raw');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [newEntry, setNewEntry] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  const isDirty = doc !== null && rawText !== doc.content;

  useEffect(() => {
    let cancelled = false;
    api
      .getList(selectedId)
      .then((loaded) => {
        if (cancelled) return;
        setDoc(loaded);
        setRawText(loaded.content);
        // Keep the chosen editor mode when moving between files.
      })
      .catch((err) => {
        if (!cancelled) onNotify(err instanceof Error ? err.message : String(err), true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, onNotify]);

  // Live reload when zapret/ files change on disk (as long as editor has no unsaved edits)
  useEffect(() => {
    if (!state.zapretFingerprint || isDirty) return;
    let cancelled = false;
    api
      .getList(selectedId)
      .then((loaded) => {
        if (cancelled) return;
        setDoc((prev) => {
          if (prev && prev.content === loaded.content) return prev;
          setRawText(loaded.content);
          return loaded;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.zapretFingerprint, selectedId, isDirty]);

  const parsedEntries = useMemo(() => {
    return rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }, [rawText]);

  const visibleEntries = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return parsedEntries;
    return parsedEntries.filter((item) => item.toLowerCase().includes(q));
  }, [parsedEntries, filterQuery]);

  const handleSave = async (textToSave: string, autoClean: boolean) => {
    if (!doc) return;
    setSaving(true);
    try {
      const res = await api.saveList(doc.id, textToSave, autoClean);
      setDoc(res.list);
      setRawText(res.list.content);
      onStateUpdated(res.state);
      onNotify(`Сохранено (${res.list.entriesCount})`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  };

  const handleAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = newEntry.trim();
    if (!val || !doc) return;
    setSaving(true);
    try {
      const res = await api.smartAddListEntries(doc.id, val);
      setDoc(res.list);
      setRawText(res.list.content);
      onStateUpdated(res.state);
      setNewEntry('');
      onNotify(res.message);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  };

  const groupedLists = useMemo(() => [
    { title: 'Обход', items: state.listsMeta.filter((item) => !item.id.includes('exclude') && item.id !== 'targets') },
    { title: 'Исключения', items: state.listsMeta.filter((item) => item.id.includes('exclude')) },
    { title: 'Цели проверки', items: state.listsMeta.filter((item) => item.id === 'targets') },
  ], [state.listsMeta]);

  const handleRemoveEntry = async (entryToRemove: string) => {
    if (!doc) return;
    const nextLines = rawText
      .split(/\r?\n/)
      .filter((line) => line.trim().toLowerCase() !== entryToRemove.toLowerCase());
    await handleSave(nextLines.join('\n'), false);
  };

  return (
    <div className="content-container">
      <div className="lists-layout">
        {/* Left Sidebar of Lists */}
        <div className="m3-card-compact" style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          {groupedLists.map((group, groupIndex) => (
            <React.Fragment key={group.title}>
              <div style={{ fontSize: '10.5px', fontWeight: 650, color: 'var(--m3-text-muted)', padding: groupIndex === 0 ? '1px 4px' : '8px 4px 1px', textTransform: 'uppercase' }}>
                {group.title}
              </div>
              {group.items.map((lm) => {
                const active = lm.id === selectedId;
                const fileName = lm.relPath.split(/[\\/]/).pop() || lm.relPath;
                return (
                  <button key={lm.id} type="button" className={`list-selector-item ${active ? 'active' : ''}`} onClick={() => setSelectedId(lm.id)}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span className="mono" style={{ fontWeight: 600, fontSize: '12px' }}>{fileName}</span>
                      <span className="score-pill">{lm.entriesCount}</span>
                    </div>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        {/* Right Editor Area */}
        <div className="m3-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {doc ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <FileText size={16} color="var(--m3-primary)" />
                    <span style={{ fontSize: '15.5px', fontWeight: 600 }}>{doc.relPath.split(/[\\/]/).pop()}</span>
                    {doc.isUser && (
                      <span className="score-pill good">
                        <ShieldCheck size={11} />
                        Защищён
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--m3-text-secondary)', marginTop: '2px' }}>
                    {doc.subtitle}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div className="chip-row">
                      <button
                        type="button"
                        className={`m3-chip ${editorMode === 'raw' ? 'selected' : ''}`}
                        onClick={() => setEditorMode('raw')}
                      >
                        <Code2 size={13} />
                        Текст
                      </button>
                      <button
                        type="button"
                        className={`m3-chip ${editorMode === 'visual' ? 'selected' : ''}`}
                        onClick={() => setEditorMode('visual')}
                      >
                        <LayoutGrid size={13} />
                        Список
                      </button>
                    </div>

                  {doc.kind === 'domains' && (
                    <button
                      type="button"
                      className="btn btn-surface"
                      disabled={saving}
                      title="Убрать https://, лишние символы и дубликаты"
                      onClick={() => handleSave(rawText, true)}
                    >
                      <Sparkles size={14} />
                      Очистить
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={saving || !isDirty}
                    onClick={() => handleSave(rawText, false)}
                  >
                    <Save size={14} />
                    Сохранить
                  </button>
                </div>
              </div>

              {editorMode === 'visual' ? (
                <>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <form onSubmit={handleAddEntry} style={{ display: 'flex', gap: '8px', flex: '1 1 280px' }}>
                      <input
                        type="text"
                        className="m3-input mono"
                        style={{ flex: 1 }}
                        placeholder={
                          doc.kind === 'ipset'
                            ? 'IP или подсеть (например, 188.114.96.0/22)...'
                            : 'Вставьте ссылку или домен (например, https://example.com)...'
                        }
                        value={newEntry}
                        onChange={(e) => setNewEntry(e.target.value)}
                      />
                      <button type="submit" className="btn btn-tonal" disabled={saving || !newEntry.trim()}>
                        <Plus size={15} />
                        Добавить
                      </button>
                    </form>

                    <div className="input-wrap" style={{ flex: '0 1 210px' }}>
                      <Search size={14} className="input-icon" />
                      <input
                        type="text"
                        className="m3-input with-icon"
                        style={{ width: '100%' }}
                        placeholder="Поиск..."
                        value={filterQuery}
                        onChange={(e) => setFilterQuery(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="domain-items-viewport">
                    <div className="domain-items-grid">
                      {visibleEntries.slice(0, 300).map((entry) => (
                        <div key={entry} className="domain-chip-item">
                          <span className="domain-chip-text" title={entry}>
                            {entry}
                          </span>
                          <button
                            type="button"
                            className="btn-icon"
                            style={{ width: '25px', height: '25px', borderRadius: '7px' }}
                            title="Удалить запись"
                            disabled={saving}
                            onClick={() => handleRemoveEntry(entry)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {visibleEntries.length > 300 && (
                    <div style={{ fontSize: '12px', color: 'var(--m3-text-muted)' }}>
                      Показаны первые 300 из {visibleEntries.length}. Используйте поиск или режим "Текст".
                    </div>
                  )}

                  {visibleEntries.length === 0 && (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--m3-text-muted)' }}>
                      Список пуст.
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <div className="m3-textarea-shell">
                    <textarea
                      className="m3-textarea"
                      value={rawText}
                      onChange={(e) => setRawText(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <div
                    style={{
                      marginTop: '8px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '11.5px',
                      color: 'var(--m3-text-muted)',
                    }}
                  >
                    <span>По одной записи на строке</span>
                    <span className="mono">Записей: {parsedEntries.length}</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: '24px', color: 'var(--m3-text-secondary)' }}>Загрузка...</div>
          )}
        </div>
      </div>
    </div>
  );
};
