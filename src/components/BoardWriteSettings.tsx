import { useEffect,useState } from 'react';
import { loadWritePolicy,saveWritePolicy,type WritePolicy } from '../ai/boardOperations';
export function BoardWriteSettings(){
 const [policy,setPolicy]=useState<WritePolicy>();const [keep,setKeep]=useState('20');const [expanded,setExpanded]=useState(false);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
 useEffect(()=>{let alive=true;loadWritePolicy().then(({policy:p})=>{if(alive){setPolicy(p);setKeep(String(p.keep));}}).catch(e=>alive&&setNote(String(e)));return()=>{alive=false};},[]);
 const update=async(enabled:boolean)=>{if(!policy||busy)return;const revoking=policy.enabled&&!enabled;const n=revoking?policy.keep:Number(keep);if(!Number.isInteger(n)||n<1||n>100){setNote('请输入1–100之间的整数');return;}setBusy(true);try{setPolicy(await saveWritePolicy(policy,enabled,n));if(revoking)setKeep(String(policy.keep));setExpanded(false);setNote(enabled?'已授权，可随时关闭。':'已关闭 AI 修改白板。');}catch(e){setNote(String(e));}finally{setBusy(false);}};
 return <section className="settings-section ai-write-settings">
 <div className="settings-row"><h3 className="settings-label">AI 整理白板</h3><button type="button" className={`switch${policy?.enabled?' is-on':''}`} role="switch" aria-label="允许 AI 修改白板" aria-checked={!!policy?.enabled} disabled={!policy||busy} onClick={()=>policy?.enabled?void update(false):setExpanded(v=>!v)}><span className="switch-knob"/></button></div>
 <p className="settings-hint">授权后，AI 可按你的要求新建节点、追加文档与连线。每批修改前自动备份，可在白板历史恢复。</p>
 {expanded&&<div className="ai-permission-note"><p>开启后不再逐次询问。共享给 AI 的材料也可能影响操作，请核对结果；原有节点和文档不会被覆盖或删除。权限仅保存在本机，随时关闭后，尚未写入的操作会被拒绝。</p><button className="btn" type="button" disabled={busy} onClick={()=>void update(true)}>知情并开启</button><button className="btn" type="button" onClick={()=>setExpanded(false)}>暂不开启</button></div>}
 <div className="settings-row"><label className="settings-label" htmlFor="ai-backup-keep">每个白板保留版本</label><input id="ai-backup-keep" type="number" min="1" max="100" value={keep} disabled={!policy||busy} onChange={e=>setKeep(e.target.value)}/><button className="btn" type="button" disabled={!policy||busy||String(policy.keep)===keep} onClick={()=>void update(!!policy?.enabled)}>保存份数</button></div>
 <p className="settings-hint">备份保存在白板目录的 .ai-backups 文件夹；下次成功修改后按份数整理。</p>{note&&<p className="settings-hint" role="status">{note}</p>}
 </section>;
}
