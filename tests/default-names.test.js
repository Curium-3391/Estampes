// Default names stored in documents follow the viewer's language (RFC
// docs/rfc/i18n Phase 4): the stored text is recognised against each
// catalog's template and rendered again; it is never rewritten.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localizeDefaultName } from "../src/i18n/widget-runtime.js";
import { CATALOGS, widgetI18nSource } from "../src/i18n/index.js";
import { createI18n } from "../src/i18n/runtime.js";

const tr = (l) => { const i = createI18n(CATALOGS, l, []); return (k, p) => i.t(k, p); };
const en = (n) => localizeDefaultName(n, CATALOGS, tr("en"));
const zh = (n) => localizeDefaultName(n, CATALOGS, tr("zh-TW"));

test("each default name the server writes reads in the viewer's language and back", () => {
  const cases = [
    ["AI · 第2次", "AI · #2"], ["你 · 第1次", "You · #1"], ["你 · 匯入", "You · imported"], ["AI · 重播", "AI · replay"],
    ["模組", "Module"], ["使用者", "User"], ["原始圖片", "Original image"], ["工作區", "Workspace"],
    ["畫布 img:0123456789abcdef", "Canvas img:0123456789abcdef"], ["對照 img:a + img:b", "Compare img:a + img:b"],
    ["對照 img:a + img:b（拆出）", "Compare img:a + img:b (split)"], ["工作區（拆出）（拆出）", "Workspace (split) (split)"],
    ["複本 a.png · 圖片", "Copy of a.png · image"], ["複本 img:1 · 標註", "Copy of img:1 · marks"], ["複本 x · 物件", "Copy of x · objects"],
    ["文字 3", "Text 3"], ["文字 3 · 2", "Text 3 · 2"],
  ];
  for (const [zhName, enName] of cases) {
    assert.equal(en(zhName), enName, zhName);
    assert.equal(zh(enName), zhName, enName);
    assert.equal(en(enName), enName, "already in the viewer's language: " + enName);
    assert.equal(zh(zhName), zhName, "already in the viewer's language: " + zhName);
  }
});

test("names the person typed, and near misses, are shown as stored", () => {
  for (const n of ["我的圖層", "Him · #2", "AI · #x", "Text", "Copy of a.png · photos", "", "  "]) {
    assert.equal(en(n), n); assert.equal(zh(n), n);
  }
  assert.equal(en(undefined), undefined);
});

test("the widget gets i18nName, and the layer list, captions and selection use it", () => {
  assert.match(widgetI18nSource("en"), /i18nName \} = \(\(\) => \{/);
  const raw = readFileSync(new URL("../public/visual-surface.html", import.meta.url), "utf8");
  for (const site of ['value:i18nName(l.name)', '+sideName(l.id)+i18nName(l.name)', 'name===l.name||name===i18nName(l.name)',
    't("vs.caption.workspace",{name:i18nName(ws.name)', 't("vs.selection.layer",{name:i18nName(layer.name)})'])
    assert.ok(raw.includes(site), site);
});
