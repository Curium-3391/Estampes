// Estampes Annotation/Context Protocol v0.2-draft.
// Stable *demo* scene metadata only. Future user images need explicit
// content identity, crop transforms and a real raster pixel resolution.
import { MARK_TYPES, polylineWithBounds, markStyle } from "./scene-catalog.js";
import { gestureGroups } from "./gesture-groups.js";
export const PROTOCOL_VERSION = "0.2-draft";
export const INTENTS = Object.freeze([
  "free-annotate", "point-out", "ask-about-region", "answer-question", "correct-assistant",
  "compare", "report-issue"
]);
export const INTENT_LABELS = Object.freeze({
  "free-annotate": "自由標註（意思以我的補充說明和畫面為準）",
  "point-out": "我想指出這個位置",
  "ask-about-region": "請解釋我標記的區域",
  "answer-question": "我正在回答你先前的問題",
  "correct-assistant": "我要更正你先前的指認",
  "compare": "請比較我標記的東西",
  "report-issue": "我想指出這裡的問題",
});
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
const HEADINGS_ZH = { right: "由左往右", "up-right": "往右上", up: "由下往上", "up-left": "往左上",
  left: "由右往左", "down-left": "往左下", down: "由上往下", "down-right": "往右下" };
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
    // focus = what this submission is about; context = earlier marks kept
    // only as background. Missing role means focus.
    const role=raw.role==="context"?"context":"focus";
    const side=workspace?{item:workspace.items.some(it=>it.id===raw.item)?raw.item:workspace.items[0].id}
      :pairImage?{side:raw.side==="right"?"right":"left"}:{};
    if(raw.type==="polyline") {
      return {id,author:"user",type:"polyline",role,...side,...markStyle(raw),geometry:polylineWithBounds(raw.points,raw),
        ...strokeFacts(raw),label:textValue(raw.label,64),grounding:"user-pointer"};
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
      ...strokeFacts(raw),
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

function arrowLines(event) {
  const arrows=event.annotations.filter(m=>m.type==="arrow"&&m.role!=="context");
  if(!arrows.length)return [];
  const dir=arrows.map(m=>(m.label||m.id)+(m.direction?"："+(HEADINGS_ZH[m.direction.heading]||m.direction.heading)+"（"+m.direction.angleDeg+"°）":"")).join("、");
  if(event.interaction.intent==="point-out")return [
    "箭頭："+dir+"。這次我選了「只是指出這裡」，所以箭頭尖端（x2,y2）是我指的對象，起點（x,y）表示從哪個方向指過去（semanticHint=point-to-target）。但如果我的補充說明表達了別的意思（例如方向、流向、移動），以我的文字為準，並告訴我兩者不一致。"
  ];
  return [
    "箭頭："+dir+"。每支箭頭都保留起點（x,y）、尖端（x2,y2）與方向；semanticHint=unspecified，表示我沒有說它是「指向某個東西」還是「表示方向、流向、移動或關係」。",
    "請依我的補充說明判斷：如果我說的是方向、流向、走向或移動，就把箭頭當成方向（起點到尖端），先討論這個方向的說法，尖端位置只用來判斷我大概在講哪一區；如果我問「指到的是什麼」，才以尖端位置為準。沒有文字又看不出來時，簡短列出可能的解讀，必要時只問一次，不要假設只有一種意思。",
  ];
}

const MEANING_ZH={"direction-arrow":"一支方向箭頭","connected-path":"一條分段畫的連續路徑","unknown":"同一個手勢（意思不明）"};
const CONFIRM_ZH={"unconfirmed":"系統依幾何推測，我沒有確認","user-confirmed":"我確認過是同一個手勢","user-rejected":"我說過它們不是同一個手勢，請分開看"};
function gestureLines(event){
  const groups=event.gestureGroups??[];
  if(!groups.length)return [];
  const name=new Map(event.annotations.map(m=>[m.id,m.label||m.id]));
  const HEAD={right:"往右",["up-right"]:"往右上",up:"往上",["up-left"]:"往左上",left:"往左",["down-left"]:"往左下",down:"往下",["down-right"]:"往右下"};
  return [
    "下面幾筆可能屬於同一個手勢（gestureGroups）。每一筆仍是獨立的標註；分組只是候選，provenance=system-inferred 是 Estampes 依筆畫相接位置"+"與繪製時間推測的，不代表我的意思：",
    ...groups.map(g=>"- "+g.id+"："+g.memberIds.map(id=>name.get(id)??id).join(" + ")+" → 可能是"+(MEANING_ZH[g.proposedMeaning]??g.proposedMeaning)+
      (g.arrow?"（"+(HEAD[g.arrow.direction.heading]??g.arrow.direction.heading)+"，尖端約在 x="+g.arrow.tip.x+", y="+g.arrow.tip.y+"）":"")+
      "；"+(CONFIRM_ZH[g.confirmation]??g.confirmation)+(g.evidence?.length?"；線索："+g.evidence.join("、"):"")+"。"),
    "未確認的分組請當成可能性考慮，不要說成我確定的意思，也不要把每一筆都當成各自獨立的問題；只有在「是不是同一個手勢」會明顯改變答案時，才問我一次。",
  ];
}

export function formatAnnotationChatMessage(event) {
  if(event?.schemaVersion!==PROTOCOL_VERSION)throw new Error("Unsupported protocol version");
  const interaction=event.interaction;
  const lines=[
    "我透過 Estampes 在同一張畫布上做了視覺指認。",
    "這次的目的："+(INTENT_LABELS[interaction.intent]||"指出位置")+"。",
    "希望你做的事："+interaction.requestedAssistantAction+"。",
  ];
  const name=m=>m.label||m.id;
  const focus=event.annotations.filter(m=>m.role!=="context"),context=event.annotations.filter(m=>m.role==="context");
  lines.push("這次我問的是："+focus.map(name).join("、")+"（role=focus）。"+
    (context.length?"其他標記（"+context.map(name).join("、")+"，role=context）是之前畫的，只當背景，除非我提到否則不用分析。":""));
  if(interaction.userNote)lines.push("我的補充說明（使用者親自輸入）："+interaction.userNote);
  if(interaction.replyTo?.quote) {
    lines.push("我提供的前文引述（使用者自行填寫，非外掛讀取的聊天紀錄）："+interaction.replyTo.quote);
  }else{
    lines.push("沒有附上前文的精確引述；請依你在目前對話中實際可見的脈絡理解，不要捏造上一輪問題。");
  }
  lines.push(
    "標註的 type 只描述我畫了什麼形狀，不代表我的意思；意思請綜合我的補充說明、這次的目的、畫面和對話判斷，不要讓形狀蓋過我寫的文字。",
    ...arrowLines(event),
    ...gestureLines(event),
    "點代表位置；框代表範圍；折線是我手繪或描的路徑（例如走線、圈選），依 points 順序連接（smooth=平滑曲線，closed=首尾相連的圈），x/y/x2/y2 是它的外框。pen=highlighter 是半透明螢光筆，代表「這一片區域」而不是精確的線；color 只是我選的顏色，不代表其他意思。",
    ...(event.workspace?[
      "底圖是一個工作區（workspaceId="+event.workspace.id+"），裡面有 "+event.workspace.items.length+" 張不同的圖片並排、不疊合："+
        event.workspace.items.map(it=>it.id+" = imageId "+it.imageId+"（"+it.width+"×"+it.height+(it.label?"，"+it.label:"")+"）").join("；")+"。每個標註的 item 表示它在哪張圖上，座標以那張圖的左上角為原點正規化。",
      "以下為 Estampes 的結構化標註事件（schemaVersion=0.2-draft）：",
      JSON.stringify(event),
      "依問題選擇讀取方式：手繪、Graph 或混合畫布用 render_canvas，參數採事件 canvasReads 中對應 item／side 的 request（含 expectedRevision 與 hiddenLayers），region 可取整組 focus 加周圍留白。若回報 STALE_CANVAS，說明狀態已變更，不要把最新版當成送出時畫面。照片小字與細節才用 process_image（只有底圖，不含筆畫或物件）；公式問題可先讀 get_visual_state。已有足夠像素時不必固定裁切，也不必固定套濾鏡。",
      "我的標記已存進這個工作區各自的圖片。回答後請用 present_visual（workspaceId="+event.workspace.id+"）的 findings（附 item）把 note 與 status 掛到我的標記 id 上，需要時用 links（fromItem/from、toItem/to）記錄不同圖上哪兩個標記是同一個東西，不要重畫我的標記。不要對我提工具名稱。",
      "Estampes 只提供像素與座標，不會替你辨識物件。若你看不到回傳的圖片，請誠實告知，不要只靠座標猜測。",
    ]:event.pair?[
      "每個標記用它 side 對應的 imageId（left="+event.pair.left.id+"，right="+event.pair.right.id+"）。",
      "底圖是左右對照畫布，兩張不同的畫布並排、不疊合：左圖 imageId="+event.pair.left.id+"（"+event.pair.left.width+"×"+event.pair.left.height+"），右圖 imageId="+event.pair.right.id+"（"+event.pair.right.width+"×"+event.pair.right.height+"）。每個標註的 side（left／right）表示它在哪張圖上，座標以那張圖的左上角為原點正規化。",
      "以下為 Estampes 的結構化標註事件（schemaVersion=0.2-draft）：",
      JSON.stringify(event),
      "依問題選擇讀取方式：手繪、Graph 或混合畫布用 render_canvas，參數採事件 canvasReads 中對應 item／side 的 request（含 expectedRevision 與 hiddenLayers），region 可取整組 focus 加周圍留白。若回報 STALE_CANVAS，說明狀態已變更，不要把最新版當成送出時畫面。照片小字與細節才用 process_image（只有底圖，不含筆畫或物件）；公式問題可先讀 get_visual_state。已有足夠像素時不必固定裁切，也不必固定套濾鏡。",
      "我的標記已存進這組對照畫布。回答後請用 present_visual（imageId="+event.pair.left.id+"，pairImageId="+event.pair.right.id+"）的 findings 把 note 與 status 掛到我的標記 id 上，需要時用 links 記錄左右哪兩個標記是同一個東西，不要重畫我的標記。不要對我提工具名稱。",
      "Estampes 只提供像素與座標，不會替你辨識物件。若你看不到回傳的圖片，請誠實告知，不要只靠座標猜測。",
    ]:event.image.kind==="raster"?[
      "這是可包含圖片、手繪與場景物件的畫布（imageId="+event.image.id+"，"+event.image.intrinsicSize.width+"×"+event.image.intrinsicSize.height+" 像素，已依 EXIF 轉正）。所有標註使用原圖左上角為原點的正規化座標。",
      "以下為 Estampes 的結構化標註事件（schemaVersion=0.2-draft）：",
      JSON.stringify(event),
      "依問題選擇讀取方式：手繪、Graph 或混合畫布用 render_canvas，參數採事件 canvasReads 中對應 item／side 的 request（含 expectedRevision 與 hiddenLayers），region 可取整組 focus 加周圍留白。若回報 STALE_CANVAS，說明狀態已變更，不要把最新版當成送出時畫面。照片小字與細節才用 process_image（只有底圖，不含筆畫或物件）；公式問題可先讀 get_visual_state。已有足夠像素時不必固定裁切，也不必固定套濾鏡。",
      "我的標記已存進這張畫布（id 如上）。回答後請用 present_visual（imageId 同上）的 findings 把 note（例如讀到的型號）與 status 掛到我的標記 id 上，不要重畫我的標記。不要對我提工具名稱。",
      "Estampes 只提供像素與座標，不會替你辨識物件。若你看不到回傳的圖片，請誠實告知，不要只靠座標猜測。",
    ]:[
      "底圖為內建 SVG 示範場景，尺寸是 SVG 座標單位而非照片像素解析度。所有標註使用原圖左上角為原點的正規化座標。",
      "以下為 Estampes 的結構化標註事件（schemaVersion=0.2-draft）：",
      JSON.stringify(event),
      "請先使用 Estampes 的 inspect_visual 工具檢視實際底圖與我標註的局部影像，再解釋我指的東西；參數：scene="+event.image.id.replace(/^demo:/,"")+", imageId="+event.image.id+", revision="+event.image.revision+"；focus 請使用各標註的 type 與 geometry.x/y/x2/y2，必要時每個標註分別呼叫一次。",
      "Estampes 只提供像素、裁切與位置，不會替你辨識物件。若宿主無法將工具回傳的 image blocks 提供給視覺模型，請誠實告知，而不是只靠座標或場景名稱猜物件。",
      "若使用者需要看圖或標註，請使用 present_visual 在同一張畫布切換標註／原圖／局部放大；不要再額外呼叫 present_visual_evidence（那是相容舊對話的獨立檢視器）。inspect_visual 只提供給模型像素，不開啟畫面。",
    ]),
    "請優先回應我所選的意圖與補充說明；若不能確認物件或對話所指，請指出不確定之處。"
  );
  return lines.join("\n");
}
