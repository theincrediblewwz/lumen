import { useCallback, useState } from 'react';
import { Stack, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { deletePromptTemplate, listPromptTemplates, savePromptTemplate } from '@/data/prompt-templates';
import { colors, floatingShadow, radii } from '@/theme/tokens';
import type { PromptTemplate } from '@/types/domain';

export default function PromptTemplatesScreen() {
  const db = useSQLiteContext();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => setTemplates(await listPromptTemplates(db)), [db]);
  useFocusEffect(useCallback(() => { load().catch(() => undefined); }, [load]));

  const edit = (template?: PromptTemplate) => {
    setEditingId(template?.id ?? null);
    setTitle(template?.title ?? '');
    setBody(template?.body ?? '');
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await savePromptTemplate(db, { id: editingId ?? undefined, title, body });
      edit();
      await load();
    } catch (error) {
      Alert.alert('无法保存模板', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (template: PromptTemplate) => {
    Alert.alert('删除这个模板？', template.title, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        await deletePromptTemplate(db, template.id);
        if (editingId === template.id) edit();
        await load();
      } },
    ]);
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 16 }}
    >
      <Stack.Screen options={{ title: '询问模板' }} />
      <View style={{ gap: 6 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 24, fontWeight: '800' }}>把常用追问留在手边</Text>
        <Text selectable style={{ color: colors.inkMuted, fontSize: 13.5, lineHeight: 20 }}>
          点击节点时，这些模板会出现在输入框下方。点击模板只会填入文字，不会自动发送。
        </Text>
      </View>

      <View style={{ padding: 16, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, boxShadow: floatingShadow, gap: 11 }}>
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '800' }}>{editingId ? '编辑模板' : '新建模板'}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          editable={!saving}
          placeholder="模板名称，例如：用直觉解释"
          placeholderTextColor={colors.gray}
          style={inputStyle}
        />
        <TextInput
          value={body}
          onChangeText={setBody}
          editable={!saving}
          multiline
          textAlignVertical="top"
          placeholder="例如：先不要给结论，用一个具体例子解释它为什么成立。"
          placeholderTextColor={colors.gray}
          style={[inputStyle, { minHeight: 112, paddingTop: 13 }]}
        />
        <View style={{ flexDirection: 'row', gap: 9 }}>
          {editingId ? <SmallButton label="取消编辑" onPress={() => edit()} /> : null}
          <SmallButton label={saving ? '保存中…' : '保存模板'} primary disabled={saving} onPress={save} />
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '800' }}>已保存</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{templates.length} 个</Text>
      </View>
      <View style={{ gap: 10 }}>
        {templates.map((template) => (
          <View key={template.id} style={{ padding: 15, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <AppIcon name="bookmark-outline" color={colors.blue} size={19} />
              <Text style={{ flex: 1, color: colors.ink, fontSize: 14.5, fontWeight: '800' }}>{template.title}</Text>
              <Pressable accessibilityLabel="编辑模板" hitSlop={10} onPress={() => edit(template)}><AppIcon name="edit" color={colors.inkMuted} size={19} /></Pressable>
              <Pressable accessibilityLabel="删除模板" hitSlop={10} onPress={() => confirmDelete(template)}><AppIcon name="delete-outline" color={colors.coral} size={19} /></Pressable>
            </View>
            <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>{template.body}</Text>
          </View>
        ))}
        {!templates.length ? <Text style={{ color: colors.inkMuted, fontSize: 13 }}>还没有模板。先保存一条你经常使用的追问。</Text> : null}
      </View>
    </ScrollView>
  );
}

function SmallButton({ label, primary, disabled, onPress }: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flex: 1, height: 44, borderRadius: 22, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? colors.ink : colors.canvas, opacity: disabled ? 0.45 : pressed ? 0.76 : 1 })}><Text style={{ color: primary ? colors.white : colors.ink, fontWeight: '800', fontSize: 13 }}>{label}</Text></Pressable>;
}

const inputStyle = { minHeight: 48, borderRadius: radii.small, borderCurve: 'continuous' as const, paddingHorizontal: 13, backgroundColor: colors.canvas, color: colors.ink, fontSize: 14 };
