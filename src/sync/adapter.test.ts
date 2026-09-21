import { describe,expect,it } from 'vitest';
import { captureDesktop,documentId,fileBytes,projectDesktop,managedKeys,type DesktopSnapshot,type DesktopLedger } from './adapter';
import { createSyncState,entityKey,queueLocalChanges } from './core';
import { sha256 } from './adapter';
import androidFixture from './fixtures/android-recaptured.json';
import type { SyncEntity } from './core';

const time='2026-09-22T00:00:00Z';
function fixture():DesktopSnapshot {
  return {revision:'0',ledger:null,files:{
    'index.json':fileBytes({version:1,projects:[{id:'p1',name:'学习',created_at:time}]}),
    'p1/project.json':fileBytes({version:1,id:'p1',name:'学习',created_at:time,updated_at:time,boards:[{id:'b1',name:'图谱',updated_at:time}]}),
    'p1/b1/board.json':fileBytes({version:1,id:'b1',name:'图谱',projectId:'p1',created_at:time,updated_at:time,viewport:{x:0,y:0,zoom:1},nodes:[{id:'n1',title:'问题',summary:'摘要',x:1,y:2,w:240,color:null,docs:[{path:'docs/a.md',title:'回答'}],created_at:time,updated_at:time}],edges:[]}),
    'p1/b1/docs/a.md':[...new TextEncoder().encode('# 回答\n\n中文 **Markdown**')],
    'p1/b1/chats.json':fileBytes({version:1,conversations:[{id:'c1',title:'对话',createdAt:time,updatedAt:time,messages:[{id:'m1',role:'user',content:'问题',at:time},{id:'m2',role:'assistant',content:'回答',at:time}]}]}),
  }};
}
describe('desktop portable adapter',()=>{
  it('projects actual Android SQLite recapture with its edit and retains every portable field',async()=>{
    const entities=Object.fromEntries((androidFixture.entities as SyncEntity[]).map(e=>[entityKey(e),e]));
    const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),entities,managed:managedKeys(entities),blobs:androidFixture.blobs};
    const next=await captureDesktop({revision:'1',files:projectDesktop(entities,ledger.blobs),ledger});
    expect(Object.values(next.entities).filter(e=>e.kind==='documents').length).toBe(Object.values(entities).filter(e=>e.kind==='documents').length);
    for(const [key,entity] of Object.entries(entities))for(const [field,value] of Object.entries(entity.data??{}))expect(next.entities[key].data?.[field],`${key}.${field}`).toEqual(value);
  });
  it('stable document ids, multi-document links and chat message identity survive restart',async()=>{
    const first=await captureDesktop(fixture());
    const id=await documentId('b1','docs/a.md');
    expect(first.entities[entityKey({kind:'documents',id})].data?.body).toContain('中文');
    expect(first.entities[entityKey({kind:'node_documents',id:`link-n1-${id}`})]).toBeTruthy();
    const state=await queueLocalChanges(createSyncState('library','desktop'),first.changes,sha256);
    const ledger:DesktopLedger={version:1,state,...first};
    const files=projectDesktop(first.entities,first.blobs);
    const next=await captureDesktop({revision:'1',files,ledger});
    expect(next.changes).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(files['p1/b1/chats.json']))).conversations[0].messages[1].id).toBe('m2');
  });
  it('retains unknown Android rows and columns through a desktop edit',async()=>{
    const first=await captureDesktop(fixture());
    first.entities[entityKey({kind:'nodes',id:'n1'})].data!.learning_score=42;
    const unknown={id:'u1',kind:'future_notes',boardId:'b1',data:{id:'u1',future:['数据']}};
    first.entities[entityKey(unknown)]=unknown;
    const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),...first};
    const snapshot=fixture();snapshot.ledger=ledger;
    const next=await captureDesktop(snapshot);
    expect(next.entities[entityKey(unknown)]).toEqual(unknown);
    expect(next.entities[entityKey({kind:'nodes',id:'n1'})].data!.learning_score).toBe(42);
  });
  it('maps Android native document IDs back without creating duplicate documents',async()=>{
    const first=await captureDesktop(fixture());const doc=Object.values(first.entities).find(e=>e.kind==='documents')!;
    const old=doc.id;delete first.entities[entityKey(doc)];doc.id='android_doc';doc.data!.id=doc.id;delete doc.data!._lumen_path;
    first.entities[entityKey(doc)]=doc;
    for(const entity of Object.values(first.entities))if(entity.data?.document_id===old)entity.data.document_id=doc.id;
    const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),entities:first.entities,managed:managedKeys(first.entities),blobs:{}};
    const next=await captureDesktop({revision:'1',files:projectDesktop(first.entities,{}),ledger});
    expect(Object.values(next.entities).filter(e=>e.kind==='documents'&&e.data)).toHaveLength(1);
    expect(next.entities[entityKey(doc)].data!.body).toContain('中文');
  });
  it('exports original attachment bytes with a derived Markdown document and valid source fields',async()=>{
    const snapshot=fixture();snapshot.files['p1/b1/docs/photo.png']=[0,1,2,255];
    const next=await captureDesktop(snapshot);const source=Object.values(next.entities).find(e=>e.kind==='source_items')!;
    expect(source.data).toMatchObject({kind:'image',byte_size:4,extraction_status:'ready'});
    expect(source.data).not.toHaveProperty('asset_uri');
    expect(next.entities[entityKey({kind:'documents',id:String(source.data!.derived_document_id)})]).toBeTruthy();
    const files=projectDesktop(next.entities,next.blobs);expect(files['p1/b1/docs/photo.png']).toEqual([0,1,2,255]);
    await expect(queueLocalChanges(createSyncState('library','desktop'),next.changes,sha256)).resolves.toBeTruthy();
  });
  it('turns deleted board entities into tombstones while retaining foreign extensions',async()=>{
    const first=await captureDesktop(fixture());
    const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),...first};
    const next=await captureDesktop({revision:'1',files:{'index.json':fileBytes({version:1,projects:[]})},ledger});
    expect(next.changes.length).toBe(first.managed.length);
    expect(next.changes.every(c=>c.entity.data===null)).toBe(true);
  });
  it('rejects unsafe incoming document paths without producing any writable manifest',async()=>{
    const first=await captureDesktop(fixture());const doc=Object.values(first.entities).find(e=>e.kind==='documents')!;doc.data!._lumen_path='docs/../../outside.md';
    expect(()=>projectDesktop(first.entities,{})).toThrow('不安全');
  });
  it('protects surviving children from a remote parent deletion',async()=>{
    const first=await captureDesktop(fixture());const key=entityKey({kind:'projects',id:'b1'});first.entities[key]={...first.entities[key],data:null};
    expect(()=>projectDesktop(first.entities,{})).toThrow('删除白板');
  });
  it('does not resurrect retired remote documents left on disk for recovery',async()=>{
    const snapshot=fixture();const first=await captureDesktop(snapshot);
    const document=Object.values(first.entities).find(e=>e.kind==='documents')!;
    const entities={...first.entities};entities[entityKey(document)]={...document,data:null};
    for(const e of Object.values(entities))if(e.kind==='nodes'||e.kind==='node_documents')entities[entityKey(e)]={...e,data:null};
    const files={...snapshot.files,...projectDesktop(entities,{})};
    const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),entities,managed:managedKeys(entities),blobs:{},retiredPaths:['p1/b1/docs/a.md']};
    const next=await captureDesktop({revision:'1',files,ledger});
    expect(next.entities[entityKey(document)].data).toBeNull();expect(next.changes).toEqual([]);
  });
  it('round-trips reading progress and preserves Android pending chat status',async()=>{
    const first=await captureDesktop(fixture());const doc=Object.values(first.entities).find(e=>e.kind==='documents')!;
    const position={id:'pos1',kind:'reading_positions',boardId:'b1',data:{id:'pos1',document_id:doc.id,ratio:0.63,anchor:'heading',updated_at:time}};
    first.entities[entityKey(position)]=position;first.entities[entityKey({kind:'conversation_messages',id:'m2'})].data!.status='pending';
    const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),entities:first.entities,managed:managedKeys(first.entities),blobs:{}};
    const next=await captureDesktop({revision:'1',files:projectDesktop(first.entities,{}),ledger});
    expect(next.changes).toEqual([]);expect(next.entities[entityKey(position)]).toEqual(position);
  });
});
