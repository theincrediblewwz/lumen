import { useCallback, useRef, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WorkspaceButton, WorkspaceCard, WorkspaceField } from '@/components/workspace-controls';
import { addNodeDocument, attachDocument, connectNodes, detachDocument, listNodeDocuments } from '@/data/node-workspace';
import { colors } from '@/theme/tokens';
import type { MarkdownDocument } from '@/types/domain';

export default function NodeDocumentsScreen() {
  const {nodeId}=useLocalSearchParams<{nodeId:string}>();const db=useSQLiteContext();const insets=useSafeAreaInsets();
  const [docs,setDocs]=useState<MarkdownDocument[]>([]);const [node,setNode]=useState<{title:string;project_id:string;document_id:string}|null>(null);
  const [title,setTitle]=useState('');const [body,setBody]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const gate=useRef(false);
  const [picker,setPicker]=useState<'documents'|'nodes'|null>(null);const [choices,setChoices]=useState<{id:string;title:string}[]>([]);
  const load=useCallback(async()=>{setDocs(await listNodeDocuments(db,nodeId));setNode(await db.getFirstAsync('SELECT title,project_id,document_id FROM nodes WHERE id=?',nodeId));},[db,nodeId]);
  useFocusEffect(useCallback(()=>{void load().catch(e=>setError(e.message));},[load]));
  async function action(fn:()=>Promise<unknown>){if(gate.current)return;gate.current=true;setBusy(true);setError('');try{await fn();await load();}catch(e){setError(e instanceof Error?e.message:'操作未完成');}finally{gate.current=false;setBusy(false);}}
  async function choose(kind:'documents'|'nodes') {
    if(!node)return;
    setChoices(await db.getAllAsync(kind==='documents'?'SELECT id,title FROM documents WHERE project_id=? AND id NOT IN (SELECT document_id FROM node_documents WHERE node_id=?) ORDER BY updated_at DESC':'SELECT id,title FROM nodes WHERE project_id=? AND id<>? ORDER BY title',node.project_id,nodeId));setPicker(kind);
  }
  async function importMarkdown(){
    const Picker=await import('expo-document-picker');const FileSystem=await import('expo-file-system');
    const result=await Picker.getDocumentAsync({type:['text/markdown','text/plain','application/octet-stream'],copyToCacheDirectory:true});if(result.canceled)return;
    const file=new FileSystem.File(result.assets[0].uri);
    try{if(file.size>2000000)throw new Error('Markdown 文件最多 2 MB');const text=await file.text();if(text.includes('\u0000'))throw new Error('请选择 UTF-8 文本文件');await addNodeDocument(db,nodeId,result.assets[0].name.replace(/\.(md|txt)$/i,''),text);}finally{try{file.delete();}catch{/* Picker temporary copy only. */}}
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:18,paddingBottom:24+insets.bottom,gap:14}}>
    <Stack.Screen options={{title:node?.title??'节点文档'}}/>
    {docs.map(doc=><WorkspaceCard key={doc.id}><WorkspaceButton label={`${doc.id===node?.document_id?'主文档 · ':''}${doc.title}`} secondary onPress={()=>router.push({pathname:'/document/[id]',params:{id:doc.id}})}/>
      {doc.id!==node?.document_id?<View style={{flexDirection:'row',gap:8}}><WorkspaceButton label="设为主文档" secondary disabled={busy} onPress={()=>void action(()=>db.runAsync('UPDATE nodes SET document_id=? WHERE id=?',doc.id,nodeId))}/><WorkspaceButton label="取消挂载" secondary disabled={busy} onPress={()=>void action(()=>detachDocument(db,nodeId,doc.id))}/></View>:null}
    </WorkspaceCard>)}
    <WorkspaceButton label="挂载已有文档" secondary disabled={busy} onPress={()=>void action(()=>choose('documents'))}/>
    <WorkspaceButton label="导入 Markdown 文件" secondary disabled={busy} onPress={()=>void action(importMarkdown)}/>
    <WorkspaceCard><WorkspaceField label="新文档标题" value={title} onChangeText={setTitle}/><WorkspaceField label="Markdown 正文" value={body} onChangeText={setBody} multiline/><WorkspaceButton label="添加到此节点" disabled={busy||!title.trim()} onPress={()=>void action(async()=>{await addNodeDocument(db,nodeId,title,body);setTitle('');setBody('');})}/></WorkspaceCard>
    <WorkspaceButton label="连接另一个节点" secondary disabled={busy} onPress={()=>void action(()=>choose('nodes'))}/>
    {picker?<WorkspaceCard><Text style={{color:colors.ink,fontWeight:'700'}}>{picker==='documents'?'选择文档':'选择相关节点'}</Text>{choices.length===0?<Text style={{color:colors.inkMuted}}>暂无可选内容</Text>:null}{choices.map(item=><WorkspaceButton key={item.id} label={item.title} secondary disabled={busy} onPress={()=>void action(async()=>{if(picker==='documents')await attachDocument(db,nodeId,item.id);else if(node){await connectNodes(db,node.project_id,nodeId,item.id);Alert.alert('已建立连接');}setPicker(null);})}/>)}<WorkspaceButton label="收起" secondary onPress={()=>setPicker(null)}/></WorkspaceCard>:null}
    {error?<Text selectable style={{color:colors.coral}}>{error}</Text>:null}
  </ScrollView>;
}
