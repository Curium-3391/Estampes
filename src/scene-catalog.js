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

export const MARK_TYPES = Object.freeze(["point","rect","arrow","polyline"]);
export const MAX_POLYLINE_POINTS = 128;

// A polyline (e.g. a PCB trace or a freehand stroke) is its vertex list;
// x/y/x2/y2 become its bounding box so crops, zooms and process_image
// regions keep working. `smooth` draws a curve through the vertices and
// `closed` joins the last vertex back to the first (e.g. circling a part).
export function polylineWithBounds(points, { smooth, closed } = {}) {
  if(!Array.isArray(points)||points.length<2||points.length>MAX_POLYLINE_POINTS) {
    throw new Error("Polyline needs 2 to "+MAX_POLYLINE_POINTS+" points");
  }
  const clean=points.map(p=>{
    if(!p||![p.x,p.y].every(v=>Number.isFinite(v)&&v>=0&&v<=1)) throw new Error("Invalid polyline point");
    return {x:p.x,y:p.y};
  });
  const xs=clean.map(p=>p.x),ys=clean.map(p=>p.y);
  return {points:clean,x:Math.min(...xs),y:Math.min(...ys),x2:Math.max(...xs),y2:Math.max(...ys),
    ...(smooth===true?{smooth:true}:{}),...(closed===true?{closed:true}:{})};
}

// What the assistant concluded about a mark, shown beside it in the canvas.
// `status` is the assistant's own claim (inspected = it looked at pixels).
export const MARK_STATUSES = Object.freeze(["inspected","uncertain"]);
export function markFindings(mark) {
  const note=typeof mark.note==="string"?mark.note.trim().slice(0,200):"";
  return {...(note?{note}:{}),...(MARK_STATUSES.includes(mark.status)?{status:mark.status}:{})};
}

// Drawing style. Colour no longer tells who drew a mark; the label colour
// and author field still do. A highlighter is wide and translucent so the
// picture stays visible underneath.
export const MARK_COLORS = Object.freeze(["gold","blue","red","green","yellow","magenta","cyan","white","black"]);
export const MARK_SIZES = Object.freeze(["fine","thin","medium","thick"]);
export const MARK_PENS = Object.freeze(["pen","highlighter"]);
export function markStyle(mark) {
  return {
    ...(MARK_COLORS.includes(mark.color)?{color:mark.color}:{}),
    ...(MARK_SIZES.includes(mark.size)?{size:mark.size}:{}),
    ...(MARK_PENS.includes(mark.pen)?{pen:mark.pen}:{}),
  };
}

function checkAssistantMark(mark) {
  if(!mark || !MARK_TYPES.includes(mark.type)) {
    throw new Error("Unsupported annotation");
  }
  // Model input must not silently convert an earlier human mark into an AI
  // mark. This rejects known Estampes user-ID/label conventions; it is not
  // an authentication mechanism for arbitrary future annotations.
  if(/^user[-_]/i.test(mark.id) || /^YOU(?:\s|[-_]|$)/i.test(mark.label??"")) {
    throw new Error("User-authored mark must be passed via priorUserAnnotations");
  }
}

// Coordinate-only assistant mark, for any image (demo scene or real photo).
export function resolveCoordinateAnnotation(mark) {
  checkAssistantMark(mark);
  if(mark.targetId!==undefined) throw new Error("Named targets are not supported; give x/y coordinates");
  if(mark.type==="polyline") {
    return {id:mark.id,type:"polyline",label:mark.label,...polylineWithBounds(mark.points,mark),...markFindings(mark),...markStyle(mark),
      author:"assistant",grounding:"unverified"};
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
  return {id:mark.id,type:mark.type,label:mark.label,...markFindings(mark),...markStyle(mark),x:mark.x,y:mark.y,
    ...(mark.type==="point"?{}:{x2:mark.x2,y2:mark.y2}),
    author:"assistant",grounding:"unverified"};
}

export function resolveSceneAnnotation(scene, mark) {
  if(!sceneLandmarks[scene]) throw new Error("Unknown scene: "+scene);
  checkAssistantMark(mark);
  if(mark.targetId===undefined) return resolveCoordinateAnnotation(mark);
  const target=sceneLandmarks[scene][mark.targetId];
  if(!target) throw new Error("Unknown landmark "+mark.targetId+" for "+scene);
  if(mark.type==="arrow"||mark.type==="polyline") throw new Error("Arrows and polylines need explicit coordinates");
  // Occluded mountains do not have a tight rectangular visual footprint.
  // A coarse triangle-wide box would falsely include the foreground tree.
  if(mark.type==="rect" && mark.targetId.startsWith("mountain-")) {
    throw new Error("Mountains are occluded; use a point or future polygon mask, not a misleading bbox");
  }
  const geom=mark.type==="point"?target.point:target.box;
  return {id:mark.id,type:mark.type,label:mark.label,...markFindings(mark),...markStyle(mark),...geom,targetId:mark.targetId,author:"assistant",grounding:"scene-anchor"};
}

export function replayUserAnnotation(mark) {
  if(!mark || !MARK_TYPES.includes(mark.type)) {
    throw new Error("Invalid historical annotation");
  }
  const geometry=mark.type==="polyline"?polylineWithBounds(mark.points,mark):{};
  return {...mark,...geometry,author:"user",grounding:"replayed-unverified"};
}
