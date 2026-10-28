import { BoardWriteSettings } from './BoardWriteSettings';
import { useEffect, useRef, useState, type SelectHTMLAttributes } from 'react';
import { ChevronDown, CopyPlus, ExternalLink, RotateCcw, Cable } from 'lucide-react';
import { listAiProfiles, loadAiProfileDeferred, hasSavedAiKey, isAiConfigured, normalizeAiSettings, saveAiProfile, type AiSettings } from '../ai/aiSettings';
import { modelLimits, modelPreset, getProviderPresets, providerFor, recommendedModel, REASONING_LABELS } from '../ai/modelCatalog';
import { CatalogManager } from './CatalogManager';
import { testConnection } from '../ai/catalogAssistant';
import { chatCompletionsUrl } from '../ai/provider';

function ConfigSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="ai-select-wrap"><select {...props}/><ChevronDown size={14} strokeWidth={1.7} aria-hidden="true"/></span>;
}

export function AiSettingsForm({ initial, onSave, onCancel, onBusyChange }: {
  initial: AiSettings; onSave: (settings: AiSettings) => void; onCancel: () => void; onBusyChange?: (busy:boolean)=>void;
}) {
  const [s, setS] = useState<AiSettings>(() => ({ ...initial, maxTokens: initial.maxTokens ?? modelLimits(initial.model).output }));
  const [profiles, setProfiles] = useState(listAiProfiles);
  const [name, setName] = useState(() => listAiProfiles().find(p => p.id === initial.profileId)?.name ?? '我的配置');
  const [providerId, setProviderId] = useState(() => providerFor(initial.baseUrl)?.id ?? 'custom');
  const requestUrl=(()=>{try{return chatCompletionsUrl(s.baseUrl,s.endpointMode);}catch{return '';}})();
  const [customModel, setCustomModel] = useState(!providerFor(initial.baseUrl)?.models.some(m => m.id === initial.model));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const [,renderCatalogue]=useState(0);
  const [testing,setTesting]=useState(false);const [testResult,setTestResult]=useState('');
  useEffect(()=>{onBusyChange?.(working||testing);},[working,testing,onBusyChange]);
  const testGeneration=useRef(0);
  useEffect(()=>{testGeneration.current++;setTestResult('');setTesting(false);},[s.baseUrl,s.model,s.apiKey,s.reasoningEffort]);
  useEffect(()=>{const changed=()=>renderCatalogue(n=>n+1);window.addEventListener('lumen-catalog-changed',changed);return()=>{window.removeEventListener('lumen-catalog-changed',changed);testGeneration.current++;};},[]);
  useEffect(() => () => { generation.current++; }, []);
  const providers=getProviderPresets();
  const provider = providers.find(p => p.id === providerId);
  const preset = modelPreset(s.model,s.baseUrl);
  const limits = modelLimits(s.model, s.maxTokens,s.baseUrl);
  const patch = (change: Partial<AiSettings>) => { setS(old => ({ ...old, ...change })); setNotice(''); };
  const normalize = () => {
    const next = normalizeAiSettings(s);
    if (next.contextBudget !== s.contextBudget || next.maxTokens !== s.maxTokens || next.temperature !== s.temperature) setNotice('已调整到当前模型的可用范围。');
    setS(next);
  };
  const chooseProfile = async (id: string) => {
    const current = ++generation.current;
    setWorking(true); setError('');
    setS(old => ({ ...old, apiKey: '' }));
    try {
      const loaded = loadAiProfileDeferred(id);
      if (current !== generation.current) return;
      setS({ ...loaded, maxTokens: loaded.maxTokens ?? modelLimits(loaded.model).output }); setName(profiles.find(p => p.id === id)?.name ?? '我的配置');
      setProviderId(providerFor(loaded.baseUrl)?.id ?? 'custom'); setCustomModel(!providerFor(loaded.baseUrl)?.models.some(m => m.id === loaded.model));
      setNotice('点击保存后使用这套配置。');
    } catch { if (current === generation.current) setError('读取配置失败，请重新选择或填写密钥。'); }
    finally { if (current === generation.current) setWorking(false); }
  };
  const chooseProvider = (id: string) => {
    setProviderId(id); setError('');
    const selected = providers.find(p => p.id === id);
    setCustomModel(!selected);
    if (selected) {
      setS(old => ({ ...old, kind: 'openai', baseUrl: selected.baseUrl, endpointMode:'base', apiKey: '', savedKey: undefined, ...recommendedModel(selected.models[0].id,selected.baseUrl) }));
    } else setS(old => ({ ...old, kind: 'openai', apiKey: '', savedKey: undefined }));
    setNotice('已切换连接，请填写这个供应商的密钥。');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (working) return;
    setWorking(true); setError('');
    try {
      const saved = await saveAiProfile(normalizeAiSettings(s), name);
      setProfiles(listAiProfiles()); onSave(saved);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试。'); }
    finally { setWorking(false); }
  };
  return <form className="ai-settings ai-settings-form" onSubmit={save} aria-label="AI 设置">
    <fieldset className="ai-settings-scroll" disabled={working}>
      <div className="ai-settings-intro"><h3>AI 设置</h3><p>保存常用连接，按需切换。</p></div>
      <section className="ai-profile-section" aria-label="配置管理">
        <div className="ai-profile-picker">
          <label className="ai-field"><span>已保存的配置</span><ConfigSelect aria-label="已保存的配置" value={s.profileId ?? ''} disabled={working} onChange={e => void chooseProfile(e.target.value)}>
            {!s.profileId && <option value="">{profiles.length ? '新配置' : '原有配置 · 尚未命名'}</option>}
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </ConfigSelect></label>
          <button type="button" className="ai-btn-secondary ai-copy-profile" disabled={working} onClick={() => {
            generation.current++; setS(old => ({ ...old, profileId: undefined })); setName(`${name.replace(/ · 副本$/, '')} · 副本`); setError(''); setNotice('保存后创建新配置，原配置保留。');
          }}><CopyPlus size={16} aria-hidden="true"/>另存为新配置</button>
        </div>
        <label className="ai-field ai-profile-name"><span>配置名称</span><input required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="例如：日常学习、深入研究" /></label>
      </section>
      <CatalogManager connection={initial}/>
      <div className="ai-settings-columns">
        <section className="ai-connection-section"><h4>连接</h4>
          <div className="ai-settings-pair">
            <label className="ai-field"><span>供应商</span><ConfigSelect aria-label="供应商" value={providerId} onChange={e => chooseProvider(e.target.value)} disabled={working}>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="custom">自定义兼容接口</option>
            </ConfigSelect></label>
            <label className="ai-field"><span>模型</span><ConfigSelect aria-label="预设模型" value={customModel ? '' : s.model} disabled={working} onChange={e => {
              if (!e.target.value) { setCustomModel(true); return; }
              setCustomModel(false); patch(recommendedModel(e.target.value,s.baseUrl));
            }}>{(provider?.models ?? []).map(m => <option key={m.id} value={m.id}>{m.label??m.id}</option>)}<option value="">自定义模型</option></ConfigSelect></label>
          </div>
          {customModel && <label className="ai-field"><span>模型 ID</span><input required spellCheck={false} value={s.model} onChange={e => patch({ model: e.target.value })} onBlur={normalize}/></label>}
          <label className="ai-field"><span>API 地址</span><input aria-label="API 地址" type="url" required spellCheck={false} value={s.baseUrl} onChange={e => {
            const next = e.target.value; setS(old => ({ ...old, baseUrl: next, endpointMode:'base', apiKey: next === old.baseUrl ? old.apiKey : '', savedKey: next === old.baseUrl ? old.savedKey : undefined }));
          }}/><small className="ai-endpoint">自动使用：{requestUrl || '请填写有效的 API 地址'}<br/>填接口根地址即可，也支持完整的 /chat/completions 地址。</small></label>
          {s.endpointMode==='legacy' && requestUrl!==(()=>{try{return chatCompletionsUrl(s.baseUrl);}catch{return requestUrl;}})() && <p className="ai-hint">已保留旧配置的请求地址。<button type="button" className="ai-btn-secondary" onClick={()=>patch({endpointMode:'base'})}>按接口根地址补全</button></p>}
          <label className="ai-field"><span>API Key</span><input type="password" required={!hasSavedAiKey(s)} autoComplete="off" value={s.apiKey} onChange={e => patch({ apiKey: e.target.value, savedKey: undefined })} placeholder={hasSavedAiKey(s) ? '已保存，使用时读取' : '仅保存在本机'}/></label>
          <label className="ai-field"><span>密钥保存</span><ConfigSelect aria-label="密钥保存" value={s.keyStorage ?? 'system'} onChange={e => patch({ keyStorage: e.target.value as 'local' | 'system' })}><option value="local">本机免提示保存</option><option value="system">系统钥匙串 / 凭据库</option></ConfigSelect></label>
          <p className="ai-hint">{s.keyStorage === 'local' ? '加密保存在本机，不弹系统密码框。加密密钥也在本机；同一账号下其他程序的防护弱于钥匙串。' : '由系统凭据库保管，首次使用时可能要求授权。'}更换接口地址后请重新填写密钥。</p>
          {s.savedKey && s.savedKey.storage !== s.keyStorage && <p className="ai-hint">保存时迁移这套配置；读取原钥匙串可能需要授权一次。也可直接填写 Key，原钥匙串条目保留。</p>}
          {provider?.note&&<p className="ai-hint">{provider.note}</p>}
          <div className="ai-connection-test"><button type="button" className="ai-btn-secondary" disabled={working||testing||!isAiConfigured(s)} onClick={async()=>{
            const turn=++testGeneration.current;setTesting(true);setTestResult('');
            try{const result=await testConnection(s);if(turn===testGeneration.current)setTestResult(`${result.ok?'通过':'未通过'} · ${result.message}（${result.elapsedMs} ms${result.status?` · HTTP ${result.status}`:''}）`);}catch{if(turn===testGeneration.current)setTestResult('测试未完成，连接或已保存密钥暂不可用；原配置未更改。');}finally{if(turn===testGeneration.current)setTesting(false);}
          }}><Cable size={14}/>{testing?'测试中…':'测试连接'}</button><small>发送一条简短测试，可能产生少量费用。</small></div>
          {testResult&&<p className="ai-catalog-status" role="status">{testResult}</p>}
        </section>
        <section className="ai-parameters-section">
          <div className="ai-section-heading"><h4>生成参数</h4><button type="button" className="ai-recommend" disabled={working} onClick={() => {
            patch(recommendedModel(s.model,s.baseUrl)); setNotice('已采用模型上限；发送时按实际输入分配剩余输出空间。');
          }}><RotateCcw size={14} aria-hidden="true"/>推荐参数</button></div>
          {(s.contextBudget>limits.maxInput||(s.maxTokens??0)>limits.maxOutput)&&<p className="ai-catalog-status">当前参数超过目录上限。可手动调整或点击推荐参数；已保存连接不会自动更改。</p>}
          <label className="ai-field"><span>上下文预算 <small>tokens</small></span><input type="number" required min={1000} max={limits.maxInput} step={1} value={Number.isFinite(s.contextBudget) ? s.contextBudget : ''} onChange={e => patch({ contextBudget: e.target.valueAsNumber })} onBlur={normalize}/></label>
          <p className="ai-hint">模型窗口 {limits.window.toLocaleString()}，输入上限 {limits.maxInput.toLocaleString()}。实际输入较长时，输出会按剩余空间调整。</p>
          <label className="ai-field"><span>最大输出 <small>tokens</small></span><input type="number" required min={1} max={limits.maxOutput} step={1} value={Number.isFinite(s.maxTokens) ? s.maxTokens : limits.output} onChange={e => patch({ maxTokens: e.target.valueAsNumber })} onBlur={normalize}/></label>
          {preset?.reasoning?<label className="ai-field"><span>思考强度</span><ConfigSelect aria-label="思考强度" value={s.reasoningEffort??preset.reasoning.default} onChange={e=>patch({reasoningEffort:e.target.value})}>{preset.reasoning.levels.map(level=><option key={level} value={level}>{REASONING_LABELS[level]??level}</option>)}</ConfigSelect></label>:<p className="ai-hint">思考强度由服务默认控制。温度采用模型推荐值。</p>}
          {(preset?.note||!limits.known)&&<p className="ai-hint">{preset?.note??'自定义型号使用应用安全上限；请按供应商文档调低。'}</p>}
          <details className="ai-model-documentation"><summary>模型说明与上限</summary><p className="ai-hint">输入与输出上限分别设置，共用总窗口。额度为本地估算，服务商分词、账号与网关限制仍适用。自定义型号默认使用应用百万级上限，可通过模型目录补充其官方能力。</p>{provider && <a href={provider.docs} target="_blank" rel="noreferrer">官方文档<ExternalLink size={12} aria-hidden="true"/></a>}</details>
        </section>
      </div>
      <label className="ai-check ai-share-check"><input type="checkbox" checked={s.shareBoard} onChange={e => patch({ shareBoard: e.target.checked })}/><span>允许 AI 读取本白板内容<small>知识库引用仍按白板中的独立授权执行。</small></span></label>
      <label className="ai-check ai-share-check"><input type="checkbox" checked={s.memoryMode!=='off'} onChange={e=>patch({memoryMode:e.target.checked?'auto':'off'})}/><span>长对话自动整理记忆<small>仅在发送时按需使用当前模型额度，单次最多两批；原始问答保留，关闭后仍可检索原文。</small></span></label>
      <BoardWriteSettings/>
    </fieldset>
    <div className="ai-settings-footer">
      <div className="ai-settings-feedback">{error ? <p role="alert">{error}</p> : <p role="status">{notice || (s.profileId ? '保存更新当前配置；另存可保留两套。' : '原有连接在保存后才会切换。')}</p>}</div>
      <div className="ai-settings-actions"><button type="button" className="ai-btn-secondary" disabled={working} onClick={onCancel}>取消</button><button type="submit" className="ai-btn-primary" disabled={working || !name.trim() || !s.baseUrl.trim() || !s.model.trim()}>{working ? '处理中…' : '保存'}</button></div>
    </div>
  </form>;
}
