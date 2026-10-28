import { Component, useEffect, useMemo, useRef, type ComponentProps, type ReactNode, type Ref } from 'react';
import { Text, View, type TextStyle, type ImageStyle, FlatList, type FlatListProps, findNodeHandle } from 'react-native';
import { router } from 'expo-router';
import {
  Renderer,
  useMarkdown,
  type RendererInterface,
  type MarkdownProps,
} from 'react-native-marked';
import { MathJaxSvg } from 'react-native-mathjax-html-to-svg';

import {
  decodeMarkdownMathPayload,
  MARKDOWN_MATH_SENTINEL,
  prepareMarkdownMathForRenderer,
} from '@/ai/markdown-math';
import { colors, radii } from '@/theme/tokens';
import type { ReadingCellFrame } from '@/data/reading-position';
import { parseReadingReference, READING_REFERENCE_PREFIX } from '@/data/reading-reference';
import { parseKnowledgeReference } from '@/data/knowledge-reference';
import { selectionActions, type ReadingSelectionEvent } from './reading-selection';

type Props = {
  value: string;
  contentPadding?: number;
  backgroundColor?: string;
  scrollEnabled?: boolean;
  listProps?: MarkdownProps['flatListProps'] & { ref?: Ref<FlatList<ReactNode>> };
  onBlockLayout?: (index: number, frame: ReadingCellFrame | null) => void;
  onSelectionAction?: (index: number, selection: ReadingSelectionEvent) => void;
  highlightedBlocks?: { start: number; end: number } | null;
  compact?: boolean;
  appearance?: 'default' | 'knowledge';
  localTextOnly?:boolean;
};
type MarkdownCellProps = ComponentProps<NonNullable<FlatListProps<ReactNode>['CellRendererComponent']>>;

class FormulaBoundary extends Component<
  { children: ReactNode; formula: string; display: boolean },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View
        style={{
          alignSelf: this.props.display ? 'stretch' : 'flex-start',
          borderRadius: radii.small,
          backgroundColor: colors.coralSoft,
          paddingHorizontal: 8,
          paddingVertical: 5,
          marginVertical: this.props.display ? 7 : 1,
        }}
      >
        <Text selectable style={{ color: colors.coral, fontSize: 12, lineHeight: 18 }}>
          这条公式暂时无法渲染，可复制原始 TeX：{this.props.formula}
        </Text>
      </View>
    );
  }
}

class MathRenderer extends Renderer implements RendererInterface {
  constructor(private localOnly=false){super();}
  override image(uri:string,alt?:string,style?:ImageStyle,title?:string):ReactNode {return this.localOnly?<Text key={this.getKey()} style={{color:colors.inkMuted}}>[{alt||title||'图片'} · 在原版中查看]</Text>:super.image(uri,alt,style,title);}
  override link(children: string | ReactNode[], href: string, styles?: TextStyle, title?: string): ReactNode {
    if(href.startsWith('lumen://conversation/')){const url=new URL(href);const id=url.pathname.slice(1);const messageIds=(url.searchParams.get('messages')??'').split(',').filter(Boolean);return <Text key={this.getKey()} accessibilityRole="link" style={styles} onPress={()=>router.push({pathname:'/discussion',params:{conversationId:id,sourceMessageIds:JSON.stringify(messageIds)}})}>{children}</Text>;}
    const knowledge = parseKnowledgeReference(href);
    if (knowledge) return <Text key={this.getKey()} accessibilityRole="link" style={styles} onPress={() => router.push({ pathname: '/knowledge-library', params: knowledge })}>{children}</Text>;
    if (!href.startsWith(READING_REFERENCE_PREFIX)) return super.link(children, href, styles, title);
    const reference = parseReadingReference(href);
    return <Text key={this.getKey()} accessibilityRole="link" style={styles}
      onPress={() => reference && router.push({ pathname: '/document/[id]', params: { id: reference.documentId, reference: JSON.stringify(reference) } })}>
      {reference ? children : '引用位置无效（原文快照仍保留）'}
    </Text>;
  }
  override codespan(text: string, styles?: TextStyle): ReactNode {
    if (!text.startsWith(MARKDOWN_MATH_SENTINEL)) return super.codespan(text, styles);

    const payload = text.slice(MARKDOWN_MATH_SENTINEL.length);
    const display = payload.startsWith('display:');
    const formula = decodeMarkdownMathPayload(payload.slice(display ? 'display:'.length : 'inline:'.length));
    const key = this.getKey();
    return (
      <FormulaBoundary key={key} formula={formula} display={display}>
        <MathJaxSvg
          color={colors.ink}
          fontCache
          fontSize={display ? 18 : 16}
          style={display
            ? { width: '100%', justifyContent: 'center', marginVertical: 9 }
            : { alignSelf: 'baseline', marginHorizontal: 1 }}
        >
          {display ? `$$${formula}$$` : `$${formula}$`}
        </MathJaxSvg>
      </FormulaBoundary>
    );
  }
}

const mathRenderer = new MathRenderer();
const localTextRenderer = new MathRenderer(true);

