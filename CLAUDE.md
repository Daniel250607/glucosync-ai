# GlucoSync AI：給 Claude 的專案說明

這個 repo 是**公開**的。寫進任何檔案、commit 訊息的內容，都不可以包含金鑰、密碼、健康數值、用藥名稱或其他個人健康資料。

## 開始工作前

1. 先 `git pull`，確認是最新版本（使用者會在兩台電腦之間切換）。
2. 讀 [docs/HANDOFF.md](docs/HANDOFF.md)，了解目前進度與待辦。
3. 使用者說「更新交接」時，更新 `docs/HANDOFF.md`，和程式一起 commit。

## 專案概要

- Vue 3 + Vite + Tailwind 的單頁 App，部署在 GitHub Pages（push 到 `main` 會自動部署，見 `.github/workflows/deploy.yml`）。
- 資料存在 localStorage；使用者登入 Google 後，會再和 Firestore 同步（`src/firebase.js`、`src/data/syncMerge.js`）。
- AI 分析使用 Gemini API（`src/services/gemini.js`）。金鑰只存在使用者的瀏覽器裡，不會寫進程式或 build。
- `firestore.rules` 是參考檔，要手動貼到 Firebase Console 才會生效。

## 指令

- 測試：`npm test`（vitest）
- Build：`npm run build`
- 如果 shell 找不到 `npm`，先把 Node 的安裝目錄加進 PATH 再執行。

## 規則

- `docs/health_context.md` 是個人健康資料，已列在 `.gitignore`，絕不能 commit；範例檔是 `docs/health_context.example.md`。
- 所有 `VITE_*` 環境變數都會被打包進公開的 JS，所以不能放任何秘密。
- commit 訊息用繁體中文：第一行是摘要，下面用條列寫變更內容。
- 改完程式後，檢查本檔與 `docs/HANDOFF.md` 是否需要一起更新。
