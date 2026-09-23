import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { referenceBlocks, type ReadingAction } from '@/data/reading-reference';
import { WorkspaceButton } from './workspace-controls';
import { colors } from '@/theme/tokens';

/** Explicit alternative for SVG formula blocks and selection across native TextViews. */
export function ReadingBlockPicker({ body, initialIndex, onClose, onChoose, busy }: {
  body: string; initialIndex: number; onClose: () => void;
  onChoose: (start: number, end: number, action: ReadingAction) => void; busy: boolean;
}) {
  const blocks = useMemo(() => referenceBlocks(body), [body]);
  const first = Math.max(0, Math.min(initialIndex, blocks.length - 1));
  const [range, setRange] = useState({ start: first, end: first });
  const [choosingEnd, setChoosingEnd] = useState(false);
  const insets = useSafeAreaInsets();
  return <Modal transparent animationType="slide" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', justifyContent: 'flex-end' }}>
      <View style={{ height: '85%', padding: 18, paddingBottom: 18 + insets.bottom, gap: 12, backgroundColor: colors.surfaceStrong, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.ink }}>引用段落</Text>
        <Text style={{ color: colors.inkMuted }}>点击起点，再点终点可选连续多段。公式保留 TeX；最多 8 段、2400 字符。</Text>
        <FlatList data={blocks} keyExtractor={(_, index) => String(index)}
          initialScrollIndex={first || undefined} onScrollToIndexFailed={() => undefined}
          renderItem={({ item, index }) => <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: index >= range.start && index <= range.end }}
            accessibilityLabel={`段落 ${index + 1}：${item.text.slice(0, 70)}`} disabled={busy}
            onPress={() => { if (choosingEnd) setRange({ start: Math.min(range.start, index), end: Math.max(range.start, index) }); else setRange({ start: index, end: index }); setChoosingEnd(!choosingEnd); }}
            style={{ padding: 12, marginVertical: 4, backgroundColor: index >= range.start && index <= range.end ? colors.blueSoft : colors.canvas, borderRadius: 12 }}>
            <Text style={{ fontSize: 12, color: colors.inkMuted }}>段落 {index + 1}</Text><Text style={{ color: colors.ink, lineHeight: 24 }}>{item.text}</Text>
          </Pressable>} />
        <View style={{ flexDirection: 'row', gap: 8 }}>{([['explain', '解释'], ['example', '举例'], ['ask', '追问']] as const).map(([action, label]) =>
          <View key={action} style={{ flex: 1 }}><WorkspaceButton label={label} disabled={busy} onPress={() => onChoose(range.start, range.end, action)} /></View>)}</View>
        <WorkspaceButton label="取消引用" secondary disabled={busy} onPress={onClose} />
      </View>
    </View>
  </Modal>;
}
