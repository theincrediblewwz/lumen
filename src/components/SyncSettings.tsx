import { useEffect, useState } from 'react';
import { getSyncStatus, keepCurrentProjection, loadSyncSettings, resolveDesktopConflict, runDesktopSync, saveSyncSettings, subscribeSync, type SyncSettings as Config } from '../sync/service';

export function SyncSettings() {
  const [config,setConfig]=useState<Config|null>(null);const [password,setPassword]=useState('');const [status,setStatus]=useState(getSyncStatus);const [error,setError]=useState('');
  useEffect(()=>{void loadSyncSettings().then(setConfig).catch(()=>setError('选择本地资料目录后可设置同步'));return subscribeSync(setStatus);},[]);
  const save=async(enabled:boolean)=>{
    if(!config)return;
    try{setError('');setConfig(await saveSyncSettings({...config,enabled},password));setPassword('');if(enabled)await runDesktopSync();}catch(e){setError(String(e));}
  };
  return <details className="settings-section settings-disclosure sync-settings">
    <summary><span>跨设备同步</span><span className="settings-summary-value">{status.pendingProjection || status.conflicts.length ? '需要处理' : error ? '未配置' : status.busy ? '同步中' : config?.enabled ? '已开启' : '未开启'}</span></summary>
    <div className="sync-settings-body">
    <p className="settings-hint">将白板、文档、知识库和附件同步到你自己的 WebDAV；各设备使用相同的同步库标识。</p>
    {config&&<>
      <label>WebDAV 地址<input className="input" value={config.endpoint} type="url" autoComplete="off" placeholder="https://…" onChange={e=>setConfig({...config,endpoint:e.target.value})}/></label>
      <label>用户名<input className="input" value={config.username} autoComplete="off" onChange={e=>setConfig({...config,username:e.target.value})}/></label>
      <label>应用密码<input className="input" type="password" value={password} autoComplete="new-password" placeholder="留空保留已保存密码" onChange={e=>setPassword(e.target.value)}/></label>
      <label>同步库标识<input className="input" value={config.libraryId} placeholder="例如 study-library" onChange={e=>setConfig({...config,libraryId:e.target.value})}/></label>
      <p className="settings-hint">开启后会上传当前资料。密码保存在系统凭据库；关闭软件后暂停同步。</p>
      <div className="settings-actions"><button className="btn" disabled={status.busy||!config.endpoint||!config.libraryId} type="button" onClick={()=>void save(true)}>保存并开启</button><button className="btn" disabled={status.busy||!config.enabled} type="button" onClick={()=>void save(false)}>暂停</button><button className="btn" disabled={status.busy||!config.enabled} type="button" onClick={()=>void runDesktopSync().catch(()=>{})}>立即同步</button></div>
    </>}
    <p className="settings-hint" role="status">{status.message}</p>{error&&<p className="error-text" role="alert">{error}</p>}
    {status.pendingProjection&&<details><summary>删除或引用冲突 · 当前资料已保留</summary><p>{status.pendingProjection.reason}</p><pre>{JSON.stringify(status.pendingProjection.entities,null,2)}</pre><p>此操作保留当前电脑内容并同步这个决定；原远端版本仍保存在同步历史中。</p><button className="btn" type="button" disabled={status.busy} onClick={()=>void keepCurrentProjection().catch(e=>setError(String(e)))}>保留当前电脑版本</button></details>}
    {status.conflicts.map(conflict=><details key={conflict.key}><summary>选择保留的内容 · {conflict.versions[0].entity.kind}</summary>{conflict.versions.map(version=><div key={version.revision}><pre>{version.entity.data===null?'删除此内容':JSON.stringify(version.entity.data,null,2)}</pre><button className="btn" type="button" disabled={status.busy} onClick={()=>void resolveDesktopConflict(conflict,version.revision).catch(e=>setError(String(e)))}>使用此版本</button></div>)}</details>)}
    </div>
  </details>;
}
