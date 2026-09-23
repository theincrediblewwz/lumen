import { useCallback, useEffect, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/app-icon';
import {
  chooseLocalBackupDirectory,
  disableLocalBackup,
  getLocalBackupStatus,
  retryLocalBackup,
  runPendingLocalBackup,
  type LocalBackupStatus,
} from '@/data/local-backup';
import {
  importLocalBackupAsCopies,
  pickLocalBackupSnapshot,
  type LocalBackupImportProgress,
} from '@/data/local-backup-import';
import type { LocalBackupSnapshot } from '@/data/local-backup-format';
import { colors, floatingShadow, radii } from '@/theme/tokens';

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<LocalBackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<LocalBackupImportProgress | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await getLocalBackupStatus(db));
  }, [db]);

  useFocusEffect(useCallback(() => {
    let active = true;
    refresh().catch(() => { if (active) setStatus(null); });
    return () => { active = false; };
  }, [refresh]));

  useEffect(() => {
    if (!status || (status.status !== 'pending' && status.status !== 'running')) return;
    const interval = setInterval(() => { void refresh(); }, 1_500);
    return () => clearInterval(interval);
  }, [refresh, status]);

  const chooseFolder = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await chooseLocalBackupDirectory(db);
      if (!next) return;
      setStatus(next);
      await runPendingLocalBackup(db);
      await refresh();
    } catch (error) {
      Alert.alert('无法设置自动备份', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await disableLocalBackup(db));
    } catch (error) {
      Alert.alert('无法关闭自动备份', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await retryLocalBackup(db));
      await runPendingLocalBackup(db);
      await refresh();
    } catch (error) {
      Alert.alert('无法重试备份', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async (snapshot: LocalBackupSnapshot) => {
    setBusy(true);
    setRestoreProgress({ current: 0, total: Math.max(1, snapshot.projects.length + 1), label: '准备恢复备份副本' });
    try {
      const result = await importLocalBackupAsCopies(db, snapshot, (progress) => setRestoreProgress(progress));
      await refresh();
      Alert.alert(
        '备份副本已恢复',
        `已新建 ${result.projectCount} 个项目副本、${result.importedTopicCount} 个专题，并恢复 ${result.importedFavoriteCount} 条收藏索引。\n\n源备份：v${result.sourceVersion}。现有项目和 API key 没有被覆盖；原始 PDF/图片不在备份中。`,
      );
    } catch (error) {
      Alert.alert('备份没有恢复', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setRestoreProgress(null);
      setBusy(false);
    }
  };

  const chooseBackupToRestore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const snapshot = await pickLocalBackupSnapshot();
      if (!snapshot) return;
      Alert.alert(
        '恢复为新副本？',
        `检测到 LearnStuff v${snapshot.version} 备份，共 ${snapshot.projects.length} 个项目。\n\n恢复不会覆盖现有内容；API key、发送授权和原始 PDF/图片不会恢复。`,
        [
          { text: '取消', style: 'cancel' },
          { text: '开始恢复', onPress: () => { void restoreBackup(snapshot); } },
        ],
      );
    } catch (error) {
      Alert.alert('无法读取备份', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 18, paddingBottom: 28 + insets.bottom, gap: 14 }}
    >
      <SettingsLink
        icon="sync"
        title="跨设备同步"
        description="连接你的 WebDAV，自动同步图谱、文档、对话与阅读位置"
        onPress={() => router.push('/sync-settings')}
      />
      <SettingsLink
        icon="smart-toy"
        title="AI 连接与发送"
        description="模型、接口地址、API key 与发送确认"
        onPress={() => router.push('/ai-settings')}
      />
      <SettingsLink
        icon="bookmark-outline"
        title="询问模板"
        description="管理每次选择节点后可快速使用的问题"
        onPress={() => router.push('/prompt-templates')}
      />
      <SettingsLink
        icon="psychology"
        title="AI 对你的了解"
        description="管理所有图谱默认继承的讲解偏好与已知内容"
        onPress={() => router.push({
          pathname: '/ai-understanding',
          params: { scopeType: 'global', scopeId: 'global', title: '全局 · 所有学习图谱' },
        })}
      />
      <SettingsLink
        icon="bookmarks"
        title="收藏"
        description="查看节点和回答收藏、原始位置及 AI 引用层级"
        onPress={() => router.push('/favorites')}
      />

      <View style={{ borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, padding: 17, boxShadow: floatingShadow, gap: 13 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSoft }}>
            <AppIcon name="backup" color={colors.blue} size={22} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '800' }}>自动本地备份</Text>
            <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{backupStatusLabel(status)}</Text>
          </View>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: backupStatusColor(status) }} />
        </View>

        <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 20 }}>
          这是整个应用共用的设置，只需选择一次。LearnStuff 会在所选位置建立自己的备份根目录，为每个项目建立可读子文件夹，并同时保留可恢复的完整 A/B 快照。
        </Text>
        <Text style={{ color: colors.inkMuted, fontSize: 11.5, lineHeight: 18 }}>
          应用私有 SQLite 仍是工作正本；项目子文件夹不是双向编辑目录。API key、访问令牌和发送许可不会进入备份。
        </Text>

        {status?.directoryUri ? (
          <View style={{ padding: 12, borderRadius: radii.medium, backgroundColor: colors.canvas, gap: 4 }}>
            <Text style={{ color: colors.ink, fontSize: 12, fontWeight: '800' }}>{backupDirectoryLabel(status.directoryUri)}</Text>
            <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>应用子目录：LearnStuff-Auto-Backup</Text>
          </View>
        ) : null}
        {status?.status === 'running' || status?.status === 'pending' ? (
          <ProgressRow current={status.progressCurrent} total={status.progressTotal || 5} label={status.progressLabel ?? '等待自动备份'} />
        ) : null}
        {restoreProgress ? (
          <ProgressRow current={restoreProgress.current} total={restoreProgress.total} label={restoreProgress.label} />
        ) : null}
        {status?.lastError ? <Text selectable style={{ color: colors.coral, fontSize: 11.5, lineHeight: 17 }}>{status.lastError}</Text> : null}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SettingsButton label={status?.directoryUri ? '更换文件夹' : '选择备份文件夹'} onPress={() => void chooseFolder()} tone="blue" />
          {status?.enabled ? <SettingsButton label="关闭备份" onPress={() => void turnOff()} /> : null}
          {status?.status === 'failed' ? <SettingsButton label="重试" onPress={() => void retry()} tone="green" /> : null}
        </View>
        <SettingsButton label="从 A/B 备份恢复副本" onPress={() => void chooseBackupToRestore()} />
        {busy ? <ActivityIndicator color={colors.blue} /> : null}
      </View>

      <View style={{ padding: 15, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, gap: 6 }}>
        <Text style={{ color: colors.ink, fontSize: 13.5, fontWeight: '800' }}>主动导出仍在每个项目里</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
          打开具体图谱的三点菜单，选择“导出当前项目”，即可每次指定分享或归档位置。它不会改变这里的自动备份目录。
        </Text>
      </View>
    </ScrollView>
  );
}

