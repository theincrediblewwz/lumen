import { describe, it, expect } from 'vitest';
import {
  chatCompletionsUrl,
  buildChatRequest,
  parseSseChunk,
  collectSseText,
  type ChatRequestConfig,
} from './provider';

const cfg: ChatRequestConfig = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
};

describe('chatCompletionsUrl', () => {
  it('给 /v1 补 chat/completions', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });
  it('容忍结尾斜杠', () => {
    expect(chatCompletionsUrl('https://x.ai/v1/')).toBe('https://x.ai/v1/chat/completions');
  });
  it('无 /v1 时补全 /v1/chat/completions', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });
  it('已含完整路径则原样', () => {
    expect(chatCompletionsUrl('https://h/v1/chat/completions')).toBe(
      'https://h/v1/chat/completions',
    );
  });
});

describe('buildChatRequest', () => {
  it('构造 OpenAI 兼容流式请求', () => {
    const spec = buildChatRequest(cfg, [{ role: 'user', content: '你好' }]);
    expect(spec.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(spec.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(spec.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
    expect('max_tokens' in body).toBe(false);
  });
  it('maxTokens 存在时写入 body', () => {
    const spec = buildChatRequest({ ...cfg, maxTokens: 256 }, [
      { role: 'user', content: 'hi' },
    ]);
    expect(JSON.parse(spec.body).max_tokens).toBe(256);
  });
  it('非 openai kind 抛错', () => {
    expect(() => buildChatRequest({ ...cfg, kind: 'ollama' }, [])).toThrow();
  });
});

describe('parseSseChunk', () => {
  it('解析多个完整事件的增量', () => {
    const buf =
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n';
    const r = parseSseChunk(buf);
    expect(r.deltas).toEqual(['你', '好']);
    expect(r.done).toBe(false);
    expect(r.rest).toBe('');
  });
  it('保留不完整的尾部到 rest', () => {
    const buf =
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' + 'data: {"choices":[{"del';
    const r = parseSseChunk(buf);
    expect(r.deltas).toEqual(['A']);
    expect(r.rest).toBe('data: {"choices":[{"del');
  });
  it('识别 [DONE] 终止', () => {
    const buf = 'data: {"choices":[{"delta":{"content":"末"}}]}\n\ndata: [DONE]\n\n';
    const r = parseSseChunk(buf);
    expect(r.deltas).toEqual(['末']);
    expect(r.done).toBe(true);
  });
  it('忽略空 delta 与心跳注释行', () => {
    const buf =
      ': keep-alive\n\n' +
      'data: {"choices":[{"delta":{}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    const r = parseSseChunk(buf);
    expect(r.deltas).toEqual(['x']);
  });
  it('流式增量拼接（rest 累积）', () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    ];
    let rest = '';
    const out: string[] = [];
    for (const c of chunks) {
      const r = parseSseChunk(rest + c);
      out.push(...r.deltas);
      rest = r.rest;
    }
    expect(out.join('')).toBe('Hello world');
  });
});

describe('collectSseText', () => {
  it('一次性收敛整段 SSE', () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"一"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"二"}}]}\n\n' +
      'data: [DONE]\n\n';
    expect(collectSseText(sse)).toBe('一二');
  });
});
