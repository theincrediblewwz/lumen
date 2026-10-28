import { describe, it, expect } from 'vitest';
import {
  chatCompletionsUrl,
  buildChatRequest,
  parseSseChunk,
  parseSseChunkRich,
  accumulateToolCalls,
  collectSseText,
  type ChatRequestConfig,
} from './provider';

it('parses all SSE line endings and every split including a split CRLF',()=>{
 for(const ending of ['\n','\r\n','\r']){
  const stream=`data: {"choices":[{"delta":{"content":"中文"}}]}${ending}${ending}data: [DONE]${ending}${ending}`;
  for(let split=0;split<=stream.length;split++){
   let rest='',text='',done=false;
   for(const part of [stream.slice(0,split),stream.slice(split),'\n\n']){const parsed=parseSseChunk(rest+part);text+=parsed.deltas.join('');done ||= parsed.done;rest=parsed.rest;}
   expect(text).toBe('中文');expect(done).toBe(true);
   let richRest='',richText='',richDone=false;
   for(const part of [stream.slice(0,split),stream.slice(split),'\n\n']){const parsed=parseSseChunkRich(richRest+part);richText+=parsed.contentDeltas.join('');richDone ||= parsed.done;richRest=parsed.rest;}
   expect(richText).toBe('中文');expect(richDone).toBe(true);
  }
 }
});

const cfg: ChatRequestConfig = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
};

describe('chatCompletionsUrl', () => {
  it('preserves custom prefixes and full endpoints with query parameters', () => {
    expect(chatCompletionsUrl('https://gateway.example/openai')).toBe('https://gateway.example/openai/chat/completions');
    expect(chatCompletionsUrl('https://gateway.example/openai/?region=cn')).toBe('https://gateway.example/openai/chat/completions?region=cn');
    expect(chatCompletionsUrl('https://gateway.example/v1/chat/completions/?api-version=2026#draft')).toBe('https://gateway.example/v1/chat/completions?api-version=2026');
    expect(chatCompletionsUrl('https://gateway.example?region=cn')).toBe('https://gateway.example/v1/chat/completions?region=cn');
    expect(chatCompletionsUrl('https://api.deepseek.com/?region=cn')).toBe('https://api.deepseek.com/chat/completions?region=cn');
  });
  it('keeps the effective route of old custom connections until the user changes parsing mode',()=>{
    expect(chatCompletionsUrl('https://gateway.example/openai','legacy')).toBe('https://gateway.example/openai/v1/chat/completions');
    expect(chatCompletionsUrl('https://gateway.example/openai','base')).toBe('https://gateway.example/openai/chat/completions');
    expect(chatCompletionsUrl('https://gateway.example/v1/chat/completions?region=cn','legacy')).toBe('https://gateway.example/v1/chat/completions?region=cn');
  });
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
      'https://api.deepseek.com/chat/completions',
    );
  });
  it('已含完整路径则原样', () => {
    expect(chatCompletionsUrl('https://h/v1/chat/completions')).toBe(
      'https://h/v1/chat/completions',
    );
  });
  it('preserves GLM and Qwen API roots', () => {
    expect(chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(chatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  });
});

describe('buildChatRequest', () => {
  it('bounds GLM sampling precision and output using its documented API limits', () => {
    for (const model of ['glm-5.3', 'glm-5.3-flash']) {
      const request = (temperature: number) => JSON.parse(buildChatRequest({ ...cfg, baseUrl:'https://open.bigmodel.cn/api/paas/v4', model, temperature, maxTokens: 1e9 }, []).body);
      expect(request(2).temperature).toBe(1);
      expect(request(0.876).temperature).toBe(1);
      expect(request(-1).temperature).toBe(1);
      expect(request(1).max_tokens).toBe(131072);
    }
  });
  it('uses supported sampling and output parameters for current models', () => {
    const mimo = JSON.parse(buildChatRequest({ ...cfg, baseUrl:'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', temperature: 2, maxTokens: 1e9 }, []).body);
    expect(mimo.temperature).toBeUndefined();
    expect(mimo.max_completion_tokens).toBe(131072);
    expect(mimo.thinking).toEqual({ type: 'enabled' });
    const openai = JSON.parse(buildChatRequest({ ...cfg, model: 'gpt-6-luna' }, [], [{}]).body);
    expect(openai.reasoning_effort).toBe('none');
    expect(openai.max_completion_tokens).toBe(128000);
    expect(openai.max_tokens).toBeUndefined();
    expect(() => buildChatRequest({ ...cfg, model: 'gpt-6-astra' }, [], [{}])).toThrow('Responses');
    expect(() => buildChatRequest({ ...cfg, model: 'deepseek-flash', contextBudget: 1e9 }, [])).toThrow('预算');
  });
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

describe('buildChatRequest tools', () => {
  it('传入 tools 时写入 body 并设 tool_choice=auto', () => {
    const spec = buildChatRequest(cfg, [{ role: 'user', content: 'hi' }], [
      { type: 'function', function: { name: 'x', description: '', parameters: {} } },
    ]);
    const body = JSON.parse(spec.body);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tool_choice).toBe('auto');
  });
  it('无 tools 时不含 tools 字段', () => {
    const spec = buildChatRequest(cfg, [{ role: 'user', content: 'hi' }]);
    expect('tools' in JSON.parse(spec.body)).toBe(false);
  });
});

describe('parseSseChunkRich + accumulateToolCalls', () => {
  it('抽取 content 与 finish_reason', () => {
    const buf =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    const r = parseSseChunkRich(buf);
    expect(r.contentDeltas).toEqual(['你好']);
    expect(r.finishReason).toBe('stop');
  });
  it('抽取并累加 tool_calls 分片', () => {
    const buf =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_node_doc","arguments":"{\\"nod"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"eId\\":\\"n1\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const r = parseSseChunkRich(buf);
    expect(r.finishReason).toBe('tool_calls');
    const calls = accumulateToolCalls(r.toolCallDeltas);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_1');
    expect(calls[0].function.name).toBe('read_node_doc');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ nodeId: 'n1' });
  });
  it('多个并行 tool_calls 按 index 分组', () => {
    const deltas = [
      { index: 0, id: 'a', name: 'list_nodes', argsFragment: '{}' },
      { index: 1, id: 'b', name: 'search_board', argsFragment: '{"query":' },
      { index: 1, argsFragment: '"丝绸"}' },
    ];
    const calls = accumulateToolCalls(deltas);
    expect(calls).toHaveLength(2);
    expect(calls[0].function.name).toBe('list_nodes');
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ query: '丝绸' });
  });
});
