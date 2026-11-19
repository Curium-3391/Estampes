// Estampes Annotation/Context Protocol v0.2-draft.
// Stable *demo* scene metadata only. Future user images need explicit
// content identity, crop transforms and a real raster pixel resolution.
import { MARK_TYPES, polylineWithBounds, markStyle } from "./scene-catalog.js";
import { gestureGroups } from "./gesture-groups.js";
import { t } from "./i18n/index.js";
export const PROTOCOL_VERSION = "0.2-draft";
export const INTENTS = Object.freeze([
  "free-annotate", "point-out", "ask-about-region", "answer-question", "correct-assistant",
  "compare", "report-issue"
]);
export const SCENE_META = Object.freeze({
  landscape: Object.freeze({id:"demo:landscape",revision:"svg-v1",width:640,height:360}),
  shapes: Object.freeze({id:"demo:shapes",revision:"svg-v1",width:640,height:360}),
  formula: Object.freeze({id:"demo:formula",revision:"svg-v1",width:640,height:360}),
});
export const INTENT_ACTIONS = Object.freeze({
  "free-annotate": "interpret-annotation",
  "point-out": "acknowledge-the-pointed-referent",
  "ask-about-region": "explain-selected-region",
  "answer-question": "treat-selection-as-answer-to-prior-question",
  "correct-assistant": "reconsider-prior-identification",
  "compare": "compare-marked-referents",
  "report-issue": "investigate-marked-problem",
});
// A mark's type is what was drawn, never what it means. Only the explicit
// point-out mode says an arrowhead is the referent; otherwise an arrow may
// be a pointer, a direction, a flow or a movement, and the user's note,
// the image and the conversation decide.
export const ARROW_HINTS = Object.freeze(["unspecified", "point-to-target"]);
export const arrowHintFor = (intent) => intent === "point-out" ? "point-to-target" : "unspecified";
const HEADINGS = ["right", "up-right", "up", "up-left", "left", "down-left", "down", "down-right"];
// Direction in image pixels (normalized coordinates stretch with the aspect
// ratio). angleDeg: 0 = right, 90 = up, counter-clockwise.
export function arrowDirection(g, width, height) {
  const dx = (g.x2 - g.x) * width, dy = (g.y - g.y2) * height;
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  return { heading: HEADINGS[Math.round(angle / 45) % 8], angleDeg: Math.round(angle),
    lengthPx: Math.round(Math.hypot(dx, dy)), provenance: "computed-from-geometry" };
}
const textValue=(value,max)=>String(value??"").trim().slice(0,max);
// Low-level drawing facts from the widget: order within this send, time
// relative to the first stroke of the send (no clock time), input device.
const msValue=(n)=>Number.isInteger(n)&&n>=0&&n<=36e5?n:undefined;
function strokeFacts(raw){
  const facts={
    order:Number.isInteger(raw.strokeOrder)&&raw.strokeOrder>0?raw.strokeOrder:undefined,
    relativeStartMs:msValue(raw.relativeStartMs),relativeEndMs:msValue(raw.relativeEndMs),
    pointerType:["mouse","pen","touch"].includes(raw.pointerType)?raw.pointerType:undefined,
  };
  for(const k of Object.keys(facts))if(facts[k]===undefined)delete facts[k];
  return Object.keys(facts).length?{stroke:facts}:{};
}
const in01=(n)=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1;

