import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
import {claimGeneration} from './generationLease';
import {prefixFingerprint} from './chatMemory';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('binds native claim, validation and release to the same immutable scope and token including empty stored messages',async()=>{
 vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});mocks.invoke.mockResolvedValue(undefined);
 const messages=[{id:'m',role:'assistant' as const,content:'',at:'old'}];const lease=await claimGeneration('p','b','c',messages,'original-root');
 expect(mocks.invoke.mock.calls[0][1].baseline).toBe(await prefixFingerprint(messages,{index:1,offset:0}));await lease.validate();await lease.release();
 expect(mocks.invoke.mock.calls.map(([cmd])=>cmd)).toEqual(['chat_generation_claim','chat_generation_validate','chat_generation_release']);
 for(const [,args] of mocks.invoke.mock.calls){expect(args.expectedScope).toBe('original-root');expect(args.token).toBe(lease.token);}
});
it('rejects native claim before returning a usable generation controller',async()=>{
 vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});mocks.invoke.mockRejectedValue(Error('busy or stale'));await expect(claimGeneration('p','b','c',[],'root')).rejects.toThrow('busy or stale');expect(mocks.invoke).toHaveBeenCalledOnce();
});
