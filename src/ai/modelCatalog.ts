/** Bundled official snapshot, checked 2026-10-22; reviewed runtime overrides are separate. */
export interface ModelPreset {
  id: string;
  label?: string;
  window: number;
  output: number;
  maxInput?: number;
  recommendedOutput?: number;
  temperature: number;
  temperatureMax?: number;
  temperaturePrecision?: number;
  omitTemperature?: boolean;
  outputParameter?: 'max_tokens' | 'max_completion_tokens';
  extra?: Record<string, unknown>;
  note?: string;
  reasoning?: { kind: 'deepseek' | 'toggle' | 'qwen' | 'effort' | 'openrouter'; levels: string[]; default: string };
}
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  docs: string;
  models: ModelPreset[];
  note?: string;
  aliases?: string[];
  sources?: { url: string; quote: string }[];
}
const million = { window: 1_048_576, output: 131_072, temperature: 1 };
const deepseekReasoning: ModelPreset['reasoning'] = { kind: 'deepseek', levels: ['none', 'low', 'high', 'max'], default: 'high' };
const effortReasoning: ModelPreset['reasoning'] = { kind: 'effort', levels: ['low', 'high', 'max'], default: 'max' };
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', docs: 'https://api-docs.deepseek.com/api/list-models/', models: ['deepseek-flash', 'deepseek-v4-pro'].map(id => ({ ...million, id, label: id === 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : 'DeepSeek V4 Pro', output: 393_216, omitTemperature: true, reasoning: deepseekReasoning })) },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', docs: 'https://developers.openai.com/api/docs/models/gpt-6-luna', models: ['gpt-6-luna', 'gpt-6-sol'].map(id => ({ id, window: 1_050_000, output: 128_000, temperature: 1, outputParameter: 'max_completion_tokens', extra: { reasoning_effort: 'none' }, note: '使用兼容白板工具的对话模式' })) },
  { id: 'mimo', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', docs: 'https://mimo.mi.com/docs/quick-start/model', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'].map(id => ({ ...million, id, omitTemperature: true, outputParameter: 'max_completion_tokens', reasoning: { kind: 'toggle', levels: ['none', 'enabled'], default: 'enabled' } })) },
  { id: 'qwen', name: '阿里 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', docs: 'https://help.aliyun.com/zh/model-studio/qwen3-8-max', models: ['qwen3.8-max', 'qwen3.8-flash'].map(id => ({ ...million, window: 1_000_000, id, maxInput: 983_616, temperatureMax: 1.99, reasoning: { kind: 'qwen', levels: ['none', 'low', 'medium', 'xhigh'], default: 'xhigh' }, note: '北京地域；可改为账号对应的地域或业务空间地址' })) },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', docs: 'https://platform.kimi.com/docs/api/chat', models: [{ ...million, window: 1_000_000, id: 'kimi-k3', output: 1_048_576, omitTemperature: true, outputParameter: 'max_completion_tokens', reasoning: effortReasoning, note: '开放 API 文档标注 1M 窗口；输入与输出共用额度' }] },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docs: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', models: ['glm-5.3', 'glm-5.3-flash'].map(id => ({ ...million, window: 1_000_000, id, temperatureMax: 1, temperaturePrecision: 2, extra: { top_p: 0.95 }, reasoning: effortReasoning })) },
];

for (const go of [true, false]) PROVIDER_PRESETS.push({
  id: go ? 'opencode-go' : 'opencode', name: go ? 'OpenCode Go' : 'OpenCode Console · 按量',
  baseUrl: `https://opencode.ai/inference/${go ? 'go/' : ''}openai/v1`, docs: go ? 'https://opencode.ai/v2/docs/console/go/' : 'https://opencode.ai/v2/docs/console/harnesses/',
  aliases:[`https://opencode.ai/zen/${go?'go/':''}v1`],
  note: go ? 'Go 要求编程代理流量；通用学习用途未获服务商保证。请确认订阅适用范围。' : 'Console（原 Zen）按量计费，与 Go 订阅入口分开。',
  models: ['deepseek', 'glm', 'kimi', 'mimo'].flatMap(id => PROVIDER_PRESETS.find(p => p.id === id)!.models.map(m => ({ ...m, id: m.id === 'deepseek-flash' ? 'deepseek-v4.1-flash' : m.id, note: '使用厂商能力参考；网关可用性与额度以 OpenCode 为准。' }))),
});
PROVIDER_PRESETS.push({ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', docs: 'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens', models: [
  { ...million, id: 'deepseek/deepseek-v4.1-flash', output: 943_718, omitTemperature: true, reasoning: { kind: 'openrouter', levels: ['none', 'low', 'high', 'max'], default: 'high' } },
  { ...million, id: 'deepseek/deepseek-v4.1-flash-1017', output: 393_216, omitTemperature: true, reasoning: { kind: 'openrouter', levels: ['none', 'low', 'high', 'max'], default: 'high' } },
  { ...million, window: 1_024_000, id: 'deepseek/deepseek-v4-pro', output: 384_000, omitTemperature: true, reasoning: { kind: 'openrouter', levels: ['none', 'high', 'xhigh'], default: 'high' } },
] });

