import type { SQLiteDatabase } from 'expo-sqlite';

import { createCompatibleProviderContext } from '@/ai/compatible-chat-draft';
import { createContextPlan, type ContextPlan } from '@/ai/context-plan';
import type { ExpansionQualityPath } from '@/ai/deep-build';
import { createModelLearningContext } from '@/ai/model-learning-context';
import { buildExpansionContext } from '@/data/knowledge-repository';
import { loadPersonalContextEvidence } from '@/data/personal-context';

type PreparedContextPreview = {
  plan: ContextPlan;
  qualityPath: ExpansionQualityPath;
};

const preparedPreviews = new Map<string, PreparedContextPreview>();
const MAX_PREPARED_PREVIEWS = 4;

export async function prepareContextPreview(
  db: SQLiteDatabase,
  nodeId: string,
  prompt: string,
  qualityPath: ExpansionQualityPath,
) {
  const built = await buildExpansionContext(
    db,
    nodeId,
    prompt,
    `preview-${Date.now().toString(36)}`,
  );
  const personal = await loadPersonalContextEvidence(db, built.project.id, built.prompt);
  const plan = createContextPlan(
    createModelLearningContext(createCompatibleProviderContext(built)),
    {
      futureEvidence: personal.evidence,
      activeScopes: personal.scopes
        .filter((scope) => scope.enabled)
        .map((scope) => ({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          label: scope.label,
        })),
    },
  );
  const previewId = `context-preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  preparedPreviews.set(previewId, { plan, qualityPath });
  while (preparedPreviews.size > MAX_PREPARED_PREVIEWS) {
    const oldestKey = preparedPreviews.keys().next().value;
    if (!oldestKey) break;
    preparedPreviews.delete(oldestKey);
  }
  return previewId;
}

export function getPreparedContextPreview(previewId: string | undefined) {
  return previewId ? preparedPreviews.get(previewId) ?? null : null;
}
