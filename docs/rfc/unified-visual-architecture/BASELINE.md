# Repository / Test / Performance Baseline

Status：**CURRENT source + OBSERVED executions**。Date2026-11-01 UTC。所有newarchitecture是Proposed；OpenDecisions見OD，Futureextensions未測未實作。

## Repository Baseline

| Item | Observed |
| --- | --- |
| Remote | https://github.com/Curium-3391/Estampes |
| 初始checkout | branch work，8220e42a8ac1d0865e5c4f67f3ebf471306b66a1，0.19.8，clean |
| Remote refresh | git fetch origin，origin/main更新至7fb9b73442401fc32a7034888deaf49303e582a6 |
| Audited commit | **7fb9b73442401fc32a7034888deaf49303e582a6**，merge PR60，0.20.0；package/lock/Changelog一致 |
| Working branch | docs/unified-visual-architecture-phase0，從最新origin/main建立，未修改main |
| AGENTS | repo與workspaceancestor未找到適用AGENTS.md；CONTRIBUTING要求大實作先issue，本次限RFC/characterization無大實作 |
| Scope | server/全部src/public/CAS/CI/Docker、現行docs/Changelog與測試索引；95source/configfiles、57baselineNodetestfiles |
| User data | 未讀寫/workspace/.estampes-data；tests/harness用tempstores；沒有核心API/格式變更或資料遷移 |

目前Remote只代表fetch當時最新；後續Agent需重新fetch比較SHA，不把本文件當main永遠不變的保證。

## Execution Environment / Dependencies

Linux6.18.57 x86_64；IntelXeonPlatinum8573C，OS可見3CPU、cgroup2CPUquota；container8GiBlimit。預設Node24.19.0/npm11.9.0與專案engines22.x不同，另使用npmexec的Node22.23.4。Python3.12.14、SymPy1.14.0/mpmath1.3.0（lock相同）；CI Python3.13本次未另跑。Chromium154.0.8037.57系統binary /usr/bin/chromium。Sharp0.34.5及完整libversions在benchmark JSON。

預載PDF4.10.38、@napi-rs/canvas；補裝playwright-core及PDFoptionalpackages，使用 `--no-save --package-lock=false`，package.json/lockfile無diff。測試使用`env -u ESTAMPES_STORAGE_DIR -u ESTAMPES_ACCESS_KEY`避免既有shell設定污染defaults；browser指定CHROME_BIN。未更動外部運行中的Estampes或使用者資料夾。

## Actual Commands / Results

| Run | Command / settings | Actual result | Interpretation |
| --- | --- | --- | --- |
| Initial | npm test；預設Node24；未設定CHROME_BIN | **273 tests；266pass、7fail、0skip；91.151s；exit1** | 7項全為Playwright找不到預期downloaded Chromium；不是證明codefailure，也不能刪掉失敗紀錄 |
| Audited baseline | CHROME_BIN=/usr/bin/chromium npm exec --yes --package=node@22 -- npm test（清理上述2env） | **273pass、0fail、0skip、0cancel；109.103s；exit0** | latestsource全suite，含CAS、PDF與FakeHostbrowser；不含真ChatGPT |
| Python CAS | python -m unittest discover -s cas-service/tests -v | **17pass；6.889s；exit0** | 真PythonUnixsocket/worker與ops；有unclosedfile ResourceWarning，未改測試 |
| Characterization | npm exec --yes --package=node@22 -- node --test tests/uva-characterization.test.js | **2pass、0fail、0skip；365.589ms；exit0** | 新增非破壞tests，只保護現況storage與axes/mark行為 |
| Docs initial | npm run docs:check | **pass：46Markdown、55tools、22configvars；exit0** | baseline文件/工具一致性，不代表design已批准 |
| Release initial | npm run release:check | **pass：Release0.20.0consistent；exit0** | 只checkmetadata，不push/tag/build/release |
| Final suite | 同Node22全suite命令，含新增characterization | **275pass、0fail、0skip、0cancel；114.554s；exit0** | 已實際全套重跑，不是273+2推算 |
| Research benchmark | Node22執行evidence/benchmark.mjs；清理上述env | **exit0**；4workloads×12measuredsamples，2warmups | 首次harness因lazyEntry.marks未初始化失敗，修正researchharness後重跑；沒有改production |