function SettingsLink({ icon, title, description, onPress }: {
  icon: Parameters<typeof AppIcon>[0]['name'];
  title: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      minHeight: 74,
      borderRadius: radii.large,
      borderCurve: 'continuous',
      padding: 15,
      backgroundColor: colors.surfaceStrong,
      boxShadow: floatingShadow,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      opacity: pressed ? 0.76 : 1,
    })}>
      <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}>
        <AppIcon name={icon} color={colors.ink} size={21} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: colors.ink, fontSize: 14.5, fontWeight: '800' }}>{title}</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>{description}</Text>
      </View>
      <AppIcon name="chevron-right" color={colors.gray} size={20} />
    </Pressable>
  );
}

function SettingsButton({ label, onPress, tone }: { label: string; onPress: () => void; tone?: 'blue' | 'green' }) {
  const backgroundColor = tone === 'blue' ? colors.blueSoft : tone === 'green' ? colors.greenSoft : colors.canvas;
  const foregroundColor = tone === 'blue' ? colors.blue : tone === 'green' ? colors.green : colors.ink;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      flex: 1,
      minHeight: 46,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor,
      opacity: pressed ? 0.72 : 1,
    })}>
      <Text style={{ color: foregroundColor, fontSize: 12, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function ProgressRow({ current, total, label }: { current: number; total: number; label: string }) {
  const safeTotal = Math.max(1, total);
  const safeCurrent = Math.min(safeTotal, Math.max(0, current));
  const percent = `${Math.round((safeCurrent / safeTotal) * 100)}%` as `${number}%`;
  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: safeTotal, now: safeCurrent }} style={{ gap: 7 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 11.5, fontWeight: '700' }}>{label}</Text>
        <Text style={{ color: colors.blue, fontSize: 11.5, fontWeight: '800' }}>{safeCurrent}/{safeTotal}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line }}>
        <View style={{ width: percent, height: '100%', borderRadius: 3, backgroundColor: colors.blue }} />
      </View>
    </View>
  );
}

function backupStatusLabel(status: LocalBackupStatus | null) {
  if (!status?.directoryUri) return '尚未选择备份文件夹';
  if (!status.enabled) return '已关闭，原备份文件仍保留';
  if (status.status === 'running') return status.progressLabel ?? '正在写入恢复副本';
  if (status.status === 'pending') return '有新改动，等待应用处理';
  if (status.status === 'failed') return '上次备份失败，应用内数据仍安全';
  if (status.status === 'synced') return status.completedAt ? `已备份 · ${shortDateTime(status.completedAt)}` : '已备份';
  return '等待第一次备份';
}

function backupStatusColor(status: LocalBackupStatus | null) {
  if (!status?.enabled) return colors.gray;
  if (status.status === 'failed') return colors.coral;
  if (status.status === 'synced') return colors.green;
  if (status.status === 'running') return colors.blue;
  return colors.amber;
}

function backupDirectoryLabel(directoryUri: string) {
  try {
    const decoded = decodeURIComponent(directoryUri);
    const tail = decoded.split('/').filter(Boolean).at(-1) ?? decoded;
    return `所选位置：${tail.includes(':') ? tail.split(':').at(-1) : tail}`;
  } catch {
    return '已选择本地备份位置';
  }
}

function shortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  return date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
