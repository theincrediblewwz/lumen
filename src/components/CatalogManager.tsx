import { useEffect, useRef, useState } from 'react';
import { ExternalLink, History, Sparkles, Square } from 'lucide-react';
import { isAiConfigured, resolveAiCredentials, type AiSettings } from '../ai/aiSettings';
import { applyCatalogue, catalogueState, loadCatalogue, proposalDifferences, rollbackCatalogue, type CatalogProposal } from '../ai/catalogStore';
import { startCatalogAssistant } from '../ai/catalogAssistant';
import type { StreamHandle } from '../ai/aiClient';

export function CatalogManager({ connection }: {connection:AiSettings}) {
  const [snapshot,setSnapshot]=useState(catalogueState);
  const [request,setRequest]=useState('检查 DeepSeek 最新模型和参数，并核对 OpenCode、OpenRouter 的 DeepSeek 目录。');
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
  const [proposal,setProposal]=useState<{data:CatalogProposal;revision:number}|null>(null);
  const handle=useRef<StreamHandle>();const generation=useRef(0);
  useEffect(()=>{const changed=()=>setSnapshot(catalogueState());window.addEventListener('lumen-catalog-changed',changed);void loadCatalogue().then(setSnapshot).catch(()=>setMessage('公共目录暂未载入，继续使用内置参数。'));return()=>{window.removeEventListener('lumen-catalog-changed',changed);generation.current++;handle.current?.cancel();};},[]);
  const inspect=async()=>{
    const turn=++generation.current;setBusy(true);setProposal(null);setMessage('准备核对公共模型目录…');
    let resolved: AiSettings;
    try { resolved = await resolveAiCredentials(connection); if(turn!==generation.current)return; if(!isAiConfigured(resolved))throw Error(); }
    catch { if(turn===generation.current){setBusy(false);setMessage('未能读取已保存密钥。原连接与目录已保留，点击检查可重试授权。');}return; }
    handle.current=startCatalogAssistant(resolved,request,
      value=>{if(turn===generation.current)setMessage(value);},
      (data,revision)=>{if(turn!==generation.current)return;handle.current=undefined;setProposal({data,revision});setBusy(false);setMessage('已整理更新建议，请核对差异和原文依据。');},
      error=>{if(turn!==generation.current)return;handle.current=undefined;setBusy(false);setMessage(error);},
    );
  };
  const mutate=async(rollback=false)=>{
    setBusy(true);
    try{
      const next=rollback?await rollbackCatalogue(snapshot.revision):await applyCatalogue(proposal!.data,proposal!.revision);
      setSnapshot(next);setProposal(null);setMessage(rollback?'已回退公共目录。你的连接与 Key 保持原样。':'公共目录已更新。你的连接、已选模型与 Key 保持原样。');
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  const differences=proposal?proposalDifferences(proposal.data):[];
  return <details className="ai-catalog-manager">
    <summary><Sparkles size={15} aria-hidden="true"/><span>模型目录</span><small>{snapshot.revision?`版本 ${snapshot.revision}`:'内置快照'}</small></summary>
    <div className="ai-catalog-body">
      <p className="ai-hint">由当前已保存的 AI 连接查官方资料，先看依据与差异，再决定应用。不会改动你的连接和 Key。</p>
      <label className="ai-field"><span>检查范围</span><textarea rows={2} maxLength={1200} value={request} disabled={busy} onChange={e=>setRequest(e.target.value)}/></label>
      <div className="ai-catalog-actions">
        {busy&&handle.current?<button type="button" className="ai-btn-secondary" onClick={()=>{generation.current++;handle.current?.cancel();handle.current=undefined;setBusy(false);setMessage('已停止，目录未更改。');}}><Square size={13}/>停止检查</button>:<button type="button" className="ai-btn-secondary" disabled={busy||!isAiConfigured(connection)||!request.trim()} onClick={()=>void inspect()}><Sparkles size={14}/>AI 检查更新</button>}
        <button type="button" className="ai-quiet-button" disabled={busy||!snapshot.canRollback} onClick={()=>void mutate(true)}><History size={14}/>回退上一版</button>
      </div>
      <p className="ai-hint">检查会使用模型额度；只读取公共资料，不包含白板、知识库或聊天历史。</p>
      {message&&<p className="ai-catalog-status" role="status">{message}</p>}
      {proposal&&<section className="ai-catalog-proposal" aria-label="目录更新预览">
        <h4>更新预览</h4><p>{proposal.data.summary}</p>
        <p className="ai-hint">以下参数由 AI 根据已读取资料整理，应用前请核对。现有连接不会跟随目录地址变化。</p>
        <div className="ai-catalog-differences" tabIndex={0} aria-label="目录修改差异"><table><thead><tr><th>项目</th><th>原值</th><th>建议值</th></tr></thead><tbody>{differences.map((row,index)=><tr key={index}><th>{row.path}</th><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody></table>{!differences.length&&<p>未发现需要更新的参数。</p>}</div>
        <details className="ai-catalog-sources"><summary>官方依据 · {proposal.data.providers.reduce((n,p)=>n+(p.sources?.length??0),0)} 条</summary>{proposal.data.providers.flatMap(p=>(p.sources??[]).map((source,index)=><div key={`${p.id}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{p.name} · {new URL(source.url).hostname}<ExternalLink size={12}/></a><blockquote>{source.quote}</blockquote></div>))}</details>
        <div className="ai-catalog-actions"><button type="button" className="ai-btn-secondary" disabled={busy} onClick={()=>setProposal(null)}>放弃建议</button><button type="button" className="ai-btn-primary" disabled={busy||!differences.length} onClick={()=>void mutate()}>应用目录更新</button></div>
      </section>}
    </div>
  </details>;
}
