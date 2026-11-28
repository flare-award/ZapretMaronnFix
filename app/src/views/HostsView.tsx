import React, { useEffect, useState } from 'react';
import { FileText, FolderOpen, RefreshCw, Save } from 'lucide-react';
import { api } from '../api';

interface HostsViewProps {
  onNotify: (message: string, isError?: boolean) => void;
}

export const HostsView: React.FC<HostsViewProps> = ({ onNotify }) => {
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [filePath, setFilePath] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const result = await api.getSystemHosts();
    setContent(result.content);
    setSavedContent(result.content);
    setFilePath(result.path);
  };

  useEffect(() => {
    load().catch((error) => onNotify(error instanceof Error ? error.message : String(error), true));
  }, []);

  const run = async (action: () => Promise<{ content?: string; path?: string }>, message: string) => {
    setBusy(true);
    try {
      const result = await action();
      if (typeof result.content === 'string') {
        setContent(result.content);
        setSavedContent(result.content);
      }
      if (result.path) setFilePath(result.path);
      onNotify(message);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content-container">
      <div className="m3-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 650 }}>
              <FileText size={17} color="var(--m3-primary)" />
              Системный hosts
            </div>
            <div className="mono" style={{ marginTop: 4, fontSize: 11.5, color: 'var(--m3-text-muted)' }}>{filePath}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-surface" disabled={busy} onClick={() => run(api.openSystemHostsLocation, 'Папка hosts открыта')}>
              <FolderOpen size={14} /> Открыть расположение
            </button>
            <button className="btn btn-tonal" disabled={busy} onClick={() => run(api.updateSystemHosts, 'Официальные записи hosts обновлены')}>
              <RefreshCw size={14} /> Обновить из Zapret
            </button>
            <button className="btn btn-primary" disabled={busy || content === savedContent} onClick={() => run(() => api.saveSystemHosts(content), 'Файл hosts сохранён')}>
              <Save size={14} /> Сохранить
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--m3-text-secondary)' }}>
          Официальные записи добавляются в отдельный управляемый блок. Ваши собственные строки вне блока сохраняются.
        </div>
        <div className="m3-textarea-shell">
          <textarea className="m3-textarea mono" style={{ minHeight: 430 }} value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} />
        </div>
      </div>
    </div>
  );
};
