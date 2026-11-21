# 金輝虎將 Lucky Tiger Slots — 靜態 Casino 遊戲部署方案

一套**零依賴、零建置**的輕量級 HTML5 老虎機遊戲站，內建完整的 SEO / GEO（生成式引擎優化）設計，可直接部署到 **Cloudflare Pages** / Netlify / Vercel / GitHub Pages 等靜態託管平台。

> **目前已上線（GitHub Pages）**：https://vip-81.github.io/lucky-tiger-slots/
> Lighthouse 實測：SEO **100** / Accessibility **100** / Best Practices **100**。
>
> 先前亦部署於 Cloudflare Pages：https://lucky-tiger-slots.pages.dev/
>
> ⚠️ **canonical / og:url / sitemap 目前指向 GitHub Pages**。若你要重新部署回 Cloudflare（或任何其他平台），請先同步修改 `index.html`、`sitemap.xml`、`robots.txt` 中的網域，再執行部署，避免 SEO 訊號指向錯誤網址。

---

## 一、專案結構

```
.
├── index.html                     # 語意化首頁 + 完整 meta + JSON-LD
├── robots.txt                     # 爬蟲規則
├── sitemap.xml                    # 網站地圖
├── manifest.webmanifest           # PWA 清單
├── netlify.toml                   # Netlify 部署/快取/安全 Headers
├── vercel.json                    # Vercel 部署設定
├── .github/workflows/deploy.yml   # GitHub Pages 自動部署
├── _headers                       # Cloudflare Pages 安全/快取標頭
├── wrangler.toml                  # Cloudflare Pages 專案設定
├── deploy-cloudflare.ps1          # Cloudflare Direct Upload 部署腳本（不含憑證）
├── deploy-github.ps1              # GitHub Pages 部署腳本（Git Data API，不含憑證）
├── .nojekyll                      # 停用 Jekyll，確保靜態檔案原樣輸出
├── tools/
│   ├── hash-helper.html           # BLAKE3 hash 重算工具頁
│   └── _files.js                  # 由本機檔案產生的 base64 資料（可重新產生）
└── assets/
    ├── css/style.css              # RWD + 無障礙樣式
    ├── js/game.js                 # 遊戲引擎（FSM / 物件池 / Web Audio）
    └── img/
        ├── favicon.svg
        └── og-cover.svg           # 社群分享封面（建議正式環境另輸出 PNG 1200×630）
```

---

## 二、SEO / GEO 設計重點

### 傳統 SEO
- **完整 meta**：`title`、`description`、`keywords`、`robots`、`canonical`。
- **社群協定**：Open Graph（含 `og:image:width/height/alt`）、Twitter Card（`summary_large_image`）。
- **語意化 HTML**：`<header>`、`<main>`、`<section>`、`<article>`、`<nav>`、`<footer>`、`<details>`，並搭配 `aria-label`、`role`、`aria-live`。
- **可索引內容**：首頁含實際文字介紹、玩法步驟、賠率表（`<table>` + `<th scope>`）、FAQ。
- **效能**：`CSS` 集中載入、`<script defer>`、DPR 上限 2、靜態資源 `immutable` 快取。

### GEO（Generative Engine Optimization）
針對 AI 摘要與引用，除了一般 SEO 外特別做以下處理：
1. **JSON-LD `@graph`**：同時声明 `WebSite`、`Organization`、`SoftwareApplication`、`FAQPage`、`BreadcrumbList`，讓 AI 能結構化理解「這是什麼、誰做的、怎麼玩、多少錢」。
2. **FAQPage 結構**：問答內容在 JSON-LD 與頁面 DOM **重複出現**，提高被 AI 直接引用的機率。
3. **條列化與結構化**：玩法用 `<ol>`、特色用 `<ul>`、賠率用 `<table>` — 生成式引擎偏好抽取結構化事實。
4. **明確的事實陳述**：例如「每次旋轉扣除 10 籌碼」「最高賠率為 100 倍」，用清晰、可被摘錄的句型。

> **網域已完成替換**：`index.html`、`sitemap.xml`、`robots.txt` 中的 canonical / og:url / Sitemap 皆已指向 `https://lucky-tiger-slots.pages.dev/`。若換網域請同步修改這三處，並重新部署。

---

## 三、Cloudflare Pages 部署（本次採用的正式環境）

