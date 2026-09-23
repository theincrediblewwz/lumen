import { readableReadingText } from '@/data/reading-reference';
import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { FlatList, Text, View } from 'react-native';
import { WorkspaceButton, WorkspaceField } from '@/components/workspace-controls';
import { colors } from '@/theme/tokens';

type Result={id:string;title:string;body:string;kind:'document'|'conversation';target:string};
export default function SearchScreen(){
  const {projectId}=useLocalSearchParams<{projectId?:string}>();const db=useSQLiteContext();const [query,setQuery]=useState('');const [results,setResults]=useState<Result[]>([]);const [error,setError]=useState('');
  useEffect(()=>{let active=true;const timer=setTimeout(()=>{if(!query.trim()){setResults([]);return;}const pattern=`%${query.trim().replace(/[\\%_]/g,'\\$&')}%`;void db.getAllAsync<Result>(`SELECT id,title,body,'document' AS kind,id AS target FROM documents WHERE (? IS NULL OR project_id=?) AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') UNION ALL SELECT m.id,c.title,m.body,'conversation',c.id FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE (? IS NULL OR c.project_id=?) AND m.body LIKE ? ESCAPE '\\' LIMIT 80`,projectId??null,projectId??null,pattern,pattern,projectId??null,projectId??null,pattern).then(rows=>{if(active){setResults(rows);setError('');}}).catch(()=>{if(active)setError('搜索暂时不可用');});},250);return()=>{active=false;clearTimeout(timer);};},[db,projectId,query]);
  return <View style={{flex:1,padding:18,gap:14}}><WorkspaceField label="搜索文档、原始资料和讨论" value={query} onChangeText={setQuery}/>{error?<Text style={{color:colors.coral}}>{error}</Text>:null}<FlatList data={results} keyExtractor={r=>`${r.kind}:${r.id}`} keyboardShouldPersistTaps="handled" ListEmptyComponent={<Text style={{color:colors.inkMuted}}>{query?'未找到匹配内容':'输入关键词，回到原文继续阅读。'}</Text>} renderItem={({item})=><View style={{marginBottom:16,gap:5}}><WorkspaceButton label={`${item.kind==='conversation'?'讨论':'文档'} · ${item.title}`} secondary onPress={()=>item.kind==='conversation'?router.push({pathname:'/discussion',params:{conversationId:item.target}}):router.push({pathname:'/document/[id]',params:{id:item.target}})}/><Text numberOfLines={3} style={{color:colors.inkMuted,lineHeight:21}}>{searchSnippet(item.body,query)}</Text></View>}/><Text style={{color:colors.inkMuted,fontSize:12}}>最多显示 80 条，可缩小关键词范围。</Text></View>;
}

function searchSnippet(body: string, query: string) {
  const text = readableReadingText(body);
  return text.slice(Math.max(0, text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) - 30));
}
