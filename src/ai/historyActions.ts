import {invoke} from '@tauri-apps/api/core';
import {prefixFingerprint,removeMemory} from './chatMemory';
import type {Conversation} from './chatStore';
export const HISTORY_CHANGED='lumen:chat-history-changed';
export interface DeletedConversation {conversationId:string;receipt:string;scope:string;title?:string}
export interface HistoryChange {projectId:string;boardId:string;conversationId:string;scope:string;deleted:boolean}
export async function deleteConversation(projectId:string,boardId:string,conversation:Conversation,scope:string,receipt:string):Promise<DeletedConversation>{
 const baseline=await prefixFingerprint(conversation.messages,{index:conversation.messages.length,offset:0});
 const result=await invoke<DeletedConversation>('chat_history_delete',{projectId,boardId,conversationId:conversation.id,expectedScope:scope,baseline,receipt});
 removeMemory(conversation.id);window.dispatchEvent(new CustomEvent<HistoryChange>(HISTORY_CHANGED,{detail:{projectId,boardId,conversationId:conversation.id,scope,deleted:true}}));return result;
}
export async function restoreConversation(projectId:string,boardId:string,item:DeletedConversation):Promise<void>{
 await invoke('chat_history_restore',{projectId,boardId,expectedScope:item.scope,receipt:item.receipt});
 window.dispatchEvent(new CustomEvent<HistoryChange>(HISTORY_CHANGED,{detail:{projectId,boardId,conversationId:item.conversationId,scope:item.scope,deleted:false}}));
}
