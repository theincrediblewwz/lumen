import { requireOptionalNativeModule } from 'expo-modules-core';

import type { PendingTextShare } from '@/data/share-intake';

type ShareInboxModule = {
  peekPendingShare(): PendingTextShare | null;
  stageShareAsync(id: string): Promise<PendingTextShare>;
  finishShareAsync(id: string): Promise<boolean>;
  addListener(event: 'onShareReceived', listener: () => void): { remove(): void };
};

export const shareInbox = requireOptionalNativeModule<ShareInboxModule>('ExpoShareInbox');
