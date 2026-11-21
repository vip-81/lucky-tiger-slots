# 金輝虎將 — 資料庫與後端服務（Supabase）

本目錄包含 **Server-Authoritative RNG / RTP** 後端：停輪結果、派彩、餘額全部由伺服器決定，前端只負責播放動畫。

> ⚠️ **重要**：所有曾經貼在對話中的金鑰（Supabase Secret Key、`sbp_` 舊 key、DB 密碼、JWT Key、Neon 連線字串、Cloudflare / GitHub token）都必須先撤銷輪替，再進行以下步驟。**本專案檔案不含任何金鑰值**。

---

## 一、檔案結構

```
supabase/
├── migrations/
│   └── 0001_init.sql        # 資料表、RLS、spin/get_round/get_balance RPC
└── functions/
    ├── spin/index.ts        # POST /functions/v1/spin — 伺服器權威旋轉
    └── round/index.ts       # POST /functions/v1/round — 斷線重連還原
assets/js/backend.js         # 前端客戶端（匿名登入 + 呼叫 Functions）
```

---

## 二、部署步驟

### 1. 啟用匿名登入
Supabase Dashboard → **Authentication → Providers → Anonymous Sign-Ins → Enable**。
（前端 `backend.js` 借助匿名登入取得 JWT；若不想開放匿名，可改為你家自己的登入系統，只要能回傳 JWT 即可。）

### 2. 套用資料庫 migration
Dashboard → **SQL Editor** → 貼上 `supabase/migrations/0001_init.sql` → Run。

會建立：
- `profiles`（餘額，唯一真相來源，自帶 `for update` 防並發雙花）
- `rounds`（伺服器決定的停輪結果，寫入後不可改）
- `transactions`（下注 / 派彩流水，可稽核）
- `game_config`（`symbol_weights`、`paytable`、`rtp_factor`）
- RPC：`spin`、`get_round`、`get_balance`（皆 `security definer`，只授權 `service_role`）

### 3. 部署 Edge Functions
```bash
supabase login
supabase link --project-ref <你的專案 ID>
supabase functions deploy spin
supabase functions deploy round
```

### 4. 設定 Function 環境變數
在 Supabase Dashboard → **Project Settings → Edge Functions → Secrets** 加入（**值請自己填，不要貼在聊天或程式碼**）：

| 環境變數名稱 | 來源 |
|---|---|
| `SUPABASE_URL` | 專案 URL |
| `SUPABASE_ANON_KEY` | Publishable / Anon Key（可公開） |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key（**僅後端**，不可進前端） |

> Edge Functions 執行環境通常已自動注入 `SUPABASE_URL` 與 service role key；若已存在可省略手動設定。

### 5. 啟用前端後端模式
在 `index.html` 找到：
```html
<script>
  window.__SLOT_BACKEND__ = {
    url: '<SUPABASE_URL>',
    publishableKey: '<SUPABASE_PUBLISHABLE_KEY>'
  };
</script>
```
把兩個佔位符換成新產生的值。**只能放 Publishable / Anon Key**，絕對不能放 Secret / Service Role Key 或 DB 密碼。

若未替換，遊戲會自動退回純前端 Demo 模式（不影響遊玩，但不能用於營運）。

---

## 三、API 規格

### POST `/functions/v1/spin`
Request：
```json
{ "bet": 10 }
```
Headers：`Authorization: Bearer <JWT>`、`apikey: <publishable key>`

Response：
```json
{
  "ok": true,
  "roundId": "uuid",
  "bet": 10,
  "stopIndices": [0, 2, 5],
  "winAmount": 0,
  "credits": 990
}
```

### POST `/functions/v1/round`
Request：`{ "roundId": "uuid" }` → 回傳該局結果，供斷線重連還原。

---

## 四、RTP 與防作弊注意事項

1. **`rtp_factor` 不是 RTP 本身**，而是派彩倍率調整係數。正式上線前必須用 **Monte Carlo 模擬**（至少 100 萬局）驗證實際 RTP 是否符合目標，並保留報告供監理查核。
2. 所有機率與賠率只在 `game_config` 調整，前端賠率表僅供顯示。
3. `profiles.credits` 更新使用 `select ... for update`，避免並發請求造成餘額雙花。
4. `rounds`、`transactions` 建議設定為只能由 `service_role` 寫入（目前的 RLS 只開放本人讀取）。
5. 斷線重連：前端把 `roundId` 存到 `sessionStorage`，重載時呼叫 `/functions/v1/round` 還原，避免「轉了但沒派彩」爭議。

---

## 五、驗證清單

- [ ] 匿名登入可取得 JWT
- [ ] 第一次 spin 自動建立 profile（初始 1000 籌碼）
- [ ] 下注後 `credits` 與 `transactions` 正確
- [ ] 中獎時 `win_amount` 與派彩流水一致
- [ ] 並發兩筆 spin 不會雙花
- [ ] 關閉頁面重開後 `/round` 可還原結果
- [ ] 前端 F12 看不到任何 Secret / Service Role Key / DB 密碼
