import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { getSyncSettings } from '../data/sync-repository';
import { runSync } from './runtime';

const TASK = 'lumen-learning-sync-v1';
if (!TaskManager.isTaskDefined(TASK)) TaskManager.defineTask(TASK, async () => {
  const db = await openDatabaseAsync('learn-stuff.db', { useNewConnection: true, finalizeUnusedStatementsBeforeClosing: false });
  try {
    await db.execAsync('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    // Background workers never migrate databases or launch a provider request.
    const exists = await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_settings'");
    if (!exists) return BackgroundTask.BackgroundTaskResult.Success;
    await runSync(db, true);
    return (await getSyncSettings(db))?.status === 'failed' ? BackgroundTask.BackgroundTaskResult.Failed : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    await db.closeAsync();
  }
});

export async function refreshBackgroundSync(db: SQLiteDatabase) {
  try {
    const enabled = Boolean((await getSyncSettings(db))?.enabled);
    const registered = await TaskManager.isTaskRegisteredAsync(TASK);
    if (enabled && !registered) {
      if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Restricted) throw new Error('restricted');
      await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
    } else if (!enabled && registered) await BackgroundTask.unregisterTaskAsync(TASK);
    await db.runAsync('UPDATE sync_settings SET background_error=NULL WHERE id=1');
  } catch {
    await db.runAsync('UPDATE sync_settings SET background_error=? WHERE id=1', '系统暂未允许后台同步；打开应用后会继续自动同步');
  }
}
