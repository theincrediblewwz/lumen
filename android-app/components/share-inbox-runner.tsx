import { router, useRootNavigationState, useSegments } from 'expo-router';
import { useEffect } from 'react';

import { shareInbox } from '@/components/share-inbox';

export function ShareInboxRunner() {
  const navigation = useRootNavigationState();
  const segments = useSegments();
  const onImportScreen = segments[0] === 'share-import';

  useEffect(() => {
    const inbox = shareInbox;
    if (!navigation?.key || !inbox) return;
    const open = () => {
      if (inbox.peekPendingShare() && !onImportScreen) router.push('/share-import');
    };
    open();
    const listener = inbox.addListener('onShareReceived', open);
    return () => listener.remove();
  }, [navigation?.key, onImportScreen]);
  return null;
}
