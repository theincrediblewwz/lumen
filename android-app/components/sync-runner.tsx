import { useEffect } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { AppState } from 'react-native';
import { refreshBackgroundSync } from '../sync/background';
import { onSyncUpdate, runSync } from '../sync/runtime';

export function SyncRunner() {
  const db = useSQLiteContext();
  useEffect(() => {
    let alive = true;
    const drain = () => {
      if (alive && AppState.currentState === 'active') void runSync(db).catch(() => undefined);
    };
    void refreshBackgroundSync(db);
    drain();
    const interval = setInterval(drain, 10_000);
    const unsubscribe = onSyncUpdate(drain);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') { drain(); void refreshBackgroundSync(db); }
    });
    return () => { alive = false; clearInterval(interval); unsubscribe(); appState.remove(); };
  }, [db]);
  return null;
}
