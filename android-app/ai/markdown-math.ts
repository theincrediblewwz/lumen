export const MARKDOWN_MATH_CONTRACT_VERSION = 'markdown-math-v1' as const;
export const MARKDOWN_MATH_SENTINEL = '\u0000learnstuff-math:' as const;

const MATH_OR_CODE_SPAN = /```[\s\S]*?```|`[^`\r\n]*`|\$\$[\s\S]+?\$\$|\$(?!\$)(?!\d+(?:[.,]\d{1,2})?(?:\s|元|美元|美金|人民币|$))[^$\r\n]+?\$(?!\$)/gu;

export function normalizeMarkdownMath(value: string) {
  return value
    .replace(/\\\[([\s\S]+?)\\\]/gu, (_match, formula: string) => `$$${formula.trim()}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/gu, (_match, formula: string) => `$${formula.trim()}$`);
}

/**
 * Protect TeX before the Markdown block lexer sees it. Without this step a
 * multiline display formula can be mistaken for a Setext heading, and inline
 * underscores can be consumed as emphasis before a custom tokenizer runs.
 */
export function prepareMarkdownMathForRenderer(value: string) {
  return normalizeMarkdownMath(value).replace(MATH_OR_CODE_SPAN, (span) => {
    if (span.startsWith('`')) return span;
    const display = span.startsWith('$$');
    const formula = span.slice(display ? 2 : 1, display ? -2 : -1).trim();
    if (!formula) return span;
    return `\`${MARKDOWN_MATH_SENTINEL}${display ? 'display' : 'inline'}:${encodeURIComponent(formula)}\``;
  });
}

export function decodeMarkdownMathPayload(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const MARKDOWN_MATH_ACCEPTANCE_SAMPLE = `# 中文与数学混排

行内公式 $E = mc^2$ 应与中文处在同一段中，旧写法 \\(a^2+b^2=c^2\\) 也应被规范化。

$$
\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}
$$

$$
\\begin{bmatrix}
1 & 0 \\\\
0 & 1
\\end{bmatrix}
$$

上下标：$x_i^2 + y_{i+1}$。
`;
