export class PersistenceError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = "PersistenceError"; this.code = code; this.details = details;
  }
}
export const fail = (code, message, details) => { throw new PersistenceError(code, message, details); };
export const integrity = (ok, message) => { if (!ok) fail("INTEGRITY_ERROR", message); };