// `image` describes a real photo loaded with load_image:
// {imageId, width, height}. Otherwise `scene` names a bundled demo SVG.
// `pairImage` (same shape as `image`) makes it a paired view: each mark's
// `side` says which of the two images its coordinates belong to.
// `workspace` ({id, items:[{id, imageId, width, height, label?}]}) makes it a
// workspace view: each mark's `item` names the image it is on.
export function buildAnnotationEvent({scene,image,pairImage,workspace,annotations,intent="free-annotate",note="",replyQuote="",gestureDecisions=[]}) {
  if(pairImage&&!image) throw new Error("A paired view needs two photos");
  const metadata=image
    ? {id:image.imageId,revision:"raster-v1",width:image.width,height:image.height,kind:"raster"}
    : SCENE_META[scene];
  if(!metadata) throw new Error("Unknown scene");
  if(!INTENTS.includes(intent)) throw new Error("Unknown intent");
  if(!Array.isArray(annotations)||annotations.length===0||annotations.length>30) {
    throw new Error("Expected 1 to 30 annotations");
  }
  const ids=new Set();
  const marks=annotations.map(raw=>{
    if(!raw || !MARK_TYPES.includes(raw.type)) throw new Error("Invalid annotation type");
    const id=textValue(raw.id,64);
    if(!id||ids.has(id))throw new Error("Missing or duplicate annotation ID");
    ids.add(id);
    const note=typeof raw.note==="string"?raw.note.slice(0,200):"";
    const details=note?{note}:{};
    // focus = what this submission is about; context = earlier marks kept
    // only as background. Missing role means focus.
    const role=raw.role==="context"?"context":"focus";
    const side=workspace?{item:workspace.items.some(it=>it.id===raw.item)?raw.item:workspace.items[0].id}
      :pairImage?{side:raw.side==="right"?"right":"left"}:{};
    if(raw.type==="polyline") {
      return {id,author:"user",type:"polyline",role,...side,...markStyle(raw),geometry:polylineWithBounds(raw.points,raw),
        ...strokeFacts(raw),...details,label:textValue(raw.label,64),grounding:"user-pointer"};
    }
    if(!in01(raw.x)||!in01(raw.y))throw new Error("Invalid normalized point");
    if(raw.type!=="point"&&(!in01(raw.x2)||!in01(raw.y2))) {
      throw new Error("Invalid normalized endpoint");
    }
    const geometry={x:raw.x,y:raw.y,...(raw.type==="point"?{}:{x2:raw.x2,y2:raw.y2})};
    const dims=side.side==="right"?pairImage:{width:metadata.width,height:metadata.height};
    return {
      id,author:"user",type:raw.type,role,...side,...markStyle(raw),
      geometry,
      ...(raw.type==="arrow"?{arrowhead:"end",semanticHint:arrowHintFor(intent),
        direction:arrowDirection(geometry,dims.width,dims.height)}:{}),
      ...strokeFacts(raw),...details,
      label:textValue(raw.label,64),
      grounding:"user-pointer",
    };
  });
  if(!marks.some(m=>m.role==="focus"))for(const m of marks)m.role="focus";
  // Candidate groups per image, on the raw normalized marks. Only groups
  // that touch this send's focus marks are reported.
  const focusIds=new Set(marks.filter(m=>m.role==="focus").map(m=>m.id));
  const sides=pairImage?[["left",image],["right",pairImage]]:[[null,{width:metadata.width,height:metadata.height}]];
  const groups=sides.flatMap(([which,dims])=>{
    const own=annotations.filter(a=>!which||(a.side==="right"?"right":"left")===which);
    return gestureGroups(own,dims,gestureDecisions).map(g=>which?{...g,side:which}:g);
  }).filter(g=>g.memberIds.some(id=>focusIds.has(id)));
  const cleanNote=textValue(note,500),cleanQuote=textValue(replyQuote,300);
  return {
    schemaVersion:PROTOCOL_VERSION,
    eventType:"annotation.submit",
    image:{
      id:metadata.id,
      revision:metadata.revision,
      kind:metadata.kind??"svg",
      intrinsicSize:{width:metadata.width,height:metadata.height,unit:metadata.kind==="raster"?"pixel":"svg-user-unit"},
      rasterPixelSize:metadata.kind==="raster"?{width:metadata.width,height:metadata.height}:null,
      pixelDensityDpi:null,
      coordinateSystem:{origin:"top-left",unit:"normalized",range:[0,1],orientation:"unrotated"},
      crop:null
    },
    ...(pairImage?{pair:{
      left:{id:image.imageId,width:image.width,height:image.height},
      right:{id:pairImage.imageId,width:pairImage.width,height:pairImage.height},
    }}:{}),
    ...(workspace?{workspace:{id:workspace.id,items:workspace.items.map(it=>({id:it.id,imageId:it.imageId,width:it.width,height:it.height,...(it.label?{label:it.label}:{})}))}}:{}),
    annotations:marks,
    ...(groups.length?{gestureGroups:groups}:{}),
    interaction:{
      intent,
      requestedAssistantAction: INTENT_ACTIONS[intent],
      userNote:cleanNote||null,
      replyTo:{
        messageId:null,
        quote:cleanQuote||null,
        provenance:cleanQuote?"user-entered":"unavailable"
      },
      // Kept for older readers; per-arrow semanticHint is the real field.
      arrowMeaning:intent==="point-out"?"arrowhead-is-target":"unspecified",
      semanticsPolicy:"geometry-is-not-intent",
      contextAvailability:"host-conversation-not-readable-by-widget"
    }
  };
}

// User-voice messages (RFC class T2). The chat shows the message as the
// person's own words, so it opens with a short sentence in their language
// (`locale`); the person's own text (notes, quote) is passed through as typed.
// The block that follows is for the assistant: English and the same in every
// language, so the model reads the same instructions and the same event
// whatever language the person uses. Nothing in the block is translated.
const MEANING_EN={"direction-arrow":"a direction arrow","connected-path":"a path drawn in pieces","unknown":"one gesture of unclear meaning"};
const CONFIRM_EN={"unconfirmed":"inferred from geometry, not confirmed by the person","user-confirmed":"the person confirmed it is one gesture","user-rejected":"the person said these are not one gesture; read them separately"};
export const ASSISTANT_BLOCK_HEADER="--- Estampes annotation, for the assistant ---";

