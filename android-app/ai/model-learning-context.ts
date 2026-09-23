import type { ExpansionContext } from '@/ai/graph-patch';
import {
  buildContentPolicyInstruction,
  createProjectContentPolicy,
  contentPolicyFingerprint,
} from '@/ai/content-policy';
import type { ProjectContentPolicy } from '@/types/domain';

export const LEARNING_MAP_PURPOSE = '这是一张个人学习图谱：节点是需要弄懂或继续追问的知识，连线表示前置、解释、证据、类比或反例。当前任务是在选中的知识点上回答问题，并把真正值得继续学习的要点接回图中。';
export const SUMMARY_MAP_PURPOSE = '这是一张资料总结图谱：节点忠实承载原资料中的主题、论点、证据、例子和结论，连线表示包含、证据、支撑、类比或反例。当前任务是在选中内容上解释或继续整理，同时明确区分原文与补充背景。';

type LearningState = ExpansionContext['selection']['status'];
type Relation = ExpansionContext['constraints']['allowedRelations'][number];
type NoteKind = ExpansionContext['selection']['document']['origin'];

export type ModelLearningContext = {
  mapPurpose: string;
  contentPolicy: {
    fingerprint: string;
    value: ProjectContentPolicy;
    instruction: string;
  };
  originalGoalOrQuestion: string;
  sourceOrPriorUnderstanding: {
    text: string;
    truncated: boolean;
  } | null;
  currentFocus: {
    title: string;
    subtitle: string | null;
    importance: number;
    learningState: LearningState;
    note: {
      text: string;
      kind: NoteKind;
      truncated: boolean;
    } | null;
  };
  pathFromGoal: Array<{
    title: string;
    importance: number;
    learningState: LearningState;
    relationFromPrevious: Relation | null;
  }>;
  directConnections: Array<{
    direction: 'towardCurrent' | 'fromCurrent';
    title: string;
    importance: number;
    learningState: LearningState;
    relation: Relation;
    note: {
      text: string;
      kind: NoteKind;
      truncated: boolean;
    } | null;
  }>;
  recentConversation: Array<{
    question: string;
    answer: string;
    answerTruncated: boolean;
  }>;
  currentQuestion: {
    text: string;
    truncated: boolean;
  };
  outputLimits: {
    maxNewNodes: number;
    maxNewEdges: number;
    allowedRelations: Relation[];
    newNodesOnly: true;
  };
};

export function createModelLearningContext(context: ExpansionContext): ModelLearningContext {
  const contentPolicy = createProjectContentPolicy(context.project.contentPolicy);
  const projectSource = context.project.sourceText.trim();
  const rootSelected = context.selection.title.trim() === context.project.title.trim()
    && context.selection.document.origin === 'source';
  const focusNote = compactDocumentBody(
    context.selection.document.body,
    context.selection.title,
    rootSelected ? projectSource : null,
  );

  return {
    mapPurpose: contentPolicy.mode === 'summary' ? SUMMARY_MAP_PURPOSE : LEARNING_MAP_PURPOSE,
    contentPolicy: {
      fingerprint: contentPolicyFingerprint(contentPolicy),
      value: contentPolicy,
      instruction: buildContentPolicyInstruction(contentPolicy),
    },
    originalGoalOrQuestion: context.project.title,
    sourceOrPriorUnderstanding: projectSource
      ? { text: projectSource, truncated: context.project.sourceTextTruncated }
      : null,
    currentFocus: {
      title: context.selection.title,
      subtitle: context.selection.subtitle.trim() || null,
      importance: context.selection.importance,
      learningState: context.selection.status,
      note: focusNote
        ? {
          text: focusNote,
          kind: context.selection.document.origin,
          truncated: context.selection.document.truncated,
        }
        : null,
    },
    pathFromGoal: context.learningPath.map((item) => ({
      title: item.title,
      importance: item.importance,
      learningState: item.status,
      relationFromPrevious: item.viaRelation,
    })),
    directConnections: context.relatedKnowledge.map((item) => {
      const note = compactDocumentBody(item.document.body, item.document.title, null);
      return {
        direction: item.direction === 'incoming' ? 'towardCurrent' as const : 'fromCurrent' as const,
        title: item.title,
        importance: item.importance,
        learningState: item.status,
        relation: item.relation,
        note: note
          ? {
            text: note,
            kind: item.document.origin,
            truncated: item.document.truncated,
          }
          : null,
      };
    }),
    recentConversation: context.recentAnswers.map((item) => ({
      question: item.question,
      answer: item.body,
      answerTruncated: item.truncated,
    })),
    currentQuestion: {
      text: context.prompt,
      truncated: context.promptTruncated,
    },
    outputLimits: {
      maxNewNodes: context.constraints.maxNodes,
      maxNewEdges: context.constraints.maxEdges,
      allowedRelations: [...context.constraints.allowedRelations],
      newNodesOnly: true,
    },
  };
}

function compactDocumentBody(body: string, title: string, duplicateProjectSource: string | null) {
  let lines = body.trim().split(/\r?\n/u);
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  if (firstContent >= 0 && normalizeHeading(lines[firstContent]) === normalizeText(title)) {
    lines.splice(firstContent, 1);
  }
  if (duplicateProjectSource !== null) {
    lines = removeDuplicateSourceSection(lines, duplicateProjectSource);
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function removeDuplicateSourceSection(lines: string[], projectSource: string) {
  const headingIndex = lines.findIndex((line) => /^##\s+原始目标或资料\s*$/u.test(line.trim()));
  if (headingIndex < 0) return lines;
  let endIndex = headingIndex + 1;
  while (endIndex < lines.length && !/^##\s+/u.test(lines[endIndex].trim())) endIndex += 1;
  const sectionText = lines.slice(headingIndex + 1, endIndex).join('\n').trim();
  const expected = projectSource.trim() || '尚未添加资料。';
  if (normalizeText(sectionText) !== normalizeText(expected)) return lines;
  return [...lines.slice(0, headingIndex), ...lines.slice(endIndex)];
}

function normalizeHeading(value: string) {
  return normalizeText(value.replace(/^#+\s*/u, ''));
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}
