import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** 与 src-tauri/src/lib.rs 的 AppInfo 对应 */
type AppInfo = {
  name: string;
  version: string;
  platform: string;
};

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // M1-2 的验收点：能调通 Rust 侧命令，说明前后端桥接与权限都就位
    invoke<AppInfo>('get_app_info')
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <div className="board-surface">
      <header className="board-topbar">
        <span className="brand">脉络</span>
        {info && (
          <span className="meta">
            Lumen {info.version} · {info.platform}
          </span>
        )}
        {error && <span className="meta meta-error">桥接未就绪：{error}</span>}
      </header>

      <main className="board-canvas">
        {/* M2 会在这里挂 CanvasEngine（SVG 连线层 + DOM 节点层） */}
      </main>

      <footer className="board-hint">右键空白处新建节点</footer>
    </div>
  );
}
