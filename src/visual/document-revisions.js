// Ordered revisions for polled canvas documents (UVA Phase 3, PR-3B-1).
// A content hash (canvasRevision's "cv:...") says WHETHER a document changed;
// it cannot say which side is newer. The tracker adds a counter that grows by
// one each time the hash seen for a document changes, plus an epoch that
// changes when this process starts (the counter then restarts). The counter is
// lazy: changes between two observations count once, which is enough to order
// them. Clients never trust a counter without its hash.
import { randomBytes } from "node:crypto";

export const MAX_POLLED_DOCUMENTS = 12;

export function createRevisionTracker({ epoch = randomBytes(6).toString("hex"), limit = 2000 } = {}) {
  const docs = new Map();
  // The highest counter ever dropped. A forgotten document that returns starts above it, so its
  // counter never goes back below what a client may still hold.
  let floor = 0;
  return {
    epoch,
    // The ordered revision of a document whose current content hash is `hash`.
    observe(documentId, hash) {
      const known = docs.get(documentId);
      if (known && known.hash === hash) return { epoch, counter: known.counter, hash };
      const next = { hash, counter: (known?.counter ?? floor) + 1 };
      docs.delete(documentId);
      docs.set(documentId, next);
      if (docs.size > limit) {
        const oldest = docs.keys().next().value;
        floor = Math.max(floor, docs.get(oldest).counter);
        docs.delete(oldest);
      }
      return { epoch, counter: next.counter, hash };
    },
  };
}

// How a client's last-seen revision relates to the current one.
//   unchanged: same epoch and same content (hash) -> nothing to send
//   snapshot:  the next revision, or no prior knowledge -> send the full state
//   gap:       the client is more than one revision behind, or from another
//              epoch (server restarted) -> full state too, flagged so the
//              client drops anything it derived from the old one
export function classifyChange(since, current) {
  if (!since) return "snapshot";
  if (since.hash === current.hash && since.epoch === current.epoch) return "unchanged";
  // After a restart the client must adopt the new epoch, so it gets the state again even if the content is the same.
  if (since.epoch !== current.epoch) return "gap";
  if (current.counter === since.counter + 1) return "snapshot";
  return "gap";
}
