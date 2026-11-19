import type MarkdownIt from 'markdown-it';

export const DEFAULT_HIGHLIGHT = '#FFF146';
const COLOR = /^#[\da-f]{6}$/i;
const OPEN = /^==\{(#[\da-f]{6})\}/i;
const MARKER = '='.charCodeAt(0);

export function highlightColor(value: string | null): string | null {
  return value && COLOR.test(value) ? value.toUpperCase() : null;
}

export function highlightMarkup(text: string, color: string): string {
  const previous = text.match(OPEN);
  const opening = `=={${color}}`;
  return previous && text.endsWith('==') ? opening + text.slice(previous[0].length) : `${opening}${text}==`;
}

// Use Markdown's own delimiter matching so code, formulas and links retain their usual parsing.
export function highlightPlugin(md: InstanceType<typeof MarkdownIt>) {
  md.inline.ruler.before('emphasis', 'lumen_highlight', (state, silent) => {
    if (silent || !state.src.startsWith('==', state.pos)) return false;
    const opening = state.src.slice(state.pos, state.pos + 12).match(OPEN);
    const text = opening?.[0] ?? '==';
    if (state.pos + text.length > state.posMax) return false;
    const token = state.push('text', '', 0);
    token.content = text;
    state.delimiters.push({ marker: MARKER, length: 0, token: state.tokens.length - 1,
      end: -1, open: !!opening, close: !opening });
    state.pos += text.length;
    return true;
  });
  md.inline.ruler2.before('fragments_join', 'lumen_highlight', state => {
    if (!state.src.includes('=={#')) return false;
    for (const delimiters of [state.delimiters, ...state.tokens_meta.flatMap(meta => meta?.delimiters ? [meta.delimiters] : [])]) {
      for (const delimiter of delimiters) {
        if (delimiter.marker !== MARKER || delimiter.end < 0) continue;
        const open = state.tokens[delimiter.token];
        const color = highlightColor(open.content.match(OPEN)?.[1] ?? null);
        if (!color) continue;
        open.type = 'mark_open';
        open.tag = 'mark';
        open.nesting = 1;
        open.content = '';
        open.attrSet('class', 'lumen-highlight');
        open.attrSet('data-lumen-highlight', color);
        open.attrSet('style', `--highlight-ink:${color}`);

        const close = state.tokens[delimiters[delimiter.end].token];
        close.type = 'mark_close';
        close.tag = 'mark';
        close.nesting = -1;
        close.content = '';
      }
    }
    return true;
  });
}

// Only restore a validated color after sanitization strips arbitrary inline styles.
export function restoreHighlightColor(node: Element) {
  if (node.tagName !== 'MARK' || !node.classList.contains('lumen-highlight')) return;
  const color = highlightColor(node.getAttribute('data-lumen-highlight'));
  if (color) (node as HTMLElement).style.setProperty('--highlight-ink', color);
}
