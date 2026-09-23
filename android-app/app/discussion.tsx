import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, Keyboard, Modal, ScrollView, Text, View } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownContent } from '@/components/markdown-content';
import { WorkspaceButton, WorkspaceCard, WorkspaceField } from '@/components/workspace-controls';
import { beginConversationTurn, createConversation, getConversation, listConversations, listMessages, updateConversationReply, type Conversation, type ConversationMessage } from '@/data/conversations';
import { prepareDiscussion } from '@/ai/discussion-context';
import { streamDiscussion } from '@/ai/discussion-client';
import { getByokCredentials, getByokProfileStatus, type ByokProfile } from '@/ai/byok-profile';
import { getByokDestination } from '@/ai/byok-data-consent';
import { colors } from '@/theme/tokens';
import { onSyncUpdate } from '@/sync/runtime';
import { composeReadingQuestion, parseReadingReference } from '@/data/reading-reference';

type Prepared = Awaited<ReturnType<typeof prepareDiscussion>> & { profile:ByokProfile|null; question:string };
const CONSENT_KEY='learnstuff.discussion-consent.v1';
export default function DiscussionScreen() {
  const params=useLocalSearchParams<{projectId?:string;nodeId?:string;conversationId?:string;initialQuestion?:string;reference?:string}>();
  const db=useSQLiteContext(); const insets=useSafeAreaInsets();
  const keyboard=useAnimatedKeyboard();
  const keyboardAvoidance=useAnimatedStyle(()=>({paddingBottom:Math.max(0,keyboard.height.value-insets.bottom)}),[insets.bottom]);
  const [conversation,setConversation]=useState<Conversation|null>(null); const [items,setItems]=useState<Conversation[]>([]);
  const [messages,setMessages]=useState<ConversationMessage[]>([]); const [question,setQuestion]=useState(params.initialQuestion??'');
  const [referenceConsumed,setReferenceConsumed]=useState(false);
  const reference=useMemo(()=>referenceConsumed?null:parseReadingReference(params.reference),[params.reference,referenceConsumed]);
  const preparing=useRef(false);
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [prepared,setPrepared]=useState<Prepared|null>(null); const [showPreview,setShowPreview]=useState(false);
  const abort=useRef<AbortController|null>(null); const gate=useRef(false); const mounted=useRef(true);
  useEffect(()=>{mounted.current=true; return ()=>{mounted.current=false;abort.current?.abort();};},[]);
  const reload=useCallback(async()=>{
    if (params.conversationId) {
      const value=await getConversation(db,params.conversationId); setConversation(value);
      if (!value) throw new Error('这段讨论不存在或已删除');
      setMessages(await listMessages(db,value.id));
    } else if (params.projectId) setItems(await listConversations(db,params.projectId,params.nodeId));
  },[db,params.conversationId,params.projectId,params.nodeId]);
  useFocusEffect(useCallback(()=>{void reload().catch(e=>setError(e.message));},[reload]));
  useEffect(()=>onSyncUpdate(()=>{if(!gate.current)void reload().catch(()=>undefined);}),[reload]);
  async function newDiscussion() {
    if (gate.current || !params.projectId) return; gate.current=true;
    try {const id=await createConversation(db,params.projectId,params.nodeId??null,reference?`关于 ${reference.title}`:'新的讨论');router.replace({pathname:'/discussion',params:{conversationId:id,initialQuestion:question,...(reference?{reference:JSON.stringify(reference)}:{})}});}
    catch(e){setError(e instanceof Error?e.message:'无法开始讨论');} finally{gate.current=false;}
  }
  async function send(value:Prepared) {
    if (!conversation || gate.current) return;
    if (!value.profile) { Alert.alert('先连接个人 AI','引用已保留，配置后重新检查并发送。',[{text:'取消',style:'cancel'},{text:'AI 设置',onPress:()=>router.push('/ai-settings')}]); return; }
    const profile=value.profile;
    gate.current=true;setBusy(true);setError('');setPrepared(null);setShowPreview(false);
    let assistantId:string|undefined;let text='';let lastSave=0;let writes=Promise.resolve(); const controller=new AbortController();abort.current=controller;
    try {
      const credentials=await getByokCredentials();
      if (!credentials||getByokDestination(credentials.profile)!==getByokDestination(profile)) throw new Error('AI 服务已改变，请重新检查发送内容');
      const SecureStore=await import('expo-secure-store');
      await SecureStore.setItemAsync(CONSENT_KEY,getByokDestination(profile));
      const turn=await beginConversationTurn(db,conversation.id,value.question);assistantId=turn.assistantId;
      setQuestion('');setReferenceConsumed(true);await reload();
      const result=await streamDiscussion(credentials,value.messages,{signal:controller.signal,onText:next=>{
        text=next;
        if(mounted.current)setMessages(current=>current.map(m=>m.id===assistantId?{...m,body:next}:m));
        if(Date.now()-lastSave>1000){lastSave=Date.now();const snapshot=next;writes=writes.then(()=>updateConversationReply(db,turn.assistantId,snapshot,'pending',profile.model));}
      }});
      await writes;await updateConversationReply(db,turn.assistantId,result.text,'complete',result.model);
    } catch(e) {
      await writes.catch(()=>undefined);
      if (assistantId) await updateConversationReply(db,assistantId,text,text?'interrupted':'failed',profile.model).catch(()=>undefined);
      if(mounted.current)setError(e instanceof Error?e.message:'讨论未完成，不会自动重试');
    } finally {gate.current=false;abort.current=null;if(mounted.current){setBusy(false);await reload().catch(()=>undefined);}}
  }
  async function prepare(previewOnly=false) {
    if(!conversation||gate.current||preparing.current||!question.trim())return;
    preparing.current=true;
    try{
      const storedQuestion=reference?composeReadingQuestion(reference,question):question;
      const context=await prepareDiscussion(db,conversation.id,storedQuestion);
      const profileStatus=await getByokProfileStatus();
      const profile=profileStatus.hasApiKey?profileStatus.profile:null;
      const value={...context,profile,question:storedQuestion};
      if(previewOnly||reference||!profile){Keyboard.dismiss();setPrepared(value);setShowPreview(true);return;}
      const SecureStore=await import('expo-secure-store');
      if(await SecureStore.getItemAsync(CONSENT_KEY)!==getByokDestination(profile)){Keyboard.dismiss();setPrepared(value);setShowPreview(true);}else await send(value);
    }catch(e){setError(e instanceof Error?e.message:'无法准备讨论');}finally{preparing.current=false;}
  }
  return <Animated.View style={[{flex:1,backgroundColor:colors.canvas},keyboardAvoidance]}>
    <Stack.Screen options={{title:conversation?.title??'讨论',headerRight:()=>conversation?<WorkspaceButton secondary disabled={busy||!messages.some(m=>m.body)} label="存为节点" onPress={()=>router.push({pathname:'/capture-discussion',params:{conversationId:conversation.id}})} />:null}} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:18,gap:14,paddingBottom:24}}>
      {error?<Text selectable accessibilityLiveRegion="polite" style={{color:colors.coral,lineHeight:22}}>{error}</Text>:null}
      {reference?<WorkspaceCard><Text style={{fontWeight:'700',color:colors.ink}}>引用 · {reference.title}</Text><Text selectable style={{lineHeight:24,color:colors.ink}}>{reference.quote}</Text><Text style={{color:colors.inkMuted}}>这次仅引用选中内容与少量前后文，发送前可检查。</Text><WorkspaceButton secondary label="回看引用原文" onPress={()=>router.push({pathname:'/document/[id]',params:{id:reference.documentId,reference:JSON.stringify(reference)}})}/><WorkspaceButton secondary label="移除这次引用" onPress={()=>setReferenceConsumed(true)}/></WorkspaceCard>:null}
      {!conversation?<><Text style={{color:colors.inkMuted,lineHeight:23}}>围绕节点持续讨论。回答可以保存为文档，并成为图上的新节点。</Text><WorkspaceButton label="开始新的讨论" onPress={()=>void newDiscussion()} />{items.map(item=><WorkspaceCard key={item.id}><Text style={{fontWeight:'700',color:colors.ink}}>{item.title}</Text><Text style={{color:colors.inkMuted}}>{new Date(item.updated_at).toLocaleString()}</Text><WorkspaceButton secondary label="继续讨论" onPress={()=>router.push({pathname:'/discussion',params:{conversationId:item.id,...(reference?{reference:JSON.stringify(reference),initialQuestion:question}:{})}})} /></WorkspaceCard>)}</>:null}
      {conversation&&!messages.length?<Text style={{color:colors.inkMuted,lineHeight:23}}>提出问题，回答会保留在这段讨论里。你可以稍后选择内容，保存成文档和新节点。</Text>:null}
      {messages.map(m=><WorkspaceCard key={m.id}><Text selectable style={{fontWeight:'700',color:colors.ink}}>{m.role==='user'?'我':'AI'}{m.status==='pending'?' · 正在回答':m.status==='interrupted'?' · 回答未完成':m.status==='failed'?' · 请求未完成':''}</Text><MarkdownContent value={m.body||'等待回答…'} contentPadding={0} scrollEnabled={false} backgroundColor={colors.surfaceStrong} />{m.body&&m.status!=='pending'?<WorkspaceButton secondary label="保存这条内容为新节点" onPress={()=>router.push({pathname:'/capture-discussion',params:{conversationId:m.conversation_id,messageIds:JSON.stringify([m.id])}})} />:null}</WorkspaceCard>)}
    </ScrollView>
    {conversation?<View style={{padding:14,paddingBottom:Math.max(14,insets.bottom),gap:8,borderTopWidth:1,borderColor:colors.line}}><WorkspaceField label="继续讨论" value={question} onChangeText={setQuestion} /><View style={{flexDirection:'row',gap:8}}><View style={{flex:1}}><WorkspaceButton label={busy?'停止生成':'发送'} disabled={!busy&&!question.trim()} onPress={()=>busy?abort.current?.abort():void prepare()} /></View><WorkspaceButton secondary label="发送内容" disabled={busy||!question.trim()} onPress={()=>void prepare(true)} /></View></View>:null}
    <Modal visible={showPreview} animationType="slide" onRequestClose={()=>setShowPreview(false)}><View style={{flex:1,paddingTop:Math.max(18,insets.top),padding:18,paddingBottom:insets.bottom+18,gap:12,backgroundColor:colors.canvas}}><Text style={{fontSize:20,fontWeight:'700'}}>发送给个人 AI 的内容</Text><Text selectable style={{lineHeight:22}}>{prepared?.profile?`${prepared.profile.label} · ${prepared.profile.baseUrl}`:'尚未配置个人 AI，当前仅预览'}{'\n'}当前问题、{prepared?.historyCount} 条历史消息{prepared?.hasReadingReference?'及所选原文快照与少量前后文':prepared?.hasReference?'及当前节点相关资料':''}。服务可能计费，失败不会自动重试。省略 {prepared?.omittedCount} 条历史记录。</Text><ScrollView><Text selectable style={{fontSize:13,lineHeight:20}}>{prepared?.preview}</Text></ScrollView><WorkspaceButton label={prepared?.profile?'发送以上内容':'连接个人 AI'} onPress={()=>prepared&&void send(prepared)} /><WorkspaceButton secondary label="返回修改" onPress={()=>setShowPreview(false)} /></View></Modal>
  </Animated.View>;
}
