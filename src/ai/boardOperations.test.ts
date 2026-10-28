import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardFile } from '../api';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),load:vi.fn(),flush:vi.fn(),release:vi.fn(),notify:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('../api',()=>({api:{boardLoad:mocks.load}}));
vi.mock('../sync/events',()=>({requestEditorFlush:mocks.flush,releaseEditorLock:mocks.release,notifyLibraryChanged:mocks.notify}));
import { sameBoardContent,commitBoardOperations,loadFlushedBoard,type OperationBatch } from './boardOperations';
const baseline:BoardFile={version:1,id:'b',projectId:'p',name:'Board',created_at:'2026',updated_at:'2026',viewport:{x:0,y:0,zoom:1},nodes:[{id:'n',title:'User understanding',summary:'original',x:0,y:0,w:240,docs:[{path:'docs/a.md',title:'Original'}],created_at:'2026',updated_at:'2026'}],edges:[],_disk_revision:'r0'};
const batch:OperationBatch={schema:'lumen.board-operations/v1',operations:[{type:'create_node',reference:'first',title:'A'}]};
const permission={policy:{enabled:true,revision:2,keep:20},scope:'local'};
beforeEach(()=>{vi.resetAllMocks();mocks.release.mockResolvedValue(undefined);mocks.flush.mockResolvedValue(undefined);mocks.notify.mockResolvedValue(undefined);});
describe('AI operation baselines',()=>{
 it('reads pending content only after the main editor has flushed it',async()=>{
   const flushed=structuredClone(baseline);flushed.nodes[0].title='Saved pending edit';
   mocks.load.mockResolvedValue(baseline);
   mocks.flush.mockImplementation(async()=>{mocks.load.mockResolvedValue(flushed);});
   expect((await loadFlushedBoard('p','b')).nodes[0].title).toBe('Saved pending edit');
   expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('flushes before the initial context read and releases on read failure',async()=>{
   mocks.flush.mockImplementation(async()=>{mocks.load.mockRejectedValue(new Error('disk unavailable'));});
   await expect(loadFlushedBoard('p','b')).rejects.toThrow('disk unavailable');
   expect(mocks.flush).toHaveBeenCalledOnce();expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('rebases pending viewport/timestamp/transport saves and passes the fresh raw revision',async()=>{
   const latest={...structuredClone(baseline),viewport:{x:40,y:20,zoom:1.4},updated_at:'later',_disk_revision:'r1'};
   mocks.flush.mockImplementation(async()=>{mocks.load.mockResolvedValue(latest);});
   mocks.invoke.mockResolvedValue({board:latest,summary:'saved'});
   await commitBoardOperations('p','b',batch,'op1',permission,baseline);
   expect(mocks.invoke).toHaveBeenCalledWith('board_operations_apply',expect.objectContaining({expectedRevision:'r1',expectedScope:'local',grantRevision:2}));
   expect(mocks.release).toHaveBeenCalledOnce();
 });
 it.each(['title','relations','documents','position','unknown','permissions'])('rejects concurrent business changes: %s',async kind=>{
   const latest=structuredClone(baseline) as BoardFile&Record<string,unknown>;
   if(kind==='title')latest.nodes[0].title='User edit';
   if(kind==='relations')latest.edges.push({id:'e',from:'n',to:'x',directed:true,created_at:'2026'});
   if(kind==='documents')latest.nodes[0].docs.push({path:'docs/b.md',title:'New'});
   if(kind==='position')latest.nodes[0].x=30;
   if(kind==='unknown')latest.future_user_data={a:1};
   if(kind==='permissions')latest._sync_content_policy={mode:'summary',allowOutsideKnowledge:false};
   mocks.load.mockResolvedValue(latest);
   await expect(commitBoardOperations('p','b',batch,'op1',permission,baseline)).rejects.toThrow('白板内容已被修改');
   expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('does not swallow a native race after the fresh read',async()=>{
   mocks.load.mockResolvedValue({...baseline,_disk_revision:'fresh'});
   mocks.invoke.mockRejectedValue(new Error('白板已被修改'));
   await expect(commitBoardOperations('p','b',batch,'op1',permission,baseline)).rejects.toThrow('白板已被修改');
   expect(mocks.notify).not.toHaveBeenCalled();expect(mocks.release).toHaveBeenCalledOnce();
 });
 it('compares object keys canonically while retaining all unknown business data',()=>{
   const a={...baseline,future:{z:2,a:1}};const b={future:{a:1,z:2},...baseline};
   expect(sameBoardContent(a,b)).toBe(true);
   const changed={...b,future:{a:2,z:2}};
   expect(sameBoardContent(a,changed)).toBe(false);
 });
});
