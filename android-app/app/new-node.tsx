import { useRef, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { ScrollView, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WorkspaceButton, WorkspaceField } from '@/components/workspace-controls';
import { createFreeBoard, createManualNode } from '@/data/node-workspace';
import { colors } from '@/theme/tokens';

export default function NewNodeScreen() {
  const {projectId,parentId}=useLocalSearchParams<{projectId?:string;parentId?:string}>(); const db=useSQLiteContext(); const insets=useSafeAreaInsets();
  const [title,setTitle]=useState(''); const [body,setBody]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const gate=useRef(false);
  async function save() {
    if(gate.current)return; gate.current=true;setBusy(true);setError('');
    try {
      const result=projectId ? {projectId,nodeId:await createManualNode(db,{projectId,parentId,title,body})} : await createFreeBoard(db,title,body);
      router.replace({pathname:'/project/[id]',params:{id:result.projectId,initialNodeId:result.nodeId}});
    } catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{gate.current=false;setBusy(false);}
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:18,paddingBottom:24+insets.bottom,gap:16}}>
    <Stack.Screen options={{title:projectId?'新建节点':'新的自由图谱'}}/>
    <Text style={{color:colors.inkMuted,lineHeight:22}}>{parentId?'新节点会连接到刚才选中的节点。':'写下一个主题，逐渐连接你的想法。'}</Text>
    <WorkspaceField label="标题" value={title} onChangeText={setTitle}/>
    <WorkspaceField label="Markdown 文档" value={body} onChangeText={setBody} multiline/>
    {error?<Text selectable style={{color:colors.coral}}>{error}</Text>:null}
    <WorkspaceButton label={busy?'保存中…':'保存文档与节点'} disabled={busy||!title.trim()} onPress={()=>void save()}/>
  </ScrollView>;
}
