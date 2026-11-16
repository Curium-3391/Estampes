// The Visual Surface widget is one self-contained HTML resource. Its workbench
// code (public/workbench.js) and the pure layout maths (geometry.js) are shared
// source files that are inlined where the HTML has the placeholder.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const workbenchSource = () => [
  // Wrapped so its helper names cannot collide with the widget's own.
  "const { clampRect, snapRect, applyOp, reconcile, profileFor } = (() => {\n" +
    readFileSync(join(ROOT, "src", "surface", "geometry.js"), "utf8").replace(/^export\s+/gm, "") +
    "\nreturn { clampRect, snapRect, applyOp, reconcile, profileFor };\n})();",
  readFileSync(join(ROOT, "public", "workbench.js"), "utf8"),
  readFileSync(join(ROOT, "public", "calculator.js"), "utf8"),
].join("\n");

export const inlineWorkbench = (html) => html.replace("__ESTAMPES_WORKBENCH__", () => workbenchSource());
