import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({listen:vi.fn(),invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:mocks.listen}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {streamChat} from './aiClient';
import {DEFAULT_AI_SETTINGS} from './aiSettings';
const settings={...DEFAULT_AI_SETTINGS,apiKey:'synthetic',baseUrl:'https://synthetic.invalid/v1'};
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('settles listener initialization failure once without sending a request',async()=>{
 vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});mocks.listen.mockRejectedValue(new Error('listen failed'));const done=vi.fn();
 const error=await new Promise<string>(resolve=>streamChat(settings,[{role:'user',content:'synthetic'}],{onDelta:()=>{},onDone:done,onError:resolve}));
 expect(error).toContain('listen failed');expect(done).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();
});
it('unsubscribes a late listener after cancellation and never starts the transport',async()=>{
 vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});let ready!:(stop:()=>void)=>void;const stop=vi.fn();mocks.listen.mockImplementation(()=>new Promise(resolve=>{ready=resolve;}));mocks.invoke.mockResolvedValue(undefined);
 let handle!:ReturnType<typeof streamChat>;const done=new Promise<void>((resolve,reject)=>{handle=streamChat(settings,[{role:'user',content:'synthetic'}],{onDelta:()=>{},onDone:resolve,onError:reject});});
 await vi.waitFor(()=>expect(ready).toBeTypeOf('function'));handle.cancel();await done;ready(stop);await vi.waitFor(()=>expect(stop).toHaveBeenCalledOnce());expect(mocks.invoke.mock.calls.some(([command])=>command==='ai_chat_stream')).toBe(false);
});
it('forwards retry status only for the active request and stops waiting on cancel',async()=>{
 vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});
 const listeners=new Map<string,(event:{payload:Record<string,unknown>})=>void>();
 const stops:ReturnType<typeof vi.fn>[]=[];
 mocks.listen.mockImplementation(async(name,listener)=>{listeners.set(name,listener);const stop=vi.fn();stops.push(stop);return stop;});
 mocks.invoke.mockResolvedValue(undefined);
 const retry=vi.fn(),error=vi.fn(),delta=vi.fn();let handle!:ReturnType<typeof streamChat>;
 const done=new Promise<void>(resolve=>{handle=streamChat(settings,[{role:'user',content:'synthetic'}],{onDelta:delta,onDone:resolve,onError:error,onRetry:retry});});
 await vi.waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('ai_chat_stream',expect.anything()));
 const requestId=mocks.invoke.mock.calls.find(([command])=>command==='ai_chat_stream')![1].requestId;
 const notice={attempt:1,maxRetries:3,delayMs:11000,reason:'AI 服务暂时满载'};
 listeners.get('ai://retry')!({payload:{requestId:'another-request',...notice}});
 expect(retry).not.toHaveBeenCalled();
 listeners.get('ai://retry')!({payload:{requestId,...notice}});
 expect(retry).toHaveBeenCalledWith(expect.objectContaining(notice));expect(error).not.toHaveBeenCalled();expect(delta).not.toHaveBeenCalled();
 handle.cancel();await done;
 await vi.waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('ai_cancel',{requestId}));
 listeners.get('ai://retry')!({payload:{requestId,...notice}});
 expect(retry).toHaveBeenCalledOnce();expect(stops).toHaveLength(4);for(const stop of stops)expect(stop).toHaveBeenCalledOnce();
});
