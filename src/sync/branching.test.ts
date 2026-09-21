import {describe,it,expect} from 'vitest';
import {createSyncState,entityKey,getConflicts,queueLocalChanges,type SyncEntity} from './core';
import {localBranches,sha256,stateProjection} from './adapter';
const entity=(body:string):SyncEntity=>({id:'doc',kind:'documents',boardId:'board',data:{id:'doc',body}});
describe('desktop conflict branches',()=>{
  it('ordinary editing follows the displayed branch and does not silently resolve the other version',async()=>{
    const first=entity('desktop');const second=entity('tablet');const key=entityKey(first);
    let state=await queueLocalChanges(createSyncState('library','desktop'),[{entity:first}],sha256);
    state=await queueLocalChanges(state,[{entity:second,parents:[]}],sha256);
    expect(getConflicts(state)[0].versions).toHaveLength(2);
    const edited=entity('desktop edited');
    state=await queueLocalChanges(state,localBranches(state,{[key]:first},[{entity:edited}]),sha256);
    expect(getConflicts(state)[0].versions.map(v=>v.entity.data!.body).sort()).toEqual(['desktop edited','tablet']);
    expect(stateProjection(state,{[key]:edited})[key]).toEqual(edited);
    state=await queueLocalChanges(state,[{entity:edited}],sha256);
    expect(getConflicts(state)).toEqual([]);
  });
  it('editing a retained projection after an unapplied deletion creates a conflict rather than acknowledging deletion',async()=>{
    const previous=entity('original');const key=entityKey(previous);
    let state=await queueLocalChanges(createSyncState('library','desktop'),[{entity:previous}],sha256);
    state=await queueLocalChanges(state,[{entity:{...previous,data:null}}],sha256);
    const changes=localBranches(state,{[key]:previous},[{entity:entity('new edit')}]);
    expect(changes[0].parents).toEqual([]);
    state=await queueLocalChanges(state,changes,sha256);
    expect(getConflicts(state)[0].versions).toHaveLength(2);
  });
});
