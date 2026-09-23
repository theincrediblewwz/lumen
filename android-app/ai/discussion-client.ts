import { createChatCompletionsUrl, normalizeByokProfile, type ByokCredentials } from './byok-profile';

export type DiscussionMessage = { role: 'system' | 'user' | 'assistant'; content: string };
class DiscussionError extends Error {}
export async function streamDiscussion(
  credentials: ByokCredentials, messages: DiscussionMessage[],
  options: { signal?: AbortSignal; onText: (text: string) => void; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ text: string; model: string }> {
  const profile = normalizeByokProfile(credentials.profile);
  if (!messages.length || JSON.stringify(messages).length > 100000) throw new Error('发送内容超过本次讨论上限，请缩小上下文');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectInterrupted: ((error: Error) => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  // Keep rejection handled even when cancellation arrives between awaited operations.
  void interrupted.catch(() => undefined);
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    rejectInterrupted?.(new DiscussionError('接收已停止或超时；已收到的内容会保留，不会自动重试'));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(abort, options.timeoutMs ?? 180000);
  try {
    const fetcher = options.fetchImpl ?? (await import('expo/fetch')).fetch;
    if (controller.signal.aborted) throw new DiscussionError('已停止接收；本次没有发起新请求');
    const body: Record<string, unknown> = { model: profile.model, messages, stream: true };
    if (profile.tokenLimitField !== 'none') body[profile.tokenLimitField] = 6000;
    const response = await Promise.race([fetcher(createChatCompletionsUrl(profile.baseUrl), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` }, body: JSON.stringify(body),
    }), interrupted]);
    if (response.redirected) throw new DiscussionError('AI 服务发生了地址跳转；为保护凭据已停止，本次不会自动重试');
    if (!response.ok) throw new DiscussionError(`AI 服务返回 HTTP ${response.status}；请求可能已计费，本次不会自动重试`);
    if (!response.body) throw new DiscussionError('此服务没有返回可读取的回答流；本次不会自动重试');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer=''; let text=''; let finished=false; let limited=false; let doneMarker=false; let receivedBytes=0;
    const frame = (line: string) => {
      if (!line.startsWith('data:')) return;
      const raw=line.slice(5).trim();
      if (raw==='[DONE]') { finished=true; doneMarker=true; return; }
      if (!raw) return;
      let parsed: { error?: unknown; choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[] };
      try { parsed=JSON.parse(raw); } catch { throw new DiscussionError('回答流格式不完整；已收到的内容会保留'); }
      if (!parsed || typeof parsed !== 'object') throw new DiscussionError('回答流格式不完整；已收到的内容会保留');
      if (parsed.error) throw new DiscussionError('AI 服务在回答中途报错；已收到的内容会保留');
      const choice=parsed.choices?.[0]; const delta=choice?.delta?.content;
      if (typeof delta === 'string') {
        if (text.length+delta.length > 1000000) throw new DiscussionError('回答超过保存上限，已停止接收');
        text+=delta; options.onText(text);
      }
      if (choice?.finish_reason === 'stop') finished=true;
      if (choice?.finish_reason && choice.finish_reason !== 'stop') limited=true;
    };
    while (true) {
      if (controller.signal.aborted) throw new DiscussionError('已停止接收；已收到的内容会保留');
      const chunk=await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      receivedBytes+=chunk.value.byteLength;
      if (receivedBytes > 8 * 1024 * 1024) throw new DiscussionError('回答流超过接收上限，已停止接收');
      buffer+=decoder.decode(chunk.value,{stream:true});
      let newline: number;
      while ((newline=buffer.indexOf('\n')) >= 0) {
        frame(buffer.slice(0,newline).replace(/\r$/u,'')); buffer=buffer.slice(newline+1);
        if (doneMarker) break;
      }
      if (doneMarker) break;
      if (buffer.length > 1000000) throw new DiscussionError('回答流数据格式异常');
    }
    if (!doneMarker) { buffer+=decoder.decode(); if (buffer.trim()) frame(buffer.trim()); }
    if (controller.signal.aborted) throw new DiscussionError('接收已停止或超时；已收到的内容会保留，不会自动重试');
    if (!finished || limited || !text.trim()) throw new DiscussionError('回答没有完整结束；已收到的内容会保留，本次不会自动重试');
    return {text,model:profile.model};
  } catch (error) {
    if (controller.signal.aborted) throw new Error('接收已停止或超时；已收到的内容会保留，不会自动重试');
    if (error instanceof DiscussionError) throw error;
    throw new Error('网络请求未完成，可能已产生费用；保留已收到的内容，不会自动重试');
  } finally {
    clearTimeout(timeout); options.signal?.removeEventListener('abort',abort);
    // A broken transport's cancel promise must not hold completion or cancellation hostage.
    void reader?.cancel().catch(() => undefined);
  }
}
