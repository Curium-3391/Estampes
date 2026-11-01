// Resolves only snapshots supplied by the caller. No lookup, I/O or grants.
import { parseVisualDocument } from "./schema.js";
import { assertEmbedBinding } from "./embed-schema.js";
import { canonicalJson } from "./validation.js";
import { parseRef, refKey } from "./references.js";
import { DocumentValidationError, assertJson } from "./validation.js";

function indexDocuments(input) {
  assertJson(input);
  if (!Array.isArray(input)) throw new DocumentValidationError("INVALID_INPUT", "Expected Document snapshots");
  const documents = input.map(parseVisualDocument), index = new Map(), sceneOwners = new Map();
  for (const d of documents) {
    if (index.has(d.id)) throw new DocumentValidationError("INTEGRITY_ERROR", "Duplicate Document identity");
    index.set(d.id, d);
    for (const s of d.scenes) {
      if (sceneOwners.has(s.id)) throw new DocumentValidationError("INTEGRITY_ERROR", "Scene identity has multiple owners");
      sceneOwners.set(s.id, d.id);
    }
  }
  return { documents, index };
}
function find(index, ref) {
  const scene = index.get(ref.documentId)?.scenes.find(s => s.id === ref.sceneId);
  const field = { object: "objects", annotation: "annotations", layer: "layers", frame: "frames" }[ref.kind];
  return scene?.[field].find(e => e.id === ref.id);
}
export function resolveReference(documents, reference) {
  const ref = parseRef(reference), { index } = indexDocuments(documents), target = find(index, ref);
  if (!target) throw new DocumentValidationError("UNRESOLVED_REFERENCE", "Reference does not resolve in supplied snapshots");
  return target; // fresh parsed data, never an authoritative mutable object
}
export function validateDocumentReferences(input) {
  const { documents, index } = indexDocuments(input);
  const edges = new Map(documents.map(d => [d.id, new Set()]));
  const requireRef = ref => {
    if (!find(index, ref)) throw new DocumentValidationError("UNRESOLVED_REFERENCE", "Reference does not resolve with its declared kind");
  };
  const requireScene = ref => {
    const scene = index.get(ref.documentId)?.scenes.find(s => s.id === ref.sceneId);
    if (!scene) throw new DocumentValidationError("UNRESOLVED_REFERENCE", "Child Scene does not resolve");
    return scene;
  };
  const canonicalBindings = new Map();
  for (const d of documents) {
    for (const b of d.bindings) {
      const projection = structuredClone(b);
      if (b.kind === "embed") delete projection.status; // resolver/audience-derived
      const identity = canonicalJson(projection);
      if (canonicalBindings.has(b.id) && canonicalBindings.get(b.id) !== identity) throw new DocumentValidationError("INTEGRITY_ERROR", "Conflicting canonical binding identity");
      canonicalBindings.set(b.id,identity);
    }
    for (const s of d.scenes) for (const o of s.objects) if (o.type === "embedded-document") {
      const binding = d.bindings.find(b => b.id === o.props.bindingId);
      edges.get(d.id).add(o.props.child.documentId);
      if (binding.status === "fresh" || binding.status === "archived") {
        const child = requireScene(o.props.child);
        // Clip may outlive a later child resize; sourceRevision records the
        // capture, not a constraint on current live child revision.
        if (((o.props.mode === "snapshot" && index.get(o.props.child.documentId).revision === 1) || (o.props.mode === "live" && index.get(o.props.child.documentId).revision === o.props.sourceRevision)) &&
          (o.props.clipRegion.x2 > child.extent.width || o.props.clipRegion.y2 > child.extent.height)) {
          throw new DocumentValidationError("OUT_OF_BOUNDS", "Clip exceeds the captured child extent");
        }
      }
    }
    for (const b of d.bindings) {
      if (b.kind === "relation" && (b.status === undefined || b.status === "fresh")) { requireRef(b.from); requireRef(b.to); }
      if (b.kind === "cas-plot" && ["fresh","stale","recomputing","conflict"].includes(b.state)) {
        requireRef(b.target);
        if (find(index, b.target).type !== "function-plot") throw new DocumentValidationError("INTEGRITY_ERROR", "CAS target is not a function plot");
      }
      if (b.kind === "embed") {
        requireRef(b.parentObject);
        assertEmbedBinding(find(index,b.parentObject),b);
      }
    }
    for (const s of d.scenes) for (const entity of [...s.annotations, ...s.objects]) {
      for (const e of entity.finding?.evidence ?? entity.evidence ?? []) if (e.source && typeof e.source === "object" && e.source.kind === "document" && e.applicability !== "historical" && e.applicability !== "stale") requireRef(e.source.ref);
    }
  }
  for (const start of edges.keys()) {
    const visited = new Set(), work = [{ id: start, path: [] }];
    while (work.length) {
      const { id, path } = work.pop();
      if (path.includes(id)) throw new DocumentValidationError("INTEGRITY_ERROR", "Cyclic embedded Documents");
      if (path.length > 8 || (visited.add(id), visited.size > 12)) throw new DocumentValidationError("LIMIT", "Embed traversal limit exceeded");
      for (const child of edges.get(id) ?? []) work.push({ id: child, path: [...path, id] });
    }
  }
  return documents;
}
export { refKey };
