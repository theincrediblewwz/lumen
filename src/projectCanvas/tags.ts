export type TagDefinition = { name: string; color: string };
export type CatalogTag = TagDefinition & { id: string };
export type TagStore = {
  definitions?: Record<string, TagDefinition>;
  assignments?: Record<string, string[]>;
};

export type TagTarget =
  | { kind: 'project'; id: string }
  | { kind: 'board'; projectId: string; id: string }
  | { kind: 'node'; projectId: string; boardId: string; id: string };

export const NO_TAGS: string[] = [];

export const SYSTEM_TAGS: CatalogTag[] = [
  { id: 'color_red', name: '红色', color: '#e0503a' },
  { id: 'color_orange', name: '橙色', color: '#e08a2b' },
  { id: 'color_yellow', name: '黄色', color: '#d4b106' },
  { id: 'color_green', name: '绿色', color: '#3a9d5d' },
  { id: 'color_blue', name: '蓝色', color: '#3b82c4' },
  { id: 'color_purple', name: '紫色', color: '#8b5cf6' },
];

const colorIds = new Map(SYSTEM_TAGS.map(({ color, id }) => [color, id]));

export function colorTag(color?: string | null) {
  return color ? colorIds.get(color.toLowerCase()) : undefined;
}

export function tagKey(target: TagTarget) {
  switch (target.kind) {
    case 'project': return target.id;
    case 'board': return `${target.projectId}/${target.id}`;
    case 'node': return `${target.projectId}/${target.boardId}/${target.id}`;
  }
}

export function assignedTags(store: TagStore | undefined, target: TagTarget): string[] {
  const key = tagKey(target);
  const assignments = store?.assignments;
  return assignments && Object.prototype.hasOwnProperty.call(assignments, key) ? assignments[key] : NO_TAGS;
}

export function allTags(store?: TagStore): CatalogTag[] {
  return [...SYSTEM_TAGS, ...Object.entries(store?.definitions ?? {}).map(([id, tag]) => ({ id, ...tag }))];
}