### 已完成了什麼
- 專案名稱：`lucky-tiger-slots`（Account ID 見後台）
- 正式網址：https://lucky-tiger-slots.pages.dev/
- 部署方式：**Direct Upload API**（PowerShell 實作，等價於 `wrangler pages deploy`）
- `_headers` 已生效：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`、`Permissions-Policy`，靜態資源 `immutable` 快取。

### 部署指令（憑證只放環境變數，不進檔案）
```powershell
$env:CF_API_TOKEN  = '<你的 API Token>'
$env:CF_ACCOUNT_ID = '<你的 Account ID>'
.\deploy-cloudflare.ps1            # 含 _headers
.\deploy-cloudflare.ps1 -SkipHeaders  # 若需要暫時排除 _headers 除錯
```

### ⚠️ Cloudflare Direct Upload 的關鍵坑（已解決）
`manifest` 的 hash **不是 SHA-256**，而是：
```
BLAKE3( base64(檔案內容) + 副檔名 ).hex 的前 32 字元
```
且 manifest 的 key **必須有前綴斜線**，例如 `/index.html`。
若用 SHA-256，API 仍會回 200 且部署顯示 success，但站點會回 **500** —— 這是本次除錯花最多時間的地方。

### 重新產生 BLAKE3 hash（檔案內容有變更時必做）
1. 在 PowerShell 執行下列指令，產生 `tools/_files.js`：
```powershell
$root = (Resolve-Path '.').Path
$exclude = @('README.md','netlify.toml','vercel.json','wrangler.toml','deploy-cloudflare.ps1','_headers','_hash.html')
$list = @()
Get-ChildItem -File $root | Where-Object { $_.Name -notin $exclude -and $_.Name -notlike '_*' } | ForEach-Object {
  $list += [pscustomobject]@{ rel=$_.Name; b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)); ext=$_.Extension.TrimStart('.') }
}
Get-ChildItem -Path "$root\assets" -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($root.Length+1).Replace('\','/')
  $list += [pscustomobject]@{ rel=$rel; b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)); ext=$_.Extension.TrimStart('.') }
}
"window.__files = $($list | ConvertTo-Json -Depth 4 -Compress);" | Set-Content "$root\tools\_files.js" -Encoding UTF8
```
2. 用瀏覽器開啟 `tools/hash-helper.html`，在 DevTools Console 執行：
```js
(async () => JSON.stringify(await Promise.all(
  window.__files.map(async f => ({ rel: f.rel, hash: await window.__hash(f.b64, f.ext) }))
)))()
```
3. 把輸出的 hash 更新到 `deploy-cloudflare.ps1` 中的 `$ASSET_HASHES`，再重新部署。

---

## 四、其他部署方式

### Netlify
直接拖曳整個資料夾到 [Netlify Drop](https://app.netlify.com/drop)，或連結 Git repo；`netlify.toml` 已設定好 publish 目錄與快取/安全 Headers。

### Vercel
```bash
npx vercel --prod
```
`vercel.json` 已處理 `cleanUrls` 與快取。

### GitHub Pages（本次已上線）
- Repo：`https://github.com/vip-81/lucky-tiger-slots`
- 網址：`https://vip-81.github.io/lucky-tiger-slots/`
- Pages 來源：**GitHub Actions**（`build_type = workflow`），由 `.github/workflows/deploy.yml` 部署。
- 根目錄的 `.nojekyll` 確保靜態檔案不被 Jekyll 處理。

首次部署（或要重新推送檔案）可執行：
```powershell
$env:GH_PAT = '<你的 GitHub Token>'
.\deploy-github.ps1
```
腳本會：建立 repo（若不存在）→ 以 Git Data API 建立 blobs/tree/commit → 更新 `main` → 啟用 Pages。
若手動操作：設定 → Pages → Source 選「GitHub Actions」，推送到 `main` 即自動部署。

---

## 五、⚠️ 資安與上線檢查清單（非常重要）

### 0. 【最優先】本次提供的所有憑證必須立即輪替
對話中先後出現了兩組長期憑證，都等於已經外洩：

| 憑證 | 輪替位置 |
|---|---|
| Cloudflare API Token、Account ID、R2 Access Key / Secret | Cloudflare 後台 → My Profile → API Tokens / R2 |
| GitHub classic PAT（`ghp_...`）與 fine-grained PAT（`github_pat_...`） | GitHub → Settings → Developer settings → Personal access tokens |

