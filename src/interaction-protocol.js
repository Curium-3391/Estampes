// Estampes Annotation/Context Protocol v0.2-draft.
// Stable *demo* scene metadata only. Future user images need explicit
// content identity, crop transforms and a real raster pixel resolution.
export const PROTOCOL_VERSION = "0.2-draft";
export const INTENTS = Object.freeze([
  "point-out", "ask-about-region", "answer-question", "correct-assistant",
  "compare", "report-issue"
]);
export const INTENT_LABELS = Object.freeze({
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
  "point-out": "acknowledge-the-pointed-referent",
  "ask-about-region": "explain-selected-region",
  "answer-question": "treat-selection-as-answer-to-prior-question",
  "correct-assistant": "reconsider-prior-identification",
  "compare": "compare-marked-referents",
  "report-issue": "investigate-marked-problem",
});
const textValue=(value,max)=>String(value??"").trim().slice(0,max);
const in01=(n)=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1;

export function buildAnnotationEvent({scene,annotations,intent="point-out",note="",replyQuote=""}) {
  const metadata=SCENE_META[scene];
  if(!metadata) throw new Error("Unknown scene");
  if(!INTENTS.includes(intent)) throw new Error("Unknown intent");
  if(!Array.isArray(annotations)||annotations.length===0||annotations.length>30) {
    throw new Error("Expected 1 to 30 annotations");
  }
  const ids=new Set();
  const marks=annotations.map(raw=>{
    if(!raw || !["point","rect","arrow"].includes(raw.type)) throw new Error("Invalid annotation type");
    const id=textValue(raw.id,64);
    if(!id||ids.has(id))throw new Error("Missing or duplicate annotation ID");
    ids.add(id);
    if(!in01(raw.x)||!in01(raw.y))throw new Error("Invalid normalized point");
    if(raw.type!=="point"&&(!in01(raw.x2)||!in01(raw.y2))) {
      throw new Error("Invalid normalized endpoint");
    }
    return {
      id,author:"user",type:raw.type,
      geometry:{
        x:raw.x,y:raw.y,
        ...(raw.type==="point"?{}:{x2:raw.x2,y2:raw.y2})
      },
      ...(raw.type==="arrow"?{arrowhead:"end"}:{}),
      label:textValue(raw.label,64),
      grounding:"user-pointer",
    };
  });
  const cleanNote=textValue(note,500),cleanQuote=textValue(replyQuote,300);
  return {
    schemaVersion:PROTOCOL_VERSION,
    eventType:"annotation.submit",
    image:{
      id:metadata.id,
      revision:metadata.revision,
      kind:"svg",
      intrinsicSize:{width:metadata.width,height:metadata.height,unit:"svg-user-unit"},
      rasterPixelSize:null,
      pixelDensityDpi:null,
      coordinateSystem:{origin:"top-left",unit:"normalized",range:[0,1],orientation:"unrotated"},
      crop:null
    },
    annotations:marks,
    interaction:{
      intent,
      requestedAssistantAction: INTENT_ACTIONS[intent],
      userNote:cleanNote||null,
      replyTo:{
        messageId:null,
        quote:cleanQuote||null,
        provenance:cleanQuote?"user-entered":"unavailable"
      },
      arrowMeaning:"arrowhead-is-target",
      contextAvailability:"host-conversation-not-readable-by-widget"
    }
  };
}

export function formatAnnotationChatMessage(event) {
  if(event?.schemaVersion!==PROTOCOL_VERSION)throw new Error("Unsupported protocol version");
  const interaction=event.interaction;
  const lines=[
    "我透過 Estampes 在同一張畫布上做了視覺指認。",
    "這次的目的："+(INTENT_LABELS[interaction.intent]||"指出位置")+"。",
    "希望你做的事："+interaction.requestedAssistantAction+"。",
  ];
  if(interaction.userNote)lines.push("我的補充說明（使用者親自輸入）："+interaction.userNote);
  if(interaction.replyTo?.quote) {
    lines.push("我提供的前文引述（使用者自行填寫，非外掛讀取的聊天紀錄）："+interaction.replyTo.quote);
  }else{
    lines.push("沒有附上前文的精確引述；請依你在目前對話中實際可見的脈絡理解，不要捏造上一輪問題。");
  }
  lines.push(
    "點代表位置；框代表範圍；箭頭的終點（箭頭尖端）才是我指的對象，起點只表示指向方向。",
    "底圖為內建 SVG 示範場景，尺寸是 SVG 座標單位而非照片像素解析度。所有標註使用原圖左上角為原點的正規化座標。",
    "以下為 Estampes 的結構化標註事件（schemaVersion=0.2-draft）：",
    JSON.stringify(event),
    "請優先回應我所選的意圖與補充說明；若無法從可見內容確認物件或對話所指，請指出不確定之處，別把座標等同於已驗證的物件辨識。"
  );
  return lines.join("\n");
}
