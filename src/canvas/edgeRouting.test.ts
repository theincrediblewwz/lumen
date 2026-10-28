import {expect,it} from 'vitest';
import {routeBoardEdges,edgeLabelLines} from './edgeRouting';
import {computeTreeLayout} from './autoLayout';
it('routes sibling relationships above every card and gives overlapping labels separate channels',()=>{
 const boxes=new Map([['a',{x:0,y:300,w:200,h:100}],['b',{x:300,y:300,w:200,h:160}],['c',{x:600,y:300,w:200,h:100}]]);
 const edges=[{id:'ac',from:'a',to:'c',label:'跨节点的关系'},{id:'ca',from:'c',to:'a',label:'相反关系'},{id:'ab',from:'a',to:'b',label:'相邻关系'}];const routes=routeBoardEdges(boxes,edges,'curved');const ys=edges.map(e=>routes.get(e.id)!.mid.y);expect(new Set(ys).size).toBe(3);expect(Math.max(...ys)).toBeLessThan(280);for(const e of edges)expect(routes.get(e.id)!.d).toContain(' Q ');
});
it('retains all label characters and scales channels with the graph',()=>{
 const label='关系文字'.repeat(30),lines=edgeLabelLines(label);expect(lines.join('')).toBe(label);const boxes=new Map([['a',{x:0,y:150,w:100,h:50}],['b',{x:150,y:150,w:100,h:50}]]);const edge=[{id:'x',from:'a',to:'b',label}];const a=routeBoardEdges(boxes,edge,'straight',.5).get('x')!;expect(a.mid.y).toBeLessThan(150);expect(lines.length).toBeGreaterThan(1);
});
it('iteratively lays out twenty thousand levels without a call-stack cap',()=>{const nodes=Array.from({length:20000},(_,i)=>({id:'n'+i,w:200})),edges=nodes.slice(1).map((n,i)=>({from:'n'+i,to:n.id,directed:true}));const result=computeTreeLayout(nodes,edges);expect(result.size).toBe(20000);expect(result.get('n19999')!.y).toBeGreaterThan(result.get('n0')!.y);});
it('reserves relationship channels and leaves a larger gap between independent trees, including wide parents',()=>{const nodes=[{id:'r',w:700},{id:'a',w:200},{id:'b',w:200},{id:'other',w:700}],edges=[{from:'r',to:'a',directed:true},{from:'r',to:'b',directed:true},{from:'a',to:'b',directed:true,label:'关系'}];const p=computeTreeLayout(nodes,edges);expect(p.get('other')!.x-(p.get('r')!.x+700)).toBeGreaterThanOrEqual(240);expect(p.get('a')!.y-p.get('r')!.y).toBeGreaterThan(200);});