其中 **classic PAT 權限極大**（`repo`、`workflow`、`delete_repo`、`admin:org`…），風險最高，請優先撤銷。

**正確做法**：
1. 立即撤銷舊 token 並重新產生（GitHub 建議改用 fine-grained PAT，僅授權 `lucky-tiger-slots` repo 的 Contents 寫入 + Pages 權限）。
2. 改用新 token 重新執行部署腳本驗證。
3. 日後透過**環境變數 / Secret 管理服務**提供，不要貼在聊天、Issue、Email 或程式碼中。

本專案所有部署腳本都**不含任何憑證**，只從 `$env:CF_API_TOKEN` / `$env:CF_ACCOUNT_ID` / `$env:GH_PAT` 讀取。另外，GitHub Actions 部署本身使用 OIDC（`id-token: write`），**不需要 PAT**。

### 1. 絕對不要把 API token 放進前端
你提供的 `4k33EiuqqWPzGvMpUev01Q4AMNXhqZFWKmNRDeDj` 看起來是 **itch.io API token**。
靜態網站的原始碼是完全公開的，任何寫進 HTML/JS 的金鑰都會被直接在原始碼或 DevTools 看到並濫用。

**正確做法**：
- 若需要即時抓取 itch.io 資料，建立一層 **Serverless Function**（例如 Netlify Functions / Vercel Functions）做代理。
- 金鑰存放在平台的 **Environment Variables**，程式中透過 `process.env.ITCHIO_TOKEN` 讀取。
- 前端只呼叫你自己的 `/api/games` 端點，不直接碰到第三方金鑰。
- 若金鑰曾經外洩，請立即至 itch.io 後台**撤銷並重新產生**。

本專案的「開源資源來源」區塊刻意做成**純靜態精選清單**，不需要任何金鑰，也不會在前端暴露敏感資訊。

### 2. 防作弊：Server-Authoritative 架構
`assets/js/game.js` 中的 `Math.random()` **僅供動畫表現**。正式博弈營運必須：
- 由**伺服器 RNG** 決定停輪結果與派彩；
- 前端只「播放」伺服器回傳的 `stopIndices`，不得自行決定中獎；
- 押注、餘額、派彩以伺服器為唯一真相來源（前端數字只是快取）；
- 加入通訊簽章 / 序號，防止重放攻擊（replay attack）。

### 3. 行動端相容性坑點
- **iOS Safari 音訊**：`AudioContext` 必須在使用者手勢（touch/click）中建立或 `resume()`，程式已在首次 `pointerdown`/`keydown` 解鎖。
- **WebGL 上下文遺失**：本專案使用 Canvas 2D，無 WebGL 上下文遺失問題；若日後改用 PixiJS/Phaser，務必監聽 `webglcontextlost` 並做資源重建。
- **記憶體洩漏**：粒子使用物件池避免 GC 抖動；`setTimeout` 在元件銷毀時應 `clearTimeout`。
- **觸控延遲**：`touch-action: manipulation` + `-webkit-tap-highlight-color` 消除 300ms 延遲與點擊高亮。
- **斷線重旋**：保留 `roundId`/序號，重連後向伺服器查詢該局結果並還原畫面，避免「轉了但沒派彩」爭議。

---

## 六、開源資源來源（本專案參考）

| 來源 | 說明 |
|---|---|
| [GitHub Topics: open-source-games](https://github.com/topics/open-source-games) | 開源遊戲專題彙整 |
| [GitHub Trending](https://github.com/trending) | 每日熱門專案 |
| [Ludum Dare 組織](https://github.com/orgs/LudumDare/repositories) | Game Jam 開源作品 |
| [Simple Game Tutorials](https://simplegametutorials.github.io/) | 遊戲開發教學 |
| [itch.io — open-source 標籤](https://itch.io/games/tag-open-source) | 獨立遊戲平台 |

> 使用任何第三方素材前，請確認其授權條款（MIT / CC0 / CC-BY 等），並依要求標示出處。

---

## 七、授權與免責聲明

本專案為**技術示範**，不涉及真實金錢博弈，不提供投機或投資建議。正式營運請遵循所在地法律規範並取得相應執照。
