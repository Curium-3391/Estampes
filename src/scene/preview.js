import { renderCanvas } from "./canvas-render.js";
export async function renderPreview(entry,{scratch=true,longSide=1000}={}){
  return renderCanvas(entry,{scratch,maxSide:longSide});
}
