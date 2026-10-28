/**
 * AI 白板工具（M5-3）：让 AI 能主动读取白板结构、节点文档、做检索，
 * 而不仅依赖打开时注入的 outline。采用 OpenAI 兼容的 function calling。
 *
 * 工具定义（JSON schema）是纯数据；执行器 executeTool 通过注入的 ToolContext
 * 访问白板与文档读取能力，因此可脱离 Tauri 单测。
 */

import type { BoardFile } from '../api';
import { boardToolPage } from './boardContext';
import { searchBoard } from './boardSearch';
import { conversationTool } from './conversationTools';
import type { StoredMessage } from './chatStore';

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 供工具执行使用的上下文（由调用方注入，含异步文档读取）。 */
export interface ToolContext {
  board: BoardFile;
  shareBoard?:boolean;
  conversationMessages?:StoredMessage[];
  allowBoard?:()=>boolean;
  /** 读取某文档相对路径的正文（docs/xxx.md） */
  readDoc: (path: string) => Promise<string>;
  applyOperations?: (args: Record<string, unknown>, callId: string) => Promise<string>;
  cancelled?: () => boolean;
  /** Conservative room remaining in this provider round; does not alter source. */
  maxDocChars?:number;
}

export const WRITE_TOOL: ToolDef={type:'function',function:{name:'apply_board_operations',description:'按用户意图整理当前白板。一次原子批次，仅创建节点、追加新Markdown文档与有向连线，不覆盖/删除原件。原生检查授权、版本和备份。最多8节点、8文档、12连线，每篇128KiB，总512KiB。新节点reference是本批唯一局部引用，后续操作可用它；parentId不填则独立，有当前讨论节点时优先用其id。只有返回成功才能说已创建；失败应告知用户。',parameters:{type:'object',additionalProperties:false,properties:{schema:{type:'string',enum:['lumen.board-operations/v1']},operations:{type:'array',minItems:1,maxItems:28,items:{oneOf:[{type:'object',additionalProperties:false,properties:{type:{const:'create_node'},reference:{type:'string'},title:{type:'string'},summary:{type:'string'},markdown:{type:'string'},parentId:{type:'string'}},required:['type','reference','title']},{type:'object',additionalProperties:false,properties:{type:{const:'append_document'},nodeId:{type:'string'},title:{type:'string'},markdown:{type:'string'}},required:['type','nodeId','title','markdown']},{type:'object',additionalProperties:false,properties:{type:{const:'connect_nodes'},from:{type:'string'},to:{type:'string'},label:{type:'string'}},required:['type','from','to']}]}}},required:['schema','operations']}}};

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_board_outline',
      description: '分页获取当前白板结构：节点与连线。按nextOffset/nextEdgeOffset续读，不能把一页当完整白板。limit=0只读关系。',
      parameters: { type: 'object', properties: {offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:0,maximum:100},edgeOffset:{type:'integer',minimum:0}}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_nodes',
      description: '分页列出节点id、标题、简介与文档数，按nextOffset续读；用read_node_doc(metadataOnly=true)查文档目录。',
      parameters: { type: 'object', properties: {offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_node_doc',
      description: '按需读取节点文档，不能将简介当作已读正文。nodeId定位节点，docIndex从0开始。metadataOnly=true列出文档目录；否则offset/length分段读取，返回nextOffset后可续读，不代表整篇已读。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 id（形如 n_xxx）' },
          docIndex: { type: 'number', description: '第几篇文档，从 0 开始，默认 0' },
          metadataOnly:{type:'boolean',description:'只列文档目录，从docIndex开始最多20篇'},
          offset:{type:'integer',minimum:0,description:'正文字符位置，默认0'},
          length:{type:'integer',minimum:1,maximum:32000,description:'本段字符数，默认12000'},
        },
        required: ['nodeId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_board',
      description: '全文检索当前白板的标题、简介和全部挂载文档。可提供1–8个不同关键词，any找相关候选，all要求这些词共同出现于同一节点的任意材料。返回nodeId、docIndex、offset、片段；再用read_node_doc细读。标题/简介不足以定位时优先使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          keywords: { type:'array',items:{type:'string'},maxItems:8,description:'可选的多个关键词/同义词' },
          mode:{type:'string',enum:['any','all']},
          offset:{type:'integer',minimum:0},
          limit:{type:'integer',minimum:1,maximum:20},
        },
        required: [],
      },
    },
  },
];

