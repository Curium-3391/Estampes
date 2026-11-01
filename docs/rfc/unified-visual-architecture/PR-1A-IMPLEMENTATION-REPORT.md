# PR-1A — Document Foundation Implementation Report

Status：**IMPLEMENTED — PRE-MERGE VALIDATED**。維護者已批准的範圍僅[PR-1A有限授權](PR-1A-AUTHORIZATION.md)，不是全部OD/ADR或Phase1 writer批准。下列CURRENT指隔離production modules，OBSERVED指測試，PROPOSED/DEFERRED指尚未啟用的服務。日期2026-11-02（Asia/Taipei）。

## 1. Repository baseline / branch

- Production baseline及fetch後origin/main：`7fb9b73442401fc32a7034888deaf49303e582a6`；version仍0.20.0。
- Phase0 →0.1 →0.2 ancestry：`b42e6afc7ca78b280ad522a93e111ba2ef407cd7` → `df70d2bfb84f5548fb8e7fc81ebfbd0eb4eefadd` → `1fc6de91d1618e57a492eee1059c54d0bb0f735d`，已逐次驗證。
- 開始時workingtreeclean；先依使用者要求push Phase0.2並ls-remote確認exact SHA，然後由該commit建立 `feat/unified-visual-architecture-pr1a`。未用較舊分支、未reset/rebase/force/main edit。
- PR-1A將依授權commit但不push／merge；新commit由最終git回報，不在此自我嵌入SHA。
- 原95source/config hashes、現有production source與既有tests保持不變；新增10production modules與2test files/1fixture。沒有新runtime dependency、version或部署變更。

## 2. Added / modified files

| File / group | Purpose / scope |
| --- | --- |
| src/documents/validation.js | Stable error codes、JSON size/depth/node/acyclic/prototype防護、canonical JSON/hash及detached JSON copies |
| src/documents/identity.js | UUIDv4 generation/parsing、legacy local IDs、Asset refs、request→command及stored entity reference語法 |
| src/documents/references.js | Full typed refs、logical versionrefs、namespaced allocation tables、collision rejection |
| src/documents/provenance.js | Principal/Actor/Owner/Provenance/import profile schemas、immutable creator/user audit、pure grants intersection |
| src/documents/schema.js | Versioned dual-domain Doc/Scene/Layer/Annotation/Object/Frame/Binding/read-history模型及local invariants，重用既有props／expression parser |
| src/documents/embed-schema.js | Sole-child-reference Embed／binding、snapshot capture、matrix/clip、eligibility/refusal形狀 |
| src/documents/integrity.js | 提供snapshots之跨Doc Ref／binding一致、cycle/depth/visited驗證；不是Store或authorization service |
| src/documents/input-schema.js | Inactive strict annotation create/update/delete wire subset；拒client actor／author／owner／resolved pose |
| src/documents/legacy-shadow.js | Pure JSON snapshot projection、明確Context／allocation、isolated original sidecar、unsupported/blocking reports |
| src/persistence/commit-root-schema.js | 六root與CURRENT／membership／recovery／alias／ledger structural metadata；無writer |
| tests/documents-foundation.test.js | Identity/ownership/domain/reference/security-shape/serialization/bounds/root counterexamples |
| tests/documents-shadow.test.js | Fidelity、historical/import trust、metadata archives、ambiguity/collision拒絕、actuallegacy serialization／edit policy |
| tests/fixtures/uva-pr1a.mjs | Synthetic deterministic UUIDs／Graph／Embed／legacy rich records，無user data |
| PR-1A-AUTHORIZATION.md / evidence/pr1a-authorization.json | 明確有限human approval來源與exact additions allowlist；不擴後續PR |
| PR-1A-SCHEMA-CONTRACT.md | Exact exports、boundary profiles、機械表示與已知未實作範圍 |
| 本report / TEST-MATRIX / TRACEABILITY / root Roadmap / README / OPEN-DECISIONS | 實作證據、partial UVA與剩餘gate，歷史Phase0 reports不改寫 |
| RFC-006 / evidence/proposed-contracts.mjs | 說明unknownlegacycreator僅限新shadow，保舊API default；Embed read ID補齊既有文字允許的legacy local ID |
| evidence/check-consistency.mjs | 嚴格放行13個新增code/test paths，保95舊hash／歷史／舊tests限制，不放行writer或舊core變更 |
| evidence/pr1a-baseline.json / pr1a-execution-manifest.json / pr1a-logs | Baseline／actual command/exit/counts／new file hashes與原始logs |