function arrowLines(event) {
  const arrows=event.annotations.filter(m=>m.type==="arrow"&&m.role!=="context");
  if(!arrows.length)return [];
  const dir=arrows.map(m=>(m.label||m.id)+(m.direction?": "+m.direction.heading+" ("+m.direction.angleDeg+"°)":"")).join("; ");
  if(event.interaction.intent==="point-out")return [
    "Arrows: "+dir+". The person chose \"point out this position\", so each arrowhead (x2,y2) is the referent and the start (x,y) shows the direction it points from (semanticHint=point-to-target). If the person's note says something else (a direction, a flow, a movement), follow the note and tell the person the two disagree."
  ];
  return [
    "Arrows: "+dir+". Each keeps its start (x,y), tip (x2,y2) and direction; semanticHint=unspecified means the person did not say whether it points at something or shows a direction, flow, movement or relation.",
    "Follow the person's note: if it talks about a direction, flow, course or movement, read the arrow as a direction (start to tip) and discuss that claim first, using the tip only to locate the area; only when the person asks what the arrow points at is the tip the referent. With no note and no clear reading, briefly list the possible readings and ask at most once; do not assume a single meaning.",
  ];
}

function gestureLines(event){
  const groups=event.gestureGroups??[];
  if(!groups.length)return [];
  const name=new Map(event.annotations.map(m=>[m.id,m.label||m.id]));
  return [
    "These strokes may belong to one gesture (gestureGroups). Each stroke is still its own annotation; a group is only a candidate, and provenance=system-inferred means Estampes inferred it from where the strokes meet and when they were drawn, not from what the person meant:",
    ...groups.map(g=>"- "+g.id+": "+g.memberIds.map(id=>name.get(id)??id).join(" + ")+" -> possibly "+(MEANING_EN[g.proposedMeaning]??g.proposedMeaning)+
      (g.arrow?" ("+g.arrow.direction.heading+", tip near x="+g.arrow.tip.x+", y="+g.arrow.tip.y+")":"")+
      "; "+(CONFIRM_EN[g.confirmation]??g.confirmation)+(g.evidence?.length?"; cues: "+g.evidence.join(", "):"")+"."),
    "Treat unconfirmed groups as possibilities: do not present them as what the person meant, and do not treat each stroke as a separate question. Ask once only when whether they are one gesture would clearly change the answer.",
  ];
}

const READ_GUIDE="Choose how to look by the question: for drawings, Graph or mixed canvases use render_canvas with the request in the event's canvasReads for that item or side (it carries expectedRevision and hiddenLayers); region can be the focus marks plus a margin. STALE_CANVAS means the canvas changed after this send: do not present the latest state as what the person saw. Use process_image only for small text and detail in photos (base image only, no strokes or objects); for formula questions read get_visual_state first. No fixed crop or filter is needed when the pixels already suffice.";
const NO_RECOGNITION="Estampes provides pixels and coordinates only; it does not recognise objects. If you cannot see the returned image, say so instead of guessing from coordinates.";

// The person's sentence, in their language. Only their own text and the
// intent label appear; how to read the marks is in the assistant block.
export function annotationSummary(event,locale){
  const interaction=event.interaction;
  const name=m=>m.label||m.id;
  const focus=event.annotations.filter(m=>m.role!=="context");
  const lines=[t("msg.annotate.summary",{count:focus.length,intent:t("msg.intent."+interaction.intent,undefined,locale)},locale)];
  for(const m of focus)if(m.note)lines.push(t("msg.annotate.markNote",{name:name(m),note:m.note},locale));
  if(interaction.userNote)lines.push(t("msg.annotate.note",{note:interaction.userNote},locale));
  if(interaction.replyTo?.quote)lines.push(t("msg.annotate.quote",{quote:interaction.replyTo.quote},locale));
  return lines.join("\n");
}

