import { ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { ProjectMeta } from '../api';

export function ProjectPath({ path, board, onNavigate }: {
  path: ProjectMeta[];
  board?: string;
  onNavigate: (id: string | null) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [path, board]);

  return (
    <nav className="project-path" aria-label="项目路径">
      {path.length || board
        ? <button type="button" onClick={() => onNavigate(null)}>项目首页</button>
        : <span aria-current="page">项目首页</span>}
      <div className="project-path-scroll" ref={scroll}>
        {path.map((project, index) => (
          <div className="project-path-segment" key={project.id}>
            <ChevronRight size={14} aria-hidden="true" />
            {index === path.length - 1 && !board
              ? <span aria-current="page" title={project.name}>{project.name}</span>
              : <button type="button" title={project.name} onClick={() => onNavigate(project.id)}>{project.name}</button>}
          </div>
        ))}
        {board && (
          <div className="project-path-segment">
            <ChevronRight size={14} aria-hidden="true" />
            <span aria-current="page" title={board}>{board}</span>
          </div>
        )}
      </div>
    </nav>
  );
}
