import { useEffect, useState } from 'react';
import type { AiRoundTiming } from '../ai/aiClient';

const LOCAL_PHASES = {
  context: '读取白板、参考资料与准备上下文',
  lease: '确认对话写入状态',
  credentials: '读取已保存连接',
  question: '保存原始提问',
  memory: '整理旧对话与发送内容',
  save: '保存回答与释放会话',
};

export interface ChatTimingReport {
  startedAt: number;
  finishedAt?: number;
  outcome?: 'completed' | 'stopped' | 'failed' | 'notSent';
  local: Partial<Record<keyof typeof LOCAL_PHASES, number>>;
  rounds: AiRoundTiming[];
  firstAnswerMs?: number;
  memoryRequests: number;
  toolCount: number;
  toolMs: number;
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

export function ChatResponseTiming({ report, progress }: { report: ChatTimingReport; progress: string }) {
  const [now, setNow] = useState(() => performance.now());
  const running = report.finishedAt === undefined;
  useEffect(() => {
    if (!running) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [running, report.startedAt]);
  const elapsed = duration(Math.max(0, (report.finishedAt ?? now) - report.startedAt));
  const label = report.outcome === 'stopped' ? '已停止' : report.outcome === 'failed' ? '未完成' : report.outcome === 'notSent' ? '发送准备' : '本次响应耗时';

  return (
    <details className="ai-response-timing">
      <summary>
        {running && progress ? <><span className="ai-tool-spinner" aria-hidden="true"/><span className="ai-progress" role="status">{progress}…</span></> : label}
        <span className="ai-response-elapsed" aria-hidden="true">{elapsed}</span>
      </summary>
      <div className="ai-response-measurements">
        <dl>
          {report.firstAnswerMs !== undefined && <div><dt>点击发送到收到首段正文</dt><dd>{duration(report.firstAnswerMs)}</dd></div>}
          {(Object.keys(LOCAL_PHASES) as (keyof typeof LOCAL_PHASES)[]).map(phase => report.local[phase] !== undefined && (
            <div key={phase}><dt>{LOCAL_PHASES[phase]}</dt><dd>{duration(report.local[phase]!)}</dd></div>
          ))}
          {report.memoryRequests > 0 && <div><dt>整理旧对话的额外模型请求</dt><dd>{report.memoryRequests} 次</dd></div>}
          {report.toolCount > 0 && <div><dt>本机执行工具 · {report.toolCount} 次</dt><dd>{duration(report.toolMs)}</dd></div>}
        </dl>
        {report.rounds.map(round => {
          const measurements: [string, number | undefined][] = [
            ['检查权限与组装请求', round.preparationMs],
            ['准备本机事件通道', round.bridgeSetupMs],
            ['等待服务响应头', round.headersMs],
            ['收到首个流数据块', round.firstBodyMs],
            ['本机桥接附加耗时（约）', round.firstDeliveryMs !== undefined && round.firstBodyMs !== undefined ? Math.max(0, round.firstDeliveryMs - round.firstBodyMs) : undefined],
            ['收到思考信号', round.firstReasoningMs],
            ['收到首段正文', round.firstTextMs],
            ['本轮流式请求用时', round.streamMs],
          ];
          return <section key={round.round}>
            <h4>模型第 {round.round} 轮</h4>
            <dl>
              {measurements.map(([name, ms]) => ms !== undefined && <div key={name}><dt>{name}</dt><dd>{duration(ms)}</dd></div>)}
              {round.retries > 0 && <div><dt>自动重试 · {round.retries} 次预定等待</dt><dd>{duration(round.retryDelayMs)}</dd></div>}
            </dl>
          </section>;
        })}
        {report.rounds.length > 0 && <p>响应头耗时包含网络、服务排队和重试。流数据可能先带回思考、工具参数或心跳。</p>}
      </div>
    </details>
  );
}
