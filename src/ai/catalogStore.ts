import { getProviderPresets, setCatalogProviders, REASONING_LABELS, type ProviderPreset, type ModelPreset } from './modelCatalog';

export interface CatalogueState { revision: number; providers: ProviderPreset[]; canRollback: boolean }
export interface PublicEvidence { url: string; text: string }
export interface CatalogProposal { schema: 'lumen.catalog-proposal/v1'; summary: string; providers: ProviderPreset[] }
export interface CatalogDifference { path: string; before: string; after: string }
const MIRROR = 'lumen.model-catalog.v1';
let state: CatalogueState = { revision: 0, providers: [], canRollback: false };
let listening=false;
const native = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
export const catalogueState = () => structuredClone(state);

export function publicUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('资料地址无效');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal)$/.test(url.hostname) || /^(\d+\.|\[)/.test(url.hostname)) throw new Error('目录只接受不含凭据的公网 HTTPS 地址');
  return url.href;
}
function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008]/.test(value)) throw new Error(`${field}无效`);
  return value.trim();
}
function integer(value: unknown, name: string, min = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 16_777_216) throw new Error(`${name}必须是有效的整数额度`);
  return value;
}
const modelKeys = ['id','label','window','output','maxInput','recommendedOutput','temperature','temperatureMax','temperaturePrecision','omitTemperature','outputParameter','note','reasoning'];
export function validateProposal(raw: string, evidence: PublicEvidence[]): CatalogProposal {
  if (raw.length > 200_000) throw new Error('目录提案过大');
  const json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  if (json.schema !== 'lumen.catalog-proposal/v1' || Object.keys(json).some(k => !['schema','summary','providers'].includes(k))) throw new Error('目录提案格式无效');
  if (!Array.isArray(json.providers) || !json.providers.length || json.providers.length > 24) throw new Error('供应商数量无效');
  const providerIds = new Set<string>();
  const providers = json.providers.map((p: Record<string, unknown>): ProviderPreset => {
    if (Object.keys(p).some(k => !['id','name','baseUrl','docs','note','models','sources'].includes(k))) throw new Error('目录提案含有不允许修改的字段');
    const id = text(p.id, 60, '供应商 ID');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || providerIds.has(id)) throw new Error('供应商 ID 重复或无效');
    providerIds.add(id);
    if (!Array.isArray(p.sources) || !p.sources.length || p.sources.length > 12) throw new Error('每个供应商必须有实际读取的资料依据');
    const sources = p.sources.map(s => {
      if (!s || typeof s !== 'object' || Object.keys(s).some(k => !['url','quote'].includes(k))) throw new Error('资料依据格式无效');
      const url = publicUrl(s.url); const quote = text(s.quote, 1600, '原文依据');
      const read = evidence.find(e => e.url === url);
      if (!read || quote.length < 15 || !compact(read.text).includes(compact(quote))) throw new Error('资料依据未实际读取，或引文与原文不符');
      return { url, quote };
    });
    const docs = publicUrl(p.docs);
    if (!sources.some(s => new URL(s.url).hostname === new URL(docs).hostname)) throw new Error('供应商文档与依据域名不符，请先读取其官方文档');
    if (!Array.isArray(p.models) || !p.models.length || p.models.length > 100) throw new Error('模型数量无效');
    const ids = new Set<string>();
    const models = p.models.map((m: Record<string, unknown>): ModelPreset => {
      if (!m || typeof m !== 'object' || Object.keys(m).some(k => !modelKeys.includes(k))) throw new Error('模型提案含有不允许的字段');
      const mid = text(m.id, 180, '模型 ID');
      if (!/^[\w./:+-]+$/.test(mid) || ids.has(mid)) throw new Error('模型 ID 重复或无效');
      ids.add(mid);
      const window = integer(m.window, '总窗口', 8192); const output = integer(m.output, '输出上限');
      const result: ModelPreset = { id: mid, window, output, temperature: 1 };
      for (const key of ['maxInput','recommendedOutput'] as const) if (m[key] !== undefined) result[key] = integer(m[key], key);
      if (result.maxInput && result.maxInput > window) throw new Error('独立输入上限超过总窗口');
      if (result.recommendedOutput && result.recommendedOutput > output) throw new Error('推荐输出超过上限');
      if (m.temperature !== undefined) { if (typeof m.temperature !== 'number' || !Number.isFinite(m.temperature) || m.temperature < 0 || m.temperature > 2) throw new Error('推荐采样值无效'); result.temperature = m.temperature; }
      if (m.temperatureMax !== undefined) { if (typeof m.temperatureMax !== 'number' || m.temperatureMax < 0 || m.temperatureMax > 2) throw new Error('采样范围无效'); result.temperatureMax = m.temperatureMax; }
      if (m.temperaturePrecision !== undefined) { if (![0,1,2,3].includes(m.temperaturePrecision as number)) throw new Error('采样精度无效'); result.temperaturePrecision = m.temperaturePrecision as number; }
      if (m.omitTemperature !== undefined) { if (typeof m.omitTemperature !== 'boolean') throw new Error('采样字段无效'); result.omitTemperature = m.omitTemperature; }
      if (m.outputParameter !== undefined) { if (!['max_tokens','max_completion_tokens'].includes(m.outputParameter as string)) throw new Error('暂未实现这个输出参数协议'); result.outputParameter = m.outputParameter as ModelPreset['outputParameter']; }
      for (const key of ['label','note'] as const) if (m[key] !== undefined) result[key] = text(m[key], 500, key);
      if (m.reasoning !== undefined) {
        const r = m.reasoning as Record<string,unknown>;
        if (!r || Object.keys(r).some(k => !['kind','levels','default'].includes(k)) || !['deepseek','toggle','qwen','effort','openrouter'].includes(r.kind as string) || !Array.isArray(r.levels) || !r.levels.length || r.levels.length > 8 || new Set(r.levels).size !== r.levels.length || !r.levels.every(l => ['none','enabled','minimal','low','medium','high','xhigh','max'].includes(l)) || !r.levels.includes(r.default)) throw new Error('思考档位格式无效');
        const valid = r.kind === 'toggle' ? ['none','enabled'] : r.kind === 'qwen' ? ['none','low','medium','xhigh'] : r.kind === 'deepseek' ? ['none','low','high','max'] : ['none','minimal','low','medium','high','xhigh','max'];
        if (!r.levels.every(level=>valid.includes(level))) throw new Error('思考档位与已实现协议不匹配');
        result.reasoning = r as unknown as NonNullable<ModelPreset['reasoning']>;
      }
      return result;
    });
    return { id, name: text(p.name, 80, '供应商名称'), baseUrl: publicUrl(p.baseUrl).replace(/\/$/, ''), docs, models, sources, ...(p.note ? { note: text(p.note, 600, '供应商说明') } : {}) };
  });
  return { schema: 'lumen.catalog-proposal/v1', summary: text(json.summary, 1200, '更新摘要'), providers };
}