// The assistant block: English, locale-invariant.
export function annotationAssistantBlock(event) {
  if(event?.schemaVersion!==PROTOCOL_VERSION)throw new Error("Unsupported protocol version");
  const interaction=event.interaction;
  const name=m=>m.label||m.id;
  const focus=event.annotations.filter(m=>m.role!=="context"),context=event.annotations.filter(m=>m.role==="context");
  const lines=[
    ASSISTANT_BLOCK_HEADER,
    "The lines above are the person's own message, in their language. This block is the same in every language: read the marks from it.",
    "The person made a visual annotation on a shared Estampes canvas. Intent: "+interaction.intent+". Requested action: "+interaction.requestedAssistantAction+".",
    "This send is about: "+focus.map(name).join(", ")+" (role=focus)."+
      (context.length?" Other marks ("+context.map(name).join(", ")+", role=context) were drawn earlier and are background only, unless the person mentions them.":""),
    "Mark notes, the person's note (interaction.userNote) and the quote (interaction.replyTo.quote) were typed by the person. The quote is the person's own, not read from the chat history.",
  ];
  if(!interaction.replyTo?.quote)lines.push("No exact quote of an earlier turn was given: rely on what you can actually see in this conversation and do not invent the previous question.");
  lines.push(
    "A mark's type only describes the shape that was drawn, not what it means. Combine the person's note, the intent, the image and the conversation; do not let the shape override what the person wrote.",
    ...arrowLines(event),
    ...gestureLines(event),
    "A point is a position; a box is an extent; a polyline is a path the person drew or traced (a route, a loop), joined in points order (smooth = curve, closed = loop), with x/y/x2/y2 as its bounding box. pen=highlighter is a translucent highlighter meaning \"this area\", not a precise line; color is only the colour the person picked.",
    ...(event.workspace?[
      "The base is a workspace (workspaceId="+event.workspace.id+") of "+event.workspace.items.length+" separate images side by side, not overlaid: "+
        event.workspace.items.map(it=>it.id+" = imageId "+it.imageId+" ("+it.width+"x"+it.height+(it.label?", "+it.label:"")+")").join("; ")+". Each mark's item names its image; coordinates are normalized to that image's top-left corner.",
      "Estampes structured annotation event (schemaVersion=0.2-draft):",
      JSON.stringify(event),
      READ_GUIDE,
      "The person's marks are stored on their images in this workspace. After answering, use present_visual (workspaceId="+event.workspace.id+") findings (with item) to attach note and status to the person's mark ids, and links (fromItem/from, toItem/to) when marks on different images are the same thing; do not redraw the person's marks. Do not mention tool names to the person.",
      NO_RECOGNITION,
    ]:event.pair?[
      "Each mark uses the imageId of its side (left="+event.pair.left.id+", right="+event.pair.right.id+").",
      "The base is a side-by-side view of two separate canvases, not overlaid: left imageId="+event.pair.left.id+" ("+event.pair.left.width+"x"+event.pair.left.height+"), right imageId="+event.pair.right.id+" ("+event.pair.right.width+"x"+event.pair.right.height+"). Each mark's side (left or right) names its image; coordinates are normalized to that image's top-left corner.",
      "Estampes structured annotation event (schemaVersion=0.2-draft):",
      JSON.stringify(event),
      READ_GUIDE,
      "The person's marks are stored in this pair. After answering, use present_visual (imageId="+event.pair.left.id+", pairImageId="+event.pair.right.id+") findings to attach note and status to the person's mark ids, and links when a left and a right mark are the same thing; do not redraw the person's marks. Do not mention tool names to the person.",
      NO_RECOGNITION,
    ]:event.image.kind==="raster"?[
      "This canvas can hold an image, drawings and scene objects (imageId="+event.image.id+", "+event.image.intrinsicSize.width+"x"+event.image.intrinsicSize.height+" pixels, EXIF-rotated). All marks use coordinates normalized to the image's top-left corner.",
      "Estampes structured annotation event (schemaVersion=0.2-draft):",
      JSON.stringify(event),
      READ_GUIDE,
      "The person's marks are stored on this canvas (id above). After answering, use present_visual (same imageId) findings to attach a note (for example a part number you read) and status to the person's mark ids; do not redraw the person's marks. Do not mention tool names to the person.",
      NO_RECOGNITION,
    ]:[
      "The base is a built-in SVG demo scene; sizes are SVG user units, not photo pixels. All marks use coordinates normalized to the top-left corner.",
      "Estampes structured annotation event (schemaVersion=0.2-draft):",
      JSON.stringify(event),
      "First use Estampes inspect_visual to look at the base image and the marked areas before explaining what the person points at. Arguments: scene="+event.image.id.replace(/^demo:/,"")+", imageId="+event.image.id+", revision="+event.image.revision+"; focus from each mark's type and geometry.x/y/x2/y2, one call per mark when needed.",
      "Estampes provides pixels, crops and positions only; it does not recognise objects. If the host cannot give the tool's image blocks to a vision model, say so instead of guessing from coordinates or the scene name.",
      "If the person needs to see the image or marks, use present_visual on the same canvas to switch the annotated, original and zoom views; do not also call present_visual_evidence (a separate viewer kept for older chats). inspect_visual gives pixels to the model only and opens no view.",
    ]),
    "Answer the person's chosen intent and note first; if you cannot be sure of the object or of what the conversation refers to, say what is uncertain."
  );
  return lines.join("\n");
}

// The text posted as the person: their sentence, a blank line, the block.
export function formatAnnotationChatMessage(event,{locale}={}) {
  const block=annotationAssistantBlock(event);
  return annotationSummary(event,locale)+"\n\n"+block;
}
