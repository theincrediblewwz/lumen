import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/sync/core-provenance.json'), 'utf8'));
const digest = file => {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
};
for (const [name, expected] of Object.entries(manifest.files)) {
  const android = digest(path.join(root, 'android-app/sync/core', name));
  const desktop = digest(path.join(root, 'src/sync/core', name));
  if (android !== expected || desktop !== expected) {
    throw new Error(`Shared sync core differs: ${name}`);
  }
}
console.log(`Shared Android/desktop sync core verified: ${Object.keys(manifest.files).length} files.`);
