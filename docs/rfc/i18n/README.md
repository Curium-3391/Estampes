# RFC: Multilingual support (i18n / l10n)

Status: **accepted 2026-11-18**: the maintainer took every recommendation in §12 (D1–D10). Docs only: nothing here changes behaviour. Written 2026-11-18 against `main` at `e42115a` (0.20.1 + UVA Phase 4A-1).

Scope: the whole framework, so widget UI, server-rendered pages, MCP tool text, messages the widget posts into the chat, default names stored in documents, module and package metadata, canvas text rendering, and docs. Every rule here is generic and works for any image type. Nothing is tied to one kind of picture.

## 1. Summary

Estampes is not an English product with a missing translation layer. Its UI is a **hard-coded Traditional Chinese** product, while its model-facing text is mostly English and its module manifests already carry a partial `*I18n` mechanism. So the work is mainly about **separating text by who reads it**, and less about translation.

The proposal:

1. Classify every string into one of seven text classes (§3). Each class gets its own language rule.
2. Use a tiny dependency-free message runtime with flat JSON catalogs. **English is the key and fallback language** and **zh-TW ships complete**. The catalogs are embedded into the widget HTML at serve time, the same way `__ESTAMPES_VERSION__` already is.
3. Resolve the locale in this order: user override, host locale, instance default (`ESTAMPES_DEFAULT_LOCALE`), then `en`.
4. Model-facing text (tool descriptions, tool results, protocol tokens) stays English and locale-invariant. A golden test guards this.
5. Persisted data stores **keys, not localized prose**, for system-generated names. This is additive. Old literal names stay as they are.
6. Migrate in phases (§9). The first code phase is a zero-visible-change extraction in which the zh-TW catalog reproduces today's strings byte for byte, so rolling back means switching back to the current text.

## 2. Inventory: where text and language assumptions live today

Counts are lines that contain CJK characters, measured on `e42115a`. They are a rough proxy for "hard-coded user text".

| Area | Files | What is there | Language today |
| --- | --- | --- | --- |
| Widget UI | `public/visual-surface.html` (315 / 2771 lines), `module-store.html` (75), `calculator.js` (68), `workbench.js` (27), `number-line.html` (21), `visual-evidence.html` (21) | Buttons, menus, status, errors, tooltips, `aria-*`, `<html lang="zh-Hant">` hard-coded, `toLocaleString()` with no explicit locale | zh-TW literals inline in JS/HTML |
| Messages the widget posts **as the user** | `src/interaction-protocol.js` (55 lines), `ui/message` calls in `visual-surface.html` (~L2404, L2503, L2567) | `INTENT_LABELS`, `HEADINGS_ZH`, `MEANING_ZH`, `CONFIRM_ZH`, first-person prose such as 「我透過 Estampes 在同一張畫布上做了視覺指認。」 | zh-TW. The model reads it, and it also shows in the chat as the user's own words |
| MCP tool descriptions and schemas | `server.js` (67 `register*Tool` calls), `src/*/mcp-tools.js`, `src/tool-guidance.js` | Tool `description`, zod `.describe()` | English, with a few zh examples (`e.g. 增強對比`, 「AI 驗…」 tab name, `選擇圖片／拍照`) |
| Tool results (`content[].text`) | `server.js`, modules | Summaries for the model, sometimes echoed to the user | English |
| Errors | `throw new Error(...)` across `src/` | Validation and lifecycle errors, surfaced to the model and sometimes to the widget | English |
| Server-rendered HTML | `src/oauth.js` (consent page, 7 lines) | `<title>連接 Estampes</title>`, instructions | zh-TW |
| Default names persisted in documents | `src/canvas-state.js` (「你 · 重播」, 「· 匯入」), `src/workspace.js` (「對照 …」, 「畫布 …」, 「工作區」, 「（拆出）」), `AUTHOR_NAME` | Written into stored documents at creation time | zh-TW, **frozen into user data** |
| Text heuristics | `src/assessment.js` `HEDGES` | Matches 疑似, 可能是… and maybe, probably… | zh + en only |
| Module manifests | `src/modules/manifest.js` | `nameI18n`, `descriptionI18n`, `titleI18n`, `profileI18n`: map of BCP-47-ish tag to text, at most 8 languages. `localized(m, field, lang = "zh-TW")` falls back from exact tag to language to base field | Base fields English, zh-TW translations. **Default lang is hard-coded `zh-TW`** in `localized()` and `catalogEntry()` |
| Permissions | `src/modules/permissions.js` | `{ zh, en }` per permission | Ad-hoc two-language table |
| Built-in modules | `src/builtin-modules/{graph,cas,astrometry}/manifest.json`, `astrometry/index.js` (10 lines) | I18n maps, plus a few zh result strings in code | Mixed |
| Canvas text | `src/pixel-font.js` (5×7 bitmap, A–Z 0–9 only), `src/visual/render-svg.js`, `src/scene/objects.js`, `src/marks-file.js` (`<text>` in SVG rendered by sharp/librsvg) | Grid labels, user text marks, exported PNGs | Pixel font is Latin-only. The SVG text relies on system fonts |
| Container fonts | `Dockerfile` (`node:22-bookworm-slim`, installs only `util-linux`) | No font packages | **Suspected:** CJK, Arabic and other scripts render as missing glyphs in server-side PNG renders (`render_canvas`, exports). Not verified, see §7 |
| Tests | 8 test files assert Chinese strings (`protocol`, `gesture-groups`, `layer-edit`, `canvas-state`, `claims-mcp`, `surface-open`, `unified-canvas`, `uva-record-store`) | Exact-string assertions | They would break on any wording change |
| Docs | English first, plus `docs/zh-TW/README.md` (see the docs conventions in `docs/DOCUMENTATION-MAINTENANCE.md`) | | Already bilingual by policy |

