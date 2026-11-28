# Estampes 繁體中文說明

**人與 AI 在同一張圖上指著說話。**

[![M8ven Score](https://m8ven.ai/badge/mcp/curium-3391-estampes-gzwn2t?v=555a26cb79941f5f59b88979b3085efa)](https://m8ven.ai/mcp/curium-3391-estampes-gzwn2t?s=readme)

[English](../../README.md) · 繁體中文

名稱取自德布西的鋼琴曲集《版畫》（*Estampes*, 1903）。

## 能做什麼

討論圖片時，常常要截圖、另外開編輯器畫圈、再重新上傳，然後來回問「是哪一個？」。Estampes 把這些步驟放回對話裡：

- **AI 指給你看**：在原圖上畫框、箭頭、折線、手繪線和文字標記，每個標記可以附備註和狀態。
- **你指給 AI 看**：在同一張畫布上用筆、螢光筆、框、箭頭、四邊形（對齊傾斜或有透視的物體）和文字標出位置，寫一句話，按送出。箭頭的意思以你寫的話為準（「水往這邊流」是方向，「這指到什麼？」才是指認）；分好幾筆畫成的箭頭會被認出是同一個手勢的候選，你可以確認、否決或自己組合，筆畫本身不會被合併。
- **一起編輯**：用「選取」可以拖曳、縮放、改形狀或旋轉任何未鎖定的標記，包括 AI 畫的；AI 會被告知你具體改了什麼。「上一步／下一步」也能復原已經送出的修改；畫布開著的時候，AI 在別處做的變更會自動出現。
- **不改動原圖**：標記是獨立的圖層，可以顯示、隱藏、改名、排序、調透明度、鎖定。
- **看清楚細節**：畫布內可以縮放和平移，放大時載入原始解析度；AI 可以對局部做對比增強、銳化、降噪、二值化、邊緣偵測或加上座標格線再判讀。
- **兩張圖並排**：左右對照兩張不同的圖（例如圖紙與實物、修改前與修改後），AI 記錄兩邊對應的位置。
- **說法要有證據**：AI 的每個說明與連結都附上信心、證據（在哪張圖的哪個位置，按一下就放大）與待解問題；只有你確認或工具佐證才算數。你否決過的說法會被記住，AI 沒有新證據不能在同一處重提。
- **多張圖放在一起**：一個工作區最多放 24 張圖，每張有自己的標記和座標；可以合併、拆分、複製、連結，不會把任何東西壓成一張圖，也能把整個工作區包成一個 `.estampes` 檔搬到另一台伺服器。
- **對位與量測**：兩張圖對位（會誠實回報品質）、疊圖或做差異、評估清晰度與雜訊、校準比例後量距離、面積、角度（附不確定度）、轉 PDF 頁面，以及偵測候選的形狀、線、圓或文字。
- **同一張畫布上的模組**：可選的 Store 提供「在畫布上放物件」的功能，而不是放像素：畫函數圖（Graph）、用 SymPy 精確計算（在獨立、隔離的容器裡跑，結果可以畫成圖），或替星空照片做天體定位。每個模組都要明確的權限，每次變更都由你核准。在 Graph 畫布上，每個標記可以選「固定在畫面」（預設，留在原位）、「固定在座標」（跟著資料移動）或「固定在曲線」（跟著某條曲線在同一個 x 的位置移動）；超出座標範圍的標記暫時不顯示，曲線刪除或在該 x 沒有定義時標示「錨點失效」並留在原位（見[使用說明（英文）](../USAGE.md#anchors-on-a-graph)）。
- **英文與繁體中文**：每個畫面跟著對話程式的語言顯示，畫布和 Store 標題列的「語言」選單可以自己選，選擇只存在你自己的瀏覽器。兩者都沒指定時用 `ESTAMPES_DEFAULT_LOCALE`（見[部署說明（英文）](../DEPLOYMENT.md)）。**從舊版升級、想維持中文介面的部署，請在 `.env` 加上 `ESTAMPES_DEFAULT_LOCALE=zh-TW`**，否則對話程式沒回報語言時會顯示英文。
- **跨回合、跨對話**：標記、圖層、變更歷史都存在你自己的伺服器上，可以匯出成圖片和分層 SVG（可用 Inkscape 開啟），或匯出 JSON 之後再載入。

圖片可以在 ChatGPT 對話中上傳或拍照、由 AI 提供公開網址，或用畫布上的「選擇圖片／拍照」按鈕直接放進畫布（Claude 不會把附件交給工具，所以在 Claude 用這個按鈕）。Estampes 負責像素處理和座標，**辨識和判斷仍然是 AI 做的**，不確定的位置會標示出來。

## 快速開始

每個人自己架一台。最簡單的方式是 Docker（amd64、arm64 都可以，包括 Raspberry Pi、NAS、迷你電腦）：

```sh
git clone https://github.com/Curium-3391/Estampes.git
cd Estampes
cp .env.example .env
docker compose up -d
docker compose exec estampes cat /data/access-key   # 第一次啟動自動產生的金鑰
```

ChatGPT 需要一個公開的 https 網址才連得到。想先試用，可以開內建的臨時通道（Cloudflare quick tunnel，不需要帳號，也不用改路由器設定），第二行指令會印出完整的連接網址：

```sh
docker compose --profile tunnel up -d
docker compose logs estampes | grep tunnel
```

臨時通道每次重啟網址都會變。長期使用請改用反向代理或具名通道。在 ChatGPT 網頁版 Plugins → **Add custom MCP server** 填入：

```
https://<你的網址>/mcp?key=<金鑰>
```

驗證方式選 **No authentication**（金鑰已經在網址裡）。這行網址含有金鑰，請不要給別人看。

**在 Claude 使用**：到 Claude 的 **Customize → Connectors → Add custom connector**，網址填 `https://<你的網址>/mcp`（不要加 `?key=`），OAuth 欄位留空，按 **Add** 再按 **Connect**。會打開你自己伺服器的授權頁，輸入金鑰按「允許」即可；金鑰不會交給 Claude，Claude 拿到的是可撤銷的權杖（換金鑰就全部失效）。之後在對話的「＋」選單開啟 Estampes，第一次顯示畫布時按 Allow。要給 Claude 看照片時，請它打開上傳畫布，再按「選擇圖片／拍照」。Claude Code 用 `claude mcp add --transport http estampes https://<你的網址>/mcp`。詳見 [Connecting Claude（英文）](../DEPLOYMENT.md#connecting-claude)。完整步驟、Heroku 與 Render、所有環境變數見 [Deployment（英文）](../DEPLOYMENT.md)。

本機開發（Node 22）：

```sh
npm ci
npm test
npm start          # http://localhost:8787/mcp
```

## 文件

除了這份說明之外，其他文件目前都是英文。

| 文件 | 內容 |
| --- | --- |
| [快速開始（英文）](../QUICKSTART.md) | 從部署到第一個標記，每一步的預期結果與失敗時怎麼辦 |
| [教學（英文）](../tutorials/README.md) | 標註照片、分析 PDF 頁面、解算星空照片；可自行產生的範例素材 |
| [相容性（英文）](../COMPATIBILITY.md) | 哪些客戶端、平台與選用功能被測過，以及怎麼測的 |
| [部署（英文）](../DEPLOYMENT.md) | Docker、臨時通道、Heroku、Render、連接 ChatGPT 與 Claude、環境變數、儲存內容 |
| [備份與還原（英文）](../BACKUP-RESTORE.md) | 儲存了什麼、備份、還原、升級與回復、金鑰外洩後怎麼辦 |
| [疑難排解（英文）](../TROUBLESHOOTING.md) | 連不上伺服器、圖片載入失敗、畫布異常、計算機不可用、模組權限錯誤 |
| [安全政策（英文）](../../SECURITY.md) | 單一擁有者的安全模型，以及如何私下回報漏洞 |
| [開發指南（英文）](../DEVELOPMENT.md) | 環境設定、各種測試、程式碼導覽、公開介面與內部實作、入門工作 |
| [模組快速入門（英文）](../modules/QUICKSTART.md)、[模組測試（英文）](../modules/TESTING.md) | 建立、測試、簽章並安裝模組；宣告式、WebAssembly、http 三種路徑 |
| [模組發佈（英文）](../modules/DISTRIBUTION.md)、[外部開發者驗收（英文）](../modules/ACCEPTANCE.md) | 發佈簽章的套件索引、在伺服器上加入來源；外部開發者驗收流程與結果 |
| [發布流程（英文）](../RELEASE.md) | 給維護者：版本順序、Docker 映像標籤、發布前檢查、回復 |
| [文件維護（英文）](../DOCUMENTATION-MAINTENANCE.md) | 給貢獻者：`npm run docs:check` 檢查什麼、改程式時要同步更新哪份文件 |
| [使用指南（英文）](../USAGE.md) | 在 ChatGPT 或 Claude 裡使用畫布：每個工具、選取與編輯標記、圖層、縮放、並排比對、匯出 |
| [工具一覽（英文）](../TOOLS.md) | MCP 工具與 HTTP 端點 |
| [影像管線（英文）](../IMAGE-PIPELINE.md) | 原檔、衍生檢視、精確的座標轉換、PDF 頁面、分析引擎 |
| [UVA 儲存（英文）](../UVA-BETA.md) | 預設的儲存引擎：設定、限制、匯出、退回舊檔案格式 |
| [UVA 斷電模擬（英文）](../UVA-POWERLOSS.md) | 怎麼模擬斷電來測試儲存，以及還沒通過驗證的部分 |
| [工作區（英文）](../WORKSPACES.md) | 多張圖放在一起；合併、拆分、複製、連結；`.estampes` 檔 |
| [模組（英文）](../MODULES.md) | 模組系統、Store、套件、背景工作、天體定位 |
| [科學計算機（英文）](../CAS.md) | SymPy 計算機模組與它的隔離容器 |
| [工作台（英文）](../WORKBENCH.md) | 畫布與計算機以視窗形式放在同一個小工具裡 |
| [畫布讀取（英文）](../CANVAS-READS.md) | `render_canvas`：把已存的畫布讀成像素 |
| [影像功能對照（英文）](../IMAGE-CAPABILITIES.md) | 影像工具涵蓋與不涵蓋的範圍 |
| [面板與版面（英文）](../SURFACES.md) | 面板與各裝置的版面（`estampes.surface/1`） |
| [視覺協定 2](../PROTOCOL-V2.md) | `estampes.visual/2`：描述整張畫布的 JSON 格式，含每個說法的證據與驗證狀態，不綁定 ChatGPT |
| [視覺協定 1（英文）](../PROTOCOL-V1.md) | 舊版格式，仍可讀取 |
| [願景](../VISION.md) | 想解決的問題、使用情境、非目標 |
| [架構](../ARCHITECTURE.md) | 伺服器、畫布小工具與 AI 如何分工（英文） |
| [變更紀錄](../../CHANGELOG.md) | 各版本的變更 |
| [開發歷程](../history/README.md) | 早期里程碑筆記與舊版協定草稿 |
| [貢獻（英文）](../../CONTRIBUTING.md)、[行為準則（英文）](../../CODE_OF_CONDUCT.md)、[求助管道（英文）](../../SUPPORT.md) | 歡迎哪些貢獻、互動規範、去哪裡發問 |
| [AI 代理規則（英文）](../../AGENTS.md) | 給在本專案工作的 AI 程式助手的規則 |
| [公開前檢查清單（英文）](../PRE-PUBLIC-CHECKLIST.md) | 給維護者：把儲存庫設為公開前要確認的事項 |

## 目前狀態與限制

目前版本見 [`package.json`](../../package.json) 或伺服器的 `/version`。

- 上傳、畫布、標記、圖層、縮放、並排比對都已在 ChatGPT（網頁與手機）實測過。較新的部分（工作台、計算機、天體定位、工作區、編輯 AI 的標記、四邊形與文字、畫布即時更新）由自動化測試與模擬宿主的瀏覽器測試涵蓋；各頁會註明是否已在真實的 ChatGPT 裡試過。
- 儲存：設定了儲存資料夾時（Docker 預設會設），圖片、畫布、工作區、面板版面與計算機筆記都存在 UVA 儲存裡，位置在儲存資料夾旁邊自己的資料夾（Docker 是 `uva-beta` volume）。舊資料第一次開啟時會自動搬進去；要退回舊格式，先用 `scripts/uva-to-legacy.mjs` 匯出，再設 `ESTAMPES_CANVAS_STORE=legacy`。預設設定能承受程序被強制結束，但還沒通過斷電驗證；備份時兩個資料夾都要備份（見[備份與還原（英文）](../BACKUP-RESTORE.md)）。
- AI 對圖片內容的辨識準確度沒有保證，Estampes 不替模型判斷「這是什麼」。
- ChatGPT 外掛 API 不允許直接在 ChatGPT 自己顯示的圖片（例如搜尋結果的圖）上疊圖層，所以圖片要經由 Estampes 的畫布顯示。
- 存取金鑰是一把共用密碼，不是個人帳號。ChatGPT 把它放在連接網址裡（不要分享這個網址）；Claude 在你伺服器的授權頁輸入一次，之後用權杖。
- Claude 的支援（登入、畫布上傳、結果大小限制）已有自動化測試，還沒在真實的 Claude 對話實測。
- 語言：英文與繁體中文。跟隨對話程式語言的功能用模擬宿主測過；ChatGPT 和 Claude 會不會把語言告訴畫面還沒實測，所以請用 `ESTAMPES_DEFAULT_LOCALE` 設定你要的預設語言。以你的名義送給 AI 的文字（標記意圖、確認或否決）在後續階段之前仍是繁體中文。
- 只支援自架，沒有官方代管的服務。

## 授權

[Mozilla Public License 2.0](../../LICENSE)。你可以使用、修改和重新散布 Estampes，也可以放進閉源或商業產品裡；但散布時，對 Estampes 本身檔案所做的修改，必須以 MPL 2.0 公開。
