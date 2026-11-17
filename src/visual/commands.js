// Command ids for the widget's own edits (UVA Phase 3, lost-ACK handling).
//
// The widget makes one id per user action and reuses it when it retries. A save
// writes the id and a hash of the edits into the canvas's change-log line, in
// the same durable record as the edit, so "applied" and "recorded" cannot
// disagree and survive a restart. The log keeps the latest 200 lines; an id that
// has aged out is reported as unknown, never as applied.
import { createHash } from "node:crypto";

export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, stable(value[k])]));
  return value;
};
export const commandHash = (args) => createHash("sha256").update(JSON.stringify(stable(args))).digest("hex").slice(0, 24);

// The command records of one change log: a line's own, and those it carries for earlier saves that failed
// while a later save of the same canvas carried their edits (src/storage.js).
export const commandRecords = (log) => (log ?? []).flatMap((line) => [...(line?.commandId ? [line] : []), ...(Array.isArray(line?.carried) ? line.carried : [])]);

// logs: one change log (array of lines) per canvas the command could have touched.
// -> { state: "none" | "applied" | "mismatch", at?, tool? }
export function judgeCommand(logs, commandId, hash) {
  let found = null;
  for (const log of logs) for (const line of commandRecords(log)) {
    if (line?.commandId !== commandId) continue;
    if (line.argsHash !== hash) return { state: "mismatch" };
    found = { state: "applied", at: line.at, tool: line.tool };
  }
  return found ?? { state: "none" };
}

// Edits that carry a command id run one at a time, from the lookup to the durable save, so a
// retry that arrives while the first call is still running waits and then finds its record.
// `await gate()` gives a release function; call it in a finally.
export function createCommandGate() {
  let tail = Promise.resolve();
  return () => {
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const ready = tail.then(() => release);
    tail = tail.then(() => turn);
    return ready;
  };
}
