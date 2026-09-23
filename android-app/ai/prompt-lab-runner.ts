import * as FileSystem from 'expo-file-system/legacy';

import { ByokProviderError } from '@/ai/byok-client';
import type { ByokCredentials } from '@/ai/byok-profile';
import { formatPromptLabRunMarkdown } from '@/ai/prompt-lab-report';
import {
  createPromptLabV3Requests,
  estimatePromptLabGate,
  PROMPT_LAB_MAX_CALLS,
  PROMPT_LAB_PRICE,
  PROMPT_LAB_VERSION,
  type BlindPromptVariant,
  type PromptLabDiagnostic,
} from '@/ai/prompt-lab';
import { PromptLabResponseError, requestPromptLabCompletion } from '@/ai/prompt-lab-client';

const LAB_DIRECTORY = `${FileSystem.documentDirectory ?? ''}prompt-lab/`;

export type PromptLabResult = {
  index: number;
  caseId: string;
  caseTitle: string;
  blindLabel: BlindPromptVariant['label'];
  status: 'succeeded' | 'failed';
  contextFingerprint: string;
  content: string | null;
  diagnostic: PromptLabDiagnostic | null;
  actualModel: string | null;
  providerResponseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  latencyMs: number | null;
  estimatedCostCny: number | null;
  error: {
    code: string;
    message: string;
    outcomeUnknown: boolean;
  } | null;
  codexScore: null;
  userScore: null;
};

export type PromptLabRun = {
  format: 'learnstuff-prompt-lab-run';
  version: typeof PROMPT_LAB_VERSION;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  provider: {
    baseUrl: 'https://api.xiaomimimo.com/v1';
    model: 'mimo-v2.5';
    thinking: 'disabled';
    retries: 0;
  };
  price: typeof PROMPT_LAB_PRICE;
  gate: ReturnType<typeof estimatePromptLabGate>;
  blindLabels: BlindPromptVariant['label'][];
  completedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostCny: number;
  results: PromptLabResult[];
  storage: {
    jsonUri: string;
    markdownUri: string;
  };
};

export async function runPromptLab(
  credentials: ByokCredentials,
  options: {
    signal?: AbortSignal;
    onProgress?: (run: PromptLabRun) => void;
    now?: () => Date;
  } = {},
) {
  if (!FileSystem.documentDirectory) throw new Error('当前设备没有可用的 App 私有文档目录');
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const runId = `mimo-v25-${createdAt.replace(/[-:.TZ]/gu, '').slice(0, 17)}`;
  const requests = createPromptLabV3Requests();
  const jsonUri = `${LAB_DIRECTORY}${runId}.json`;
  const markdownUri = `${LAB_DIRECTORY}${runId}.md`;
  const run: PromptLabRun = {
    format: 'learnstuff-prompt-lab-run',
    version: PROMPT_LAB_VERSION,
    runId,
    createdAt,
    updatedAt: createdAt,
    status: 'running',
    provider: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5',
      thinking: 'disabled',
      retries: 0,
    },
    price: PROMPT_LAB_PRICE,
    gate: estimatePromptLabGate(runId),
    blindLabels: requests.map((item) => item.blindLabel),
    completedCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostCny: 0,
    results: [],
    storage: { jsonUri, markdownUri },
  };
  await FileSystem.makeDirectoryAsync(LAB_DIRECTORY, { intermediates: true });
  await persistRun(run);
  options.onProgress?.(cloneRun(run));

  for (const [jobIndex, request] of requests.entries()) {
    if (options.signal?.aborted) {
      run.status = 'stopped';
      run.updatedAt = now().toISOString();
      await persistRun(run);
      options.onProgress?.(cloneRun(run));
      return run;
    }
    try {
      const completion = await requestPromptLabCompletion(request, credentials, options.signal);
      const result: PromptLabResult = {
        index: jobIndex + 1,
        caseId: request.caseId,
        caseTitle: request.caseTitle,
        blindLabel: request.blindLabel,
        status: 'succeeded',
        contextFingerprint: request.contextPlan.fingerprint,
        content: completion.content,
        diagnostic: completion.diagnostic,
        actualModel: completion.actualModel,
        providerResponseId: completion.providerResponseId,
        inputTokens: completion.usage?.inputTokens ?? null,
        outputTokens: completion.usage?.outputTokens ?? null,
        cachedInputTokens: completion.usage?.cachedInputTokens ?? null,
        latencyMs: completion.latencyMs,
        estimatedCostCny: completion.estimatedCostCny,
        error: null,
        codexScore: null,
        userScore: null,
      };
      run.results.push(result);
      run.completedCalls += 1;
      run.totalInputTokens += result.inputTokens ?? 0;
      run.totalOutputTokens += result.outputTokens ?? 0;
      run.totalEstimatedCostCny += result.estimatedCostCny ?? 0;
      run.updatedAt = now().toISOString();
      await persistRun(run);
      options.onProgress?.(cloneRun(run));
    } catch (error) {
      const safe = error instanceof ByokProviderError
        ? error
        : new ByokProviderError('实验发生未知错误；为避免重复计费已经停止', 'prompt_lab_unknown', true);
      const response = error instanceof PromptLabResponseError ? error.responseMetadata : null;
      run.results.push({
        index: jobIndex + 1,
        caseId: request.caseId,
        caseTitle: request.caseTitle,
        blindLabel: request.blindLabel,
        status: 'failed',
        contextFingerprint: request.contextPlan.fingerprint,
        content: response?.content ?? null,
        diagnostic: response?.diagnostic ?? null,
        actualModel: response?.actualModel ?? null,
        providerResponseId: response?.providerResponseId ?? null,
        inputTokens: response?.usage?.inputTokens ?? null,
        outputTokens: response?.usage?.outputTokens ?? null,
        cachedInputTokens: response?.usage?.cachedInputTokens ?? null,
        latencyMs: response?.latencyMs ?? null,
        estimatedCostCny: response?.estimatedCostCny ?? null,
        error: { code: safe.code, message: safe.message, outcomeUnknown: safe.outcomeUnknown },
        codexScore: null,
        userScore: null,
      });
      run.completedCalls += 1;
      run.totalInputTokens += response?.usage?.inputTokens ?? 0;
      run.totalOutputTokens += response?.usage?.outputTokens ?? 0;
      run.totalEstimatedCostCny += response?.estimatedCostCny ?? 0;
      run.status = options.signal?.aborted ? 'stopped' : 'failed';
      run.updatedAt = now().toISOString();
      await persistRun(run);
      options.onProgress?.(cloneRun(run));
      return run;
    }
  }

  run.status = run.completedCalls === PROMPT_LAB_MAX_CALLS ? 'completed' : 'stopped';
  run.updatedAt = now().toISOString();
  await persistRun(run);
  options.onProgress?.(cloneRun(run));
  return run;
}