這些是**新增但未接線**的production code，不是把全部變更稱docs-only。舊server.js、ImageEntry、Canvas/Scene/Storage、Module Runtime、CAS/Graph、Workbench、deployment皆零diff。

## 3. Architecture contracts implemented

CURRENT：strict version1 Document與inline Scene、Graph無asset需求、單SceneOwner、dual Annotation/Object、typedrefs、closedmetadata與namespaced extensions；layer.content唯一membership、legacy跨kind同字ID可分辨；Frame/gesture/intent references；明確Tombstone可保retained-invalid anchor。Object props使用原typed validators，source-relative／world資料不轉Raster；沒有重寫graph math。

CURRENT：不可變createdBy/createdAt/original/sourceTrust、lastEditedBy、sticky user edit revision、module signer/lineage descriptors、import unknown/unclaimed、server-only ActorContext read形狀與wire rejection。Current/grants/adoption event／Host session真實性**未驗**；解析資料不是授權。

CURRENT：Embed object/binding childRef完全一致、snapshot獨立identity/capture revision、有限affine condition、clip、snapshot refusal；跨Doc集合驗canonical binding collision、cycle、depth8/visited12與去重edges。沒有第二份child scene data，也沒有render/clone/child-edit implementation。

CURRENT：coherent六root結構、非self-referential membership/recovery descriptors、positiveauthority epoch、typed alias/ledger/logicalrevisionrefs、CURRENT checksum一致。沒有讀reference pages、fsync、lease、publication或durable ACK。

CURRENT：唯讀shadow mapper不呼叫Store、clock、UUID allocator或renderer。完整source sidecar可hash還原，supported geometry/layers/scene props/annotation fields保留；unknown/歷史intent/舊history與unsupported內容有report；unrepresentable active objects或ambiguous refs返回document=null。由caller提供已驗Asset/transform/identity，不從16hex alias猜fullbytes，也不替legacy PNG造假Asset。

## 4. Exact public / internal interfaces

完整export contract見[PR-1A-SCHEMA-CONTRACT](PR-1A-SCHEMA-CONTRACT.md)。這裡的public是**ES module exports**，沒有新增MCP tool／HTTP／WASM ABI／config。主要函式：

- identity：`createId(kind)`、`parseId(kind,value)`、`parseAssetRef(value)`、`normalizeRequestId(req)`。
- model：`parseVisualDocument(value)`、`parseDocumentJson(text)`；native `.safeParse` schemas區分trusted records與inactive client inputs。
- refs：`parseRef`、`lookupIdentity(table,source)`、`validateDocumentReferences(documents)`、`resolveReference(documents,ref)`；只有caller-provided snapshots。
- provenance：`parseProvenance`、`assertCreatorUnchanged(before,after)`、`intersectGrants(installation,capability,lease)`；不建authenticated session／grant store。
- embed：`assertEmbedBinding(object,binding)`與structural eligibility/refusal schemas。
- wire：`parseEditDocumentInput(value)`、`parseAnnotationPatch(input,storedType)`；沒有executor，其他future ops不假裝已實作。
- metadata：`parseCommitRoot`、`assertCurrentEnvelope(root,envelope)`、`assertCommitIndexEntry(root,entry)`；驗提供資料，不查disk。
- compatibility：`mapLegacyCanvas(canvasJsonRecord,context)` → `{status,document,sidecars,report}`；stable errors為`DocumentValidationError(code,message,path)`。Mapping diagnostics UNKNOWN_AUTHOR/ARCHIVED_LEGACY_FIELD是report codes，不冒充新registered MCP error codes。

Canonical排序沿現有src/modules/packages.js的Object.keys.sort規則；不round geometry、不coerce ID、不默默drop unknown formal fields。原始sidecar與returned projection沒有共享可變JSON leaves。

## 5. Actual tests / commands

所有驗證命令／環境／exit/counts與loghash已記錄於[evidence/pr1a-execution-manifest.json](evidence/pr1a-execution-manifest.json)。Node命令明確透過`npm exec --yes --package=node@22 --`；Node22.23.4、Python3.12.14、Chromium154.0.8037.57、Sharp0.34.5/libvips8.17.3，沒有以預設Node24冒稱Node22。

