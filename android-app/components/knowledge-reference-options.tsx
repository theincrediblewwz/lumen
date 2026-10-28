import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { KnowledgePolicy } from '@/data/knowledge-library-core';
import { colors, radii } from '@/theme/tokens';
import { AppIcon } from './app-icon';

const options: { value: KnowledgePolicy; label: string; detail: string }[] = [
  { value: 'disabled', label: '不引用', detail: '不向 AI 提供这份知识库。' },
  { value: 'allowed', label: '按需引用', detail: '根据问题查找你的理解、经验和材料。' },
  { value: 'priority', label: '优先引用', detail: '优先参考你指定的条目及其材料依据。' },
];

export function KnowledgeReferenceOptions({
  value, onChange, boundCount, onChooseEntries, disabled = false, compact = false,
  sourceRestricted = false, onOpenSourceSettings,
}: {
  value: KnowledgePolicy;
  onChange: (value: KnowledgePolicy) => void;
  boundCount: number;
  onChooseEntries?: () => void;
  disabled?: boolean;
  compact?: boolean;
  sourceRestricted?: boolean;
  onOpenSourceSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value)!;
  const expanded = !compact || open;
  const heading = <View style={{ flex: 1, gap: 4 }}>
    <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>引用我的知识库</Text>
    <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{compact ? `本白板 · ${selected.label}` : '仅此白板 · 自动保存'}</Text>
  </View>;
  return <View style={{ backgroundColor: colors.surface, borderRadius: radii.large, padding: 18, gap: expanded ? 14 : 0 }}>
    {compact ? <Pressable accessibilityRole="button" accessibilityLabel="引用我的知识库" accessibilityState={{ expanded: open }} onPress={() => setOpen(current => !current)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      {heading}<AppIcon name={open ? 'expand-less' : 'expand-more'} size={20} color={colors.inkMuted} />
    </Pressable> : heading}
    {expanded ? <>
      <View style={{ flexDirection: 'row', gap: 4, backgroundColor: colors.graySoft, borderRadius: radii.small, padding: 4 }}>
        {options.map(option => <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: value === option.value, disabled }} disabled={disabled} onPress={() => onChange(option.value)} style={({ pressed }) => ({ flex: 1, minHeight: 44, paddingHorizontal: 4, paddingVertical: 8, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: value === option.value ? colors.surfaceStrong : 'transparent', opacity: disabled ? 0.5 : pressed ? 0.65 : 1 })}>
          <Text style={{ color: value === option.value ? colors.ink : colors.inkMuted, fontSize: 13, fontWeight: value === option.value ? '600' : '400', textAlign: 'center' }}>{option.label}</Text>
        </Pressable>)}
      </View>
      <Text style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 20 }}>{selected.detail}</Text>
      {value === 'priority' && boundCount === 0 ? <Text style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 20 }}>还未指定知识，请先选择条目。</Text> : null}
      {sourceRestricted && value !== 'disabled' ? <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12 }}>
        <Text accessibilityRole="alert" style={{ color: colors.inkMuted, fontSize: 13, lineHeight: 20 }}>当前仅依据本白板资料，知识库不会发送给 AI。允许资料外补充后，这项授权才会生效。</Text>
        {onOpenSourceSettings ? <Pressable accessibilityRole="button" onPress={onOpenSourceSettings} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: colors.ink, fontSize: 13 }}>查看资料范围设置</Text></Pressable> : null}
      </View> : null}
      {onChooseEntries ? <Pressable accessibilityRole="button" accessibilityLabel="选择知识条目" disabled={disabled} accessibilityState={{ disabled }} onPress={onChooseEntries} style={({ pressed }) => ({ minHeight: 44, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: disabled ? 0.5 : pressed ? 0.65 : 1 })}>
        <Text style={{ flex: 1, color: colors.ink, fontSize: 14 }}>选择知识条目</Text>
        <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{boundCount ? `已指定 ${boundCount} 条` : '未指定'}</Text>
        <AppIcon name="chevron-right" size={18} color={colors.inkMuted} />
      </Pressable> : null}
    </> : null}
  </View>;
}
