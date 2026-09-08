import { useCallback, useEffect, useState } from 'react';
import { api, type SnapshotMeta, type BoardFile } from '../api';

/**
 * 快照与恢复（M6-8）：列出当前白板 `.snapshots/` 下的历史版本，可恢复 / 删除，也可手动存一份。
 * 白板每次打开会自动存快照（去重、保留最近 20 份）；恢复前会自动给当前状态存一份「恢复前保险」。
 */

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function SnapshotPanel({
  open,
  projectId,
  boardId,
  boardName,
  onClose,
  onRestored,
}: {
  open: boolean;
  projectId: string | null;
  boardId: string | null;
  boardName: string | null;
  onClose: () => void;
  /** 恢复成功后把新白板内容交回 App 应用到画布 */
  onRestored: (board: BoardFile) => void;
}) {
  const [items, setItems] = useState<SnapshotMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId || !boardId) return;
    setBusy(true);
    try {
      setItems(await api.snapshotList(projectId, boardId));
    } catch (e) {
      setNote(`读取快照失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [projectId, boardId]);

  useEffect(() => {
    if (open) {
      setNote(null);
      refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const doCreate = async () => {
    if (!projectId || !boardId) return;
    setBusy(true);
    setNote(null);
    try {
      const f = await api.snapshotCreate(projectId, boardId, false);
      setNote(f ? '已存快照。' : '当前内容与最近一份快照相同，未重复保存。');
      await refresh();
    } catch (e) {
      setNote(`保存失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (m: SnapshotMeta) => {
    if (!projectId || !boardId) return;
    if (
      !confirm(
        `恢复到「${fmtTime(m.created_at)}」这份快照？\n当前白板内容会先自动存一份「恢复前保险」，可再回退。`,
      )
    )
      return;
    setBusy(true);
    setNote(null);
    try {
      const board = await api.snapshotRestore(projectId, boardId, m.file);
      onRestored(board);
      setNote('已恢复。当前状态已存为「恢复前保险」快照。');
      await refresh();
    } catch (e) {
      setNote(`恢复失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (m: SnapshotMeta) => {
    if (!projectId || !boardId) return;
    if (!confirm(`删除这份快照？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await api.snapshotDelete(projectId, boardId, m.file);
      await refresh();
    } catch (e) {
      setNote(`删除失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="gs-overlay" onClick={onClose}>
      <div
        className="gs-panel snap-panel glass-surface"
        role="dialog"
        aria-label="快照与恢复"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="snap-head">
          <div className="snap-title">
            <span>快照与恢复</span>
            {boardName && <span className="snap-sub">{boardName}</span>}
          </div>
          <div className="snap-head-actions">
            <button type="button" className="snap-btn snap-btn-primary" onClick={doCreate} disabled={busy}>
              存快照
            </button>
            <button type="button" className="snap-btn" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
        </div>

        {note && <div className="snap-note">{note}</div>}

        <div className="snap-list">
          {busy && items.length === 0 && <div className="gs-status">加载中…</div>}
          {!busy && items.length === 0 && (
            <div className="gs-status gs-hint">
              还没有快照。白板每次打开会自动存一份；也可点右上角「存快照」手动保存。保留最近 20 份。
            </div>
          )}
          {items.map((m) => (
            <div key={m.file} className="snap-item">
              <div className="snap-item-main">
                <div className="snap-item-time">
                  {fmtTime(m.created_at)}
                  {m.auto_backup && <span className="snap-badge">恢复前保险</span>}
                </div>
                <div className="snap-item-meta">
                  {m.nodes} 节点 · {m.edges} 连线 · {fmtBytes(m.bytes)}
                </div>
              </div>
              <div className="snap-item-actions">
                <button type="button" className="snap-btn" onClick={() => doRestore(m)} disabled={busy}>
                  恢复
                </button>
                <button type="button" className="snap-btn snap-btn-danger" onClick={() => doDelete(m)} disabled={busy}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
