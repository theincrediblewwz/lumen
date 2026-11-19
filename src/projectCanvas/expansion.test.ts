import { describe, expect, it } from 'vitest';
import { peerOffset, radialPositions, revealCards, translate } from './expansion';
import { TILE_HEIGHT, TILE_WIDTH } from './layout';

const origin = { x: 54, y: 66 };

describe('project folder previews', () => {
  it('leaves room between the parent and every child, including in outer rings', () => {
    for (const count of [1, 2, 3, 5, 6, 7, 13, 43, 200]) {
      const cards = [origin, ...radialPositions(origin, count)];
      for (const [i, point] of cards.entries()) {
        expect(cards.slice(i + 1).every(other => Math.abs(point.x - other.x) >= TILE_WIDTH
          || Math.abs(point.y - other.y) >= TILE_HEIGHT)).toBe(true);
      }
    }
  });

  it('clears the preview by translating all other cards by the exact same offset', () => {
    const child = radialPositions(origin, 1)[0];
    const peers = [{ x: child.x + 3, y: child.y }, { x: 535, y: 260 }];
    const offset = peerOffset(peers, [child], origin, () => 0);
    const shifted = peers.map(peer => translate(peer, offset));
    expect(offset).not.toEqual({ x: 0, y: 0 });
    expect(shifted.every(peer => Math.abs(peer.x - child.x) >= TILE_WIDTH + 23.99
      || Math.abs(peer.y - child.y) >= TILE_HEIGHT + 23.99)).toBe(true);
    expect(shifted[1].x - shifted[0].x).toBeCloseTo(peers[1].x - peers[0].x);
    expect(shifted[1].y - shifted[0].y).toBeCloseTo(peers[1].y - peers[0].y);
    expect(peerOffset([peers[1]], [child], origin, () => 0)).toEqual({ x: 0, y: 0 });
  });

  it('reveals the group without resizing the base view', () => {
    const view = { x: 0, y: 0, zoom: 0.9 };
    const point = { x: -100, y: 50 };
    const next = revealCards(view, [origin, point], origin, 820, 640);
    expect(next.zoom).toEqual(view.zoom);
    expect(next.x + point.x * next.zoom).toBeCloseTo(24);
    expect(next.y).toEqual(view.y);
    expect(view).toEqual({ x: 0, y: 0, zoom: 0.9 });
  });
});