Host signals already available, but not used today:

- The MCP Apps host context exposes `locale` (`@modelcontextprotocol/ext-apps` 2.0.4, `McpUiHostContext.locale?: string`).
- ChatGPT exposes `window.openai.locale` to widgets. ChatGPT is also reported to send `_meta["openai/locale"]` on tool calls. **Unverified on a live host.** Phase 1 must confirm both before relying on them.

## 3. Text classes and their language rules

The core of the design. Every string is one of the classes below, and the class decides its language.

| # | Class | Reader | Language rule |
| --- | --- | --- | --- |
| T1 | **UI chrome**: widget buttons, labels, status, `aria-*`, Store, consent page | Person | Resolved user locale (§5) |
| T2 | **User-voice messages**: text the widget sends with `ui/message role=user`, which the chat shows as the person's own message | Person **and** model | A localized human sentence plus an **English structured block** (`intent=…`, `role=focus`, `semanticHint=…`, ids, coordinates). The model relies only on the block. The sentence is for the person |
| T3 | **Model contract**: tool descriptions, input-schema `describe()`, server instructions, tool-result text, protocol tokens, error codes | Model | **English, locale-invariant.** Never localized, so model behaviour does not change with the person's language. Remove the stray zh examples or keep them only as explicitly multilingual examples |
| T4 | **User content**: notes, mark text, layer names the person typed, module data | Person | **Never translated.** Passed through verbatim, with bidi isolation (§7) |
| T5 | **System-generated names that are persisted**: default layer and workspace names | Person, later, possibly in another locale | Store a **key plus params** (for example `{ nameKey: "layer.replay", nameParams: { author: "user" } }`) and render at read time. Old documents keep their literal `name` |
| T6 | **Module and package metadata**: names, descriptions, capability titles, profiles, panel titles, permission text | Person (Store) and model (profiles) | Person-facing fields: localized through the manifest `*I18n` maps. `capability.description` is model contract (T3) and stays in the base language |
| T7 | **Docs** | Contributors, deployers | English is canonical. zh-TW is a maintained translation of user-facing pages only, as the docs policy already states |

Errors span classes. The `Error` thrown in `src/` stays English (T3) but gains a stable `code`. The widget maps `code` to a T1 message and falls back to the English text when no translation exists.

## 4. Catalog format and runtime

**Format.** One flat JSON file per locale, in `src/i18n/locales/<tag>.json`:

```json
{
  "layer.replay": "You · replay",
  "store.plan.expires": "Expires {time}",
  "canvas.marks.count": "{count, plural, one {# mark} other {# marks}}"
}
```

