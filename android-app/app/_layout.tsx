import { SQLiteProvider } from 'expo-sqlite';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Suspense } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { migrateDatabase } from '@/data/database';
import { LocalBackupRunner } from '@/components/local-backup-runner';
import { SyncRunner } from '@/components/sync-runner';
import { colors } from '@/theme/tokens';

const sqliteOptions = {
  // expo-sqlite 16 can otherwise finalize FTS-owned statements twice when
  // the provider closes during navigation, reloads, or process teardown.
  finalizeUnusedStatementsBeforeClosing: false,
} as const;

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Suspense
        fallback={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}>
            <ActivityIndicator color={colors.ink} />
          </View>
        }
      >
        <SQLiteProvider databaseName="learn-stuff.db" options={sqliteOptions} onInit={migrateDatabase} useSuspense>
          <LocalBackupRunner />
          <SyncRunner />
          <Stack
          screenOptions={{
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.ink,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: colors.canvas },
          }}
        >
          <Stack.Screen name="index" options={{ title: 'LearnStuff' }} />
          <Stack.Screen name="new-project" options={{ title: '新的学习目标', presentation: 'modal' }} />
          <Stack.Screen name="new-topic" options={{ title: '新建专题', presentation: 'modal' }} />
          <Stack.Screen name="ai-settings" options={{ title: 'AI 设置' }} />
          <Stack.Screen name="settings" options={{ title: '应用设置' }} />
          <Stack.Screen name="sync-settings" options={{ title: '跨设备同步' }} />
          <Stack.Screen name="discussion" options={{ title: '讨论' }} />
          <Stack.Screen name="capture-discussion" options={{ title: '保存为文档与节点', presentation: 'modal' }} />
          <Stack.Screen name="node-documents" options={{ title: '节点文档' }} />
          <Stack.Screen name="new-node" options={{ title: '新建节点', presentation: 'modal' }} />
          <Stack.Screen name="search" options={{ title: '搜索文档与对话' }} />
          <Stack.Screen name="ai-understanding" options={{ title: 'AI 对你的了解' }} />
          <Stack.Screen name="favorites" options={{ title: '收藏' }} />
          <Stack.Screen name="move-project" options={{ title: '移动到专题', presentation: 'modal' }} />
          <Stack.Screen name="prompt-templates" options={{ title: '询问模板' }} />
          <Stack.Screen name="prompt-lab" options={{ title: 'Prompt 匿名对比' }} />
           <Stack.Screen name="node-answers" options={{ title: '回答记录', presentation: 'modal' }} />
           <Stack.Screen name="answer/[id]" options={{ title: '完整回答', presentation: 'modal' }} />
          <Stack.Screen name="ai-context-preview" options={{ title: 'AI 发送内容预览' }} />
          <Stack.Screen name="project/[id]" options={{ title: '知识地图', headerShown: false }} />
          <Stack.Screen name="project-settings" options={{ title: '内容与资料' }} />
          <Stack.Screen name="document/[id]" options={{ title: 'Markdown', presentation: 'modal' }} />
          </Stack>
          <StatusBar style="dark" />
        </SQLiteProvider>
      </Suspense>
    </GestureHandlerRootView>
  );
}
