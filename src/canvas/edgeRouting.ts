import {edgeGeometry,type Box,type EdgeStyle,type EdgeGeometry} from './geometry';
export function edgeLabelLines(label:string):string[]{
 const result:string[]=[];for(const paragraph of label.split('\n')){const chars=Array.from(paragraph);if(!chars.length)result.push('');for(let i=0;i<chars.length;i+=22)result.push(chars.slice(i,i+22).join(''));}return result;
}
export interface RoutingEdge{id:string;from:string;to:string;label?:string|null}
/** Same-row relationships get their own channels above the row, outside cards. */
export function routeBoardEdges(boxes:Map<string,Box>,edges:RoutingEdge[],style:EdgeStyle,scale=1):Map<string,EdgeGeometry>{
 const routes=new Map<string,EdgeGeometry>();const bands=new Map<number,{bottom:number;height:number;intervals:[number,number][] }[]>();
 for(const edge of edges){const a=boxes.get(edge.from),b=boxes.get(edge.to);if(!a||!b)continue;
  const normal=edgeGeometry(a,b,style);routes.set(edge.id,normal);if(edge.from===edge.to)continue;
  const sameRow=a.y<b.y+b.h&&b.y<a.y+a.h;if(!sameRow)continue;
  const x1=a.x+a.w/2,x2=b.x+b.w/2,mid=(x1+x2)/2,lines=edge.label?edgeLabelLines(edge.label):[];
  const width=Math.max(24,...lines.map(s=>Array.from(s).length*12))*scale+16*scale;
  const height=Math.max(24,lines.length*16+12)*scale;
  const interval:[number,number]=[Math.min(x1,x2,mid-width/2)-8*scale,Math.max(x1,x2,mid+width/2)+8*scale];
  let top=Math.min(a.y,b.y);for(const box of boxes.values())if(box.y<Math.max(a.y+a.h,b.y+b.h)&&box.y+box.h>Math.min(a.y,b.y)&&box.x<interval[1]&&box.x+box.w>interval[0])top=Math.min(top,box.y);
  const key=Math.round(top);const lanes=bands.get(key)??[];let lane=lanes.find(l=>l.intervals.every(([l,r])=>interval[1]<l||interval[0]>r)&&l.height>=height);
  if(!lane){const bottom=lanes.length?lanes.at(-1)!.bottom+lanes.at(-1)!.height:24*scale;lane={bottom,height,intervals:[]};lanes.push(lane);bands.set(key,lanes);}
  lane.intervals.push(interval);const y=top-lane.bottom-height/2;
  const turn=8*scale,direction=x2>x1?1:-1;
  routes.set(edge.id,{start:{x:x1,y:a.y},end:{x:x2,y:b.y},mid:{x:mid,y},d:`M ${x1} ${a.y} L ${x1} ${y+turn} Q ${x1} ${y} ${x1+direction*turn} ${y} L ${x2-direction*turn} ${y} Q ${x2} ${y} ${x2} ${y+turn} L ${x2} ${b.y}`});
 }return routes;
}