Initial 7failfiles：cards-e2e、layers-e2e、surface-open（2case）、upload、workbench-e2e、zoom-perf。CHROME_BIN/Node22重跑全部通過，因此本次無剩餘已觀察producttestfailure。現有browsercasepass屬realserver+realwidget+realSymPy+**FakeHost**；沒有取得真ChatGPTWeb/MobileHost驗收。Initial執行中optionalinstall曾更新未追蹤的node_modules，因此該run只作環境診斷，不作穩定perf比較；Node22baseline於install完成後開始。

未執行：Dockerbuild/Composesmoke、tagreleaseworkflow、多archimagebuild、Python3.13環境重跑、realChatGPTWeb/iOS/Android/MCPAppsCSPmanual。原因：Phase0聚焦已可直接執行的localtests與docs，真Host需要實際session；既有container安全配置只做sourceaudit。不得將未執行列成skiptestpassed。

## Performance Observations / Derived Proposal

可重跑harness：[benchmark.mjs](evidence/benchmark.mjs)；rawsamples與版本：[benchmark-results.json](evidence/benchmark-results.json)。合成資料：3000×2000PNG、20個sin(n*x)functionplots、100條128-pointstroke、1600maxSide render，先暖機；tan(x)另外量sampler。freshimport每sample使用新dir、清除registries並flushstorage，沒有重複importfastpath混入。

| Workload | median ms | nearest-rank p95 ms（12samples） | Proposed median gate ms（×1.25） | Proposed p95 gate ms（×1.25） |
| --- | --- | --- | --- | --- |
| tanadaptive sampling | 3.543 | 7.488 | 4.429 | 9.360 |
| mixedwarm serverrender | 393.389 | 464.950 | 491.736 | 581.188 |
| bundleexport | 56.773 | 65.543 | 70.966 | 81.929 |
| bundlefreshimport | 117.945 | 166.473 | 147.431 | 208.091 |

EndRSS344555520bytes（約328.6MiB），**不是peak或perviewer記憶體**；fixtures尚有cache與imports累積，不能歸因單一store。sample小、sharedcloudrunner，只能當規劃baseline；1.25倍是待批准regressionallowance，不是實測改善。現有zoom-perf觀察40wheelburst1804ms、photoelementreuse=true、scenechildmutations=0，測試無FPS/各framepercentile，不能宣稱60fps。

未有數字的multiViewer、panelresize、docpropagation、highres/multiimagepeakmemory依RFC007量測計畫，在Phase3exit先量再定budget；不能以未測定SLO取代要求。canonicalgeometry與metadata完整性不因perfthreshold放寬。

## Final Verification

已實際完成：Node22全suite275pass、Python17pass、新characterization2pass（亦包含於275）、4workloadbenchmark、docs:check、release:check、gitdiffwhitespacecheck、Phase0scope/ID/hashconsistencycheck。原始logs與SHA256/命令/exitcodes列[execution manifest](evidence/execution-manifest.json)。沒有執行Docker/realHost/Python3.13/multiViewer性能驗收，沒有核心重構、資料遷移或發布。

文件修改範圍：新增本套RFC/ADR/appendix/audit/baseline/testmatrix/trace/risk/OD/hostscript/evidence與rootRoadmap；既有docs/ARCHITECTURE只加Proposedreview入口；新增tests/uva-characterization；95個baselineproduction/configfiles內容雜湊不變。最終planningcommit由git與交付回報識別，不把它混同為auditedimplementationSHA。

Readiness：**READY WITH BLOCKERS — Architecture Approval Required**。Phase0planning與可用tests完成；Phase1未開始，需OD-01/02及其相依ADR明確批准；後續Host與新功能tests是各自phasegates，不能誤列為Phase0已實作。
