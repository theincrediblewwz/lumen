const CONSENT_KEY = 'learnstuff.ai-data-consent.v5';
export const AI_DATA_CONSENT_VERSION = '2026-07-25-v5';
export const AI_DATA_CONSENT_DISCLOSURE = '为了完整回答并展开当前知识点，应用会把你的问题、当前学习目标、受限长度的项目资料、选中节点 Markdown、到当前节点的学习路径、直接相连知识的短摘录，以及这个节点最近两条回答发送到你配置的 AI Gateway，再由 Gateway 转发给它明确配置的供应商：DeepSeek、Xiaomi MiMo 或 OpenAI。发送前可查看逐段预览。\n\n不会发送其他项目、整张无关图谱或供应商 API key。不同供应商的数据政策不同：MiMo 的公开政策说明会处理 IP 地址和提交内容以生成结果，不会将提交内容用于模型训练或其他目的，并只在实现所述目的或法律要求所需期限内保留；DeepSeek 与 OpenAI 适用各自政策。已经发送的内容无法由本 App 收回。AI 生成的完整回答与图补丁会在 Gateway 加密缓存最多 24 小时，用于防止重复扣费。AI 结果仍是推断，不能自动视为事实。';

type ConsentRecord = {
  version: string;
  gatewayOrigin: string;
  acceptedAt: string;
};

export async function hasAiDataConsent(gatewayUrl: string) {
  const SecureStore = await import('expo-secure-store');
  const value = await SecureStore.getItemAsync(CONSENT_KEY);
  return isAiDataConsentCurrent(value, gatewayUrl);
}

export function isAiDataConsentCurrent(value: string | null, gatewayUrl: string) {
  if (!value) return false;
  try {
    const record = JSON.parse(value) as Partial<ConsentRecord>;
    return record.version === AI_DATA_CONSENT_VERSION
      && record.gatewayOrigin === new URL(gatewayUrl).origin;
  } catch {
    return false;
  }
}

export async function recordAiDataConsent(gatewayUrl: string) {
  const SecureStore = await import('expo-secure-store');
  const record: ConsentRecord = {
    version: AI_DATA_CONSENT_VERSION,
    gatewayOrigin: new URL(gatewayUrl).origin,
    acceptedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(CONSENT_KEY, JSON.stringify(record));
}

export async function clearAiDataConsent() {
  const SecureStore = await import('expo-secure-store');
  await SecureStore.deleteItemAsync(CONSENT_KEY);
}
