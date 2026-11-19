import { bentGeometry, edgeGeometry, segmentHitsBox, type Box, type EdgeGeometry, type Pt } from './geometry';

export function edgeLabelLines(label: string): string[] {
  const lines: string[] = [];
  for (const paragraph of label.split('\n')) {
    const chars = Array.from(paragraph);
    if (!chars.length) lines.push('');
    for (let i = 0; i < chars.length; i += 22) lines.push(chars.slice(i, i + 22).join(''));
  }
  return lines;
}

interface RoutingEdge {
  id: string;
  from: string;
  to: string;
  label?: string | null;
  route?: { kind: 'straight' | 'bent'; control?: Pt };
}

type LaidEdge = EdgeGeometry & { labelPoint: Pt };
type LabelLane = { bottom: number; height: number; intervals: [number, number][] };

/** Captions can take a lane above crowded cards while the links keep their own shape. */
export function routeBoardEdges(boxes: Map<string, Box>, edges: RoutingEdge[], scale = 1): Map<string, LaidEdge> {
  const routes = new Map<string, LaidEdge>();
  const bands = new Map<number, LabelLane[]>();
  const straight = new Set(edges.filter(edge => edge.route?.kind !== 'bent').map(edge => `${edge.from}/${edge.to}`));
  const placeCaptions = boxes.size * edges.length <= 200000;
  for (const edge of edges) {
    const a = boxes.get(edge.from), b = boxes.get(edge.to);
    if (!a || !b) continue;
    const opposing = edge.from !== edge.to && straight.has(`${edge.to}/${edge.from}`);
    const normal = edge.route?.kind === 'bent' && edge.route.control
      ? bentGeometry(a, b, edge.route.control, scale)
      : edgeGeometry(a, b, opposing ? 8 * scale : 0);
    routes.set(edge.id, { ...normal, labelPoint: normal.mid });
    if (!placeCaptions || !edge.label || edge.from === edge.to || edge.route?.kind === 'bent') continue;
    if (a.y >= b.y + b.h || b.y >= a.y + a.h) continue;
    const lines = edgeLabelLines(edge.label);
    const captionWidth = (Math.min(360, Math.max(...edge.label.split('\n').map(line => Array.from(line).length)) * 14) + 16) * scale;
    const gap = Math.max(b.x - a.x - a.w, a.x - b.x - b.w);
    const obstructed = [...boxes].some(([id, box]) => id !== edge.from && id !== edge.to
      && segmentHitsBox(normal.start, normal.end, box, 8 * scale));
    if (!obstructed && gap >= captionWidth && !opposing) continue;

    const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2, mid = (x1 + x2) / 2;
    const width = (Math.max(24, ...lines.map(line => Array.from(line).length * 12)) + 16) * scale;
    const height = Math.max(24, lines.length * 16 + 12) * scale;
    const interval: [number, number] = [Math.min(x1, x2, mid - width / 2) - 8 * scale, Math.max(x1, x2, mid + width / 2) + 8 * scale];
    let top = Math.min(a.y, b.y);
    for (const box of boxes.values()) {
      if (box.y < Math.max(a.y + a.h, b.y + b.h) && box.y + box.h > Math.min(a.y, b.y)
        && box.x < interval[1] && box.x + box.w > interval[0]) top = Math.min(top, box.y);
    }
    const key = Math.round(top);
    const lanes = bands.get(key) ?? [];
    let lane = lanes.find(row => row.height >= height && row.intervals.every(([left, right]) => interval[1] < left || interval[0] > right));
    if (!lane) {
      const previous = lanes.at(-1);
      lane = { bottom: previous ? previous.bottom + previous.height : 24 * scale, height, intervals: [] };
      lanes.push(lane);
      bands.set(key, lanes);
    }
    lane.intervals.push(interval);
    routes.set(edge.id, { ...normal, labelPoint: { x: mid, y: top - lane.bottom - height / 2 } });
  }
  return routes;
}
