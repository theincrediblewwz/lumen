import type { ByokProfile } from '@/ai/byok-profile';

const CONSENT_KEY = 'learnstuff.byok-data-consent.v1';
export const BYOK_DATA_CONSENT_VERSION = '2026-07-25-v2';

type ConsentRecord = {
  version: typeof BYOK_DATA_CONSENT_VERSION;
  destination: string;
  acceptedAt: string;
};

export function getByokDestination(profile: ByokProfile) {
  return `${profile.baseUrl}|${profile.model}`;
}

export function getByokDisclosure(profile: ByokProfile) {
  return `为了完整回答并展开当前知识点，应用会把你的问题、当前学习目标和当前节点作为基础，再根据问题形态从受限长度的项目资料、学习路径、直接相连知识和最近回答中选择真正相关的部分，直接发送到你配置的服务：${profile.label}（${profile.baseUrl}，模型 ${profile.model}）。发送前可查看选择与省略原因。\n\n不会发送其他项目或整张无关图谱。API key 只保存在本机安全存储，不会写入项目数据库或 Markdown。该服务的数据处理、保存期限、训练政策和计费规则由你选择的服务商决定；本 App 无法替它核验，也无法收回已经发送的内容。AI 结果仍会作为“推断”保存，不能自动视为事实。`;
}

export async function hasByokDataConsent(profile: ByokProfile) {
  const SecureStore = await import('expo-secure-store');
  return isByokDataConsentCurrent(await SecureStore.getItemAsync(CONSENT_KEY), profile);
}

export function isByokDataConsentCurrent(value: string | null, profile: ByokProfile) {
  if (!value) return false;
  try {
    const record = JSON.parse(value) as Partial<ConsentRecord>;
    return record.version === BYOK_DATA_CONSENT_VERSION
      && record.destination === getByokDestination(profile);
  } catch {
    return false;
  }
}

export async function recordByokDataConsent(profile: ByokProfile) {
  const SecureStore = await import('expo-secure-store');
  const record: ConsentRecord = {
    version: BYOK_DATA_CONSENT_VERSION,
    destination: getByokDestination(profile),
    acceptedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(CONSENT_KEY, JSON.stringify(record));
}

export async function clearByokDataConsent() {
  const SecureStore = await import('expo-secure-store');
  await SecureStore.deleteItemAsync(CONSENT_KEY);
}
