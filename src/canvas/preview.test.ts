import { describe, expect, it } from 'vitest';
import { flowHighlight, flowPanelWidth, materialImageSize, stepPreview } from './preview';
describe('material previews and subboard presentation', () => {
  it('visits all document pages, then the next image/document, and supports returning', () => {
    const counts = [3, 1, 2]; let position = { resource: 0, page: 0 };
    const visited = [];
    for (let i = 0; i < 6; i++) { visited.push(position); position = stepPreview(position, counts); }
    expect(visited).toEqual([{ resource: 0, page: 0 }, { resource: 0, page: 1 }, { resource: 0, page: 2 }, { resource: 1, page: 0 }, { resource: 2, page: 0 }, { resource: 2, page: 1 }]);
    expect(position).toEqual({ resource: 0, page: 0 }); expect(stepPreview(position, counts, -1)).toEqual({ resource: 2, page: 1 });
    expect(stepPreview({ resource: 20, page: 99 }, [1])).toEqual({ resource: 0, page: 0 }); expect(stepPreview(position, [])).toEqual(position);
  });
  it('grows higher-resolution slides while preserving portrait and landscape ratios', () => {
    expect(materialImageSize(400, 200)).toEqual({ w: 400, h: 200 });
    expect(materialImageSize(2400, 1200)).toEqual({ w: 1600, h: 800 });
    expect(materialImageSize(1200, 2400)).toEqual({ w: 800, h: 1600 }); expect(materialImageSize(0, 0)).toEqual({ w: 240, h: 240 });
  });
  it('keeps resized subboards within the available viewport and highlights the original hue', () => {
    expect(flowPanelWidth(900, 1280)).toBe(900); expect(flowPanelWidth(2000, 720)).toBe(688); expect(flowPanelWidth(100, 720)).toBe(280);
    expect(flowHighlight('#e0503a')).toMatch(/^hsl\(\d+ 100% 65%\)$/); expect(flowHighlight('#3a9d5d')).not.toBe(flowHighlight('#3b82c4'));
  });
});
