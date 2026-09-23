import { useEffect } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { AppState } from 'react-native';

import { runPendingLocalBackup } from '@/data/local-backup';

const BACKUP_POLL_MS = 2_500;

export function LocalBackupRunner() {
  const db = useSQLiteContext();

  useEffect(() => {
    let active = true;
    let running = false;
    const drain = async () => {
      if (!active || running || AppState.currentState !== 'active') return;
      running = true;
      try {
        await runPendingLocalBackup(db);
      } finally {
        running = false;
      }
    };
    void drain();
    const interval = setInterval(() => { void drain(); }, BACKUP_POLL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void drain();
    });
    return () => {
      active = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [db]);

  return null;
}
