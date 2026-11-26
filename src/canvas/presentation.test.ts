import {describe,it,expect} from 'vitest';
import {aggregateHeat,heatLevel,isolatedHeatLabelZoom,readHeatLabel,resizedBox,snapConnection,boardAppearance,imageDisplaySize,resizedImageBox} from './presentation';
import {CanvasEngine} from './CanvasEngine';
import type {BoardNode} from '../api';
const node=(id:string,x:number,y:number):BoardNode=>({id,x,y,w:240,h:96,title:id,docs:[],created_at:'',updated_at:''});
describe('canvas presentation',()=>{
 it('retains subflow presence when overview cells merge and conserves all nodes',()=>{
  const nodes=[node('normal',0,0),{...node('flow-a',100,100),color:'#3b82c4',flow:{nodeIds:['a']}},{...node('flow-b',1500,1500),color:'#e0503a',flow:{nodeIds:[]}}];
  for(const level of [1,4,9]){const cells=aggregateHeat(nodes,level);expect(cells.reduce((sum,c)=>sum+c.count,0)).toBe(3);expect(cells.reduce((sum,c)=>sum+c.flowCount,0)).toBe(2);expect(cells.some(c=>c.flowCount>0&&!!c.flowColor)).toBe(true);}
 });
 it('conserves every node while coarser spatial levels merge into fewer regions',()=>{
  const nodes=Array.from({length:10000},(_,i)=>node(String(i),(i%100)*280,Math.floor(i/100)*140));
  let previous=Infinity;
  for(const zoom of [.3,.15,.075,.02,.005,.001]){const cells=aggregateHeat(nodes,heatLevel(zoom));expect(cells.reduce((sum,c)=>sum+c.count,0)).toBe(10000);expect(cells.length).toBeLessThanOrEqual(previous);previous=cells.length;}
  expect(heatLevel(.35)).toBe(0);expect(previous).toBe(1);expect(aggregateHeat([node('a',-500,-500),node('b',500,500)],9)).toHaveLength(1);
 });
 it('keeps named members separate from the node count and stops at their first separate heat tier',()=>{
  const a={...node('a',-200,-30),heatLabel:{name:'第一棵树',color:'#d43c63',fontSize:22}};
  const b={...node('b',440,0),heatLabel:{name:'第二棵树',color:'#147da8',fontSize:16}};
  const nodes=[a,b,node('unnamed',20,80)];
  const [merged]=aggregateHeat(nodes,heatLevel(.14));
  expect(merged.count).toBe(3);
  expect(merged.labels).toEqual([{...a.heatLabel,nodeId:'a',x:-80,y:18},{...b.heatLabel,nodeId:'b',x:560,y:48}]);
  expect(merged.nodeIds).toEqual(['a','b','unnamed']);
  const zoom=isolatedHeatLabelZoom(nodes,'b',.14)!;
  expect(zoom).toBeGreaterThan(.14);
  expect(heatLevel(zoom)).toBe(1);
  expect(aggregateHeat(nodes,heatLevel(zoom)).find(cell=>cell.labels.some(label=>label.nodeId==='b'))?.labels).toHaveLength(1);
  expect(isolatedHeatLabelZoom([a,{...b,x:a.x,y:a.y}], 'b', .14)).toBeUndefined();
 });
 it('reads only valid neon colors and bounds names and font sizes',()=>{
  expect(readHeatLabel({name:'  ',color:'#f00'})).toBeUndefined();
  expect(readHeatLabel({name:` ${'字'.repeat(80)} `,color:'var(--accent)',fontSize:99})).toEqual({name:'字'.repeat(60),color:'#00ab70',fontSize:32});
 });
 it('fits distant nodes below twenty percent and preserves the zoom anchor',()=>{
  const engine=new CanvasEngine({}, {minZoom:.001,maxZoom:3});engine.fit({x:0,y:0,width:100000,height:100000},{width:1200,height:800});expect(engine.viewport.zoom).toBeLessThan(.01);
  const p={x:430,y:220},before=engine.toWorld(p);engine.zoomByFactor(p,.1);expect(engine.toWorld(p).x).toBeCloseTo(before.x);expect(engine.toWorld(p).y).toBeCloseTo(before.y);
 });
 it('snaps to the nearest rectangle within a constant screen radius',()=>{
  const nodes=[node('from',0,0),node('near',400,0),node('far',800,0)];const box=(n:BoardNode)=>({x:n.x,y:n.y,w:n.w,h:n.h!});
  expect(snapConnection({x:380,y:40},nodes,'from',box,1)).toBe('near');expect(snapConnection({x:370,y:40},nodes,'from',box,1)).toBeNull();expect(snapConnection({x:350,y:40},nodes,'from',box,.5)).toBe('near');expect(snapConnection({x:900,y:40},nodes,'far',box,1)).toBeNull();
 });
 it('resizes independently at each corner and clamps without moving the opposite corner',()=>{
  const b={x:100,y:200,w:240,h:100};expect(resizedBox(b,'se',100,50)).toEqual({x:100,y:200,w:340,h:150});
  const r=resizedBox(b,'nw',200,200);expect(r.w).toBe(120);expect(r.h).toBe(64);expect(r.x+r.w).toBe(b.x+b.w);expect(r.y+r.h).toBe(b.y+b.h);
 });
 it('places images at their true ratio and keeps that ratio from every resize corner',()=>{const size=imageDisplaySize(1600,900);expect(size.w/size.h).toBeCloseTo(16/9);for(const corner of ['nw','ne','sw','se']){const box=resizedImageBox({x:100,y:200,...size},corner,120,40);expect(box.w/box.h).toBeCloseTo(16/9);}expect(imageDisplaySize(1,1)).toEqual({w:160,h:160});});
 it('validates stored board font values',()=>{expect(boardAppearance({fontSize:Infinity})).toEqual({fontFamily:'system',fontSize:15,previewFontFamily:'system',previewFontSize:15,zoomSensitivity:1});expect(boardAppearance({fontSize:400,fontFamily:'serif'}).fontSize).toBe(32);});
 it('keeps the previous zoom speed for old boards and bounds each board sensitivity',()=>{
  expect(boardAppearance().zoomSensitivity).toBe(1);expect(boardAppearance({zoomSensitivity:NaN}).zoomSensitivity).toBe(1);
  expect(boardAppearance({zoomSensitivity:Infinity}).zoomSensitivity).toBe(1);
  expect(boardAppearance({zoomSensitivity:0}).zoomSensitivity).toBe(.25);expect(boardAppearance({zoomSensitivity:9}).zoomSensitivity).toBe(3);
  expect(boardAppearance({zoomSensitivity:.75}).zoomSensitivity).toBe(.75);expect(boardAppearance({fontSize:18}).zoomSensitivity).toBe(1);
 });
});
