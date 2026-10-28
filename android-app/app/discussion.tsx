import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Alert, Keyboard, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownContent } from '@/components/markdown-content';
import { AutoGrowingInput } from '@/components/auto-growing-input';
import { WorkspaceButton, WorkspaceCard } from '@/components/workspace-controls';
import { QuietDisclosure } from '@/components/quiet-disclosure';
import { AppIcon } from '@/components/app-icon';
import { beginConversationTurn, createConversation, getConversation, listConversations, listMessages, updateConversationReply, type Conversation, type ConversationMessage } from '@/data/conversations';
import { prepareDiscussion } from '@/ai/discussion-context';
import { knowledgeReferenceLinks } from '@/data/knowledge-library-core';
import { streamDiscussion } from '@/ai/discussion-client';
import { getByokCredentials, getByokProfileStatus, type ByokProfile } from '@/ai/byok-profile';
import { getByokDestination } from '@/ai/byok-data-consent';
import { colors, radii } from '@/theme/tokens';
import { onSyncUpdate } from '@/sync/runtime';
import { composeReadingQuestion, parseReadingReference } from '@/data/reading-reference';

type Prepared = Awaited<ReturnType<typeof prepareDiscussion>> & { profile:ByokProfile|null; question:string };
const CONSENT_KEY='learnstuff.discussion-consent.v1';
export default function DiscussionScreen() {
  const params=useLocalSearchParams<{projectId?:string;nodeId?:string;conversationId?:string;initialQuestion?:string;reference?:string;sourceMessageIds?:string}>();
  const sourceIds=useMemo(()=>{try{const value=JSON.parse(params.sourceMessageIds??'[]');return new Set<string>(Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):[]);}catch{return new Set<string>();}},[params.sourceMessageIds]);
  const db=useSQLiteContext(); const insets=useSafeAreaInsets();
  const keyboard=useAnimatedKeyboard();
  const keyboardAvoidance=useAnimatedStyle(()=>({paddingBottom:Math.max(0,keyboard.height.value-insets.bottom)}),[insets.bottom]);
  const [conversation,setConversation]=useState<Conversation|null>(null); const [items,setItems]=useState<Conversation[]>([]);
  const [messages,setMessages]=useState<ConversationMessage[]>([]); const [question,setQuestion]=useState(params.initialQuestion??'');
  const [referenceConsumed,setReferenceConsumed]=useState(false);
  const reference=useMemo(()=>referenceConsumed?null:parseReadingReference(params.reference),[params.reference,referenceConsumed]);
  const preparing=useRef(false);
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [prepared,setPrepared]=useState<Prepared|null>(null); const [showPreview,setShowPreview]=useState(false);
  const [toolsOpen,setToolsOpen]=useState(false), [messageTools,setMessageTools]=useState<string|null>(null);
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
      const checked = await prepareDiscussion(db, conversation.id, value.question);
      if (checked.preview !== value.preview) throw new Error('参考资料或知识库在预览后改变，请重新检查发送内容');
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
      await writes;await updateConversationReply(db,turn.assistantId,result.text + knowledgeReferenceLinks(value.knowledgeReferences),'complete',result.model);
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
    <Stack.Screen options={{title:conversation?.title??'讨论',headerRight:()=>conversation?<Pressable accessibilityRole="button" accessibilityLabel="讨论操作" accessibilityState={{ expanded:toolsOpen }} onPress={()=>setToolsOpen(value=>!value)} style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'}}><AppIcon name="more-horiz" color={colors.inkMuted}/></Pressable>:null}} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:18,gap:14,paddingBottom:24}}>
      {error?<Text selectable accessibilityLiveRegion="polite" style={{color:colors.coral,lineHeight:22}}>{error}</Text>:null}
      {toolsOpen&&conversation?<WorkspaceButton secondary disabled={busy||!messages.some(m=>m.body)} label="存为节点" onPress={()=>router.push({pathname:'/capture-discussion',params:{conversationId:conversation.id}})} />:null}
      {reference?<QuietDisclosure title={`引用 · ${reference.title}`}><Text selectable style={{lineHeight:24,color:colors.ink}}>{reference.quote}</Text><WorkspaceButton secondary label="回看引用原文" onPress={()=>router.push({pathname:'/document/[id]',params:{id:reference.documentId,reference:JSON.stringify(reference)}})}/><WorkspaceButton secondary label="移除这次引用" onPress={()=>setReferenceConsumed(true)}/></QuietDisclosure>:null}
      {!conversation?<><Text style={{color:colors.inkMuted,lineHeight:23}}>围绕节点持续讨论。回答可以保存为文档，并成为图上的新节点。</Text><WorkspaceButton label="开始新的讨论" onPress={()=>void newDiscussion()} />{items.map(item=><WorkspaceCard key={item.id}><Text style={{fontWeight:'700',color:colors.ink}}>{item.title}</Text><Text style={{color:colors.inkMuted}}>{new Date(item.updated_at).toLocaleString()}</Text><WorkspaceButton secondary label="继续讨论" onPress={()=>router.push({pathname:'/discussion',params:{conversationId:item.id,...(reference?{reference:JSON.stringify(reference),initialQuestion:question}:{})}})} /></WorkspaceCard>)}</>:null}
      {conversation&&!messages.length?<Text style={{color:colors.inkMuted,lineHeight:23}}>从一个问题开始，继续你的思考。</Text>:null}
      {sourceIds.size?<Text style={{color:colors.inkMuted}}>已标出这篇文档所用的 {sourceIds.size} 条来源消息。</Text>:null}
      {messages.map(m=><View key={m.id} style={{padding:14,gap:10,borderRadius:radii.medium,backgroundColor:m.role==='user'?colors.surfaceStrong:colors.canvas,...(sourceIds.has(m.id)?{borderWidth:1,borderColor:colors.blue}:{})}}><View style={{flexDirection:'row',alignItems:'center',gap:10}}><Text style={{flex:1,fontSize:12,color:colors.inkMuted}}>{m.role==='user'?'我':'AI'}{sourceIds.has(m.id)?' · 笔记来源':''}{m.status==='pending'?' · 正在回答':m.status==='interrupted'?' · 回答未完成':m.status==='failed'?' · 请求未完成':''}</Text>{m.body&&m.status!=='pending'?<Pressable accessibilityRole="button" accessibilityLabel="消息操作" accessibilityState={{expanded:messageTools===m.id}} onPress={()=>setMessageTools(id=>id===m.id?null:m.id)} style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'}}><AppIcon name="more-horiz" color={colors.inkMuted} size={20}/></Pressable>:null}</View><MarkdownContent value={m.body||'等待回答…'} contentPadding={0} scrollEnabled={false} backgroundColor={m.role==='user'?colors.surfaceStrong:colors.canvas} />{messageTools===m.id&&m.body&&m.status!=='pending'?<WorkspaceButton secondary label="保存这条内容为新节点" onPress={()=>router.push({pathname:'/capture-discussion',params:{conversationId:m.conversation_id,messageIds:JSON.stringify([m.id])}})} />:null}</View>)}
    </ScrollView>
    {conversation?<View style={{padding:14,paddingBottom:Math.max(14,insets.bottom),gap:10}}><AutoGrowingInput accessibilityLabel="继续讨论的问题" placeholder="写下你的问题…" value={question} onChangeText={setQuestion} editable={!busy} minHeight={64} maxHeight={180} /><View style={{flexDirection:'row',gap:8}}><View style={{flex:1}}><WorkspaceButton label={busy?'停止生成':'发送'} disabled={!busy&&!question.trim()} onPress={()=>busy?abort.current?.abort():void prepare()} /></View><WorkspaceButton secondary label="发送内容" disabled={busy||!question.trim()} onPress={()=>void prepare(true)} /></View></View>:null}
    <Modal visible={showPreview} transparent animationType="fade" onRequestClose={()=>setShowPreview(false)}><View style={{flex:1,justifyContent:'flex-end',padding:12,paddingTop:insets.top+12,paddingBottom:insets.bottom+12,backgroundColor:colors.scrim}}><View style={{maxHeight:'100%',padding:18,gap:14,borderRadius:radii.large,backgroundColor:colors.surfaceStrong}}><Text style={{color:colors.ink,fontSize:20,fontWeight:'600'}}>本次参考</Text><Text selectable style={{color:colors.inkMuted,fontSize:12,lineHeight:20}}>{prepared?.profile?`${prepared.profile.label} · ${prepared.profile.baseUrl} · 可能计费`:'尚未连接 AI，当前仅预览'}</Text><ScrollView style={{flexShrink:1}} contentContainerStyle={{gap:10}}><Text selectable style={{fontSize:15,lineHeight:24,color:colors.ink}}>{question}</Text>{prepared?.knowledgeReferences.map(ref=><QuietDisclosure key={`${ref.entryId}:${ref.revisionId}`} title={ref.title} meta={`${ref.kind==='material'?'材料':ref.kind==='experience'?'经验':'我的理解'}${ref.truncated?' · 节选':''}`}><Text selectable style={{color:colors.ink,lineHeight:24}}>{ref.excerpt}</Text>{ref.source?<Text selectable style={{color:colors.inkMuted,fontSize:12,lineHeight:20}}>{ref.source}</Text>:null}<WorkspaceButton secondary label="查看引用原文" onPress={()=>{setShowPreview(false);router.push({pathname:'/knowledge-library',params:{entryId:ref.entryId,revisionId:ref.revisionId}});}}/></QuietDisclosure>)}<QuietDisclosure title="完整发送内容" meta={prepared?`${prepared.historyCount} 条历史消息${prepared.omittedCount?` · 已省略 ${prepared.omittedCount} 条`:''}`:undefined}><Text selectable style={{color:colors.ink,fontSize:13,lineHeight:22}}>{prepared?.preview}</Text></QuietDisclosure></ScrollView><View style={{flexDirection:'row',gap:10}}><View style={{flex:1}}><WorkspaceButton secondary label="返回修改" onPress={()=>setShowPreview(false)}/></View><View style={{flex:1}}><WorkspaceButton label={prepared?.profile?'发送以上内容':'连接个人 AI'} onPress={()=>prepared&&void send(prepared)}/></View></View></View></View></Modal>
  </Animated.View>;
}
