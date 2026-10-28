import {documentPreview} from '@/data/rich-document';
import { Pressable, Text, View } from 'react-native';
import type { MarkdownDocument } from '@/types/domain';
import { colors, radii } from '@/theme/tokens';
import { MarkdownContent } from './markdown-content';

function previewMarkdown(body: string, title: string): string {
  const text = body.trim().replace(/^#\s+([^\r\n]+)\r?\n+/, (heading, headingTitle: string) => headingTitle.trim() === title.trim() ? '' : heading).trim();
  if (!text) return '这篇文档还没有正文';
  const preview = text.slice(0, 440);
  const openFences = (preview.match(/^\s*```/gm) ?? []).length % 2;
  return `${preview}${openFences ? '\n```' : ''}${text.length > 440 ? '\n\n…' : ''}`;
}

export function NodeDocumentCards({ documents, onOpen, onMove, compact = false }: {
  documents: MarkdownDocument[];
  onOpen: (documentId: string) => void;
  onMove?: (documentId: string, direction: -1 | 1) => void;
  compact?: boolean;
}) {
  return <View style={{ gap: compact ? 8 : 12 }}>
    {documents.map((document, index) => <View key={document.id} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radii.medium, padding: compact ? 11 : 14, backgroundColor: colors.surfaceStrong, gap: 5 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`阅读第 ${index + 1} 篇文档：${document.title}`} onPress={() => onOpen(document.id)} style={({ pressed }) => ({ minHeight: 38, flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.65 : 1 })}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontWeight: '800', fontSize: compact ? 13 : 15 }}>{document.title}</Text>
        <Text style={{ color: colors.blue, fontSize: 12, fontWeight: '700' }}>阅读</Text>
      </Pressable>
      <View style={{ maxHeight: compact ? 75 : 120, overflow: 'hidden' }} pointerEvents="none">
        <MarkdownContent value={previewMarkdown(documentPreview(document.body), document.title)} contentPadding={0} scrollEnabled={false} compact backgroundColor={colors.surfaceStrong} />
      </View>
      {onMove && documents.length > 1 ? <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`提高${document.title}的排序`} disabled={index === 0} onPress={() => onMove(document.id, -1)} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', opacity: index === 0 ? 0.35 : 1 }}><Text style={{ color: colors.blue }}>上移</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`降低${document.title}的排序`} disabled={index === documents.length - 1} onPress={() => onMove(document.id, 1)} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', opacity: index === documents.length - 1 ? 0.35 : 1 }}><Text style={{ color: colors.blue }}>下移</Text></Pressable>
      </View> : null}
    </View>)}
  </View>;
}
