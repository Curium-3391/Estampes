export const id = (prefix, n = 1) => prefix + ":" + n.toString(16).padStart(8,"0") + "-0000-4000-8000-000000000001";
export const HASH = "a".repeat(64), TIME = "2026-11-01T00:00:00Z";
export const asset = () => ({ assetId: "asset:sha256:" + HASH, legacyImageId: "img:" + HASH.slice(0,16) });
export const provenance = (kind = "user") => {
  const principal = kind === "module" ? { kind, moduleId: "org.estampes.graph", publisherFingerprint: HASH, ownershipLineageId: id("lineage"), version: "1.0.0", packageDigest: "b".repeat(64) } : { kind, principalId: "owner:local" };
  return { author: kind, createdBy: structuredClone(principal), createdAt: TIME, lastEditedBy: structuredClone(principal), lastEditedAt: TIME,
    ownership: kind === "module" ? { kind, moduleId: principal.moduleId, publisherFingerprint: HASH, ownershipLineageId: id("lineage") } : { kind: "instance", ownerId: "owner:local" },
    grounding: kind === "user" ? "user-pointer" : "unverified", editedByUser: false, sourceTrust: "local" };
};
export function document(n = 1) {
  return { schema: "estampes.document/1", id: id("doc",n), kind: "graph", title: "Graph", revision: 1, state: "active", persistence: "memory",
    createdAt: TIME, updatedAt: TIME, defaultSceneId: id("scene",n), bindings: [], annotationSupport: "shared-v1", provenance: { createdBy: "user" },
    scenes: [{ id: id("scene",n), documentId: id("doc",n), revision: 1, extent: { width: 1600, height: 1000, unit: "du" }, background: { kind: "solid", color: "white" },
      layers: [], objects: [], annotations: [], frames: [], gestureDecisions: [], rejections: [], interactionEvents: [], undo: { entries: [] }, tombstones: [] }] };
}
export function populated(n = 1) {
  const d = document(n), s = d.scenes[0];
  s.layers = [{ id: "L1", author: "user", name: "Ink", opacity: 0, visible: true, locked: true, content: [{kind:"object",id:"o1"},{kind:"annotation",id:id("ann")}]}];
  s.objects = [{ id: "o1", type: "axes-2d", revision: 1, props: { xRange: [-10,10], yRange: [-10,10] }, layerId: "L1", visibility: "public", provenance: provenance("module") }];
  s.frames = [{ id: "axes:o1", kind: "axes", ownerObjectId: "o1" }];
  s.annotations = [{ id: id("ann"), revision: 1, type: "point", layerId: "L1", geometry: { x: 4, y: 5 }, anchor: { space: "document" }, style: { color: "blue" }, provenance: provenance(), intentEventIds: [] }];
  return d;
}
export function embed(parent = document(), child = document(2), mode = "live") {
  const p = structuredClone(parent), s = p.scenes[0], ref = { documentId: p.id, sceneId: s.id, kind: "object", id: id("obj",9) }, target = { documentId: child.id, sceneId: child.defaultSceneId };
  s.layers.push({ id: id("layer",9), author: "user", name: "Embed", opacity: 1, visible: true, locked: false, content: [{kind:"object",id:ref.id}] });
  s.objects.push({ id: ref.id, type: "embedded-document", revision: 1, layerId: id("layer",9), parent: { documentId: p.id, sceneId: s.id }, visibility: "public", locked: false, provenance: provenance(),
    props: { bindingId: id("bind",parseInt(p.id.slice(4,12),16)*100+9), child: structuredClone(target), mode, sourceRevision: 1, localToDocument: [1,0,0,0,1,0,0,0,1], clipRegion: { space: "child-document", x: 0, y: 0, x2: 100, y2: 100 },
      ...(mode === "snapshot" ? { snapshotOrigin: {documentId:id("doc",99),sceneId:id("scene",99),revision:1,contentHash:HASH} } : {}), missingTargetPolicy: "placeholder", defaultEditTarget: "parent" } });
  p.bindings.push({ id: id("bind",parseInt(p.id.slice(4,12),16)*100+9), kind: "embed", parentObject: ref, child: structuredClone(target), mode, sourceRevision: 1, status: "fresh" });
  return p;
}
export function legacy() {
  return { version: 1, imageId: asset().legacyImageId, width: 1600, height: 1000, savedAt: TIME,
    marks: [{ id: "user-ink", type: "polyline", author: "user", grounding: "user-pointer", layer: "L1", x: .1, y: .2, x2: .3, y2: .4,
      points: [{x:.1,y:.2},{x:.3,y:.4}], smooth: true, closed: false, color: "blue", size: "fine", pen: "highlighter", strokeOrder: 2, relativeStartMs: 10, relativeEndMs: 20, pointerType: "pen",
      note: "Claim", confidence: "low", review: "confirmed", evidence: [{id:"e1",observer:"user",kind:"position",image:asset().legacyImageId,region:[.1,.2,.3,.4],says:"here"}] },
      { id: "ai", type: "rect", author: "assistant", grounding: "unverified", layer: "L1", x: .2, y: .2, x2: .4, y2: .4, label: "AI" }],
    layers: [{id:"L1",author:"user",name:"Ink",opacity:0,locked:true},{id:"L2",author:"assistant",name:"Empty",module:"org.estampes.graph"}],
    objects: [{ id:"o1",type:"axes-2d",props:{xRange:[-1,1],yRange:[-1,1]},layer:"L1",visibility:"public",revision:3,
      provenance:{author:"module",module:"org.estampes.graph",moduleVersion:"1.0.0",createdAt:TIME,updatedAt:TIME},evidence:[{observer:"tool",source:"org.estampes.graph",says:"computed",region:[.1,.2,.3,.4]}] }],
    links: {}, gestureDecisions: [{id:"g1",memberIds:["user-ink","ai"],verdict:"user-confirmed"}], rejections:[{kind:"note",from:{image:asset().legacyImageId,text:"prior"}}] };
}
export const context = () => ({ documentId: id("doc"), sceneId: id("scene"), sourceStoreId: id("doc",8).slice(4), asset: asset(), sourceToDocument:[1,0,0,0,1,0,0,0,1],
  ownerId:"owner:local",title:"Legacy",projectedAt:TIME,sourceTrust:"migrated-local" });
