// Resolves only snapshots supplied by the caller. No lookup, I/O or grants.
import { parseVisualDocument } from "./schema.js";
import { assertEmbedBinding } from "./embed-schema.js";
import { canonicalJson } from "./validation.js";
import { parseRef, refKey } from "./references.js";
import { DocumentValidationError, assertJson, bounded, ContentHashSchema, RevisionSchema, hashJson, parse } from "./validation.js";
import { z } from "zod";
import { DocumentIdSchema, UUIDSchema } from "./identity.js";

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
function analyzeReferences(input, mode) {
  const { documents, index } = indexDocuments(input);
  const edges = new Map(documents.map(d => [d.id, new Set()]));
  const missingDependencies = [];
  const missing = (ref, required, reason) => {
    missingDependencies.push({ target: structuredClone(ref), required, reason });
    // Partial means absent external Documents, never malformed supplied data.
    if (required && (mode !== "partial" || index.has(ref.documentId))) {
      throw new DocumentValidationError("UNRESOLVED_REFERENCE", "Required dependency is absent from the declared snapshots");
    }
  };
  const requireRef = (ref, required = true, reason = "active") => {
    const target = find(index, ref);
    if (!target) missing(ref, required, reason);
    return target;
  };
  const requireScene = (ref, required = true, reason = "active") => {
    const scene = index.get(ref.documentId)?.scenes.find(s => s.id === ref.sceneId);
    if (!scene) missing(ref, required, reason);
    return scene;
  };
  const checkFinding = finding => {
    for (const e of finding?.evidence ?? []) if (e.source?.kind === "document") {
      const active = e.applicability !== "historical" && e.applicability !== "stale";
      requireRef(e.source.ref, active, active ? "active-evidence" : "historical");
    }
    const activeContext = ["user-confirmed", "user-rejected", "independently-verified"].includes(finding?.verification?.currentState);
    for (const source of finding?.claimContext?.sourceRevisionVector ?? []) requireRef(source.ref, activeContext, activeContext ? "active-claim-context" : "historical-context");
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
        if (child && ((o.props.mode === "snapshot" && index.get(o.props.child.documentId).revision === 1) || (o.props.mode === "live" && index.get(o.props.child.documentId).revision === o.props.sourceRevision)) &&
          (o.props.clipRegion.x2 > child.extent.width || o.props.clipRegion.y2 > child.extent.height)) {
          throw new DocumentValidationError("OUT_OF_BOUNDS", "Clip exceeds the captured child extent");
        }
      } else requireScene(o.props.child, false, "explicitly-unresolved");
    }
    for (const b of d.bindings) {
      checkFinding(b.finding);
      if (b.kind === "relation") {
        const active = b.status === undefined || b.status === "fresh";
        requireRef(b.from, active, active ? "active" : "explicitly-unresolved");
        requireRef(b.to, active, active ? "active" : "explicitly-unresolved");
      }
      // A derived binding names an object some module made. While it is live the object must exist; once it is removed, unavailable or unresolved the reference may dangle, explicitly. The core does not look at what kind of object it is.
      if (b.kind === "derived") requireRef(b.target, ["fresh", "stale", "recomputing", "conflict"].includes(b.state), ["fresh", "stale", "recomputing", "conflict"].includes(b.state) ? "active" : "explicitly-unresolved");
      if (b.kind === "embed") {
        const parent = requireRef(b.parentObject);
        if (parent) assertEmbedBinding(parent,b);
      }
    }
    for (const s of d.scenes) for (const entity of [...s.annotations, ...s.objects]) {
      checkFinding(entity.finding);
      for (const e of entity.evidence ?? []) if (e.source && typeof e.source === "object" && e.source.kind === "document") {
        const active = e.applicability !== "historical" && e.applicability !== "stale";
        requireRef(e.source.ref, active, active ? "active-evidence" : "historical");
      }
      if (entity.provenance.derivedFrom) requireRef(entity.provenance.derivedFrom, false, "historical");
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
  return { documents, missingDependencies, authorizationChecked: false, binaryAssetsChecked: false };
}

// Compatibility API: still requires active targets in the supplied snapshots.
// It does not prove a complete repository snapshot. Prefer the explicit APIs.
export function validateDocumentReferences(input) { return analyzeReferences(input, "supplied").documents; }
export function validatePartialDocumentSnapshots(input) {
  return { ...analyzeReferences(input, "partial"), scope: "partial-document-snapshots", completeClosure: false };
}
export const DocumentClosureManifestSchema = bounded(z.object({ schema: z.literal("estampes.document-closure/1"),
  storeInstanceId: UUIDSchema, generation: RevisionSchema,
  documents: z.array(z.object({ documentId: DocumentIdSchema, revision: RevisionSchema, contentHash: ContentHashSchema }).strict()),
}).strict());
export function validateCompleteDocumentClosure(input, declaration) {
  const manifest = parse(DocumentClosureManifestSchema, declaration), { documents } = indexDocuments(input);
  const declared = new Map();
  for (const item of manifest.documents) {
    if (declared.has(item.documentId)) throw new DocumentValidationError("INTEGRITY_ERROR", "Duplicate closure declaration");
    declared.set(item.documentId, item);
  }
  if (declared.size !== documents.length) throw new DocumentValidationError("INTEGRITY_ERROR", "Closure declaration differs from supplied Document set");
  for (const d of documents) {
    const expected = declared.get(d.id);
    if (!expected || expected.revision !== d.revision || expected.contentHash !== hashJson(d)) throw new DocumentValidationError("INTEGRITY_ERROR", "Closure revision or content hash differs");
  }
  return { ...analyzeReferences(documents, "complete"), scope: "declared-complete-document-closure", completeClosure: true, declaration: manifest };
}
export { refKey };
