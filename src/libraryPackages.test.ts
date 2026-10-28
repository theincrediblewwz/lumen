import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn(),save:vi.fn(),flush:vi.fn(),release:vi.fn(),listen:vi.fn(),off:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:mocks.open,save:mocks.save}));
vi.mock('@tauri-apps/api/event',()=>({listen:mocks.listen}));
vi.mock('./ai/boardOperations',()=>({loadWritePolicy:async()=>({scope:'library-scope'})}));
vi.mock('./sync/events',()=>({requestEditorFlush:mocks.flush,releaseEditorLock:mocks.release}));
import { exportLibraryPackage,restoreLibraryPackage,applyLibraryPreferences } from './libraryPackages';
import { loadSettings } from './settings';
const values=new Map<string,string>();
beforeEach(()=>{vi.resetAllMocks();values.clear();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});mocks.flush.mockResolvedValue(undefined);mocks.release.mockResolvedValue(undefined);mocks.listen.mockResolvedValue(mocks.off);mocks.save.mockResolvedValue('E:/synthetic/library.zip');mocks.invoke.mockResolvedValue({projects:2,boards:3,files:20});});
afterEach(()=>vi.unstubAllGlobals());
describe('library content portability boundary',()=>{
 it('exports only allowlisted preferences and project-scoped reading data; never reads or exports AI keys/connections',async()=>{
  values.set('lumen.ai.v1',JSON.stringify({apiKey:'synthetic secret not portable',baseUrl:'https://synthetic.invalid'}));values.set('lumen.settings.v2',JSON.stringify({theme:'paper',apiKey:'extra field excluded'}));
  values.set('lumen.reader.progress.v1',JSON.stringify({'p/b/docs/one.md':0.5,'other/b/docs/two.md':0.8}));
  await exportLibraryPackage({id:'p',name:'Project'},()=>{});
  expect(mocks.invoke).toHaveBeenCalledOnce();const args=mocks.invoke.mock.calls[0][1];expect(args.expectedScope).toBe('library-scope');expect(args.projectId).toBe('p');expect(args.preferences.progress).toEqual({'p/b/docs/one.md':0.5});expect(args.preferences.ui.theme).toBe('paper');
  expect(JSON.stringify(args)).not.toMatch(/apiKey|baseUrl|synthetic secret|extra field/);expect(mocks.flush).toHaveBeenCalledOnce();expect(mocks.release).toHaveBeenCalledOnce();expect(mocks.off).toHaveBeenCalledOnce();
 });
 it('cancelled picking does no work; a failed write unlocks the editor and preserves the error',async()=>{
  mocks.save.mockResolvedValueOnce(null);await exportLibraryPackage(undefined,()=>{});expect(mocks.flush).not.toHaveBeenCalled();
  mocks.invoke.mockRejectedValueOnce(Error('Disk full'));await expect(exportLibraryPackage(undefined,()=>{})).rejects.toThrow('Disk full');expect(mocks.release).toHaveBeenCalledOnce();expect(mocks.off).toHaveBeenCalledOnce();
 });
 it('restores into a selected new location without changing config or credentials, and applies only safe reader/appearance preferences on request',async()=>{
  mocks.open.mockResolvedValueOnce('E:/synthetic/backup.zip').mockResolvedValueOnce('E:/synthetic/restores');await restoreLibraryPackage();
  expect(mocks.invoke).toHaveBeenCalledWith('library_package_restore',{srcPath:'E:/synthetic/backup.zip',parentPath:'E:/synthetic/restores',expectedScope:'library-scope'});
  values.set('lumen.ai.v1','unchanged synthetic connection');applyLibraryPreferences({ui:{theme:'paper',glassClarity:500},reader:{mode:'double',fontScale:999},progress:{'p/b/docs/one.md':0.6,'bad':Infinity}});
  expect(values.get('lumen.ai.v1')).toBe('unchanged synthetic connection');expect(loadSettings().glassClarity).toBe(100);expect(JSON.parse(values.get('lumen.reader.prefs.v3')!).fontScale).toBe(150);expect(JSON.parse(values.get('lumen.reader.progress.v1')!)).toEqual({'p/b/docs/one.md':0.6});
 });
 it('reports a full local preference store without throwing after the library has been restored',()=>{
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw Error('quota');}});
  expect(applyLibraryPreferences({reader:{mode:'single',fontScale:100},progress:{'p/b/docs/one.md':0.5}})).toEqual(['阅读显示偏好','阅读进度偏好']);
 });
});