let overrides: ProviderPreset[] = [];
export function setCatalogProviders(providers: ProviderPreset[]) { overrides = structuredClone(providers); }
export function getProviderPresets(): ProviderPreset[] {
  return [...PROVIDER_PRESETS.filter(p => !overrides.some(o => o.id === p.id)), ...overrides.map(p=>{const original=PROVIDER_PRESETS.find(o=>o.id===p.id);try{if(original&&new URL(original.baseUrl).origin===new URL(p.baseUrl).origin)return {...p,aliases:[...new Set([original.baseUrl,...original.aliases??[],...p.aliases??[]])]};}catch{}return p;})];
}

export const PROTOCOL_RESERVE = 4096;
/** Unknown model: explicitly an application ceiling, not an official model limit. */
export const CUSTOM_WINDOW = 1_048_576;
export const CUSTOM_OUTPUT = 393_216;
export function modelPreset(id: string, baseUrl?: string): ModelPreset | undefined {
  const provider = baseUrl ? providerFor(baseUrl) : undefined;
  const name=id.trim();return (provider ? provider.models : getProviderPresets().filter(p => !['opencode', 'opencode-go'].includes(p.id)).flatMap(p => p.models)).find(m => m.id === name || provider?.id==='deepseek'&&name==='deepseek-v4.1-flash'&&m.id==='deepseek-flash');
}
export function providerFor(baseUrl: string): ProviderPreset | undefined {
  try {
    const url = new URL(baseUrl);
    return getProviderPresets().filter(p => [p.baseUrl, ...(p.aliases ?? [])].some(base => { const root = new URL(base); return root.origin === url.origin && (url.pathname === root.pathname || url.pathname.startsWith(root.pathname.replace(/\/$/, '') + '/')); })).sort((a,b) => b.baseUrl.length-a.baseUrl.length)[0];
  } catch { return undefined; }
}
export function modelLimits(model: string, requestedOutput?: number, baseUrl?: string, policy?: ModelPreset | null) {
  const preset = policy === undefined ? modelPreset(model, baseUrl) : policy ?? undefined;
  const window = preset?.window ?? CUSTOM_WINDOW;
  const maxOutput = Math.min(preset?.output ?? CUSTOM_OUTPUT, window - PROTOCOL_RESERVE - 1000);
  const fallback = preset?.recommendedOutput ?? preset?.output ?? 4096;
  const output = Math.min(maxOutput, Math.max(1, Math.floor(Number.isFinite(requestedOutput) ? requestedOutput! : fallback)));
  return { window, maxOutput, output, maxInput: Math.min(preset?.maxInput ?? window, window - PROTOCOL_RESERVE - 1024), known: !!preset };
}
export function recommendedModel(model: string, baseUrl?: string) {
  const preset = modelPreset(model, baseUrl);
  const limits = modelLimits(model, undefined, baseUrl);
  return { model, maxTokens: limits.output, contextBudget: limits.maxInput, temperature: preset?.temperature ?? 0.7, reasoningEffort: preset?.reasoning?.levels[preset.reasoning.levels.length - 1] };
}
export function modelTemperature(model: string, requested?: number, policy?: ModelPreset | null) {
  const preset = policy === undefined ? modelPreset(model) : policy ?? undefined;
  if (preset?.omitTemperature) return preset.temperature;
  const value = Math.min(preset?.temperatureMax ?? 2, Math.max(0, Number.isFinite(requested) ? requested! : 0.7));
  return preset?.temperaturePrecision === undefined ? value : Number(value.toFixed(preset.temperaturePrecision));
}
export const REASONING_LABELS: Record<string,string> = { none: '关闭', enabled: '开启', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: 'Max' };
export function reasoningFields(preset: ModelPreset | undefined, requested?: string): Record<string,unknown> {
  const r = preset?.reasoning;
  if (!r) return {};
  const value = requested ?? r.default;
  if (!r.levels.includes(value)) throw new Error('当前模型不支持这个思考档位，请在设置中重新选择。');
  if (r.kind === 'openrouter') return { reasoning: { effort: value } };
  if (r.kind === 'qwen') return value === 'none' ? { enable_thinking: false } : { enable_thinking: true, reasoning_effort: value };
  if (r.kind === 'toggle') return { thinking: { type: value === 'none' ? 'disabled' : 'enabled' } };
  if (r.kind === 'deepseek') return { thinking: { type: value === 'none' ? 'disabled' : 'enabled' }, reasoning_effort: value };
  return { reasoning_effort: value };
}
