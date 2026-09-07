import { describe, it, expect } from 'vitest';
import {
  parseChats,
  serializeChats,
  deriveTitle,
  EMPTY_CHATS,
  type StoredMessage,
} from './chatStore';

describe('parseChats', () => {
  it('空串返回空历史', () => {
    expect(parseChats('')).toEqual(EMPTY_CHATS);
    expect(parseChats('   ')).toEqual(EMPTY_CHATS);
  });
  it('非法 JSON 返回空历史', () => {
    expect(parseChats('{不是 json')).toEqual(EMPTY_CHATS);
  });
  it('解析合法历史并补齐字段', () => {
    const raw = JSON.stringify({
      version: 1,
      conversations: [
        { id: 'c1', title: 't', messages: [{ role: 'user', content: '你好' }] },
      ],
    });
    const parsed = parseChats(raw);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0].messages[0].content).toBe('你好');
    expect(parsed.conversations[0].messages[0].at).toBeTruthy();
  });
  it('过滤掉结构损坏的会话', () => {
    const raw = JSON.stringify({ version: 1, conversations: [{ id: 'x' }, null] });
    expect(parseChats(raw).conversations).toHaveLength(0);
  });
});

describe('serializeChats round-trip', () => {
  it('序列化后可再解析回来', () => {
    const chats = {
      version: 1 as const,
      conversations: [
        {
          id: 'c1',
          title: '标题',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          messages: [{ role: 'user' as const, content: 'hi', at: '2026-01-01' }],
        },
      ],
    };
    const round = parseChats(serializeChats(chats));
    expect(round.conversations[0].id).toBe('c1');
    expect(round.conversations[0].messages[0].content).toBe('hi');
  });
});

describe('deriveTitle', () => {
  it('取首条用户消息', () => {
    const msgs: StoredMessage[] = [
      { role: 'user', content: '丝绸之路的研究脉络是什么', at: '' },
    ];
    expect(deriveTitle(msgs)).toBe('丝绸之路的研究脉络是什么');
  });
  it('过长截断加省略号', () => {
    const msgs: StoredMessage[] = [
      { role: 'user', content: '一二三四五六七八九十一二三四五六七八九十一二三四五六', at: '' },
    ];
    expect(deriveTitle(msgs).endsWith('…')).toBe(true);
  });
  it('无用户消息给默认名', () => {
    expect(deriveTitle([])).toBe('新对话');
  });
});
