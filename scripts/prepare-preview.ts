/** Prepare only generated synthetic data beside an isolated-preview executable. */
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import fixture from '../src/sync/fixtures/android-recaptured.json';
import {projectDesktop} from '../src/sync/adapter';
import {entityKey,type SyncEntity} from '../src/sync/core';
import {emptyKnowledgeLibrary,saveKnowledgeInLibrary} from '../src/knowledge/core';
const directory=process.argv[2];if(!directory)throw new Error('Preview output directory required');
const target=resolve(directory);const library=resolve(target,'.preview/library');const config=resolve(target,'.preview/config/config.json');
if(existsSync(config))throw new Error('Preview already initialized; refusing to replace its data');
const entities=Object.fromEntries((fixture.entities as SyncEntity[]).map(e=>[entityKey(e),e]));
for(const [name,bytes] of Object.entries(projectDesktop(entities,fixture.blobs))){const path=resolve(library,name);if(!path.startsWith(library+ '\\')&&!path.startsWith(library+'/'))throw new Error('Unsafe fixture path');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,new Uint8Array(bytes));}
const material=saveKnowledgeInLibrary(emptyKnowledgeLibrary(),{kind:'material',title:'注意力的材料（合成示例）',body:'注意力根据相关性组合信息。',source:'本地验收合成材料'});
const own=saveKnowledgeInLibrary(material.library,{kind:'understanding',title:'我怎样理解注意力（合成示例）',body:'# 我的理解\n\n我把注意力看作根据问题选择记忆的过程。\n\n$$\\frac{QK^{T}}{\\sqrt{d_k}}$$',basisIds:[material.entry.id]});
mkdirSync(resolve(library,'knowledge'),{recursive:true});writeFileSync(resolve(library,'knowledge/library.json'),JSON.stringify(own.library,null,2)+'\n');
mkdirSync(dirname(config),{recursive:true});writeFileSync(config,JSON.stringify({storage_root:'.preview/library'},null,2)+'\n');