/** 找节点 */
function findNode(board: BoardFile, nodeId: string) {
  return board.nodes.find((n) => n.id === nodeId);
}

/** 执行一个工具调用，返回给模型看的文本结果。 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  callId = '',
): Promise<string> {
  if(name==='search_conversation'||name==='read_conversation')return ctx.conversationMessages?conversationTool(name,args,ctx.conversationMessages,ctx.maxDocChars):'当前没有可读取的会话。';
  if(ctx.shareBoard===false||ctx.allowBoard?.()===false)return '用户没有分享白板，不能读取或操作白板。';
  switch (name) {
    case 'apply_board_operations':
      if(!ctx.applyOperations)return '未授权AI修改白板，请让用户在设置中主动开启。';
      return ctx.applyOperations(args,callId);
    case 'read_board_outline':
      return boardToolPage(ctx.board,args,ctx.maxDocChars);

    case 'list_nodes': {
      return boardToolPage(ctx.board,args,ctx.maxDocChars,false);
    }

    case 'read_node_doc': {
      const nodeId = String(args.nodeId ?? '');
      const idx = Number(args.docIndex ?? 0);
      const node = findNode(ctx.board, nodeId);
      if (!node) return `未找到节点 ${nodeId}。可先调用 list_nodes 获取有效 id。`;
      if (!node.docs || node.docs.length === 0) return `节点「${node.title}」没有关联文档。`;
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.docs.length) {
        return `节点「${node.title}」只有 ${node.docs.length} 篇文档，docIndex ${idx} 越界。`;
      }
      if(args.metadataOnly===true){const cap=ctx.maxDocChars??16000,result={nodeId,total:node.docs.length,documents:node.docs.slice(idx,idx+20).map((d,i)=>({docIndex:idx+i,title:d.title.slice(0,120),bytes:d.bytes})),nextDocIndex:null as number|null};while(result.documents.length&&JSON.stringify(result).length>cap)result.documents.pop();result.nextDocIndex=idx+result.documents.length<node.docs.length?idx+result.documents.length:null;return result.documents.length?JSON.stringify(result):JSON.stringify({budgetLimited:true,total:node.docs.length,message:'上下文空间不足，目录尚未返回。'});}
      if(ctx.maxDocChars!=null&&ctx.maxDocChars<128)return '上下文空间不足，正文尚未读取。请说明未完成部分或增大预算。';
      const offset=Number(args.offset??0),requestedLength=Number(args.length??12000);
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(requestedLength)||requestedLength<1||requestedLength>32000)return 'offset须为非负整数，length为1–32000。';
      const length=Math.min(requestedLength,ctx.maxDocChars??32000);
      const doc = node.docs[idx];
      try {
        if(ctx.cancelled?.())return '已取消读取。';
        const content = await ctx.readDoc(doc.path);
        if(ctx.cancelled?.())return '已取消读取。';
        if(offset>content.length)return `offset越界，正文共${content.length}字符。`;
        let start=offset;if(start>0&&/[\uDC00-\uDFFF]/.test(content[start])&&/[\uD800-\uDBFF]/.test(content[start-1]))start--;
        let end=Math.min(content.length,start+length);if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1])&&/[\uDC00-\uDFFF]/.test(content[end]))end--;if(end===start&&start<content.length)end=Math.min(content.length,start+2);
        return `# 节点「${node.title}」的文档《${doc.title}》\nnodeId=${nodeId}; docIndex=${idx}; offset=${start}; totalChars=${content.length}; nextOffset=${end<content.length?end:'null'}\n${end<content.length?'这里只是正文片段，可按nextOffset续读。':'已到文档末尾。'}\n\n${content.slice(start,end)}`;
      } catch (e) {
        return `读取文档失败：${String(e)}`;
      }
    }

    case 'search_board':
      return searchBoard(ctx.board,args,ctx.readDoc,ctx.cancelled,ctx.maxDocChars);

    default:
      return `未知工具：${name}`;
  }
}
