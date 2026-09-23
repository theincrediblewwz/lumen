export type InitialExpansionStore = Pick<
  typeof import('expo-secure-store'),
  'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'
>;

const PREFIX = 'learnstuff.initial-expansion.';

export async function prepareInitialExpansion(projectId: string, store?: InitialExpansionStore) {
  const SecureStore = store ?? await import('expo-secure-store');
  await SecureStore.setItemAsync(intentKey(projectId), JSON.stringify({ state: 'pending', createdAt: new Date().toISOString() }));
}

export async function claimInitialExpansion(projectId: string, store?: InitialExpansionStore) {
  const SecureStore = store ?? await import('expo-secure-store');
  const key = intentKey(projectId);
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as { state?: unknown };
    if (value.state !== 'pending') return false;
  } catch {
    await SecureStore.deleteItemAsync(key);
    return false;
  }
  await SecureStore.setItemAsync(key, JSON.stringify({ state: 'claimed', claimedAt: new Date().toISOString() }));
  return true;
}

export async function clearInitialExpansionIntent(projectId: string, store?: InitialExpansionStore) {
  const SecureStore = store ?? await import('expo-secure-store');
  await SecureStore.deleteItemAsync(intentKey(projectId));
}

function intentKey(projectId: string) {
  return `${PREFIX}${projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}
