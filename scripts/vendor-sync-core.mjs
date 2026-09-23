import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/vendor-sync-core.mjs /path/to/android-app/sync/core');
const target = path.resolve('src/sync/core');
fs.mkdirSync(target, { recursive:true });
const hashes = {};
for (const name of fs.readdirSync(source).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts')).sort()) {
  // Store canonical LF bytes so the provenance is stable across Windows and CI.
  const bytes = Buffer.from(fs.readFileSync(path.join(source,name), 'utf8').replace(/\r\n/g, '\n'));
  fs.writeFileSync(path.join(target,name),bytes);
  hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync('src/sync/core-provenance.json', JSON.stringify({ source:'LearnStuffQuickly/android-app/sync/core', files:hashes },null,2)+'\n');