| Command / scope | Actual result | Exit |
| --- | --- | --- |
| `env -u ESTAMPES_STORAGE_DIR -u ESTAMPES_ACCESS_KEY CHROME_BIN=/usr/bin/chromium npm exec --yes --package=node@22 -- npm test` | 328 pass、0 fail/cancel/skip/todo；131389.889668ms；含原275與新增53，不重複相加focused | 0 |
| `npm exec --yes --package=node@22 -- node --test tests/documents-foundation.test.js tests/documents-shadow.test.js` | 53 pass、0 fail/skip；最後source單獨重跑 | 0 |
| `npm exec --yes --package=node@22 -- node --test docs/rfc/unified-visual-architecture/evidence/contract-validation.spec.mjs` | 22 pass、0 fail/skip；原期待未改 | 0 |
| `npm exec --yes --package=node@22 -- node docs/rfc/unified-visual-architecture/evidence/validate-contract-examples.mjs` | EX-01..09共9個formal examples、9 fences、7 tool schemas，0 errors；這些仍是Proposed API範例 | 0 |
| `python -m unittest discover -s cas-service/tests -v` | 17 pass、0 fail/skip；6.240s；有unclosed-file/StreamWriter ResourceWarnings及asyncio teardown診斷 | 0 |
| `npm exec --yes --package=node@22 -- npm run docs:check` | 85 markdown files、55 tools、22 config variables | 0 |
| `npm exec --yes --package=node@22 -- npm run release:check` | 0.20.0一致；只有check，未push tag或publish | 0 |
| `npm exec --yes --package=node@22 -- node docs/rfc/unified-visual-architecture/evidence/check-consistency.mjs` | 8 RFC、12 ADR、67 UVA、23 PR、R/FG各6、OD各6、95舊hash／歷史紀錄／原16doc期待保持、9formal範例；僅明列PR-1A additions可變更 | 0 |
| `git diff --check 1fc6de91d1618e57a492eee1059c54d0bb0f735d`（含stage後新增檔） | 無whitespace errors | 0 |

執行環境：Linux x64 kernel6.18.57、container overlayfs；npm11.9.0、Zod4.6.7。Node22.23.4經npm exec使用，預設Node24.19.0只記錄為環境，不當作測試版本。完整Node套件也執行既有fake Host／Chromium UI測試，不能推論真ChatGPT驗收。[Baseline](evidence/pr1a-baseline.json)保存commit／ancestry、遠端refs及13新code/test hashes。

開發中曾有missing parenthesis smoke error，已在正式tests前修正。第一輪27tests有1項因fixture的props.child與binding.child共享同JS object，無法製造預期不一致；修fixture為獨立資料，保留拒絕預期。50tests輪的stress fixture意外重用既有bind ID，validator正確拒絕；修為真正不同IDs，不放寬duplicate檢查。原有passing tests／22proposed cases的期待皆未改。另在review發現JSON leaf alias與同shortalias fullhash collision，加入防護與反例，不能以這些development results代替最後source重跑。

未執行／非本PR：new writer/fsync/kill/recovery/GC、實際user data migration、真Module grant/adoption/Host session認證、Graph/Embed渲染／editing、完整v2 Bundle/CAS integration、真ChatGPT Web/Mobile/CSP、production imagePython3.13／跨平台持久性與performance benchmark。Future cases沒有加成必敗或skip tests；schema pass不代表新runtime behavior已通過。

## 6. Legacy compatibility evidence

原275suite與95source/config hashes保護實際舊路徑；新增test直接調用現有serializeCanvas/restoreCanvas，比對shadow前後legacy序列化，並確認old editCanvas仍拒user移動/restyle AI mark。未更改既有授權、scene op、API／URI／manifest／ABI／bundle／data formats。

新shadow保legacy mark/object/layer ID、stroke時序、opacity0、empty/locked layers、Scene props與原tool evidence、rejections／gesture original；缺creator不借layer.module、不虛構時間／actor。外部歷史confirmed可保review/history，current不直接confirmed。legacy `.edited`無法證明原Evidence仍適用時stale，raw不刪。

`status:mapped`只表示可產有效read projection；遇未知metadata可能editableComplete=false但rawRecoverable=true。缺explicitlayer/refmapping、unknown objects、duplicateIDs、fullhashaliascollision、legacyPNG轉asset等會block。沒有聲稱支援全部legacy migration；無法顯示為正式模型的資料仍保完整sidecar/report，且未動source。

## 7. PR-1A acceptance matrix

