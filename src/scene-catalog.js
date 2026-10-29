// Semantic anchors for the **built-in SVG samples only**.
// This is deterministic scene geometry, NOT image recognition.
// Coordinates are source-image-normalized [0,1] with origin top-left.
export const sceneIds = ["landscape","shapes","formula"];
const p=(x,y)=>({x:x/640,y:y/360});
const rect=(x,y,x2,y2)=>({x:x/640,y:y/360,x2:x2/640,y2:y2/360});
const spot=(point,box)=>({point,box});

export const sceneLandmarks = Object.freeze({
  landscape: Object.freeze({
    sun: spot(p(508,73),rect(469,34,547,112)),
    house: spot(p(160,265),rect(67,155,252,324)),
    "house-roof": spot(p(159,194),rect(67,155,252,233)),
    tree: spot(p(525,177),rect(446,108,594,316)),
    "mountain-left": spot(p(167,139),rect(0,72,324,255)),
    // Chosen from visible dark teal mountain, away from the foreground tree.
    "mountain-right": spot(p(360,130),rect(188,45,562,252)),
  }),
  shapes: Object.freeze({
    circle: spot(p(157,154),rect(85,82,229,226)),
    square: spot(p(362,155),rect(296,89,428,221)),
    triangle: spot(p(565,190),rect(495,95,633,240)),
  }),
  formula: Object.freeze({
    equation: spot(p(320,158),rect(111,105,533,214)),
    "equals-sign": spot(p(248,157),rect(210,120,286,187)),
  }),
});

export const landmarkIds = [...new Set(
  Object.values(sceneLandmarks).flatMap(scene=>Object.keys(scene))
)].sort();

export function resolveSceneAnnotation(scene, mark) {
  if(!sceneLandmarks[scene]) throw new Error("Unknown scene: "+scene);
  if(!mark || !["point","rect","arrow"].includes(mark.type)) {
    throw new Error("Unsupported annotation");
  }
  const base={id:mark.id,type:mark.type,label:mark.label};
  if(mark.targetId!==undefined) {
    const target=sceneLandmarks[scene][mark.targetId];
    if(!target) throw new Error("Unknown landmark "+mark.targetId+" for "+scene);
    if(mark.type==="arrow") throw new Error("Arrows need explicit start and end coordinates");
    const geom=mark.type==="point"?target.point:target.box;
    return {...base,...geom,targetId:mark.targetId,author:"assistant",grounding:"scene-anchor"};
  }
  if(!Number.isFinite(mark.x)||!Number.isFinite(mark.y)||
     mark.x<0||mark.x>1||mark.y<0||mark.y>1) {
    throw new Error("Invalid ungrounded coordinates");
  }
  if(mark.type!=="point"&&
     (!Number.isFinite(mark.x2)||!Number.isFinite(mark.y2)||
      mark.x2<0||mark.x2>1||mark.y2<0||mark.y2>1)) {
    throw new Error("Invalid endpoint");
  }
  return {...base,x:mark.x,y:mark.y,
    ...(mark.type==="point"?{}:{x2:mark.x2,y2:mark.y2}),
    author:"assistant",grounding:"unverified"};
}

export function replayUserAnnotation(mark) {
  if(!mark || !["point","rect","arrow"].includes(mark.type)) {
    throw new Error("Invalid historical annotation");
  }
  return {...mark,author:"user",grounding:"replayed-unverified"};
}
