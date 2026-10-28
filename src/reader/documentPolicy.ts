/** Generated/imported Markdown uses explicit math delimiters. This does not assign authorship. */
export function generatedDocument(path:string):boolean{return /(?:^|\/)docs\/(?:chat_[a-f0-9]{64}|note_ai_[a-zA-Z0-9_-]+|(?:import_import_|source_import_)[a-zA-Z0-9_-]+)\.md$/i.test(path);}
