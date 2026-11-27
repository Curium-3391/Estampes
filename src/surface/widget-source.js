// The Visual Surface widget is one self-contained HTML resource. Its workbench
// code (public/workbench.js) and the pure layout maths (geometry.js) are shared
// source files that are inlined where the HTML has the placeholder.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localizeHtml, widgetI18nSource } from "../i18n/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const workbenchSource = () => [
  // Wrapped so its helper names cannot collide with the widget's own.
  "const { clampRect, snapRect, applyOp, reconcile, profileFor } = (() => {\n" +
    readFileSync(join(ROOT, "src", "surface", "geometry.js"), "utf8").replace(/^export\s+/gm, "") +
    "\nreturn { clampRect, snapRect, applyOp, reconcile, profileFor };\n})();",
  readFileSync(join(ROOT, "public", "workbench.js"), "utf8"),
  readFileSync(join(ROOT, "public", "calculator.js"), "utf8"),
  readFileSync(join(ROOT, "public", "module-view.js"), "utf8"),
  readFileSync(join(ROOT, "public", "flow-view.js"), "utf8"),
  readFileSync(join(ROOT, "public", "sandboxed-view.js"), "utf8"),
].join("\n");

// The shared document store (poll/reconcile rules) is page-level, outside every viewer: a plain
// module with its `export` keywords stripped.
export const documentStoreSource = () =>
  "const { createDocumentStore, POLL_BATCH } = (() => {\n" +
    readFileSync(join(ROOT, "src", "surface", "document-store.js"), "utf8").replace(/^export\s+/gm, "") +
    "\nreturn { createDocumentStore, POLL_BATCH };\n})();";

// Messages posted as the person (T2): their sentence plus an English block.
export const userVoiceSource = () =>
  "const { reviewParts, editParts, fallbackParts, joinUserVoice } = (() => {\n" +
    readFileSync(join(ROOT, "src", "surface", "user-voice.js"), "utf8").replace(/^export\s+/gm, "") +
    "\nreturn { reviewParts, editParts, fallbackParts, joinUserVoice };\n})();";

// Localize the static markup first, then inline the scripts: localizeHtml
// never touches <script> content, and the inlined sources stay as they are.
export const inlineWorkbench = (html) => localizeHtml(html)
  .replace("__ESTAMPES_WORKBENCH__", () => workbenchSource())
  .replace("__ESTAMPES_DOCSTORE__", () => documentStoreSource())
  .replace("__ESTAMPES_USERVOICE__", () => userVoiceSource())
  .replace("__ESTAMPES_I18N__", () => widgetI18nSource());
