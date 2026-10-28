import {expect,it} from 'vitest';
import {localDocumentPath} from './documentLink';
import {generatedDocument} from './documentPolicy';
it('resolves portable source links without permitting paths to another board or scheme',()=>{
 expect(localDocumentPath('source_import_123.md')).toBe('docs/source_import_123.md');expect(localDocumentPath('./docs/原文.md#heading')).toBe('docs/原文.md');
 for(const value of ['../other.md','docs/../../secrets.md','https://example.com/a.md','file:///key.md','%2e%2e%2fother.md','docs/%00.md'])expect(localDocumentPath(value)).toBeNull();
});
it('uses explicit math policy for both imported source and AI notes without altering literal identifiers',()=>{
 expect(generatedDocument('p/b/docs/import_import_123_0.md')).toBe(true);expect(generatedDocument('docs/source_import_123.md')).toBe(true);expect(generatedDocument('docs/user_notes.md')).toBe(false);
});
