# 變更紀錄

版本號以 `package.json` 為準。較早的里程碑細節在 [docs/history/](docs/history/README.md)。

## 0.7.2 — 臨時公開網址

- `docker compose --profile tunnel up -d` 開一條 Cloudflare quick tunnel，log 裡會印出 ChatGPT 的連接網址。不需要帳號，也不用改路由器設定；網址會在每次重啟後改變。

## 0.7.1 — 自架的安全預設

- Docker 沒有設定 `ESTAMPES_ACCESS_KEY` 時，第一次啟動會自動產生金鑰，存在 `/data/access-key`；`ESTAMPES_ALLOW_OPEN=1` 才會不用金鑰。
- compose 預設只綁 `127.0.0.1`，容器唯讀、移除所有 capabilities、`no-new-privileges`。
- `ESTAMPES_TRUST_PROXY` 設定後才信任 `X-Forwarded-*` 標頭。
- `/export` 下載連結有簽章。Heroku 會自動產生金鑰。

## 0.7.0 — 磁碟儲存、Docker 與視覺協定 1

- `ESTAMPES_STORAGE_DIR`：每張圖存成 `images/<hash>/`（原檔、`canvas.json`、`marks.svg`、變更歷史），重啟後畫布還在。
- Docker／compose（非 root、`/data` volume、`/healthz`），GHCR 多架構映像檔（amd64、arm64），Heroku `app.json`。
- 圖層可以改名、排序、調透明度、鎖定。
- 「選取」工具：移動、改樣式、刪除單一標記，包括之前回合畫的。
- `estampes.visual/1` 協定：`get_visual_state` 工具與 `/api/v1/canvas`。

## 0.6.0 — 並排比對

- `pairImage`：兩張不同的圖左右並排，GPT 記錄兩邊標記之間的連結和信心程度，使用者用 `review_visual_link` 確認或否決。

## 0.5.x — 真實圖片與畫布

- 0.5.0：`load_image`（對話中的檔案或公開 https 網址）、`process_image`（CLAHE、銳化、降噪、二值化、邊緣、局部放大）、`overlay_grid`（帶座標的格線）。
- 0.5.1：`present_visual` 顯示真實照片，預設原圖，可選處理後的分頁。
- 0.5.2：修正畫布分頁會跳回第一頁。
- 0.5.3：折線與手繪、加快處理速度、標記附 GPT 備註與狀態。
- 0.5.4：筆、顏色、螢光筆，驗收圖，裁切座標，標記跨回合保留。
- 0.5.5：復原／重做，GPT 驗收圖分頁，縮小回傳資料，匯出 `image.jpg` 與分層 `marks.svg`。
- 0.5.6：修正 ChatGPT 晚送工具輸入造成照片變形。
- 0.5.7：畫布內縮放與平移（雙指、Ctrl+滾輪、按鈕），放大時載入原始解析度圖塊。
- 0.5.8：手機上拖曳不再捲動對話。
- 0.5.9：圖層：每次送出、每次 GPT 繪圖都是一個可以顯示或隱藏的圖層。

## 0.4.x 以前 — 概念驗證

- M0.3：數線，驗證 ChatGPT 內 GPT → 小工具 → 使用者 → GPT 的往返。
- M0.4～0.4.7：內建 SVG 示範場景上的點、框、箭頭，`inspect_visual` 給模型看像素，最後整合成單一畫布。
- 0.4.8：選用的存取金鑰、速率限制、CORS 白名單、鎖定相依套件版本。
