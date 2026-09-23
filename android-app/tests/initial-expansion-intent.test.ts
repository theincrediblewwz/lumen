import assert from 'node:assert/strict';
import test from 'node:test';

import { claimInitialExpansion, clearInitialExpansionIntent, prepareInitialExpansion } from '../ai/initial-expansion-intent';

test('a newly prepared goal is claimed exactly once across remounts and failures', async () => {
  const values = new Map<string, string>();
  const store = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };

  await prepareInitialExpansion('project 1', store);
  assert.equal(await claimInitialExpansion('project 1', store), true);
  assert.equal(await claimInitialExpansion('project 1', store), false);
  assert.match([...values.values()][0] ?? '', /claimed/);

  await clearInitialExpansionIntent('project 1', store);
  assert.equal(await claimInitialExpansion('project 1', store), false);
});

test('a malformed persisted intent is removed instead of dispatching AI', async () => {
  const values = new Map([['learnstuff.initial-expansion.project-2', '{broken']]);
  const store = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };
  assert.equal(await claimInitialExpansion('project-2', store), false);
  assert.equal(values.size, 0);
});