export async function getLatestPromptLabRun(): Promise<PromptLabRun | null> {
  if (!FileSystem.documentDirectory) return null;
  try {
    const latest = await FileSystem.readAsStringAsync(`${LAB_DIRECTORY}latest.json`);
    const pointer = JSON.parse(latest) as { jsonUri?: unknown };
    if (typeof pointer.jsonUri !== 'string' || !pointer.jsonUri.startsWith(LAB_DIRECTORY)) return null;
    const raw = await FileSystem.readAsStringAsync(pointer.jsonUri);
    const parsed = JSON.parse(raw) as PromptLabRun;
    return parsed.format === 'learnstuff-prompt-lab-run' && parsed.version === PROMPT_LAB_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export async function exportPromptLabRun(run: PromptLabRun) {
  const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const baseName = `learnstuff-${run.runId}`;
  const jsonUri = await FileSystem.StorageAccessFramework.createFileAsync(
    permission.directoryUri,
    `${baseName}.json`,
    'application/json',
  );
  await FileSystem.StorageAccessFramework.writeAsStringAsync(jsonUri, JSON.stringify(run, null, 2));
  const markdownUri = await FileSystem.StorageAccessFramework.createFileAsync(
    permission.directoryUri,
    `${baseName}.md`,
    'text/markdown',
  );
  await FileSystem.StorageAccessFramework.writeAsStringAsync(markdownUri, formatPromptLabRunMarkdown(run));
  return { jsonUri, markdownUri };
}

async function persistRun(run: PromptLabRun) {
  const json = JSON.stringify(run, null, 2);
  const markdown = formatPromptLabRunMarkdown(run);
  await FileSystem.writeAsStringAsync(run.storage.jsonUri, json);
  await FileSystem.writeAsStringAsync(run.storage.markdownUri, markdown);
  await FileSystem.writeAsStringAsync(
    `${LAB_DIRECTORY}latest.json`,
    JSON.stringify({ version: 1, runId: run.runId, jsonUri: run.storage.jsonUri }, null, 2),
  );
}

function cloneRun(run: PromptLabRun): PromptLabRun {
  return JSON.parse(JSON.stringify(run)) as PromptLabRun;
}