| Requirement / subset | Implemented evidence | Deferred boundary |
| --- | --- | --- |
| A IDs/import namespaces/collisions | production typed parsers/generators、Ref scopes、mapping tables、53focused tests中的identity cases | registry分配／真正bundle import／cross-store closure |
| B Document/Scene/Annotation/Object/Layer/Frame/binding | strict schemas、dual domains、owner/default/membership/localrefs、typed external snapshots | Renderer point sampling、store subscription／content commands |
| C Authorship/Actor/Owner | read/wire分離、immutable creator、import unknown、module lineage、grantintersection shape/helper | Current grants/session/adoption proof、LLM/user editing policy activation |
| D Embed | canonical binding、live/snapshot identity、matrix/clip、structuralcycle/refusal | preflight traversal authorization、clone transaction/render/edit |
| E CommitRoot metadata | 六roots、membership/recovery/hash/alias/epoch/ledger shape、CURRENT consistency | physical file hashes/closure、writer/fsync/GC/retention execution |
| F Pure shadow mapping | actual legacy snapshot fidelity、determinism、isolated original、explicit blockers/report | exhaustive migration／PNG intake／store authority／new durable files |
| UVA-01 subset | typedidentity、asset-independent Graph **model**、duplicates | actualdocument create/lifecycle/asset writes |
| UVA-03 subset | scene typedprops/ref/layer/owner validation | real scenecommand transactions/permission/rollback |
| UVA-24 subset | read-onlyshadow/metadata/sourcefidelity | planner/side-write/commit/reload/migrationreport |
| UVA-27 subset | oldruntime tests/hash unchanged、serialization/edit policy | newlegacytool adapter與v2formats integration |
| UVA-28 / UVA-42 subset | forgedactor fields拒絕、lineage/effectivegrants資料形狀 | actualruntimepermissions/currentgrants/latejobs/Hostauth |
| UVA-55 subset | proposed22tests/九examples＋production equivalent applicable fields/negativecases | fullnewAPI implementation/validator dispatch equivalence |

每個UVA只標明**適用subset**；沒有將整個67case或整個UVA-01/03/24/27/28/42/55標Passed。PR-1A退出以本表範圍為準，不提前替後續PR解gate。

## 8. Deviations / implementation mechanics

沒有架構方向偏離或newruntime dependency。JSON read-history容器、boundedinput防護及tuple表示在SchemaContract明列，都是既有概念的mechanics，不啟動新協議。Scene Object沿用原evidence domain，沒有為統一Marks而抹資料。

兩個文件澄清：RFC006的missingauthor句明確區分legacy importer default與新shadow unknown（遵循最新授權與ANNOTATION-POLICY）；docs-onlyEmbeddedObject validator原只允UUID，補為正式EMBED-CONTRACT已明列的legacy local object ID union。新創建仍由server UUID；沒有將legacy image自動變embed，既有tests預期不變。

Resource guarding不宣稱滿載64MiB或5000strokes性能已證，細節在SchemaContract。原始source bytes hash／PNGdecode未由此純函式驗證；canonical sidecar hash不是磁碟source bytes hash。維護者需在未來intake／migration／writer整合時補真證據，不能把Context宣稱當驗證。

## 9. Risks / deferred requirements

- Trusted read schemas不認證caller；adoptionEventId／sourceTrust／persistence資料值不能當權限或durable ACK。新工具啟用前必須完成server-only ActorContext、current grant/ownership/locks、user edit guard與scope enforcement。
- CrossDoc helper只能驗提供的snapshots，不能證實未提供store／assetbytes／archive是否存在，更不是原子交易或跨Widget一致性。
- Legacy unsupported entities返回block/raw，不提供假placeholder renderer或自動PNG；後續UI需顯示report與explicit choices，不可當已完成migration。
- History inverse/forward只是bounded read data，不能由未驗操作直接執行；newUndo/Redo/evidence classifier仍待對應PR。
- 所有later deployment/capacity/durability、realHost、performance budgets與OD-03/04/05等原gate維持pending。

## 10. Rollback

本PR沒有改檔案格式／user volume，也沒有任何新工具或writer啟用。回退此implementation commit或移除這13個隔離code/test additions及對應doc changes即可恢復原baseline active paths；不需要資料rollback、pointercutback、舊binary寫入新volume或刪使用者資料。若後續integration開始使用新schema，那是另一PR，必須依自己的rollback gate處理，不從這個無資料變更rollback推廣。

## 11. Readiness for PR-1C review / stop

PR-1A提供可審的schema/readonly prerequisite；**PR-1C implementation not authorized**。下一次審查可使用已固定CommitRoot/Ref/Provenance interfaces與tests，但仍需OD-01/ADR-010 backend、fsync/lease/physicalclosure與故障測試的明確範圍批准。PR-1D/1B同樣未獲准，不因本次Nodepass就開writer或cutover。

已完成final checks；建立獨立commit後停止；不push PR-1A、不merge、不release、不進下一PR。
