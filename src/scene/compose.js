import sharp from "sharp";
import { applySceneOps, canvasObjects } from "./scene-ops.js";
import { moduleLayer, canvasMarks } from "../canvas-state.js";
import { serializeCanvas, restoreCanvas } from "../storage.js";

const full={x:0,y:0,x2:1,y2:1};
async function png(entry){
  const data=await sharp(entry.sourceBytes).rotate().resize({width:entry.width,height:entry.height,fit:"fill"}).png().toBuffer();
  if(data.length>8e6)throw Error("Image layer exceeds 8 MB; resize the source image first");
  return "data:image/png;base64,"+data.toString("base64");
}
// Prepare all async inputs before changing destination state. Copy the source
// snapshot once; subsequent changes never propagate between canvases.
export async function composeCanvas(target, source=null, region=full){
  if(source===target)throw Error("Use promotion without a source to make the base editable");
  const sourceState=source?structuredClone(serializeCanvas(source)):null;
  const targetBase=target.baseAsObject?null:await png(target);
  const sourceBase=source&&!source.baseAsObject?await png(source):null;
  const before=structuredClone(serializeCanvas(target));
  const sx=region.x2-region.x,sy=region.y2-region.y;
  if(!(sx>0&&sy>0))throw Error("region must have positive width and height");
  const point=(x,y)=>({x:region.x+x*sx,y:region.y+y*sy});
  const rect=r=>({...point(r.x,r.y),x2:region.x+r.x2*sx,y2:region.y+r.y2*sy});
  const create=(type,props,name)=>applySceneOps(target,[{op:"object.create",type,props}],{author:"user"},{layer:name}).created[0];
  try{
    if(targetBase){
      const id=create("image",{png:targetBase,region:full,source:target.imageId},"原始圖片");
      const layer=target.objects.get(id).layer;
      target.layers=[target.layers.find(l=>l.id===layer),...target.layers.filter(l=>l.id!==layer)];
      target.baseAsObject=true;
    }
    if(!source)return {created:[]};
    const layerMap=new Map(),idMap=new Map(),created=[];
    const prefix="複本 "+(source.fileName||source.imageId)+" · ";
    if(sourceBase)created.push(create("image",{png:sourceBase,region,source:source.imageId},prefix+"圖片"));
    for(const l of sourceState.layers){const next=moduleLayer(target,prefix+l.name+" "+(target.objectSeq??0),l.module);Object.assign(next,{author:l.author,opacity:l.opacity,visible:l.visible,locked:l.locked});layerMap.set(l.id,next.id);}
    for(const old of [...(sourceState.objects??[])].sort((a,b)=>(a.type==="axes-2d"?-1:0)-(b.type==="axes-2d"?-1:0))){
      if(old.visibility!=="public")continue;
      const p=structuredClone(old.props);
      if(p.frame)p.frame=idMap.get(p.frame);
      if(old.type==="axes-2d")p.region=rect(p.region??{x:.08,y:.07,x2:.96,y2:.9});
      if(old.type==="image")p.region=rect(p.region);
      if(old.type==="shape"&&(p.space??"canvas")==="canvas"){
        if(p.x!==undefined)Object.assign(p,point(p.x,p.y));
        if(p.x2!==undefined){const q=point(p.x2,p.y2);p.x2=q.x;p.y2=q.y;}
        if(p.points)p.points=p.points.map(([x,y])=>{const q=point(x,y);return [q.x,q.y];});
        if(p.r)p.r*=sx;
      }
      const id=create(old.type,p,prefix+"物件"),next=target.objects.get(id);
      if(layerMap.has(old.layer))next.layer=layerMap.get(old.layer);
      next.derivedFrom={image:source.imageId,object:old.id};idMap.set(old.id,id);created.push(id);
    }
    for(const old of sourceState.marks){
      const m=structuredClone(old);m.id="copy-"+(target.objectSeq??0)+"-"+m.id;
      while(target.marks.has(m.id))m.id="c"+m.id;
      Object.assign(m,point(old.x,old.y));
      if(old.x2!==undefined){const q=point(old.x2,old.y2);m.x2=q.x;m.y2=q.y;}
      if(old.points)m.points=old.points.map(q=>point(q.x,q.y));
      m.layer=layerMap.get(old.layer)??moduleLayer(target,prefix+"標註").id;
      m.derivedFrom={image:source.imageId,mark:old.id};
      if(m.evidence)m.evidence=m.evidence.map(e=>e.image===source.imageId&&e.region?{...e,image:target.imageId,region:[region.x+e.region[0]*sx,region.y+e.region[1]*sy,region.x+e.region[2]*sx,region.y+e.region[3]*sy]}:e);
      target.marks.set(m.id,m);
    }
    if(canvasMarks(target).length>500)throw Error("Too many marks in composed canvas");
    target.objectRender=null;
    return {created};
  }catch(error){restoreCanvas(target,before);throw error;}
}
