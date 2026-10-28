import {useEffect,useState} from 'react';
import type {BoardFile} from '../api';
import {loadWritePolicy,listBoardBackups,restoreBoardBackup,type BoardBackup} from '../ai/boardOperations';
export function BoardBackupList({projectId,boardId,onRestored}:{projectId:string;boardId:string;onRestored:(board:BoardFile)=>void}){
 const [scope,setScope]=useState<string|null>(null);
 const [items,setItems]=useState<BoardBackup[]>([]);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
 const refresh=()=>Promise.all([listBoardBackups(projectId,boardId),loadWritePolicy()]).then(([items,permission])=>{setItems(items);setScope(permission.scope);}).catch(e=>setNote(String(e)));
 useEffect(()=>{void refresh();},[projectId,boardId]);
 const restore=async(item:BoardBackup)=>{if(busy||!confirm('恢复此版本的白板与关联文档？当前版本会先备份，聊天记录保留。'))return;setBusy(true);try{const board=await restoreBoardBackup(projectId,boardId,item.file,scope);onRestored(board);setNote('已恢复，恢复前版本也已保存。');await refresh();}catch(e){setNote(String(e));}finally{setBusy(false);}};
 return <section className="board-backups"><h3>AI 整理与文档版本</h3><p className="settings-hint">包含白板和关联文档原件。恢复不回退对话；保留份数可在设置中调整。</p>{note&&<p role="status" className="snap-note">{note}</p>}{!items.length&&<p className="settings-hint">尚无修改前版本。</p>}{items.map(item=><div key={item.file} className="snap-item"><div className="snap-item-main"><div className="snap-item-time">{new Date(item.created_at).toLocaleString()}<span className="snap-badge">{item.reason}</span></div><small>{(item.bytes/1024).toFixed(1)} KB</small></div><button className="snap-btn" disabled={busy} type="button" onClick={()=>void restore(item)}>恢复此版本</button></div>)}</section>;
}
