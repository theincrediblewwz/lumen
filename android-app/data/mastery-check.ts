export type MasteryPrompt = {
  question: string;
  reference: string;
  usedFallbackQuestion: boolean;
  usedFallbackReference: boolean;
};

const questionHeadings = ['自检问题', '自检', '检查理解'];
const referenceHeadings = ['自检参考', '参考答案', '答案要点'];

export function buildMasteryPrompt(title: string, markdown: string): MasteryPrompt {
  const question = findSection(markdown, questionHeadings);
  const reference = findSection(markdown, referenceHeadings);
  return {
    question: question || `请不要照抄正文，用自己的话解释“${title}”，再给出一个具体例子或应用场景。`,
    reference: reference || buildReference(markdown, title),
    usedFallbackQuestion: !question,
    usedFallbackReference: !reference,
  };
}

function findSection(markdown: string, headings: string[]) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let collecting = false;
  const collected: string[] = [];
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(line)?.[1].replace(/[*_`]/g, '').trim();
    if (heading) {
      if (collecting) break;
      collecting = headings.some((candidate) => heading === candidate || heading.startsWith(`${candidate}（`) || heading.startsWith(`${candidate} (`));
      continue;
    }
    if (collecting) collected.push(line);
  }
  return collected.join('\n').trim().slice(0, 1_200);
}

function buildReference(markdown: string, title: string) {
  const withoutSelfCheck = markdown
    .replace(/(^|\n)#{1,6}\s+(?:自检问题|自检|检查理解|自检参考|参考答案|答案要点)[^\n]*\n[\s\S]*$/u, '')
    .replace(/(^|\n)#{1,6}\s+/gu, '$1')
    .replace(/(^|\n)>\s?/gu, '$1')
    .trim();
  return (withoutSelfCheck || `${title} 的节点文档目前没有可比较的参考要点。请先补充文档，再完成自评。`).slice(0, 1_500);
}
