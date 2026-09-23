import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fileBytes,type DesktopSnapshot,type DesktopLedger} from './adapter';
const native=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>native);
vi.mock('./events',()=>({requestEditorFlush:vi.fn(async()=>{}),releaseEditorLock:vi.fn(async()=>{}),notifyLibraryChanged:vi.fn(async()=>{})}));
import {runDesktopSync,getSyncStatus} from './service';

let snapshot:DesktopSnapshot;let offline:boolean;let editOnPut:boolean;let stored:Map<string,number[]>;
beforeEach(()=>{
  vi.stubGlobal('window',new EventTarget());offline=false;editOnPut=false;stored=new Map();
  snapshot={revision:'0',ledger:null,files:{
    'index.json':fileBytes({version:1,projects:[{id:'p',name:'Project',created_at:'2026-09-22'}]}),
    'p/project.json':fileBytes({version:1,boards:[{id:'b'}]}),
    'p/b/board.json':fileBytes({version:1,id:'b',projectId:'p',name:'Board',created_at:'2026-09-22',updated_at:'2026-09-22',viewport:{x:0,y:0,zoom:1},nodes:[],edges:[]}),
  }};
  native.invoke.mockImplementation(async(command:string,args:Record<string,unknown>)=>{
    if(command==='sync_settings_get')return {enabled:true,endpoint:'https://dav.example.invalid/',username:'synthetic',libraryId:'test',deviceId:'desktop'};
    if(command==='sync_snapshot')return structuredClone(snapshot);
    if(command==='sync_apply'){
      if(args.expectedRevision!==snapshot.revision)throw new Error('CAS: local files changed');
      snapshot={revision:String(Number(snapshot.revision)+1),ledger:structuredClone(args.ledger as DesktopLedger),files:{...snapshot.files,...args.files as Record<string,number[]>}};
      return snapshot.revision;
    }
    if(command==='sync_http'){
      if(offline)return {status:503,headers:{},body:[]};
      const url=new URL(String(args.url));const path=url.pathname.slice(1);const method=String(args.method);
      if(method==='MKCOL')return {status:201,headers:{},body:[]};
      if(method==='PUT'){
        stored.set(path,args.body as number[]);
        if(editOnPut){editOnPut=false;snapshot.revision=String(Number(snapshot.revision)+1);}
        return {status:201,headers:{},body:[]};
      }
      if(method==='GET')return {status:stored.has(path)?200:404,headers:{},body:stored.get(path)??[]};
      if(method==='PROPFIND'){
        const entries=new Map<string,boolean>();
        for(const key of stored.keys())if(key.startsWith(path)){
          const rest=key.slice(path.length);const slash=rest.indexOf('/');entries.set(path+(slash<0?rest:rest.slice(0,slash+1)),slash>=0);
        }
        const xml=`<d:multistatus xmlns:d="DAV:">${[...entries].map(([name,directory])=>`<d:response><d:href>/${name}</d:href><d:propstat><d:prop><d:resourcetype>${directory?'<d:collection/>':''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`;
        return {status:207,headers:{},body:[...new TextEncoder().encode(xml)]};
      }
    }
    throw new Error(`unexpected command ${command}`);
  });
});
describe('desktop sync persistence boundaries',()=>{
  it('persists the outbox before a network failure and replays it on reconnect',async()=>{
    offline=true;await expect(runDesktopSync()).rejects.toThrow();
    expect(snapshot.ledger?.state.outbox).toHaveLength(1);expect(stored.size).toBe(0);expect(getSyncStatus().message).toContain('未完成');
    offline=false;await runDesktopSync();
    expect(snapshot.ledger?.state.outbox).toEqual([]);expect(stored.size).toBe(1);expect(getSyncStatus().message).toContain('已同步');
  });
  it('retains a published outbox when local editing invalidates the apply snapshot, then safely retries',async()=>{
    editOnPut=true;await expect(runDesktopSync()).rejects.toThrow('CAS');
    expect(snapshot.ledger?.state.outbox).toHaveLength(1);expect(stored.size).toBe(1);
    await runDesktopSync();expect(snapshot.ledger?.state.outbox).toEqual([]);expect(stored.size).toBe(1);
  });
});
