import type { PortableGraphManifest } from '@/data/portable-knowledge';
import type { NodeAnswer, PromptTemplate } from '@/types/domain';
import type { KnowledgeLibrary } from './knowledge-library-core';
import {validateOriginalAssets,type OriginalAsset} from './rich-backup';

export const APP_BACKUP_FORMAT = 'learnstuff-app-backup' as const;
export const APP_BACKUP_VERSION = 6 as const;
export const BACKUP_PROGRESS_TOTAL = 5;

export type LocalBackupSlot = 'a' | 'b';

export type LocalBackupSnapshot = {
  format: typeof APP_BACKUP_FORMAT;
  version: 2 | 3 | 4 | 5 | typeof APP_BACKUP_VERSION;
  originalAssets?:OriginalAsset[];
  exportedAt: string;
  revision: number;
  projects: PortableGraphManifest[];
  answers: NodeAnswer[];
  promptTemplates: PromptTemplate[];
  topics: Array<{
    id: string;
    parentId: string | null;
    title: string;
    createdAt: string;
    updatedAt: string;
  }>;
  aiUnderstandingDocuments: Array<{
    id: string;
    scopeType: 'global' | 'topic' | 'project';
    scopeId: string;
    category: 'preference' | 'known' | 'pending';
    title: string;
    body: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  projectAiScopeSettings: Array<{
    projectId: string;
    scopeType: 'global' | 'topic' | 'project';
    scopeId: string;
    enabled: boolean;
    updatedAt: string;
  }>;
  favorites: Array<{
    id: string;
    targetType: 'node' | 'answer';
    targetId: string;
    projectId: string;
    nodeId: string;
    createdAt: string;
  }>;
  favoriteBindings: Array<{
    scopeType: 'global' | 'topic' | 'project';
    scopeId: string;
    favoriteId: string;
    createdAt: string;
  }>;
  exclusions: string[];
  knowledgeLibrary?: KnowledgeLibrary;
};

export type BackupFileStore = {
  write: (fileName: string, mimeType: string, contents: string) => Promise<void>;
  directory?: (directoryName: string) => Promise<BackupFileStore>;
  writeBytes?:(fileName:string,mimeType:string,bytes:Uint8Array)=>Promise<void>;
};

export function nextLocalBackupSlot(activeSlot: LocalBackupSlot | null): LocalBackupSlot {
  return activeSlot === 'a' ? 'b' : 'a';
}

export async function writeLocalBackupSnapshot(
  store: BackupFileStore,
  snapshot: LocalBackupSnapshot,
  slot: LocalBackupSlot,
  onProgress?: (current: number, label: string) => Promise<void> | void,
  readAsset?:(asset:OriginalAsset)=>Promise<Uint8Array>,
) {
  if(snapshot.version===6){const originals=validateOriginalAssets(snapshot.originalAssets,snapshot.projects);if(originals.length){if(!store.directory||!readAsset)throw Error('备份原件写入不可用');const folder=await store.directory('原件');if(!folder.writeBytes)throw Error('备份目录不支持原件写入');const seen=new Set<string>();for(const original of originals){if(seen.has(original.sha256))continue;seen.add(original.sha256);await folder.writeBytes(`${original.sha256}.bin`,'application/octet-stream',await readAsset(original));}}}
  const jsonName = `learnstuff-backup-slot-${slot}.json`;
  const markdownName = `learnstuff-backup-slot-${slot}.md`;
  const commitName = `learnstuff-backup-commit-${slot}.json`;
  await onProgress?.(2, `正在写入 ${slot.toUpperCase()} 槽图谱快照`);
  await store.write(jsonName, 'application/json', JSON.stringify(snapshot, null, 2));
  await onProgress?.(3, `正在写入 ${slot.toUpperCase()} 槽 Markdown 目录`);
  await store.write(markdownName, 'text/markdown', backupMarkdown(snapshot));
  await onProgress?.(4, '正在写入恢复说明与完成标记');
  await writeReadableProjectMirrors(store, snapshot);
  await store.write(
    'README-LearnStuff-Backup.md',
    'text/markdown',
    '# LearnStuff 自动本地备份 v6\n\nA/B 两槽轮换，latest指向最近完整版本。v6包含全部图谱、正文、对话、来源、知识历史和引用权限；原件先保存并校验到“原件”文件夹，完成标记最后写。恢复时选择槽位JSON并授权同一备份目录。请保留整个文件夹。API key、同步凭据和设备身份不参与备份。旧版v2–v5仍可恢复文字；旧记录中已经缺失的原件无法重建。\n',
  );
  const pointer = {
    format: 'learnstuff-app-backup-pointer',
    version: 1,
    slot,
    revision: snapshot.revision,
    completedAt: new Date().toISOString(),
    jsonFile: jsonName,
    markdownFile: markdownName,
  };
  await store.write(commitName, 'application/json', JSON.stringify(pointer, null, 2));
  await onProgress?.(5, '正在切换到最新完整备份');
  await store.write('learnstuff-backup-latest.json', 'application/json', JSON.stringify(pointer, null, 2));
  return pointer;
}

async function writeReadableProjectMirrors(store: BackupFileStore, snapshot: LocalBackupSnapshot) {
  if (!store.directory) return;
  const projectsRoot = await store.directory('项目');
  const index = [];
  for (const project of snapshot.projects) {
    const folderName = `${backupName(project.project.title, '项目')}-${backupName(project.project.id.slice(-10), 'id')}`;
    const projectStore = await projectsRoot.directory!(folderName);
    const markdownStore = await projectStore.directory!('Markdown');
    const answerStore = await projectStore.directory!('回答');
    const projectAnswers = snapshot.answers.filter((answer) => answer.projectId === project.project.id);
    await projectStore.write('learnstuff.graph.json', 'application/json', JSON.stringify(project, null, 2));
    await projectStore.write(
      'README.md',
      'text/markdown',
      `# ${project.project.title}\n\n这是自动备份中的可读项目镜像。应用私有 SQLite 与根目录 A/B 完整快照仍是恢复正本；请勿把这里当成双向编辑目录。\n\n- 内容模式：${project.project.contentPolicy?.mode === 'summary' ? '总结图' : '学习图'}\n- 展开方向：${project.project.layoutDirection === 'horizontal' ? '从左到右' : '从上到下'}\n- 节点：${project.nodes.length}\n- 关系：${project.edges.length}\n- 文档：${project.documents.length}\n- 资料来源：${project.sourceItems?.length ?? 0}\n- 掌握记录：${project.masteryAttempts?.length ?? 0}\n- 复习记录：${project.reviewEvents?.length ?? 0}\n- 图谱修改批次：${project.graphMutationBatches?.length ?? 0}\n- 全部回答：${projectAnswers.length}\n\n> v6 原件在备份根目录“原件”文件夹，按哈希校验。此镜像供文字查阅；恢复到应用后可阅读图文和PDF。\n`,
    );
    for (const [index, document] of project.documents.entries()) {
      await markdownStore.write(
        `${String(index + 1).padStart(3, '0')}-${backupName(document.title, '文档')}.md`,
        'text/markdown',
        `<!-- 原路径：${document.path}；来源：${document.origin} -->\n\n${document.body}\n`,
      );
    }
    for (const [index, answer] of projectAnswers.entries()) {
      await answerStore.write(
        `${String(index + 1).padStart(3, '0')}-${answer.saved ? '已收藏' : '未收藏'}-${backupName(answer.question, '回答')}.md`,
        'text/markdown',
        `# ${answer.question}\n\n- 节点 ID：${answer.nodeId}\n- 回答来源：${answer.adapter}${answer.actualModel ? ` / ${answer.actualModel}` : ''}\n- 收藏：${answer.saved ? '是' : '否'}\n\n${answer.body}\n`,
      );
    }
    index.push({
      id: project.project.id,
      title: project.project.title,
      folder: `项目/${folderName}`,
      layoutDirection: project.project.layoutDirection ?? 'vertical',
      updatedAt: project.project.updatedAt,
    });
  }
  await store.write(
    'learnstuff-projects-index.json',
    'application/json',
    JSON.stringify({ version: 1, generatedAt: snapshot.exportedAt, projects: index }, null, 2),
  );
}

function backupName(value: string, fallback: string) {
  const clean = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (clean || fallback).slice(0, 72);
}

function backupMarkdown(snapshot: LocalBackupSnapshot) {
  const lines = [
    '# LearnStuff 自动本地备份',
    '',
    `- 导出时间：${snapshot.exportedAt}`,
    `- 数据修订：${snapshot.revision}`,
    `- 项目数量：${snapshot.projects.length}`,
    `- 专题数量：${snapshot.topics.length}`,
    `- AI 对你的了解：${snapshot.aiUnderstandingDocuments.length}`,
    `- 收藏数量：${snapshot.favorites.length}`,
    `- 询问模板：${snapshot.promptTemplates.length}`,
    `- 独立知识：${snapshot.knowledgeLibrary?.entries.length ?? 0}`,
    '',
    '> 这是便于人工检查的合并目录。完整恢复数据以同槽位 JSON 为准。',
  ];
  for (const project of snapshot.projects) {
    lines.push('', `# 项目：${project.project.title}`, '', project.project.sourceText || '（无原始资料）');
    for (const document of project.documents) {
      lines.push('', `## ${document.title}`, '', `路径：\`${document.path}\` · 来源：${document.origin}`, '', document.body);
    }
    for (const conversation of project.fusion?.conversations ?? []) {
      lines.push('', `## 对话：${conversation.title}`);
      for (const message of project.fusion?.messages.filter((item) => item.conversation_id === conversation.id) ?? []) {
        lines.push('', `### ${message.role === 'user' ? '我' : 'AI'}${message.status === 'complete' ? '' : '（未完成）'}`, '', message.body);
      }
    }
  }
  if (snapshot.answers.length) {
    lines.push('', '# 全部回答记录');
    for (const answer of snapshot.answers) {
      lines.push('', `## ${answer.saved ? '已收藏' : '未收藏'}：${answer.question}`, '', answer.body);
    }
  }
  if (snapshot.knowledgeLibrary?.entries.length) {
    lines.push('', '# 独立知识库');
    for (const entry of snapshot.knowledgeLibrary.entries) lines.push('', `## ${entry.title}${entry.archived ? '（已归档）' : ''}`, '', entry.body, '', `出处：${entry.source || '无'}`);
  }
  if (snapshot.promptTemplates.length) {
    lines.push('', '# 询问模板');
    for (const template of snapshot.promptTemplates) lines.push('', `## ${template.title}`, '', template.body);
  }
  if (snapshot.aiUnderstandingDocuments.length) {
    lines.push('', '# AI 对你的了解');
    for (const document of snapshot.aiUnderstandingDocuments) {
      lines.push(
        '',
        `## ${document.title}`,
        '',
        `范围：${document.scopeType}/${document.scopeId} · 类型：${document.category} · ${document.enabled ? '启用' : '停用'}`,
        '',
        document.body,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
