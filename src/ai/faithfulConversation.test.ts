import {describe,expect,it} from 'vitest';
import {faithfulConversationAnswers,faithfulMarkdownTranscript,prepareFaithfulConversation,type ConversationAnalysisJob} from './faithfulConversation';
import {sharedMarkdown,type ImportedMessage} from './shareTranscript';
import {validateTreePlan,type ImportSource} from './conversationImport';
import {requestInputTokens} from './provider';
const sourceFor=(transcript:ImportedMessage[]):ImportSource=>({name:'Synthetic.md',url:'https://synthetic.invalid/share',text:sharedMarkdown('Synthetic',transcript),transcript});
const metadata=(job:ConversationAnalysisJob)=>({schema:'lumen.faithful-metadata/v1',answers:(JSON.parse(job.messages[1].content).parts as {id:string}[]).map(part=>({id:part.id,title:`Title ${part.id}`,summary:'Summary',guide:'New AI guide.',parent:null as string|null,reason:'Suggested relationship, not an original source relation.'}))});
describe('faithful originals',()=>{
it('preserves BOM-first numbered CRLF originals and ignores fenced headers',()=>{
 const first='\r\n  $$x_i^2$$  \r\n```md\r\n## 第 99 条回答\r\n```\r\n\r\n',last='\r\nLast 😀\r\n\r\n';
 const text='\uFEFF## 第 1 条回答\r\n'+first+'## 第 2 条回答\r\n'+last,answers=faithfulConversationAnswers({text,name:'numbered.md'});
 expect(answers.map(a=>a.content)).toEqual([first,last]);expect(answers.map(a=>a.id)).toEqual(['answer_1','answer_2']);expect(answers.map(a=>a.round)).toEqual([1,2]);
});
});
describe('faithful parsing and selection',()=>{
it('keeps role-body leading/trailing whitespace and never guesses ordinary headings',()=>{
 const text='# Export\r\n## 提问\r\n\r\nQuestion\r\n## 回答\r\n\r\nAnswer $x_i$  \r\n\r\n';
 expect(faithfulMarkdownTranscript(text)?.messages.at(-1)?.content).toBe('\r\nAnswer $x_i$  \r\n\r\n');
 expect(()=>faithfulConversationAnswers({name:'article',text:'# Article\n## Intro\nText'})).toThrow('明确的回答分隔');
 expect(()=>faithfulConversationAnswers({name:'mixed',text:'## 回答\nFirst\n## 第 2 条回答\nSecond'})).toThrow('混用');
});
it('keeps exact link messages, stable IDs, and one node per assistant in a checked round',()=>{
 const source=sourceFor([{role:'user',content:'Q1'},{role:'assistant',content:'  A1\r\n\r\n'},{role:'assistant',content:'A1b'},{role:'user',content:'Q2'},{role:'assistant',content:'A2'}]);source.selectedRounds=[1];
 const answers=faithfulConversationAnswers(source);expect(answers.map(a=>a.id)).toEqual(['answer_2','answer_3']);expect(answers[0].content).toBe('  A1\r\n\r\n');
 expect(()=>faithfulConversationAnswers({...source,selectedRounds:[]})).toThrow('至少勾选');
});
});
describe('faithful metadata',()=>{
it('reads every long-answer piece within budget but retains one complete original node',()=>{
 const large='Formula😀 $x_i$\r\n'.repeat(7000)+'\r\n',source=sourceFor([{role:'user',content:'Question'},{role:'assistant',content:large},{role:'user',content:'Followup'},{role:'assistant',content:'Final\n\n'}]);
 const pipeline=prepareFaithfulConversation(source,8000),answers=faithfulConversationAnswers(source),received=new Map<string,string>();expect(pipeline.jobs.length).toBeGreaterThan(1);
 for(const job of pipeline.jobs){expect(requestInputTokens(job.messages)).toBeLessThanOrEqual(8000);for(const part of JSON.parse(job.messages[1].content).parts)received.set(part.id,(received.get(part.id)??'')+part.content);}
 expect(answers.map(a=>received.get(a.id))).toEqual(answers.map(a=>a.content));
 const plan=validateTreePlan(pipeline.assemble(pipeline.jobs.map((job,i)=>pipeline.validate(metadata(job),i))));expect(plan.nodes).toHaveLength(3);expect(plan.mode).toBe('faithful');expect(plan.nodes.filter(n=>n.original).map(n=>n.original!.content)).toEqual(answers.map(a=>a.content));
 expect(plan.nodes[1].markdown).toContain('新 AI 建议');expect(plan.nodes[1].markdown).toContain('全部片段');expect(new TextEncoder().encode(plan.nodes[1].original!.content).length).toBeGreaterThan(65536);
});
it('includes bounded previous-answer evidence for parent suggestions',()=>{
 const pipeline=prepareFaithfulConversation(sourceFor([{role:'user',content:'Q1'},{role:'assistant',content:'First evidence'},{role:'user',content:'Q2'},{role:'assistant',content:'Second evidence'}]),8000),job=pipeline.jobs[0],input=JSON.parse(job.messages[1].content);
 expect(input.parentContext[0]).toMatchObject({id:'answer_2',answerExcerpt:'First evidence'});const raw=metadata(job);raw.answers[1].parent=raw.answers[0].id;
 const plan=validateTreePlan(pipeline.assemble([pipeline.validate(raw,0)]));expect(plan.nodes[2].parent).toBe('answer_2');
});
it.each(['missing','duplicate','unknown','future','self','original','reason'])('rejects invalid metadata: %s',kind=>{
 const pipeline=prepareFaithfulConversation(sourceFor([{role:'user',content:'Q'},{role:'assistant',content:'A'},{role:'assistant',content:'B'}]),8000),raw=metadata(pipeline.jobs[0]);
 if(kind==='missing')raw.answers.pop();if(kind==='duplicate')raw.answers[1].id=raw.answers[0].id;if(kind==='unknown')raw.answers[0].id='unknown';if(kind==='future')raw.answers[0].parent=raw.answers[1].id;if(kind==='self')raw.answers[0].parent=raw.answers[0].id;if(kind==='original')Object.assign(raw.answers[0],{original:{id:'forged',content:'changed'}});if(kind==='reason')raw.answers[0].reason=' ';
 expect(()=>pipeline.validate(raw,0)).toThrow();
});
it('rejects combined metadata overflow without truncating guides or originals',()=>{
 const pipeline=prepareFaithfulConversation(sourceFor([{role:'user',content:'Q'},{role:'assistant',content:'研究材料'.repeat(20000)}]),8000),results=pipeline.jobs.map((job,i)=>{const raw=metadata(job);raw.answers[0].guide='导'.repeat(10000);return pipeline.validate(raw,i);});
 expect(()=>validateTreePlan(pipeline.assemble(results))).toThrow('节点标题、正文或标识无效');
});
});
