import { Archive, BookOpen, Bookmark, Folder, FolderClosed, FolderOpen, GitFork, Grid2X2, Network, Orbit, Spline, Workflow, type LucideIcon } from 'lucide-react';
import type { CoverTarget } from '../projectCanvas/covers';
import type { CoverPreset } from '../projectCanvas/coverPresets';
import '../projectCanvas/coverArtwork.css';

const skinMarks: Record<string, [LucideIcon, LucideIcon]> = {
  'celadon-line': [Folder, GitFork],
  'ivory-grid': [Grid2X2, Network],
  'saddle-leather': [FolderOpen, Bookmark],
  'graphite-leather': [Archive, Workflow],
  'sand-linen': [BookOpen, Spline],
  'indigo-gilt': [FolderClosed, Orbit],
};

export function ProjectTileArtwork({ kind, cover }: { kind: CoverTarget['kind']; cover?: CoverPreset }) {
  const folder = kind === 'project';
  const Mark = cover && skinMarks[cover.id]?.[folder ? 0 : 1];
  const artwork = cover?.kind === 'photo'
    ? <img className="project-cover-image" src={cover.url} alt="" draggable={false} loading="lazy" decoding="async" />
    : cover && Mark && <span className="project-cover-skin" data-cover-style={cover.id}>
      <Mark size={23} strokeWidth={1.45} />
    </span>;
  if (folder) {
    return <span className={`project-folder-icon${artwork ? ' has-cover' : ''}`} aria-hidden="true">
      {artwork && <span className="project-folder-surface">{artwork}</span>}
    </span>;
  }
  return <span className="project-board-icon" aria-hidden="true">
    {artwork ?? <GitFork size={43} strokeWidth={1.35} />}
  </span>;
}
