import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLatestExpansionJobForProject,
  markDeepBuildStageFailed,
  recoverStaleExpansionJobs,
} from '../data/expansion-jobs';

test('startup recovery fails stale BYOK work instead of queueing it for automatic replay', async () => {
  const statements: string[] = [];
  const db = {
    runAsync: async (sql: string) => {
      statements.push(sql);
      return { changes: 1 };
    },
  };
  const recovered = await recoverStaleExpansionJobs(db as never);
  assert.equal(recovered, 4);
  assert.match(statements[0], /ai_deep_build_stages/);
  assert.match(statements[0], /status = 'unknown_charge'/);
  assert.match(statements[1], /adapter = 'byok'.*status = 'running'/s);
  assert.match(statements[1], /status = 'failed'/);
  assert.match(statements[1], /provider_outcome_unknown/);
  assert.match(statements[2], /adapter != 'byok'.*status = 'running'/s);
  assert.doesNotMatch(statements[2], /SET status = 'failed'/);
});

test('maps the latest persisted failure for project-level warning UI', async () => {
  const db = {
    getFirstAsync: async () => ({
      id: 'job-1', project_id: 'project-1', selection_id: 'node-1', prompt: '继续', adapter: 'byok',
      quality_path: 'deep',
      status: 'failed', attempt_count: 1, request_json: '{}', response_json: null,
      error_code: 'provider_network_unknown', error_message: '是否已计费不确定；不会自动重试',
      next_retry_at: null, lease_expires_at: null,
    }),
  };
  const job = await getLatestExpansionJobForProject(db as never, 'project-1');
  assert.equal(job?.adapter, 'byok');
  assert.equal(job?.qualityPath, 'deep');
  assert.equal(job?.status, 'failed');
  assert.match(job?.errorMessage ?? '', /不会自动重试/);
});

test('persists rejected deep output and usage for diagnosis without marking it successful', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const transaction = {
    runAsync: async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args });
      return { changes: 1 };
    },
  };
  const db = {
    withExclusiveTransactionAsync: async (callback: (value: typeof transaction) => Promise<void>) => {
      await callback(transaction);
    },
  };
  await markDeepBuildStageFailed(db as never, 'job-1', 'knowledge_dossier', {
    code: 'invalid_provider_output_knowledge_dossier',
    message: 'items 缺少 concept',
    outcomeUnknown: true,
    rejectedOutput: { answerMarkdown: '# 已返回的回答' },
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    actualModel: 'mimo-v2.5',
  });
  assert.match(calls[0].sql, /artifact_json = COALESCE/);
  assert.match(String(calls[0].args[3]), /rejected_provider_output/);
  assert.match(String(calls[0].args[4]), /"outputTokens":200/);
  assert.equal(calls[0].args[5], 'mimo-v2.5');
  assert.match(calls[1].sql, /SET status = 'failed'/);
});