- Keys are dotted and stable. Never reuse a key for a new meaning.
- Messages use a small subset of ICU MessageFormat: `{name}`, `{n, plural, …}` and `{x, select, …}`. Plural rules come from `Intl.PluralRules`. Numbers, dates and lists go through `Intl.NumberFormat`, `Intl.DateTimeFormat` and `Intl.ListFormat` with the resolved locale. That fixes the bare `toLocaleString()` calls.
- No dependency. A hand-written runtime of about 150 lines, shared by server and widget. The widgets are single-file HTML with no build step, so a library would need inlining anyway. Node 22 and every target browser ship full ICU `Intl`.
- `en.json` is the source of truth for keys. `zh-TW.json` must have every key, which CI checks. Other locales may be partial.

**Delivery to widgets.** When the server serves a `ui://` resource, it inlines the catalogs of all shipped locales as `window.__ESTAMPES_I18N__`, the same mechanism as `__ESTAMPES_VERSION__`. The widget picks a locale at runtime because host locale arrives at runtime, after the resource may already be cached. Budget: about 600 strings × 2–3 locales ≈ 40–70 KB uncompressed. If the number of locales grows, switch to inlining `en` plus the instance default, and fetch others from `/i18n/<tag>.json`.

**Server side.** `t(locale, key, params)` from the same module. Only T1 surfaces rendered by the server (OAuth page), T2 sentences and T5 rendering use it. T3 code paths must not import it, and a lint rule enforces that (§8).

## 5. Locale selection

Resolution order, first match wins:

1. **User override.** A language picker in the widget settings, stored in widget state (`setWidgetState` / local state). It is a per-person preference and never stored in a canvas document, because documents are shared and exported.
2. **Host locale.** `hostContext.locale` (MCP Apps) or `window.openai.locale` (ChatGPT) in the widget. For server-rendered T2/T5 text: the locale the widget passes in `_meta["estampes/locale"]` on its own calls, else the host's per-call `_meta` locale if verified to exist, else step 3.
3. **Instance default.** New env var `ESTAMPES_DEFAULT_LOCALE` (BCP 47), read by `src/config.js` and documented in `DEPLOYMENT.md`. Each user self-deploys, so this is effectively "my language".
4. **`en`.**

Matching uses `Intl.LocaleMatcher`-style negotiation: exact tag, then script or region equivalents (`zh-Hant`, `zh-HK` and `zh-MO` → `zh-TW`; `zh-Hans`, `zh-SG` → `zh-CN` if shipped), then the bare language, then the next step in the chain. A missing **key** falls back per key along `requested → instance default → en → key name`. A missing key never produces an empty string. `<html lang>` and `dir` are set from the resolved locale.

**Compatibility with today.** Current deployments behave as zh-TW. When the host reports a Chinese locale, nothing changes. If a host reports no locale, the chain falls through to `en`, which would be a visible change for existing zh users. Existing deployers should therefore set `ESTAMPES_DEFAULT_LOCALE=zh-TW`, and the release notes must say so. See decision D1.

## 6. Modules and third-party translations

What already exists and should be kept:

- Manifest `nameI18n`, `descriptionI18n`, `titleI18n` (capabilities and panels) and `profileI18n` (with the existing check that only text, not cost or data flow, may differ). The tag regex and the 8-language cap stay.

Changes:

