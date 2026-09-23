import type { ExpansionContext, LearningExpansion } from '@/ai/graph-patch';

export function createLocalExpansion(context: ExpansionContext): LearningExpansion {
  const parent = context.selection;
  const prompt = context.prompt || `继续拆解 ${parent.title}`;
  const firstImportance = Math.max(6, parent.importance - 1);
  const secondImportance = Math.max(5, parent.importance - 2);

  const patch: LearningExpansion['patch'] = {
    version: 1 as const,
    summary: `本地演示围绕「${parent.title}」创建两个固定示例节点。`,
    nodes: [
      {
        clientId: 'core-intuition',
        title: `${parent.title}的核心直觉`,
        subtitle: '先建立可解释的理解',
        importance: firstImportance,
        status: 'learning',
        document: {
          title: `${parent.title}的核心直觉`,
          body: `# ${parent.title}的核心直觉\n\n> **重要性 ${firstImportance}/10：** 建立直觉通常是解释当前知识点的第一步。\n\n> 本地演示固定内容：没有调用任何 AI，也没有真正回答用户问题。\n\n**用户问题：** ${prompt}\n\n配置 AI 后，这里会由模型补充解释、例子、验证问题和来源记录。`,
        },
      },
      {
        clientId: 'required-prerequisite',
        title: `${parent.title}的必要前置`,
        subtitle: '定位仍然缺失的基础',
        importance: secondImportance,
        status: 'learning',
        document: {
          title: `${parent.title}的必要前置`,
          body: `# ${parent.title}的必要前置\n\n> **重要性 ${secondImportance}/10：** 它用于演示如何把未知继续拆成前置知识。\n\n> 本地演示固定内容：没有调用任何 AI，也没有判断真实前置。\n\n**用户问题：** ${prompt}\n\n配置 AI 后，模型会判断哪些前置已掌握，哪些仍需继续追溯。`,
        },
      },
    ],
    edges: [
      {
        clientId: 'edge-core-intuition',
        sourceRef: 'selection',
        targetRef: 'core-intuition',
        relation: 'prerequisite',
        importance: firstImportance,
        document: {
          title: `${parent.title} → 核心直觉`,
          body: `# 为什么需要核心直觉\n\n要回答「${prompt}」，先把符号或步骤还原成可以解释的直觉。`,
        },
      },
      {
        clientId: 'edge-required-prerequisite',
        sourceRef: 'selection',
        targetRef: 'required-prerequisite',
        relation: 'prerequisite',
        importance: secondImportance,
        document: {
          title: `${parent.title} → 必要前置`,
          body: `# 为什么追溯这个前置\n\n这个前置是理解「${parent.title}」时需要检查的知识边界。`,
        },
      },
    ],
  };
  return {
    version: 1,
    answerMarkdown: `# ${parent.title} · 本地演示\n\n## 你的问题\n\n${prompt}\n\n## 这不是 AI 回答\n\n当前没有连接远程 AI。本次只创建两个固定示例节点，用来体验图谱、Markdown 与回答历史如何一起保存；它没有分析问题，也不能用于判断知识内容是否正确。\n\n## 本次生成的知识要点\n\n1. **${parent.title}的核心直觉 · ${firstImportance}/10** — 演示先建立直觉的学习入口。\n2. **${parent.title}的必要前置 · ${secondImportance}/10** — 演示继续追溯前置知识的入口。`,
    keyPoints: [
      { title: `${parent.title}的核心直觉`, importance: firstImportance, importanceReason: '建立直觉通常是解释当前知识点的第一步。' },
      { title: `${parent.title}的必要前置`, importance: secondImportance, importanceReason: '它用于演示如何把未知继续拆成前置知识。' },
    ],
    patch,
  };
}

