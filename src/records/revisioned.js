// The parts that every revision-checked record store shares (models: src/models/store.js, flows: src/flow/store.js). A store over one kind of UVA
// record promises the same things: one writer per record store and kind, per-record locks taken in id order, a write that names the revision it
// was made against, a command id that answers again with its first result, and a history bounded by size. What differs between kinds (who may open
// a record, how a value is checked, what the id looks like) stays in the store of that kind.
import { createHash } from "node:crypto";

export const clone = (v) => JSON.parse(JSON.stringify(v));
export const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
export const sigOf = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

export const HISTORY_BYTES = 256 * 1024, HISTORY_MAX = 20;

// The newest history entries that fit: at most HISTORY_MAX, and at most HISTORY_BYTES of values of valueBytes each (always at least one).
export function trimHistory(history, valueBytes) {
  const room = Math.max(1, Math.min(HISTORY_MAX, Math.floor(HISTORY_BYTES / Math.max(1, valueBytes))));
  return history.slice(-room);
}

const claimed = new WeakMap();
// Refuses a second store of the same kind over the same records: its locks could not see the first one's writes. Returns the error text or null.
export function claimStore(records, kind) {
  const kinds = claimed.get(records) ?? new Set();
  if (kinds.has(kind)) return "a " + kind + " store already exists over these records; a second writer would not see its locks";
  kinds.add(kind); claimed.set(records, kinds);
  return null;
}

// Runs fn while holding the locks of ids, taken in sorted order (so two changes over the same ids in opposite order cannot wait on each other).
export function createLocks() {
  const locks = new Map();
  return async function withLocks(ids, fn) {
    const sorted = [...new Set(ids)].sort(), releases = [];
    try {
      for (const id of sorted) {
        const before = locks.get(id) ?? Promise.resolve();
        let release; const mine = new Promise((r) => { release = r; });
        const chained = before.then(() => mine);
        locks.set(id, chained);
        await before;
        releases.push(() => { release(); if (locks.get(id) === chained) locks.delete(id); });
      }
      return await fn();
    } finally { for (const r of releases.reverse()) r(); }
  };
}

// The changes whose expected revision is not the record's revision now: [{ id, expectedRevision, revision }].
export const staleOf = (changes, current) => changes
  .map((c, i) => ({ id: c.id, expectedRevision: c.expectedRevision, revision: current[i].revision }))
  .filter((s) => s.expectedRevision !== s.revision);
