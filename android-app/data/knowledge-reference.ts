/** react-native-marked prefixes hyphenated schemes with '/' as if they were relative paths. */
export function parseKnowledgeReference(href: string): { entryId: string; revisionId: string } | null {
  const match = /^\/?learnstuff-knowledge:\/\/([a-zA-Z0-9_-]{1,128})\/([a-zA-Z0-9_-]{1,128})$/u.exec(href);
  return match ? { entryId: match[1], revisionId: match[2] } : null;
}
