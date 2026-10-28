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
  it('projects newly attached Android originals without desktop path hints into every header alias',async()=>{
    const snapshot=fixture(),image=[137,80,78,71,13,10,26,10,1],zip=[80,75,3,4,2];
    const imageHash=await sha256(new Uint8Array(image)),zipHash=await sha256(new Uint8Array(zip));
    const imagePath=`docs/asset_${imageHash}.png`,zipPath=`docs/asset_${zipHash}.zip`;
    const metadata={schema:'lumen-document/v1',kind:'markdown_bundle',original:{path:zipPath,sha256:zipHash,size:zip.length,media_type:'application/zip'},images:{'images/a.png':{path:imagePath,sha256:imageHash,size:image.length,media_type:'image/png'}},pages:0,extraction:'ready'};
    snapshot.files['p1/b1/docs/a.md']=[...new TextEncoder().encode('<!-- lumen-document/v1\n'+JSON.stringify(metadata)+'\n-->\n\n![图](images/a.png)')];snapshot.files[`p1/b1/${imagePath}`]=image;snapshot.files[`p1/b1/${zipPath}`]=zip;
    const first=await captureDesktop(snapshot);
    for(const row of Object.values(first.entities).filter(e=>e.kind==='source_items'&&e.data?.asset_blob)){delete row.data!._lumen_path;delete row.data!._lumen_paths;delete(row.data!.asset_blob as Record<string,unknown>).mediaType;}
    const files=projectDesktop(first.entities,first.blobs);expect(files[`p1/b1/${imagePath}`]).toEqual(image);expect(files[`p1/b1/${zipPath}`]).toEqual(zip);
    const recaptured=await captureDesktop({revision:'1',files,ledger:{version:1,state:createSyncState('library','desktop'),...first}});
    expect(Object.values(recaptured.entities).filter(e=>e.kind==='source_items'&&e.data?.asset_blob)).toHaveLength(2);
  });

  it('roundtrips rich Markdown with exact ZIP/images and reuses legacy Android asset identities',async()=>{
    const snapshot=fixture(),encoder=new TextEncoder(),image=[137,80,78,71,13,10,26,10,1,2,3],zip=[80,75,3,4,1,2];
    snapshot.files['p1/b1/docs/old-photo.png']=image;
    const old=await captureDesktop(snapshot),oldSource=Object.values(old.entities).find(e=>e.kind==='source_items'&&e.data?.kind==='image')!;
    const imageHash=await sha256(new Uint8Array(image)),zipHash=await sha256(new Uint8Array(zip));
    const imagePath=`docs/asset_${imageHash}.png`,zipPath=`docs/asset_${zipHash}.zip`;
    const meta={schema:'lumen-document/v1',kind:'markdown_bundle',original:{path:zipPath,sha256:zipHash,size:zip.length,media_type:'application/zip'},images:{'images/image-001.png':{path:imagePath,sha256:imageHash,size:image.length,media_type:'image/png'}},pages:0,extraction:'ready'};
    snapshot.files['p1/b1/docs/a.md']=[...encoder.encode('<!-- lumen-document/v1\n'+JSON.stringify(meta)+'\n-->\n\n# 原始\n\n![图](images/image-001.png)')];snapshot.files[`p1/b1/${imagePath}`]=image;snapshot.files[`p1/b1/${zipPath}`]=zip;
    snapshot.ledger={version:1,state:createSyncState('library','desktop'),...old};const captured=await captureDesktop(snapshot);
    const images=Object.values(captured.entities).filter(e=>e.kind==='source_items'&&e.data?.kind==='image');expect(images).toHaveLength(1);expect(images[0].id).toBe(oldSource.id);
    const files=projectDesktop(captured.entities,captured.blobs);expect(files[`p1/b1/${imagePath}`]).toEqual(image);expect(files['p1/b1/docs/old-photo.png']).toEqual(image);expect(files[`p1/b1/${zipPath}`]).toEqual(zip);expect(files['p1/b1/docs/a.md']).toEqual(snapshot.files['p1/b1/docs/a.md']);
    const again=await captureDesktop({revision:'new',files,ledger:{version:1,state:createSyncState('library','desktop'),...captured}});expect(again.changes).toEqual([]);
    const corrupt={...snapshot,files:{...snapshot.files,[`p1/b1/${imagePath}`]:[1]}};await expect(captureDesktop(corrupt)).rejects.toThrow('校验');
  });
  it('deletes and restores only conversation provenance while keeping captured notes and other history through sync',async()=>{
    const snapshot=fixture();const original=JSON.parse(new TextDecoder().decode(new Uint8Array(snapshot.files['p1/b1/chats.json'])));original.conversations.push({...original.conversations[0],id:'c2',messages:[{id:'other',role:'user',content:'other',at:time}]});snapshot.files['p1/b1/chats.json']=fileBytes(original);
    snapshot.files['p1/b1/chat-captures.json']=fileBytes([{id:'capture',conversation_id:'c1',source_answer_id:null,document_path:'docs/a.md',node_id:'n1',message_ids_json:'["m1","m2"]',selection_key:'chat:c1:m1,m2',created_at:time}]);
    const first=await captureDesktop(snapshot);const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),...first};const deleted={...snapshot,files:{...snapshot.files},ledger};deleted.files['p1/b1/chats.json']=fileBytes({...original,conversations:original.conversations.filter((c:{id:string})=>c.id!=='c1')});deleted.files['p1/b1/chat-captures.json']=fileBytes([]);
    const change=await captureDesktop(deleted);expect(change.changes.filter(c=>!c.entity.data).map(c=>c.entity.kind).sort()).toEqual(['conversation_documents','conversation_messages','conversation_messages','conversations']);const projected=projectDesktop(change.entities,change.blobs);expect(projected['p1/b1/docs/a.md']).toEqual(snapshot.files['p1/b1/docs/a.md']);
    const restored=await captureDesktop({...snapshot,ledger:{version:1,state:createSyncState('library','desktop'),...change}});expect(restored.entities[entityKey({kind:'conversations',id:'c1'})].data).toBeTruthy();expect(restored.entities[entityKey({kind:'conversations',id:'c2'})]).toEqual(first.entities[entityKey({kind:'conversations',id:'c2'})]);projectDesktop(restored.entities,restored.blobs);
  });
  it('never publishes corrupt, empty or unexpectedly missing original chats as deletions',async()=>{
    const first=await captureDesktop(fixture());const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),...first};
    for(const variant of ['broken','empty','missing']){const snapshot=fixture();snapshot.ledger=ledger;if(variant==='missing')delete snapshot.files['p1/b1/chats.json'];else snapshot.files['p1/b1/chats.json']=variant==='empty'?[]:[...new TextEncoder().encode('{broken')];await expect(captureDesktop(snapshot)).rejects.toThrow();}
    const fresh=fixture();delete fresh.files['p1/b1/chats.json'];await expect(captureDesktop(fresh)).resolves.toBeTruthy();
  });
  it('preserves node conversation scope and error-only changes through an idempotent roundtrip',async()=>{
    const snapshot=fixture();const chats=JSON.parse(new TextDecoder().decode(new Uint8Array(snapshot.files['p1/b1/chats.json'])));chats.conversations[0].sourceNodeId='n1';snapshot.files['p1/b1/chats.json']=fileBytes(chats);
    const first=await captureDesktop(snapshot);const ledger:DesktopLedger={version:1,state:createSyncState('library','desktop'),...first};
    const files=projectDesktop(first.entities,first.blobs);const projected=JSON.parse(new TextDecoder().decode(new Uint8Array(files['p1/b1/chats.json'])));expect(projected.conversations[0].sourceNodeId).toBe('n1');expect((await captureDesktop({revision:'1',files,ledger})).changes).toEqual([]);
    chats.conversations[0].messages[1].error=true;snapshot.files['p1/b1/chats.json']=fileBytes(chats);snapshot.ledger=ledger;const changed=await captureDesktop(snapshot);expect(changed.entities[entityKey({kind:'conversation_messages',id:'m2'})].data!.status).toBe('failed');expect(changed.changes.length).toBeGreaterThan(0);
  });
  it('rejects cross-conversation explicit message identity collisions without choosing one answer',async()=>{
    const snapshot=fixture();snapshot.files['p1/b1/chats.json']=fileBytes({version:1,conversations:[{id:'c1',messages:[{id:'duplicate',role:'assistant',content:'first'}]},{id:'c2',messages:[{id:'duplicate',role:'assistant',content:'second'}]}]});await expect(captureDesktop(snapshot)).rejects.toThrow('原始对话');
  });
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
  it('rejects platform aliases and Unicode collisions before projecting or capturing files',async()=>{
    const first=await captureDesktop(fixture());const source={id:'source',kind:'source_items',boardId:'b1',data:{id:'source',derived_document_id:Object.values(first.entities).find(e=>e.kind==='documents')!.id,asset_blob:{sha256:'hash',size:1,mediaType:'image/png'},_lumen_path:'docs/safe.png',_lumen_paths:[] as string[]}};
    for(const path of ['docs/a.md.','docs/a.md ','docs/CON.txt','docs/COM1.png','docs/LPT².png','docs/a|b.png']){source.data._lumen_paths=[path];expect(()=>projectDesktop({...first.entities,[entityKey(source)]:source},{hash:[1]})).toThrow();}
    for(const paths of [['docs/Photo.png','docs/photo.png'],['docs/é.png','docs/e\u0301.png']]){source.data._lumen_paths=paths;expect(()=>projectDesktop({...first.entities,[entityKey(source)]:source},{hash:[1]})).toThrow('冲突');const snapshot=fixture();for(const path of paths)snapshot.files[`p1/b1/${path}`]=[1];await expect(captureDesktop(snapshot)).rejects.toThrow('冲突');}
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
