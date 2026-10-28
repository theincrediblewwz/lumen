import { describe, it, expect } from 'vitest';
import { emptyKnowledgeLibrary, saveKnowledgeInLibrary, resolveKnowledgeReferences, copyKnowledgeLibrary, knowledgeReferenceLinks, validateKnowledgeLibrary } from './core';
import { captureDesktop, projectDesktop, fileBytes } from '../sync/adapter';
import { createSyncState, entityKey } from '../sync/core';
import { renderMarkdown } from '../reader/engine';

describe('independent knowledge', () => {
  it('includes only matching node bindings and keeps disabled permission authoritative', () => {
    const { library, entry } = saveKnowledgeInLibrary(emptyKnowledgeLibrary(), { kind: 'understanding', title: '节点理解', body: '我的观点' });
    library.bindings.push({ id: 'binding', project_id: 'board', node_id: 'node', entry_id: entry.id, created_at: entry.created_at });
    library.settings.push({ id: 'board', project_id: 'board', policy: 'priority', updated_at: entry.updated_at });
    expect(() => resolveKnowledgeReferences(library, 'board', '')).toThrow('没有可用');
    expect(resolveKnowledgeReferences(library, 'board', '', { nodeId: 'node' }).map(ref => ref.entryId)).toEqual([entry.id]);
    expect(resolveKnowledgeReferences(library, 'board', '', { nodeId: 'node', sourceBound: true })).toEqual([]);
    library.settings[0].policy = 'disabled';
    expect(resolveKnowledgeReferences(library, 'board', '', { nodeId: 'node' })).toEqual([]);
  });
  it('handles a valid 12000-level evidence chain without recursion and still enforces citation budget', () => {
    const { library, entry } = saveKnowledgeInLibrary(emptyKnowledgeLibrary(), { kind: 'material', title: '材料', body: '依据' });
    const template = library.revisions[0];
    library.entries = Array.from({ length: 12000 }, (_, i) => ({ ...entry, id: `k_${i}`, revision_id: `r_${i}`, basis_json: i < 11999 ? JSON.stringify([`k_${i + 1}`]) : '[]' }));
    library.revisions = library.entries.map(row => ({ ...template, id: row.revision_id, entry_id: row.id, basis_json: row.basis_json }));
    library.bindings = [{ id: 'binding', project_id: 'board', node_id: null, entry_id: 'k_0', created_at: entry.created_at }];
    library.settings = [{ id: 'board', project_id: 'board', policy: 'allowed', updated_at: entry.updated_at }];
    const valid = validateKnowledgeLibrary(library);
    expect(resolveKnowledgeReferences(valid, 'board', '').length).toBe(6);
    valid.settings[0].policy = 'priority';
    expect(() => resolveKnowledgeReferences(valid, 'board', '')).toThrow('必要知识引用超出');
  });
  it('preserves authored meaning and resolves cited immutable versions with material evidence', () => {
    const material = saveKnowledgeInLibrary(emptyKnowledgeLibrary(), { kind: 'material', title: '文献', body: '材料原文' });
    const own = saveKnowledgeInLibrary(material.library, { kind: 'understanding', title: '我的注意力理解', body: '我的观点', basisIds: [material.entry.id] });
    const library = { ...own.library, bindings: [{ id: 'binding', project_id: 'board', node_id: null, entry_id: own.entry.id, created_at: own.entry.created_at }], settings: [{ id: 'board', project_id: 'board', policy: 'priority' as const, updated_at: own.entry.updated_at }] };
    const refs = resolveKnowledgeReferences(library, 'board', '注意力');
    expect(refs.map(ref => ref.entryId)).toEqual([own.entry.id, material.entry.id]);
    const html = renderMarkdown(knowledgeReferenceLinks(refs)).html;
    expect(html).toContain(`href="learnstuff-knowledge://${own.entry.id}/${own.entry.revision_id}"`);
    const next = saveKnowledgeInLibrary(library, { id: own.entry.id, expectedRevision: own.entry.revision_id, kind: own.entry.kind, title: own.entry.title, body: '新的观点', basisIds: [material.entry.id] });
    expect(next.library.revisions.find(row => row.id === own.entry.revision_id)?.body).toBe('我的观点');
    const copy = copyKnowledgeLibrary(next.library);
    expect(copy.library.entries.find(row => row.id === copy.entryIds.get(own.entry.id))?.basis_json).toBe(JSON.stringify([copy.entryIds.get(material.entry.id)]));
  });
  it('projects and recaptures global knowledge without duplicating or rewriting historical revisions', async () => {
    const {library} = saveKnowledgeInLibrary(emptyKnowledgeLibrary(), {kind:'experience',title:'经验',body:'先形成自己的理解'});
    const captured = await captureDesktop({revision:'test',ledger:null,files:{'index.json':fileBytes({projects:[]}),'knowledge/library.json':fileBytes(library)}});
    const projected = projectDesktop(captured.entities, {});
    const ledger = {version:1 as const,state:createSyncState('test','desktop'),entities:captured.entities,managed:captured.managed,blobs:{}};
    expect((await captureDesktop({revision:'test2',ledger,files:projected})).changes).toEqual([]);
    const corrupted = {...library,revisions:library.revisions.map(row=>({...row,body:'overwritten'})),entries:library.entries.map(row=>({...row,body:'overwritten'}))};
    await expect(captureDesktop({revision:'test',ledger,files:{...projected,'knowledge/library.json':fileBytes(corrupted)}})).rejects.toThrow('不能覆盖');
    expect(captured.entities[entityKey({kind:'knowledge_entries',id:library.entries[0].id})].boardId).toBeNull();
  });
});
