import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import { useSQLiteContext } from 'expo-sqlite';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View, type ViewToken } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MarkdownContent } from '@/components/markdown-content';
import { WorkspaceButton } from '@/components/workspace-controls';
import { getDocument } from '@/data/knowledge-repository';
import { createManualNode, getDocumentDiscussion, saveDocumentRevision } from '@/data/node-workspace';
import { advanceReadingRestore, beginReadingRestore, firstReadingIndex, READING_RESTORE_INTERVAL_MS, readingBlocks, restoreReadingIndex, saveReadingPosition, type ReadingCellFrame, type ReadingRestorePlan } from '@/data/reading-position';
import { appendSourceCitations, listSourceCitationsForTarget } from '@/data/source-citations';
import { colors, radii } from '@/theme/tokens';
import type { MarkdownDocument, SourceCitation } from '@/types/domain';
import { onSyncUpdate } from '@/sync/runtime';
import { createReadingReference, parseReadingReference, readingQuestions, resolveReadingReference, type ReadingAction } from '@/data/reading-reference';
import { ReadingBlockPicker } from '@/components/reading-block-picker';
import type { ReadingSelectionEvent } from '@/components/reading-selection';

const digestText = (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);

export default function DocumentScreen() {
  const { id,reference:referenceParam }=useLocalSearchParams<{id:string;reference?:string}>();const db=useSQLiteContext();const insets=useSafeAreaInsets();const navigation=useNavigation();
  const reference=useMemo(()=>parseReadingReference(referenceParam),[referenceParam]);
  const [referenceReady,setReferenceReady]=useState(!reference);const [referenceNotice,setReferenceNotice]=useState('');
  const [highlighted,setHighlighted]=useState<{start:number;end:number}|null>(null);
  const [picking,setPicking]=useState(false);const [selecting,setSelecting]=useState(false);const selectionGate=useRef(false);
  const [pickerStart,setPickerStart]=useState<number|null>(null);
  const [document,setDocument]=useState<MarkdownDocument|null>(null);const [body,setBody]=useState('');const [editing,setEditing]=useState(false);const [saving,setSaving]=useState(false);
  const [citations,setCitations]=useState<SourceCitation[]>([]);const [source,setSource]=useState<Awaited<ReturnType<typeof getDocumentDiscussion>>>(null);
  const [error,setError]=useState('');const [toc,setToc]=useState(false);const [progress,setProgress]=useState(0);const [ready,setReady]=useState(false);
  const [renderEpoch,setRenderEpoch]=useState(0);
  const list=useRef<FlatList<ReactNode>>(null);const saved=useRef<{anchor:string;ratio:number}|null>(null);const interacted=useRef(false);const restored=useRef(false);
  const restorePlan=useRef<ReadingRestorePlan|null>(null);const frames=useRef(new Map<number,ReadingCellFrame>());const visible=useRef<number[]>([]);const scrollOffset=useRef(0);
  const contentGeneration=useRef(0);const lastGestureAt=useRef(0);const syncCheck=useRef(0);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);const retryTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const value=useMemo(()=>appendSourceCitations(document?.body??'',citations),[document?.body,citations]);const blocks=useMemo(()=>readingBlocks(value),[value]);
  const live=useRef({blocks,db,id,document,citations,source,editing,ready});live.current={blocks,db,id,document,citations,source,editing,ready};
  usePreventRemove(editing&&body!==document?.body,({data})=>Alert.alert('保留这次编辑？','你的修改尚未保存。',[{text:'继续编辑',style:'cancel'},{text:'放弃修改',style:'destructive',onPress:()=>navigation.dispatch(data.action)}]));
  useEffect(()=>{let active=true;setReady(false);restored.current=false;interacted.current=false;frames.current.clear();visible.current=[];scrollOffset.current=0;contentGeneration.current++;setRenderEpoch(contentGeneration.current);
    Promise.all([getDocument(db,id),listSourceCitationsForTarget(db,'document',id),getDocumentDiscussion(db,id),db.getFirstAsync<{anchor:string;ratio:number}>('SELECT anchor,ratio FROM reading_positions WHERE id=?',id)]).then(([doc,refs,origin,position])=>{
      if(!active)return;
      const requested=parseReadingReference(referenceParam);
      if(requested&&doc&&requested.projectId!==doc.projectId){setDocument(null);setBody('');setError('引用文档不属于这份资料的白板，保留引用快照。');setReady(true);return;}
      setDocument(doc);setBody(doc?.body??'');setCitations(refs);setSource(origin);saved.current=position;setProgress(position?.ratio??0);setReady(true);if(!doc)setError('这篇文档不存在或已删除');
    }).catch(()=>{if(active){setError('无法读取文档');setReady(true);}});return()=>{active=false;restorePlan.current=null;if(timer.current)clearTimeout(timer.current);if(interacted.current&&saved.current)void saveReadingPosition(db,id,saved.current.anchor,saved.current.ratio).catch(()=>undefined);if(retryTimer.current)clearTimeout(retryTimer.current);};
  },[db,id,referenceParam]);
  useEffect(()=>{
    let active=true;
    const unsubscribe=onSyncUpdate(()=>{
      const check=++syncCheck.current;
      void Promise.all([getDocument(db,id),listSourceCitationsForTarget(db,'document',id),getDocumentDiscussion(db,id)]).then(([next,refs,origin])=>{
        if(!active||check!==syncCheck.current||!live.current.ready||!next)return;
        const current=live.current;
        const changed=next.body!==current.document?.body||next.updatedAt!==current.document.updatedAt||next.title!==current.document.title;
        const referencesChanged=JSON.stringify(refs)!==JSON.stringify(current.citations);
        if(current.editing){if(changed)setError('此文档在另一设备有更新；你的编辑仍保留，保存时会检查冲突。');return;}
        // A sync status event must not reset scrolling; also avoid interrupting a live gesture.
        if(!changed&&!referencesChanged&&JSON.stringify(origin)===JSON.stringify(current.source))return;
        if(Date.now()-lastGestureAt.current<800)return;
        if(next.body!==current.document?.body||referencesChanged){
          stopRestoration();restored.current=false;frames.current.clear();visible.current=[];
          contentGeneration.current++;setRenderEpoch(contentGeneration.current);
        }
        setDocument(next);setBody(next.body);setCitations(refs);setSource(origin);
      }).catch(()=>undefined);
    });
    return()=>{active=false;unsubscribe();};
  },[db,id]);
  useEffect(()=>{if(editing){stopRestoration();frames.current.clear();visible.current=[];}},[editing]);
  const jumpToReference=useRef(jump);jumpToReference.current=jump;
  useEffect(()=>{
    if(!ready)return;
    let active=true;setReferenceReady(!reference);setHighlighted(null);setReferenceNotice('');
    if(reference)void resolveReadingReference(reference,document,digestText).then(result=>{
      if(!active)return;setReferenceReady(true);
      if('index' in result){setHighlighted({start:result.index,end:result.index+reference.blockHashes.length-1});setReferenceNotice(result.status==='exact'?'已定位引用段落':'文档已有更新，已找到未改变的引用段落');jumpToReference.current(result.index,true);}
      else setReferenceNotice(result.status==='missing'?'原文不存在或不属于此白板；以下保留引用快照。':result.status==='ambiguous'?'原文有多处相同段落，无法确定原位置；以下保留引用快照。':'原文内容已改变，无法可靠定位；以下保留引用快照。');
    }).catch(()=>{if(active){setReferenceReady(true);setReferenceNotice('暂时无法定位；以下保留引用快照。');}});
    return()=>{active=false;};
  },[ready,reference,document]);
  async function quoteSelection(start:number,end:number,action:ReadingAction,selection?:ReadingSelectionEvent){
    if(selection?.quote.includes('\uFFFC')){setPickerStart(start);setPicking(true);return;}
    if(!document||selectionGate.current)return;selectionGate.current=true;setSelecting(true);
    try{
      const captured=await createReadingReference(document,start,end,digestText,selection);
      setPicking(false);setError('');
      router.push({pathname:'/discussion',params:{projectId:document.projectId,reference:JSON.stringify(captured),initialQuestion:readingQuestions[action]}});
    }catch(e){const message=e instanceof Error?e.message:'无法引用所选内容';setError(message);if(picking)Alert.alert('调整引用范围',message);}
    finally{selectionGate.current=false;setSelecting(false);}
  }
  function stopRestoration(){restorePlan.current=null;if(retryTimer.current){clearTimeout(retryTimer.current);retryTimer.current=null;}}
  function persistIndex(index:number){
    const current=live.current;const block=current.blocks[index];if(!block)return;
    const next={anchor:block.anchor,ratio:index/Math.max(1,current.blocks.length-1)};saved.current=next;setProgress(next.ratio);
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>{void saveReadingPosition(current.db,current.id,next.anchor,next.ratio).catch(()=>setError('阅读位置暂未保存'));},500);
  }
  function updateVisiblePosition(){
    if(restorePlan.current)return;
    const index=firstReadingIndex(visible.current,frames.current,scrollOffset.current);if(index===null)return;
    setProgress(index/Math.max(1,live.current.blocks.length-1));
    if(interacted.current)persistIndex(index);
  }
  function restorationTick(){
    retryTimer.current=null;
    const current=restorePlan.current;if(!current)return;
    const next=advanceReadingRestore(current,Date.now(),frames.current.get(current.index),scrollOffset.current);
    restorePlan.current=next.plan;
    if(!next.plan){updateVisiblePosition();return;}
    if(next.command?.type==='offset')list.current?.scrollToOffset({offset:next.command.offset,animated:false});
    else if(next.command?.type==='index')list.current?.scrollToIndex({index:next.command.index,animated:false,viewPosition:0});
    retryTimer.current=setTimeout(restorationTick,READING_RESTORE_INTERVAL_MS);
  }
  function jump(index:number,explicit=false){
    stopRestoration();restored.current=true;
    const target=Math.max(0,Math.min(live.current.blocks.length-1,index));
    if(explicit){interacted.current=true;persistIndex(target);}else setProgress(target/Math.max(1,live.current.blocks.length-1));
    restorePlan.current=beginReadingRestore(target,Date.now());restorationTick();
  }
  function restore(){if(reference&&!referenceReady)return;if(!restored.current&&live.current.ready&&live.current.blocks.length)jump(restoreReadingIndex(live.current.blocks,saved.current));}
  function manualInteraction(){lastGestureAt.current=Date.now();interacted.current=true;restored.current=true;stopRestoration();updateVisiblePosition();}
  const viewChanged=useRef(({viewableItems}:{viewableItems:ViewToken[]})=>{
    visible.current=viewableItems.filter(item=>item.isViewable&&item.index!==null).map(item=>item.index!);updateVisiblePosition();
  }).current;
  async function save(){if(!document||saving)return;setSaving(true);try{const updatedAt=await saveDocumentRevision(db,id,body,document.updatedAt,document.body);setDocument({...document,body,origin:'learner',updatedAt});setEditing(false);setError('');restored.current=false;}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setSaving(false);}}
  async function saveCopy(){if(!document||saving)return;setSaving(true);try{await createManualNode(db,{projectId:document.projectId,title:document.title.slice(0,145)+' · 编辑副本',body});restored.current=false;setEditing(false);setBody(document.body);Alert.alert('已保存为独立文档与新节点');}catch(e){setError(e instanceof Error?e.message:'副本未保存');}finally{setSaving(false);}}
  if(!ready)return <View style={{flex:1,justifyContent:'center'}}><ActivityIndicator color={colors.ink}/></View>;
  if(!document)return <ScrollView contentContainerStyle={{padding:20,gap:14}}><Text style={{color:colors.coral}}>{error}</Text>{reference?<><Text style={{color:colors.inkMuted}}>{referenceNotice||'原文已不可用，引用快照仍保留。'}</Text><Text style={{fontWeight:'700',color:colors.ink}}>{reference.title}</Text><Text selectable style={{color:colors.ink,lineHeight:26}}>{reference.quote}</Text></>:null}</ScrollView>;
  return <KeyboardAvoidingView behavior={process.env.EXPO_OS==='ios'?'padding':undefined} style={{flex:1,backgroundColor:colors.canvas}}>
    <Stack.Screen options={{title:document.title,headerRight:()=> <Pressable accessibilityRole="button" onPress={()=>editing?void save():setEditing(true)} disabled={saving} style={{minHeight:44,padding:12}}><Text style={{color:colors.ink,fontWeight:'700'}}>{editing?'保存':'编辑'}</Text></Pressable>}}/>
    {error?<Text selectable style={{color:colors.coral,padding:12}}>{error}</Text>:null}
    {editing?<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:18,gap:12,paddingBottom:insets.bottom+24}}>
      <TextInput accessibilityLabel="Markdown 源码" value={body} onChangeText={setBody} multiline textAlignVertical="top" style={{minHeight:500,padding:16,borderRadius:radii.large,backgroundColor:colors.surfaceStrong,color:colors.ink,lineHeight:25,fontSize:16}}/>
      <WorkspaceButton label="另存为新文档与节点" secondary disabled={saving} onPress={()=>void saveCopy()}/>
      <WorkspaceButton label="取消编辑" secondary disabled={saving} onPress={()=>Alert.alert('放弃未保存修改？','原文会保留。',[{text:'继续编辑',style:'cancel'},{text:'放弃修改',onPress:()=>{restored.current=false;setBody(document.body);setEditing(false);}}])}/>
    </ScrollView>:<>
      <View style={{paddingHorizontal:18,paddingVertical:8,gap:6}}>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><Pressable accessibilityRole="button" onPress={()=>setToc(true)} style={{padding:12}}><Text style={{color:colors.blue}}>目录</Text></Pressable><Text style={{color:colors.inkMuted,fontSize:12}}>已读 {Math.round(progress*100)}%</Text><Pressable accessibilityRole="button" accessibilityLabel="阅读操作" onPress={()=>Alert.alert('阅读操作','长按文字可解释、举例或追问；公式和跨段内容可用“引用段落”。',[{text:'引用段落',onPress:()=>setPicking(true)},{text:'取消',style:'cancel'}])} style={{padding:12,minHeight:44}}><Text style={{color:colors.ink,fontSize:20}}>···</Text></Pressable></View>
        {referenceNotice?<View style={{padding:10,backgroundColor:colors.blueSoft,borderRadius:12,gap:6}}><Text style={{color:colors.inkMuted}}>{referenceNotice}</Text>{!highlighted&&reference?<Text selectable style={{color:colors.ink,lineHeight:23}}>{reference.quote}</Text>:null}<Pressable accessibilityRole="button" onPress={()=>{setReferenceNotice('');setHighlighted(null);}} style={{paddingVertical:8}}><Text style={{color:colors.blue}}>收起引用提示</Text></Pressable></View>:null}
        {source?.conversation_id?<WorkspaceButton label="回到原始讨论" secondary onPress={()=>router.push({pathname:'/discussion',params:{conversationId:source.conversation_id!}})}/>:source?.source_answer_id?<WorkspaceButton label="查看原始回答" secondary onPress={()=>router.push({pathname:'/answer/[id]',params:{id:source.source_answer_id!}})}/>:null}
      </View>
      <MarkdownContent key={`${id}:${renderEpoch}`} value={value} highlightedBlocks={highlighted} onSelectionAction={(index,event)=>void quoteSelection(index,index,event.action,event)} onBlockLayout={(index,frame)=>{if(renderEpoch!==contentGeneration.current)return;if(frame)frames.current.set(index,frame);else frames.current.delete(index);}}
        listProps={{ref:list,onLayout:restore,onContentSizeChange:restore,onTouchStart:manualInteraction,onScrollBeginDrag:manualInteraction,
          onScroll:event=>{scrollOffset.current=event.nativeEvent.contentOffset.y;if(interacted.current&&!restorePlan.current)lastGestureAt.current=Date.now();updateVisiblePosition();},scrollEventThrottle:80,
          onViewableItemsChanged:viewChanged,viewabilityConfig:{itemVisiblePercentThreshold:1},onScrollToIndexFailed:info=>{
            const plan=restorePlan.current;if(!plan||plan.index!==info.index)return;
            list.current?.scrollToOffset({offset:Math.max(0,info.averageItemLength*info.index),animated:false});
          }}}/>
    </>}
    {picking?<ReadingBlockPicker body={document.body} initialIndex={pickerStart??firstReadingIndex(visible.current,frames.current,scrollOffset.current)??0} busy={selecting} onClose={()=>{setPicking(false);setPickerStart(null);}} onChoose={(start,end,action)=>void quoteSelection(start,end,action)}/>:null}
    <Modal visible={toc} transparent animationType="slide" onRequestClose={()=>setToc(false)}><View style={{flex:1,backgroundColor:'rgba(0,0,0,0.25)',justifyContent:'flex-end'}}><View style={{maxHeight:'80%',backgroundColor:colors.surfaceStrong,padding:18,paddingBottom:18+insets.bottom,gap:10,borderTopLeftRadius:24,borderTopRightRadius:24}}><Text style={{fontSize:20,fontWeight:'700',color:colors.ink}}>目录</Text><ScrollView>{blocks.filter(b=>b.heading).map(block=><Pressable key={block.anchor} accessibilityRole="button" onPress={()=>{setToc(false);jump(block.index,true);}} style={{minHeight:48,paddingVertical:12,paddingLeft:(block.depth-1)*12}}><Text style={{color:colors.ink,fontSize:16}}>{block.heading}</Text></Pressable>)}{blocks.every(b=>!b.heading)?<Text style={{color:colors.inkMuted,padding:12}}>文档暂无 Markdown 标题</Text>:null}</ScrollView><WorkspaceButton label="关闭目录" secondary onPress={()=>setToc(false)}/></View></View></Modal>
  </KeyboardAvoidingView>;
}
