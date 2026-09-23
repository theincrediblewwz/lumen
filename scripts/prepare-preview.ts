/** Prepare only generated synthetic data beside an isolated-preview executable. */
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import fixture from '../src/sync/fixtures/android-recaptured.json';
import {projectDesktop} from '../src/sync/adapter';
import {entityKey,type SyncEntity} from '../src/sync/core';
const directory=process.argv[2];if(!directory)throw new Error('Preview output directory required');
const target=resolve(directory);const library=resolve(target,'.preview/library');const config=resolve(target,'.preview/config/config.json');
if(existsSync(config))throw new Error('Preview already initialized; refusing to replace its data');
const entities=Object.fromEntries((fixture.entities as SyncEntity[]).map(e=>[entityKey(e),e]));
for(const [name,bytes] of Object.entries(projectDesktop(entities,fixture.blobs))){const path=resolve(library,name);if(!path.startsWith(library+ '\\')&&!path.startsWith(library+'/'))throw new Error('Unsafe fixture path');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,new Uint8Array(bytes));}
mkdirSync(dirname(config),{recursive:true});writeFileSync(config,JSON.stringify({storage_root:'.preview/library'},null,2)+'\n');
