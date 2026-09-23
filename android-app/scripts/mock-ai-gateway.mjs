import { createServer } from 'node:http';

const port = Number(process.env.MOCK_AI_GATEWAY_PORT ?? 8787);

const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true, mode: 'mock' }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/graph/expand') {
    response.writeHead(404);
    response.end(JSON.stringify({ error: { message: 'Not found' } }));
    return;
  }

  try {
    const context = JSON.parse(await readBody(request));
    if (context.schemaVersion !== 1 || context.selection?.kind !== 'node') {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { message: 'Invalid expansion context' } }));
      return;
    }
    const title = String(context.selection.title);
    const prompt = String(context.prompt || `继续拆解 ${title}`);
    const importance = Math.max(5, Number(context.selection.importance || 7) - 1);
    response.writeHead(200);
    response.end(JSON.stringify({
      version: 1,
      summary: `Mock Gateway 已从「${title}」生成两个经过结构约束的知识点。`,
      nodes: [
        {
          clientId: 'concept-model',
          title: `${title}的概念模型`,
          subtitle: '用一个最小例子建立直觉',
          importance,
          status: 'learning',
          document: {
            title: `${title}的概念模型`,
            body: `# ${title}的概念模型\n\n**问题：** ${prompt}\n\n这是来自本地 Mock Gateway 的结构化响应，用于验证真实 HTTP 链路。`,
          },
        },
        {
          clientId: 'boundary-check',
          title: `${title}的理解边界`,
          subtitle: '确认哪里仍然说不清楚',
          importance: Math.max(4, importance - 1),
          status: 'uncertain',
          document: {
            title: `${title}的理解边界`,
            body: `# ${title}的理解边界\n\n尝试不用术语解释「${title}」，记录无法解释的跳步，再决定是否继续追溯。`,
          },
        },
      ],
      edges: [
        {
          clientId: 'edge-concept-model',
          sourceRef: 'selection',
          targetRef: 'concept-model',
          relation: 'support',
          importance,
          document: {
            title: `${title} → 概念模型`,
            body: '# 关系说明\n\n概念模型帮助把抽象描述连接到可推演的例子。',
          },
        },
        {
          clientId: 'edge-boundary-check',
          sourceRef: 'concept-model',
          targetRef: 'boundary-check',
          relation: 'evidence',
          importance: Math.max(4, importance - 1),
          document: {
            title: '概念模型 → 理解边界',
            body: '# 关系说明\n\n能否迁移概念模型，是检查理解边界的一条证据。',
          },
        },
      ],
    }));
  } catch (error) {
    response.writeHead(400);
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Invalid JSON' } }));
  }
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Mock AI Gateway listening on http://0.0.0.0:${port}\n`);
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Request body too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

