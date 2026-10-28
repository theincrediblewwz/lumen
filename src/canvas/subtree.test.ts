import {expect,it} from 'vitest';
import {descendantIds,translateFromBaseline} from './subtree';
import {createHistory,replacePresent,commitFromBaseline,undo,redo} from './history';
import type {BoardNode} from '../api';
const node=(id:string,x=0,y=0):BoardNode=>({id,title:id,x,y,w:240,docs:[{path:'docs/'+id+'.md',title:id}],created_at:'at',updated_at:'at'});
it('collects every directed descendant once while excluding incoming, unrelated and undirected nodes',()=>{
 const nodes=['root','a','b','leaf','other','parent','related'].map(id=>node(id));
 const edges=[['root','a',true],['root','b',true],['a','leaf',true],['b','leaf',true],['leaf','root',true],['parent','root',true],['root','related',false],['root','missing',true]].map(([from,to,directed])=>({from:from as string,to:to as string,directed:directed as boolean}));
 expect([...descendantIds(nodes,edges,'root')].sort()).toEqual(['a','b','leaf','root']);expect(descendantIds(nodes,edges,'missing').size).toBe(0);
});
it('uses an iterative traversal for a deep graph',()=>{const nodes=Array.from({length:20000},(_,i)=>({id:String(i)}));const edges=nodes.slice(1).map((n,i)=>({from:String(i),to:n.id,directed:true}));expect(descendantIds(nodes,edges,'0').size).toBe(20000);});
it('moves from a frozen baseline without accumulated drift and undoes the whole group once',()=>{
 const nodes=[node('root',5,8),node('child',40,50),node('other',5,8)],positions=new Map(nodes.slice(0,2).map(n=>[n.id,{x:n.x,y:n.y}]));
 let h=createHistory(nodes);h=replacePresent(h,translateFromBaseline(h.present,positions,20,30));h=replacePresent(h,translateFromBaseline(h.present,positions,50,60));h=commitFromBaseline(h,nodes);
 expect(h.past).toHaveLength(1);expect(h.present[0]).toMatchObject({x:55,y:68});expect(h.present[1]).toMatchObject({x:90,y:110});expect(h.present[2]).toBe(nodes[2]);expect(h.present[1].docs).toBe(nodes[1].docs);expect(undo(h).present).toEqual(nodes);expect(redo(undo(h)).present).toEqual(h.present);
});
