import type { SQLiteDatabase } from 'expo-sqlite';

import type { SourceCitation } from '@/types/domain';

type SourceCitationRow = {
  id: string;
  target_type: SourceCitation['targetType'];
  target_id: string;
  source_item_id: string;
  source_title: string;
  locator: string;
  quote: string;
  created_at: string;
};

export async function listSourceCitationsForTarget(
  db: SQLiteDatabase,
  targetType: SourceCitation['targetType'],
  targetId: string,
): Promise<SourceCitation[]> {
  const rows = await db.getAllAsync<SourceCitationRow>(
    `SELECT citation.*, item.title AS source_title
     FROM source_citations citation
     JOIN source_items item ON item.id = citation.source_item_id
     WHERE citation.target_type = ? AND citation.target_id = ?
     ORDER BY item.created_at, citation.locator, citation.id`,
    targetType,
    targetId,
  );
  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    sourceItemId: row.source_item_id,
    sourceTitle: row.source_title,
    locator: row.locator,
    quote: row.quote,
    createdAt: row.created_at,
  }));
}

export function appendSourceCitations(markdown: string, citations: SourceCitation[]) {
  if (!citations.length) return markdown;
  const lines = citations.map((citation, index) => {
    const title = escapeMarkdown(citation.sourceTitle);
    const locator = escapeMarkdown(citation.locator);
    const quote = citation.quote.trim()
      ? `\n\n> ${citation.quote.trim().replace(/\n/gu, '\n> ')}`
      : '';
    return `${index + 1}. **${title}** · ${locator}${quote}`;
  });
  return `${markdown.trim()}\n\n---\n\n## 资料定位\n\n${lines.join('\n\n')}`;
}

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_[\]<>#])/gu, '\\$1');
}
