import type { ContextPlan } from '@/ai/context-plan';
import type { ExpansionContext } from '@/ai/graph-patch';

export class StoredExpansionDataError extends Error {
  constructor(message: string, public readonly code: 'invalid_saved_request' | 'invalid_saved_plan' | 'invalid_saved_artifact') {
    super(message);
    this.name = 'StoredExpansionDataError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function records(value: unknown, required: (item: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(value) && value.every((item) => record(item) && required(item));
}

/** Persisted requests can come from an interrupted older build or a sync import. */
export function parseStoredExpansionContext(value: unknown, projectId: string, nodeId: string): ExpansionContext {
  if (!record(value) || value.schemaVersion !== 2 || typeof value.requestId !== 'string'
    || !record(value.project) || value.project.id !== projectId
    || typeof value.project.title !== 'string' || typeof value.project.sourceText !== 'string'
    || (value.project.contentPolicy != null && !record(value.project.contentPolicy))
    || (value.project.sourceReferences !== undefined && !records(value.project.sourceReferences,
      item => typeof item.sourceItemId === 'string' && typeof item.locator === 'string'))
    || !record(value.selection) || value.selection.id !== nodeId
    || typeof value.selection.title !== 'string' || typeof value.selection.subtitle !== 'string'
    || !record(value.selection.document) || typeof value.selection.document.body !== 'string'
    || !records(value.learningPath, item => typeof item.title === 'string')
    || !records(value.relatedKnowledge, item => typeof item.title === 'string'
      && record(item.document) && typeof item.document.body === 'string')
    || !records(value.recentAnswers, item => typeof item.question === 'string' && typeof item.body === 'string')
    || !Array.isArray(value.nearbyNodes)
    || typeof value.prompt !== 'string'
    || !record(value.constraints) || !Number.isInteger(value.constraints.maxNodes)
    || !Number.isInteger(value.constraints.maxEdges) || !strings(value.constraints.allowedRelations)
    || !record(value.contextManifest) || !Array.isArray(value.contextManifest.sections)) {
    throw new StoredExpansionDataError('已保存的展开上下文不完整或与当前节点不符，请重新发起问题', 'invalid_saved_request');
  }
  return value as ExpansionContext;
}

export function parseStoredContextPlan(value: unknown): ContextPlan {
  if (!record(value) || value.version !== 1 || !record(value.budget)
    || !records(value.selected, item => typeof item.id === 'string' && typeof item.kind === 'string')
    || !records(value.omitted, item => typeof item.id === 'string')
    || !records(value.activeScopes, item => typeof item.scopeId === 'string')
    || !records(value.resolvedEvidence, item => typeof item.category === 'string')
    || !record(value.modelContext) || !record(value.modelContext.contentPolicy)
    || !record(value.modelContext.contentPolicy.value)
    || typeof value.modelContext.contentPolicy.value.mode !== 'string'
    || typeof value.modelContext.contentPolicy.instruction !== 'string'
    || !record(value.modelContext.currentFocus) || !record(value.modelContext.currentQuestion)
    || typeof value.modelContext.currentFocus.title !== 'string'
    || typeof value.modelContext.currentQuestion.text !== 'string'
    || !records(value.modelContext.pathFromGoal, item => typeof item.title === 'string')
    || !records(value.modelContext.directConnections, item => typeof item.title === 'string')
    || !records(value.modelContext.recentConversation, item => typeof item.question === 'string')
    || !record(value.modelContext.outputLimits)
    || !strings(value.modelContext.outputLimits.allowedRelations)
    || !Number.isInteger(value.modelContext.outputLimits.maxNewNodes)
    || !Number.isInteger(value.modelContext.outputLimits.maxNewEdges)
    || typeof value.fingerprint !== 'string') {
    throw new StoredExpansionDataError('已保存的上下文计划不完整，请重新发起问题', 'invalid_saved_plan');
  }
  return value as ContextPlan;
}
