/** Synthetic cross-platform contract evidence only; never reads application configuration. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureDesktop,fileBytes,type DesktopSnapshot } from '../src/sync/adapter';
const time='2026-09-22T00:00:00Z';
const output=process.argv[2];if(!output)throw new Error('Usage: vite-node scripts/export-sync-fixtures.ts OUTPUT_DIRECTORY');
mkdirSync(output,{recursive:true});
for(const variant of ['initial','edited']) {
  const snapshot:DesktopSnapshot={revision:'0',ledger:null,files:{
    'index.json':fileBytes({version:1,projects:[{id:'p_fixture',name:'桌面夹',created_at:time}]}),
    'p_fixture/project.json':fileBytes({version:1,id:'p_fixture',name:'桌面夹',created_at:time,updated_at:time,boards:[{id:'b_fixture',name:'学习图谱',updated_at:time}]}),
    'p_fixture/b_fixture/board.json':fileBytes({version:1,id:'b_fixture',name:'学习图谱',projectId:'p_fixture',created_at:time,updated_at:time,viewport:{x:0,y:0,zoom:1},nodes:[
      {id:'n_fixture_1',title:variant==='initial'?'主问题':'编辑后的主问题',summary:'来源问题',x:1,y:2,w:240,color:null,docs:[{path:'docs/answer.md',title:'回答'},{path:'docs/note.md',title:'补充笔记'}],created_at:time,updated_at:time},
      {id:'n_fixture_2',title:'后续问题',summary:'来自讨论',x:300,y:100,w:240,color:null,docs:[{path:'docs/chat.md',title:'对话笔记'}],created_at:time,updated_at:time}],edges:[{id:'e_fixture',from:'n_fixture_1',to:'n_fixture_2',directed:true,label:'进一步讨论',created_at:time}]}),
    'p_fixture/b_fixture/docs/answer.md':[...new TextEncoder().encode(`# 回答\n\n${variant==='initial'?'中文 **Markdown**':'电脑编辑后的正文'}\n\n$E=mc^2$`)],
    'p_fixture/b_fixture/docs/note.md':[...new TextEncoder().encode('# 补充笔记\n\n|a|b|\n|-|-|\n|1|2|')],
    'p_fixture/b_fixture/docs/chat.md':[...new TextEncoder().encode('# 对话笔记\n\n来自回答。')],
    'p_fixture/b_fixture/docs/image.png':[137,80,78,71,0,1,2,255],
    'p_fixture/b_fixture/chats.json':fileBytes({version:1,conversations:[{id:'c_fixture',title:'学习讨论',createdAt:time,updatedAt:time,messages:[{id:'m_fixture_1',role:'user',content:'解释它',at:time},{id:'m_fixture_2',role:'assistant',content:'# 完整回答\n\n这是说明。',at:time}]}]}),
    'p_fixture/b_fixture/chat-captures.json':fileBytes([{id:'capture_fixture',conversation_id:'c_fixture',source_answer_id:null,document_path:'docs/chat.md',node_id:'n_fixture_2',message_ids_json:'["m_fixture_1","m_fixture_2"]',selection_key:'fixture_selection',created_at:time}]),
    'p_fixture/b_fixture/reading-positions.json':fileBytes([{path:'docs/answer.md',anchor:'answer',ratio:0.63,updated_at:time}]),
  }};
  const result=await captureDesktop(snapshot);
  writeFileSync(resolve(output,`desktop-${variant}.json`),JSON.stringify({entities:Object.values(result.entities),blobs:result.blobs},null,2)+'\n');
}
