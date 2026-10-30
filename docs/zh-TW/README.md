# Estampes 繁體中文說明

**人與 AI 在同一張圖上指著說話。**

[English](../../README.md) · 繁體中文

名稱取自德布西的鋼琴曲集《版畫》（*Estampes*, 1903）。

## 能做什麼

討論圖片時，常常要截圖、另外開編輯器畫圈、再重新上傳，然後來回問「是哪一個？」。Estampes 把這些步驟放回對話裡：

- **GPT 指給你看**：在原圖上畫框、箭頭、折線、手繪線和文字標記，每個標記可以附備註和狀態。
- **你指給 GPT 看**：在同一張畫布上用筆、螢光筆、框、箭頭標出位置，寫一句話，按送出。
- **不改動原圖**：標記是獨立的圖層，可以顯示、隱藏、改名、排序、調透明度、鎖定。
- **看清楚細節**：畫布內可以縮放和平移，放大時載入原始解析度；GPT 可以對局部做對比增強、銳化、降噪、二值化、邊緣偵測或加上座標格線再判讀。
- **兩張圖並排**：左右對照兩張不同的圖（例如圖紙與實物、修改前與修改後），GPT 記錄兩邊對應的位置。
- **說法要有證據**：GPT 的每個說明與連結都附上信心、證據（在哪張圖的哪個位置，按一下就放大）與待解問題；只有你確認或工具佐證才算數。你否決過的說法會被記住，GPT 沒有新證據不能在同一處重提。
- **跨回合、跨對話**：標記、圖層、變更歷史都存在你自己的伺服器上，可以匯出成圖片和分層 SVG（可用 Inkscape 開啟），或匯出 JSON 之後再載入。

圖片來源只用 ChatGPT 原生的方式：在對話中上傳、拍照，或由 GPT 提供公開網址。Estampes 負責像素處理和座標，**辨識和判斷仍然是 GPT 做的**，不確定的位置會標示出來。

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

驗證方式選 **No authentication**（金鑰已經在網址裡）。這行網址含有金鑰，請不要給別人看。完整步驟、Heroku 與 Render、所有環境變數見 [Deployment（英文）](../DEPLOYMENT.md)。

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
| [部署](../DEPLOYMENT.md) | Docker、Heroku、Render、連接 ChatGPT、環境變數、儲存內容 |
| [使用指南（英文）](../USAGE.md) | 在 ChatGPT 裡使用畫布：標記、圖層、縮放、並排比對、匯出 |
| [工具一覽（英文）](../TOOLS.md) | MCP 工具與 HTTP 端點 |
| [視覺協定 2](../PROTOCOL-V2.md) | `estampes.visual/2`：描述整張畫布的 JSON 格式，含每個說法的證據與驗證狀態，不綁定 ChatGPT |
| [願景](../VISION.md) | 想解決的問題、使用情境、非目標 |
| [架構](../ARCHITECTURE.md) | 伺服器、畫布小工具與 GPT 如何分工（英文） |
| [變更紀錄](../../CHANGELOG.md) | 各版本的變更 |
| [開發歷程](../history/README.md) | 早期里程碑筆記與舊版協定草稿 |
| [貢獻](../../CONTRIBUTING.md) | 歡迎哪些貢獻 |

## 目前狀態與限制

目前版本見 [`package.json`](../../package.json) 或伺服器的 `/version`。

- 上傳、畫布、標記、圖層、縮放、並排比對都已在 ChatGPT（網頁與手機）實測過。
- GPT 對圖片內容的辨識準確度沒有保證，Estampes 不替模型判斷「這是什麼」。
- ChatGPT 外掛 API 不允許直接在 ChatGPT 自己顯示的圖片（例如搜尋結果的圖）上疊圖層，所以圖片要經由 Estampes 的畫布顯示。
- 存取金鑰是放在網址裡的共用密碼，不是個人帳號驗證；不要把連接網址分享給別人。
- 只支援自架，沒有官方代管的服務。

## 授權

[Mozilla Public License 2.0](../../LICENSE)。你可以使用、修改和重新散布 Estampes，也可以放進閉源或商業產品裡；但散布時，對 Estampes 本身檔案所做的修改，必須以 MPL 2.0 公開。