1. `localized(m, field, lang)` and `catalogEntry(mod, lang)` lose their hard-coded `"zh-TW"` default and take the resolved locale. They use the same negotiation as §5, so `zh-Hant` finds `zh-TW`.
2. `permissions.js` `{zh, en}` moves into the core catalog (`permission.canvas.read.description`, …).
3. **Runtime strings from modules** (result summaries, info-card text, panel labels) are the gap. Modules cannot ship HTML or scripts, so their translatable output is data. Proposal, **deferred to module system v2 (UVA P5)**:
   - Packages may include `locales/<tag>.json` with a namespaced key space (`<moduleId>:<key>`). The core loads them at install, validates them like manifests (size caps, no control characters, placeholder parity with the module's base locale), and treats them as **untrusted data**: rendered as text only, never as markup.
   - Module outputs may carry `{ key, params }` next to their plain `summary`. The core resolves the key in the person's locale and falls back to `summary`.
   - Signature coverage: locale files are inside the signed package, so the existing signature policy covers them.
4. Model-facing module text (`capability.description`, input schemas) stays in the base language (T3).

## 7. Canvas text, fonts and RTL

- **Coordinates are never mirrored.** Image space is absolute. RTL affects UI chrome and text runs only, never mark geometry, arrow direction semantics or `x/y` values.
- **UI mirroring.** Convert widget CSS to logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`) as panels are touched. Set `dir` on `<html>` from the locale. Toolbar icon order follows `dir`. Canvas pan and zoom controls do not.
- **User text (T4).** Render with `dir="auto"` and `unicode-bidi: isolate` (`plaintext` in multi-line notes), so a Hebrew note next to an English id does not reorder. The same applies in SVG `<text>` (`direction` / `unicode-bidi` attributes) and in `ui/message` T2 sentences (wrap user text in FSI…PDI, U+2068…U+2069).
- **Pixel font.** `src/pixel-font.js` covers A–Z and 0–9 and silently drops other characters. Keep it for grid labels (locale-neutral identifiers like `B7`) and document that restriction. Never feed it localized words. A label containing characters outside the set should fall back to SVG text, not vanish.
- **Server-side fonts.** Phase 0 check (2026-11-18): the published image (`node:22-bookworm-slim`) had **no fonts at all**. The maintainer confirmed `/usr/share/fonts` does not exist in the running container. With no fonts, `sharp` renders SVG `<text>` as missing-glyph boxes for every script, Latin included, so labels in `render_canvas` and PNG exports were unreadable in any language. CI hosts have fonts, so tests did not catch it. **Fixed as a bug:** the default image now installs `fonts-dejavu-core` and `fontconfig-config` (about 3 MB, covering Latin, Greek, Cyrillic and basic Arabic/Hebrew). The Docker build runs `scripts/check-fonts.mjs`, which fails if two different strings render identically. Other scripts (CJK and so on) come from a mounted font folder now and from Store font packs later (§7.1, revised D7). Widget rendering uses the viewer's system fonts and is unaffected.
- **Text metrics.** Anything that measures text width for layout (label boxes, `labelWidth`) must not assume one character equals one cell. Use `Intl.Segmenter` for grapheme counts and real measurement in the widget.
- **Line breaking.** CJK needs no spaces, and Thai needs dictionary breaking. Rely on browser and Pango line breaking. Never `split(" ")` user text for wrapping.

### 7.1 Extra fonts: image variant, mounted folder, or font packs in the Store

Question from the maintainer (2026-11-18): could fonts be installed through the module Store instead of a separate image variant (D7)?

What any option has to respect:

- **A small Latin font stays in the base image regardless.** Core text (grid labels, numbers, ids, English labels) must render without any optional add-on, and the Docker build checks it. Optional fonts only add scripts.
- **Server renders use fontconfig.** `sharp`/librsvg resolves fonts through fontconfig, which falls back per glyph across every installed font. The base image's config (`fontconfig-config`) already scans `/usr/share/fonts`, `/usr/local/share/fonts` and the user's font folder. So any option only has to put font files in one of those folders, or in a folder named by a generated `fonts.conf`. Fontconfig reads the font list when the process starts, so a newly added font may need a server restart. Picking up fonts without a restart (a render worker process, or a rescan) is to be verified.
- **Widgets are unaffected.** The canvas in the browser uses the viewer's own fonts. Only server renders (`render_canvas`, PNG exports, verification crops) need these fonts.
- **Fonts are untrusted binaries.** FreeType parses them inside the server process, and font parsers have had security bugs. Any font from outside the image is a security-sensitive input in the sense of `AGENTS.md`.
- **Size and licence.** Noto Sans CJK is about 16–20 MB per weight and region, and about 100 MB for the full set. Redistributed fonts must carry their licence (OFL 1.1 or Apache 2.0 for Noto and DejaVu).

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| A. Image variant (D7 as decided) | A build arg that adds CJK fonts, or a `-cjk` image tag | Simple. Fonts come from Debian packages | One more image to build, test and publish for every release. Users must switch images. One combination per variant (CJK, Arabic, Indic… multiply) |
| B. Mounted font folder | Document a read-only volume, for example `./fonts:/usr/local/share/fonts:ro` in `compose.yaml` | Works with no code change once the base fonts fix lands. Any font, any script. Survives image updates. Trust is the owner's own choice of files | Manual: the user downloads font files. No in-app discovery |
| C. Font packs in the Store | A new package kind carrying font files, a licence and a coverage list (scripts or languages), installed under `/data/fonts/<pack>/`, with the core generating a `fonts.conf` that includes those folders | One image. Install from the canvas. Per-language preference order can be generated (for example zh-TW prefers Noto Sans CJK TC over SC for Han glyphs). The Store can warn that a label uses a script no installed font covers | Needs a new manifest runtime kind (`fonts` or `assets`), a change to the public `estampes.module` format, so it belongs in **module system v2 (P5)**. Binary untrusted input needs signature, source allowlist, size cap, licence check and coverage check at install. Downloads go through the module egress rules |

Fallback chain for server renders under C: per-glyph through fontconfig, in the order *pack the person's locale prefers → other installed packs → base DejaVu*. A glyph that nothing covers stays a box, and the render result should then say which scripts were missing, so the model does not claim a label is readable.

**Recommendation:** replace the image variant in D7 with **B now** and **C in P5**. B needs only documentation and solves CJK for a self-hosted owner today. C is the long-term, in-app answer, and its manifest kind should be designed into module system v2 next to module locales (§6.3), not added to `estampes.module/1`. Official font packs (Noto CJK TC/SC/JP/KR, Noto Arabic, Noto Devanagari) would be the first entries, signed by the project. If C ships, B stays as the escape hatch for fonts nobody packaged. The maintainer accepted this on 2026-11-18, replacing the image variant in D7.

## 8. Test strategy

All of these run in `npm test` or a new `npm run i18n:check`. None needs a live host.

1. **Catalog integrity.** Every `en` key exists in `zh-TW`. No extra keys. Placeholder and plural-branch parity per message. ICU subset parses. No empty values.
2. **Hard-coded string lint.** Fails on a CJK character, or a string literal assigned to `textContent`, `title`, `placeholder` or `aria-label`, in `public/*` and in the T1/T2/T5 server modules, outside the catalogs. An allowlist covers deliberate cases such as demo SVG content and the bitmap font table. It ships in **warn** mode until extraction is done, then switches to **fail**.
3. **Model-contract invariance (T3 golden).** Render every tool definition (`tools/list`) and a fixed set of tool results under `en`, `zh-TW` and the pseudo-locales, and assert they are **byte-identical**. This is the guard that a UI translation never changes model behaviour.
4. **Pseudo-locales.** `en-XA` (accented, about 40 % longer, bracketed: `[Ŝĥöŵ ļåýéŕš ~~~]`) finds unextracted strings and truncation. `ar-XB` (RTL, mirrored) finds layout that ignores `dir`. Run the existing fake-host widget tests (`visual-widget`, `widget-contract`, `surface-*`) under both and assert no raw key names and no unextracted text in the DOM.
5. **Locale resolution unit tests.** The full chain in §5, including `zh-Hant` → `zh-TW`, unknown tags, missing host locale and a malformed override.
6. **Persistence.** Documents with old literal names and new `nameKey` names load, export and import round-trip unchanged (`estampes.workspace/1`, `estampes.bundle/1`). A document created under `zh-TW` reads correctly under `en`.
7. **Existing exact-string tests.** The 8 test files that assert Chinese text switch to asserting via `t("zh-TW", key)` or the structured block, so a translation edit is not a test failure.
8. **Live host check.** Not automated. Record in the changelog whether ChatGPT and Claude actually deliver a locale. Unexecuted means "not executed", per `AGENTS.md`.

## 9. Phased migration

Each phase is one or a few PRs. Phases 0–2 change no persisted format.

| Phase | Content | Visible change | Rollback |
| --- | --- | --- | --- |
| **0. Prep** | This RFC and decisions. Hard-coded-string lint in warn mode (`npm run i18n:check`, done). Catalog-integrity check arrives with the first catalog in Phase 1. Font render check (§7). Remove the default `"zh-TW"` argument only where callers already pass a locale (none change behaviour) | None | Revert PR |
| **1. Runtime + extraction, zh-TW only** | Add `src/i18n/` runtime and `en.json`/`zh-TW.json`. Mechanically replace literals in widgets, `oauth.js` and `interaction-protocol.js` with `t()`. **The resolved locale is pinned to `zh-TW`.** A golden test asserts the widget DOM text and `ui/message` text are byte-identical to before | None, by construction | `ESTAMPES_I18N=off` pins the runtime to `zh-TW`, the same as Phase 1. Or revert. No data touched |
| **2. Locale selection + English UI** | Enable host locale and `ESTAMPES_DEFAULT_LOCALE` in widgets. Language picker. `<html lang/dir>`. `Intl` formatting. Store and permission text localized | Yes: English for non-zh hosts | Set `ESTAMPES_DEFAULT_LOCALE=zh-TW` and disable host detection with the flag. Revert is safe |
| **3. User-voice split (T2) + errors** | `ui/message` becomes a localized sentence plus an English structured block. Error `code` mapping. `HEDGES` per locale | Chat messages the person posts change wording. The model sees the same block in every locale | Flag to restore the current all-zh message. Model-behaviour regression check: compare the model's reading on recorded interactions (manual, labelled) |
| **4. Persisted names (T5)** | New documents store `nameKey`/`nameParams` (additive optional fields). Readers render them. Literal `name` is also written as a cache for older readers | Default names follow the viewer's locale | Older builds ignore the new fields and use the literal `name`. No migration of existing data |
| **5. Module runtime strings** | `locales/` in packages and `{key, params}` outputs, **designed inside module system v2** | Module output localized | Optional fields. Modules without them keep working |
| **6. More locales + RTL** | Contributor guide for adding a locale. zh-CN/ja/… on request. RTL polish when the first RTL locale is requested. Font image variant if D7 says so | Per locale | Remove the locale file |

## 10. Interaction with the UVA roadmap (P4–P7)

- **P4 (Graph documents, `gph:` ids, #183/#187, in progress).** It touches `visual-surface.html` and `src/workspace.js` heavily. Phase 1 extraction rewrites hundreds of lines in the same 2,771-line file, so there is a high merge-conflict risk. Mitigation: run Phase 1 **after the open 4A PRs land**, extract per panel in short-lived PRs, and announce a short freeze on `visual-surface.html`. New UVA code from now on should take user text from a catalog (Phase 0 lint in warn mode flags new literals). Graph documents' default names should be born as T5 keys rather than migrated later.
- **P5 (module system v2: #174 CAS decoupling, #85 module-owned interactive views, #86 capability flows).** This is the main conflict point. Module-owned views (#85) would let modules own UI text for the first time. If v2 freezes its view or output contract without a localization hook, adding one later is a breaking change to a public extension contract (`AGENTS.md` lists the module manifest and package formats as public). **Recommendation:** make §6.3 (`locales/` in packages, `{key, params}` outputs, namespaced keys, untrusted-data rendering) a required section of the v2 design, even if its implementation ships later.
- **P6/P7 (later UVA phases).** No direct conflict. Exports, bundles and the persistence layer only meet i18n through T5. Bundles must carry `nameKey` and the literal `name` together, and import must not localize or rewrite stored text, per the persistence rules in `AGENTS.md`.
- **Docs.** `scripts/check-docs.mjs` could later flag zh-TW pages older than their English source. That is optional.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Merge conflicts with concurrent UVA work in `visual-surface.html` | Sequencing and per-panel PRs (§10). Mechanical extraction kept separate from behaviour changes |
| Model behaviour drifts when user-voice text changes language | The T2 structured block is English in every locale. A T3 golden test. Manual check on recorded interactions in Phase 3 |
| Host does not deliver a locale, so existing zh users suddenly see English | `ESTAMPES_DEFAULT_LOCALE`. Release-note instruction. Verify live hosts in Phase 2 |
| Localized text frozen into persisted documents (already happening for default names) | T5 keys from Phase 4. Never rewrite old data |
| Untrusted module translations (spoofing, giant strings, markup) | Same validation as manifests. Text-only rendering. Covered by package signature. Placeholder parity |
| Server renders show missing glyphs for non-Latin text | Phase 0 verification. Font layer or image variant (D7) |
| Translation upkeep for a one-maintainer project | Only en and zh-TW are required to be complete. Other locales are partial with per-key fallback. CI shows missing keys rather than blocking |
| Bundle size of inlined catalogs | Budget in §4. Switch to fetch when there are more than 3 locales |

**Global rollback.** Through Phase 2, the zh-TW catalog equals today's strings and the `ESTAMPES_I18N=off` flag pins the locale to zh-TW, so turning the flag off restores today's UI without a redeploy of older code. Phases 3–5 add only optional fields and per-feature flags. No phase migrates or rewrites existing user data.

## 12. Decisions

All ten were decided on 2026-11-18 by the maintainer, who accepted every recommendation below. The "Recommendation" column is therefore the decision.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Source and fallback language | (a) English keys and fallback, zh-TW complete. (b) zh-TW as source | **(a).** The repo is public and English-first. Existing users set `ESTAMPES_DEFAULT_LOCALE=zh-TW` or rely on a host locale |
| D2 | Message library | Hand-written ICU subset vs a library (i18next, FormatJS) | **Hand-written.** No build step, single-file widgets, no new dependency or supply-chain surface |
| D3 | Locales in v1 | en + zh-TW only vs more | **en + zh-TW.** Add others on request with partial-catalog fallback |
| D4 | Language of messages posted as the user (T2) | (a) Person's locale plus English structured block. (b) Always English. (c) Keep zh | **(a).** The chat shows them as the person's words, and the block keeps the model's reading stable |
| D5 | Model-facing text (tool descriptions and results) | Keep English and invariant vs localize | **Keep English and invariant**, guarded by a golden test |
| D6 | Default names stored in documents | Key plus literal cache (new docs only) vs keep literal | **Key plus literal cache, new documents only.** No migration of old data |
| D7 | Fonts for server-side rendering | Add Noto to the main image / separate `-fonts` image variant / do nothing | **Revised 2026-11-18 (§7.1):** a small Latin font in the base image (bug fix), plus a mounted font folder now, plus Store font packs in module system v2 (P5). No image variant |
| D8 | Third-party module runtime strings | Design now inside module system v2 vs later | **Make it a required section of the P5 design now.** Implement later |
| D9 | Timing versus UVA | Start Phase 1 now / after open Phase 4A PRs / after P5 | **Phase 0 now. Phase 1 after the open 4A PRs merge**, per panel, with a short freeze on `visual-surface.html` |
| D10 | RTL | Full mirroring in v1 vs bidi-safe user text now, mirroring when the first RTL locale ships | **Bidi-safe user text now. Mirroring later** |

### 12.1 D1 in practice: English base or zh-TW base

The maintainer asked what "zh-TW complete" means and whether it is native support. It is native under both options: zh-TW strings are hand-written in the repository, never machine-translated at runtime, and CI requires every key to exist in zh-TW. "Base" only decides which catalog is the reference for keys and the last fallback. The comparison:

| Aspect | English base (decided) | zh-TW base (alternative) |
| --- | --- | --- |
| What a zh user sees | Identical. With a Chinese host locale or `ESTAMPES_DEFAULT_LOCALE=zh-TW`, every string is zh-TW | Identical |
| Writing a new string | Add the key to `en.json` and `zh-TW.json` in the same PR. The parity check fails otherwise | Add it to `zh-TW.json` and `en.json` in the same PR. Same rule, other order |
| Fallback when a key is missing | Falls back to English. With parity enforced for en and zh-TW, this only happens in partial extra locales (a ja user sees English for untranslated strings) | Falls back to Chinese. A ja or en user of a partial locale sees Chinese, which most non-Chinese readers cannot use |
| Third-party modules | Matches what exists: manifest base fields (`name`, `description`, capability `description`) are already English, and module authors elsewhere will write English first. `nameI18n` adds zh-TW | Modules would be expected to ship zh-TW as their base, or the core needs a second rule ("module base is English, core base is zh-TW"). That is confusing and goes against the existing manifest format |
| Outside contributors | Can write the English string. The maintainer or a translator fills zh-TW. CI parity needs a "translation pending" marker so their PR is not blocked | Must write Chinese to add any UI text, which most outside contributors cannot do |
| Maintainer effort | The maintainer reads zh-TW first but has to keep English in sync | Natural for the maintainer, who already writes zh-TW, but English quality depends on later passes |
| Consistency with docs | Same as docs policy: English canonical, zh-TW maintained | Opposite of docs policy |
| Migration cost | Phase 1 has to write English for about 630 existing zh lines | Phase 1 extraction is mechanical. English can follow later |

Net: the difference is mostly about contributors, third-party modules and fallback for future partial locales, not about what Chinese users see. zh-TW base is cheaper for Phase 1 alone. English base is cheaper over time for an open, public module ecosystem. A middle path is possible: extract zh-TW first in Phase 1 (pinned locale, byte-identical) and write the English catalog in Phase 2, while keeping English as the base. The phase plan already does this.