const markdownStyles: NonNullable<MarkdownProps['styles']> = {
        text: { color: colors.ink, fontSize: 16, lineHeight: 26 },
        paragraph: { marginTop: 3, marginBottom: 12 },
        h1: { color: colors.ink, fontSize: 27, lineHeight: 35, fontWeight: '800', marginTop: 8, marginBottom: 12 },
        h2: { color: colors.ink, fontSize: 22, lineHeight: 30, fontWeight: '800', marginTop: 18, marginBottom: 9 },
        h3: { color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: '800', marginTop: 14, marginBottom: 7 },
        h4: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: '800', marginTop: 12, marginBottom: 6 },
        strong: { color: colors.ink, fontWeight: '800' },
        em: { color: colors.inkMuted, fontStyle: 'italic' },
        link: { color: colors.blue, textDecorationLine: 'underline' },
        blockquote: {
          borderLeftWidth: 4,
          borderLeftColor: colors.blue,
          backgroundColor: colors.blueSoft,
          paddingHorizontal: 14,
          paddingVertical: 9,
          marginVertical: 10,
          borderRadius: radii.small,
        },
        codespan: { color: colors.ink, backgroundColor: colors.graySoft, fontFamily: 'monospace', fontSize: 14 },
        code: { backgroundColor: colors.graySoft, padding: 14, borderRadius: radii.small, marginVertical: 10 },
        list: { marginBottom: 10 },
        li: { color: colors.ink, fontSize: 16, lineHeight: 25 },
        hr: { backgroundColor: colors.line, height: 1, marginVertical: 18 },
        table: { borderWidth: 1, borderColor: colors.line, marginVertical: 12 },
        tableCell: { borderColor: colors.line, padding: 8 },
};

const compactMarkdownStyles: NonNullable<MarkdownProps['styles']> = {
  ...markdownStyles,
  text: { color: colors.inkMuted, fontSize: 13, lineHeight: 19 },
  paragraph: { marginTop: 0, marginBottom: 5 },
  h1: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '700', marginTop: 2, marginBottom: 4 },
  h2: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: '700', marginTop: 3, marginBottom: 4 },
  h3: { color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: '700', marginTop: 3, marginBottom: 4 },
  li: { color: colors.inkMuted, fontSize: 13, lineHeight: 19 },
};

const knowledgeMarkdownStyles: NonNullable<MarkdownProps['styles']> = {
  ...markdownStyles,
  text: { color: colors.ink, fontSize: 16, lineHeight: 28 },
  paragraph: { marginTop: 4, marginBottom: 16 },
  h1: { color: colors.ink, fontSize: 22, lineHeight: 31, fontWeight: '600', marginTop: 20, marginBottom: 12, borderBottomWidth: 0 },
  h2: { color: colors.ink, fontSize: 19, lineHeight: 28, fontWeight: '600', marginTop: 22, marginBottom: 10, borderBottomWidth: 0 },
  h3: { color: colors.ink, fontSize: 17, lineHeight: 26, fontWeight: '600', marginTop: 18, marginBottom: 8 },
  blockquote: { borderLeftWidth: 2, borderLeftColor: colors.lineStrong, backgroundColor: colors.graySoft, paddingHorizontal: 14, paddingVertical: 10, marginVertical: 14, borderRadius: radii.small },
};

export function MarkdownContent({
  value,
  contentPadding = 18,
  backgroundColor = colors.canvas,
  scrollEnabled = true,
  listProps,
  onBlockLayout,
  onSelectionAction,
  highlightedBlocks,
  compact = false,
  appearance = 'default',
  localTextOnly = false,
}: Props) {
  const measured = useRef(onBlockLayout); measured.current = onBlockLayout;
  const selection = useRef(onSelectionAction); selection.current = onSelectionAction;
  const instance = useRef(`reader-${Date.now()}-${Math.random()}`).current;
  useEffect(() => {
    if (!onSelectionAction || !selectionActions) return;
    const listener = selectionActions.addListener('onSelectionAction', event => {
      if (!event.key.startsWith(instance + ':')) return;
      const index = Number(event.key.slice(instance.length + 1));
      if (Number.isSafeInteger(index) && index >= 0) selection.current?.(index, event);
    });
    return () => listener.remove();
  }, [instance, onSelectionAction]);
  const CellRenderer = useMemo(() => function MarkdownCell({ index, children, style, onLayout, onFocusCapture }: MarkdownCellProps) {
    const cell = useRef<View>(null);
    const key = `${instance}:${index}`;
    useEffect(() => () => { measured.current?.(index, null); void selectionActions?.unbind(key).catch(() => undefined); }, [index, key]);
    return <View ref={cell} collapsable={false} style={style} {...{ onFocusCapture }}
      onLayout={event => {
        onLayout?.(event); measured.current?.(index, event.nativeEvent.layout);
        const tag = findNodeHandle(cell.current);
        if (tag && selection.current) void selectionActions?.bind(tag, key).catch(() => undefined);
      }}>{children}</View>;
  }, [instance]);
  const theme = useMemo(() => ({ colors: { background: backgroundColor, border: colors.line, code: colors.ink, link: colors.blue, text: colors.ink } }), [backgroundColor]);
  const elements = useMarkdown(prepareMarkdownMathForRenderer(value || '_这份文档还没有正文。_'), {
    renderer: localTextOnly?localTextRenderer:mathRenderer, theme, styles: compact ? compactMarkdownStyles : appearance === 'knowledge' ? knowledgeMarkdownStyles : markdownStyles, colorScheme: 'light',
  });
  if (!scrollEnabled) return <View style={{ backgroundColor, padding: contentPadding }}>{elements}</View>;
  return <FlatList<ReactNode>
    data={elements}
    extraData={highlightedBlocks}
    renderItem={({ item, index }) => highlightedBlocks && index >= highlightedBlocks.start && index <= highlightedBlocks.end
      ? <View style={{ backgroundColor: colors.blueSoft, borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: 8 }}>{item}</View> : <>{item}</>}
    keyExtractor={(_, index) => String(index)}
    initialNumToRender={12}
    maxToRenderPerBatch={10}
    windowSize={7}
    removeClippedSubviews={false}
    CellRendererComponent={CellRenderer}
    style={{ backgroundColor }}
    contentContainerStyle={{ padding: contentPadding, paddingBottom: 64 }}
    {...listProps}
  />;
}
