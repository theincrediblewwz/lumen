import {usePreventRemove} from '@react-navigation/native';
import {pickNodeDocument} from '@/data/rich-document-files';
import { useCallback, useEffect, useRef, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WorkspaceButton, WorkspaceCard, WorkspaceField } from '@/components/workspace-controls';
import { NodeDocumentCards } from '@/components/node-document-cards';
import { addNodeDocument, attachDocument, connectNodes, detachDocument, listNodeDocuments, moveNodeDocumentPriority } from '@/data/node-workspace';
import { colors } from '@/theme/tokens';
import type { MarkdownDocument } from '@/types/domain';

export default function NodeDocumentsScreen() {
  const {nodeId}=useLocalSearchParams<{nodeId:string}>();const db=useSQLiteContext();const insets=useSafeAreaInsets();
  const [docs,setDocs]=useState<MarkdownDocument[]>([]);const [node,setNode]=useState<{title:string;project_id:string;document_id:string}|null>(null);
  const [title,setTitle]=useState('');const [body,setBody]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const gate=useRef(false);
  const [managementVisible,setManagementVisible]=useState(false);
  const [picker,setPicker]=useState<'documents'|'nodes'|null>(null);const [choices,setChoices]=useState<{id:string;title:string}[]>([]);
  const load=useCallback(async()=>{setDocs(await listNodeDocuments(db,nodeId));setNode(await db.getFirstAsync('SELECT title,project_id,document_id FROM nodes WHERE id=?',nodeId));},[db,nodeId]);
  useFocusEffect(useCallback(()=>{void load().catch(e=>setError(e.message));},[load]));
  async function action(fn:()=>Promise<unknown>){if(gate.current)return;gate.current=true;setBusy(true);setError('');let completed=false;try{await fn();completed=true;await load();}catch(e){const detail=e instanceof Error?e.message:'请稍后重试';setError(completed?`操作已完成，但列表暂时未刷新：${detail}`:detail);}finally{gate.current=false;setBusy(false);}}
  async function choose(kind:'documents'|'nodes') {
    if(!node)return;
    setChoices(await db.getAllAsync(kind==='documents'?'SELECT id,title FROM documents WHERE project_id=? AND id NOT IN (SELECT document_id FROM node_documents WHERE node_id=?) ORDER BY updated_at DESC':'SELECT id,title FROM nodes WHERE project_id=? AND id<>? ORDER BY title',node.project_id,nodeId));setPicker(kind);
  }
  const [importProgress,setImportProgress]=useState('');const importController=useRef<AbortController|null>(null);
  useEffect(()=>()=>importController.current?.abort(),[]);
  usePreventRemove(importProgress==='正在保存挂载…',()=>Alert.alert('正在完成保存','保存完成后即可返回。'));
  async function importMarkdown(){if(!node)return;const controller=new AbortController();importController.current=controller;try{await pickNodeDocument(db,nodeId,node.project_id,setImportProgress,controller.signal);}finally{importController.current=null;setImportProgress('');}}
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:18,paddingBottom:24+insets.bottom,gap:14}}>
    <Stack.Screen options={{title:node?.title??'节点文档'}}/>
    <Text style={{color:colors.inkMuted,lineHeight:21}}>按这里的顺序显示每篇文档的预览；点标题阅读完整内容。</Text>
    <NodeDocumentCards documents={docs} onOpen={documentId=>router.push({pathname:'/document/[id]',params:{id:documentId}})} onMove={(documentId,direction)=>void action(()=>moveNodeDocumentPriority(db,nodeId,documentId,direction))}/>
    <WorkspaceButton label={managementVisible?'收起文档管理':'添加或管理文档'} secondary onPress={()=>setManagementVisible(value=>!value)}/>
    {importProgress?<View style={{gap:8}}><Text style={{color:colors.inkMuted}}>{importProgress}</Text><WorkspaceButton label="停止预检" disabled={importProgress==='正在保存挂载…'} secondary onPress={()=>importController.current?.abort()}/></View>:null}
    {managementVisible?<>
      <WorkspaceButton label="挂载已有文档" secondary disabled={busy} onPress={()=>void action(()=>choose('documents'))}/>
      <WorkspaceButton label="导入 Markdown、PDF 或图文 ZIP" secondary disabled={busy} onPress={()=>void action(importMarkdown)}/>
      <WorkspaceCard><WorkspaceField label="新文档标题" value={title} onChangeText={setTitle}/><WorkspaceField label="Markdown 正文" value={body} onChangeText={setBody} multiline/><WorkspaceButton label="添加到此节点" disabled={busy||!title.trim()} onPress={()=>void action(async()=>{await addNodeDocument(db,nodeId,title,body);setTitle('');setBody('');})}/></WorkspaceCard>
      {docs.filter(doc=>doc.id!==node?.document_id).map(doc=><WorkspaceCard key={doc.id}><Text style={{color:colors.ink,fontWeight:'700'}}>{doc.title}</Text><View style={{flexDirection:'row',gap:8}}><WorkspaceButton label="设为 AI 首选" secondary disabled={busy} onPress={()=>void action(()=>db.runAsync('UPDATE nodes SET document_id=? WHERE id=?',doc.id,nodeId))}/><WorkspaceButton label="取消挂载" secondary disabled={busy} onPress={()=>void action(()=>detachDocument(db,nodeId,doc.id))}/></View></WorkspaceCard>)}
      <WorkspaceButton label="连接另一个节点" secondary disabled={busy} onPress={()=>void action(()=>choose('nodes'))}/>
    </>:null}
    {picker?<WorkspaceCard><Text style={{color:colors.ink,fontWeight:'700'}}>{picker==='documents'?'选择文档':'选择相关节点'}</Text>{choices.length===0?<Text style={{color:colors.inkMuted}}>暂无可选内容</Text>:null}{choices.map(item=><WorkspaceButton key={item.id} label={item.title} secondary disabled={busy} onPress={()=>void action(async()=>{if(picker==='documents')await attachDocument(db,nodeId,item.id);else if(node){await connectNodes(db,node.project_id,nodeId,item.id);Alert.alert('已建立连接');}setPicker(null);})}/>)}<WorkspaceButton label="收起" secondary onPress={()=>setPicker(null)}/></WorkspaceCard>:null}
    {error?<Text selectable style={{color:colors.coral}}>{error}</Text>:null}
  </ScrollView>;
}