export function proposalDifferences(proposal: CatalogProposal): CatalogDifference[] {
  const rows: CatalogDifference[] = [];
  const labels:Record<string,string>={name:'供应商名称',baseUrl:'接口地址',docs:'官方文档',note:'说明',label:'模型名称',window:'总上下文',output:'最大输出',maxInput:'独立输入上限',recommendedOutput:'推荐输出',temperature:'推荐采样',omitTemperature:'采样由模型管理',outputParameter:'输出参数',reasoning:'思考档位'};
  const display=(key:keyof ModelPreset,value:unknown):string=>{
    if(value===undefined)return'未设置';if(typeof value==='number')return value.toLocaleString();
    if(key==='reasoning'){const r=value as NonNullable<ModelPreset['reasoning']>;return`${r.levels.map(level=>REASONING_LABELS[level]??level).join(' / ')}；默认${REASONING_LABELS[r.default]??r.default}（${r.kind}）`;}
    return typeof value==='string'?value:JSON.stringify(value);
  };
  for (const p of proposal.providers) {
    const old = getProviderPresets().find(x => x.id === p.id);
    for (const field of ['name','baseUrl','docs','note'] as const) if (p[field] !== undefined && p[field] !== old?.[field]) rows.push({ path: `${p.name} · ${labels[field]}`, before: old?.[field] ?? '新增', after: p[field]! });
    for (const m of p.models) {
      const previous = old?.models.find(x => x.id === m.id);
      for (const field of Object.keys(m) as (keyof ModelPreset)[]) {
        if (field === 'id') continue;
        if (JSON.stringify(previous?.[field]) !== JSON.stringify(m[field])) rows.push({ path: `${p.name} / ${m.id} · ${labels[field]??field}`, before: display(field,previous?.[field]), after: display(field,m[field]) });
      }
      if (!previous && !rows.some(row => row.path.startsWith(`${p.name} / ${m.id}`))) rows.push({ path: `${p.name} / ${m.id}`, before: '新增', after: m.id });
    }
  }
  return rows;
}
function publish(next: CatalogueState) {
  state = next; setCatalogProviders(next.providers);
  try { localStorage.setItem(MIRROR, JSON.stringify(next)); } catch { /* Rust remains canonical; a full mirror cannot damage connections. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('lumen-catalog-changed'));
}
export async function loadCatalogue(): Promise<CatalogueState> {
  if (native()) {
    if(!listening){listening=true;void import('@tauri-apps/api/event').then(({listen})=>listen('lumen://model-catalog-changed',()=>{void loadCatalogue().catch(()=>{});})).catch(()=>{listening=false;});}
    const { invoke } = await import('@tauri-apps/api/core');
    const next = await invoke<CatalogueState>('model_catalog_load'); publish(next);
  }
  return catalogueState();
}
export async function applyCatalogue(proposal: CatalogProposal, revision: number): Promise<CatalogueState> {
  const providers = structuredClone(state.providers);
  for (const p of proposal.providers) {
    const current = getProviderPresets().find(x => x.id === p.id);
    const models = [...(current?.models ?? []).filter(m => !p.models.some(n => n.id === m.id)), ...p.models.map(m => ({...current?.models.find(previous=>previous.id===m.id),...m}))];
    const aliases = [...new Set([...(current?.aliases ?? []), ...(current && current.baseUrl !== p.baseUrl ? [current.baseUrl] : [])])];
    const merged = { ...current, ...p, aliases, models };
    const index = providers.findIndex(o => o.id === p.id);
    if (index < 0) providers.push(merged); else providers[index] = merged;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const next = await invoke<CatalogueState>('model_catalog_apply', { expectedRevision: revision, providers });
  publish(next); return catalogueState();
}
export async function rollbackCatalogue(revision: number) {
  const { invoke } = await import('@tauri-apps/api/core');
  const next = await invoke<CatalogueState>('model_catalog_rollback', { expectedRevision: revision }); publish(next); return catalogueState();
}
