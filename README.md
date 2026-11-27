# GlucoSync AI

這是一個控糖、降脂的個人健康紀錄 App，在手機瀏覽器上就能使用。它可以記錄每天的飲食、飲水、運動和用藥，並用 AI（Gemini 或 Grok，可在設定頁切換）分析餐點、提出建議。

> ⚠️ 本 App 只是個人的紀錄與參考工具，不能取代醫師的診斷或治療。AI 給的建議不會、也不應該用來調整藥物；有任何疑問請找主治醫師。

## 主要功能

- **今日記錄**：記錄餐點（可用文字或最多 4 張照片，請 AI 分析營養；AI 會依你寫的品項、份量和進食順序估算，並回饋順序是否恰當）、飲水與飲品（每次記純水都會留下時間，可以看到上次何時喝水）、運動（分成有氧、肌力、輕度活動；有氧用「講話測試」選強度：輕鬆、中等、費力；可以記次數或時間；快選可以拖曳排序）、早晚用藥勾選，以及身體不適日。
- **AI 燈號**：分別用紅、黃、綠燈提示血糖與三酸甘油脂、飽和脂肪、腎臟與水分、SGLT-2 抑制劑的酮酸中毒風險，並在一天結束時產生總結。
- **運動目標**：依糖尿病照護指引分成三項：每天餐後活動（任何強度都算）、每週中等以上有氧 150 分鐘（費力 1 分鐘算 2 分鐘）、每週肌力訓練 2 天；最近一次尿酮不是陰性時，會提醒先不要做費力運動。
- **趨勢**：用圖表呈現每天的攝取量與運動量（運動依類別堆疊，並畫出近 7 天的有氧累計）。
- **檢驗**：記錄回診的檢驗數值，並和基準值、目標值比較；每個項目都有中文名稱與標準值（HDL-C、肌酸酐、尿酸依設定頁的性別判斷；用藥清單有 SGLT-2 抑制劑時，尿糖陽性是預期的藥物作用，不判斷達標）。每日的碳水與飽和脂肪目標依最新檢驗、體重與身高，用固定的指引規則計算並註明依據（規則集中在 `src/data/targetRules.js`），按「套用」才寫入設定；AI 只負責解釋與飲食建議。檢驗趨勢圖依實際日期排列。
- **體重**：不用每天記，量了再記（今日記錄或追蹤檢驗表單）；最新一筆會自動用來計算飲水範圍與運動熱量。設定身高後，體重趨勢圖會標出標準體重範圍（BMI 18.5–24）。
- **回診報告**：整理最近 14、30 或 90 天的資料，可以列印、存成 PDF，或下載成 PNG。
- **備份與同步**：可以匯出、匯入 JSON 備份；登入 Google 後，資料會在多台裝置之間同步（Firestore）。
- **手機配對**：用 QR Code 把設定從電腦轉到手機。

## 資料與隱私

- 資料預設只存在這個瀏覽器（localStorage）。設定好 Firebase 並登入 Google 後，才會同步到您自己的 Firestore。
- AI 服務的 API Key（Gemini、Grok）和 Firebase 設定只存在瀏覽器的設定頁裡，不會寫進程式碼，也不會出現在公開的網頁上。
- 健康背景、檢驗基準值和用藥清單都由使用者在設定頁自行輸入或匯入，程式碼裡沒有任何個人資料。
- 匯出的備份檔不包含 API Key 和 Firebase 設定。

## 使用方式

1. 打開部署好的網頁（GitHub Pages）。
2. 到 ⚙️ 設定選擇 AI 服務（Gemini 或 Grok），貼上自己的 API Key。Grok 要在 xAI 主控台建立「Grok API」類型的金鑰。
3. 需要多台裝置同步時，在設定頁貼上 Firebase 網頁設定，並用 Google 登入。
4. 在設定頁的「健康背景」可以匯入自己的背景資料，格式參考 `docs/health_context.example.md`。

### Firebase 設定重點

- Authentication 只啟用 Google 登入，並把部署網站的網域加進授權網域。
- Firestore 的安全規則參考 `firestore.rules`，要手動貼到 Firebase Console 發布。前端的帳號檢查只是畫面上的限制，真正的防護是這份規則。

## 開發

需要 Node.js 20.19 以上（或 22.12 以上）。

```bash
npm install
npm run dev      # 本機開發
npm test         # 單元測試 (vitest)
npm run build    # 產生 dist/
```

- 本機開發時，可以把 `.env.example` 複製成 `.env.local` 並填入金鑰。`.env.local` 只在 `npm run dev` 時使用，不能 commit。
- 所有 `VITE_*` 變數都會被打包進公開的 JS，所以 production build 不會讀取 Gemini Key。

## 部署

push 到 `main` 後，GitHub Actions（`.github/workflows/deploy.yml`）會自動 build 並部署到 GitHub Pages。build 時不會傳入任何秘密。

## 技術

Vue 3、Vite、Tailwind CSS、Chart.js、Firebase（Auth、Firestore）、Gemini API 或 xAI Grok API（Structured Outputs）。
