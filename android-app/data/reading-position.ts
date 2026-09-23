import type { SQLiteDatabase } from 'expo-sqlite';
import { lexer } from 'marked';
import { decodeMarkdownMathPayload, prepareMarkdownMathForRenderer } from '../ai/markdown-math';

export type ReadingBlock={anchor:string;index:number;heading?:string;depth:number};
/** Mirrors the stock marked renderer's top-level blocks; fenced headings stay code. */
export function readingBlocks(markdown:string):ReadingBlock[] {
  const seen=new Map<string,number>();
  return lexer(prepareMarkdownMathForRenderer(markdown||'_这份文档还没有正文。_'),{gfm:true}).filter(t=>t.type!=='space').map((token,index)=>{
    let hash=2166136261;for(let i=0;i<token.raw.length;i++){hash=Math.imul(hash^token.raw.charCodeAt(i),16777619);}
    const key=(hash>>>0).toString(36);const occurrence=(seen.get(key)??0)+1;seen.set(key,occurrence);
    const heading=token.type==='heading'?token.text.replace(/`\u0000learnstuff-math:(inline|display):([^`]+)`/gu,(_match:string,kind:string,payload:string)=>`${kind==='display'?'$$':'$'}${decodeMarkdownMathPayload(payload)}${kind==='display'?'$$':'$'}`):undefined;
    return {anchor:`block:${key}:${occurrence}`,index,heading,depth:token.type==='heading'?token.depth:0};
  });
}
export function restoreReadingIndex(blocks:ReadingBlock[],position:{anchor:string;ratio:number}|null) {
  if(!position||!blocks.length)return 0;
  const found=blocks.findIndex(block=>block.anchor===position.anchor);
  return found>=0?found:Math.round(Math.min(1,Math.max(0,Number.isFinite(position.ratio)?position.ratio:0))*(blocks.length-1));
}

export type ReadingCellFrame = { y: number; height: number };
export type ReadingRestorePlan = { index: number; deadline: number; nextAttemptAt: number; attempts: number };
export const READING_RESTORE_INTERVAL_MS = 180;
export const READING_RESTORE_WINDOW_MS = 6500;
export const READING_RESTORE_MAX_ATTEMPTS = 32;
export function beginReadingRestore(index: number, now: number): ReadingRestorePlan {
  return { index, deadline: now + READING_RESTORE_WINDOW_MS, nextAttemptAt: now, attempts: 0 };
}
/** Measured native cell offsets win over FlatList's average-height estimates. Keep watching
 * for late formula/image layout changes, but never beyond the deadline or after cancellation. */
export function advanceReadingRestore(plan: ReadingRestorePlan | null, now: number, frame: ReadingCellFrame | undefined, scrollOffset: number) {
  if (!plan || now >= plan.deadline || plan.attempts >= READING_RESTORE_MAX_ATTEMPTS) return { plan: null, command: null } as const;
  if (now < plan.nextAttemptAt) return { plan, command: null } as const;
  const measured = frame && Number.isFinite(frame.y) && Number.isFinite(frame.height) && frame.height > 0;
  const offset = measured ? Math.max(0, frame.y) : null;
  const command = offset === null ? { type: 'index' as const, index: plan.index }
    : Math.abs(offset - scrollOffset) > 1 ? { type: 'offset' as const, offset } : null;
  return { plan: { ...plan, attempts: plan.attempts + (command ? 1 : 0), nextAttemptAt: now + READING_RESTORE_INTERVAL_MS }, command };
}
/** Ignore the last few pixels of a preceding block at the top of the viewport. */
export function firstReadingIndex(indices: number[], frames: ReadonlyMap<number, ReadingCellFrame>, offset: number): number | null {
  const sorted = [...indices].filter(index => Number.isSafeInteger(index) && index >= 0).sort((a, b) => a - b);
  return sorted.find(index => { const frame = frames.get(index); return !frame || frame.y + frame.height > offset + 8; }) ?? sorted[sorted.length - 1] ?? null;
}
export async function saveReadingPosition(db:SQLiteDatabase,documentId:string,anchor:string,ratio:number) {
  if(!Number.isFinite(ratio))return;
  await db.runAsync('INSERT INTO reading_positions(id,document_id,anchor,ratio,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET anchor=excluded.anchor,ratio=excluded.ratio,updated_at=excluded.updated_at',documentId,documentId,anchor,Math.max(0,Math.min(1,ratio)),new Date().toISOString());
}
