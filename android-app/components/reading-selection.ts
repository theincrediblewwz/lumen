import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ReadingAction } from '@/data/reading-reference';

export type ReadingSelectionEvent = { key: string; action: ReadingAction; quote: string; before: string; after: string };
type SelectionModule = {
  bind(tag: number, key: string): Promise<number>;
  unbind(key: string): Promise<void>;
  addListener(event: 'onSelectionAction', listener: (event: ReadingSelectionEvent) => void): { remove(): void };
};
export const selectionActions = requireOptionalNativeModule<SelectionModule>('ExpoSelectionActions');
