/**
 * ============================================================================
 * 金輝虎將 — 後端客戶端（Supabase）
 * ============================================================================
 * 職責：
 *   1. 匿名登入取得 JWT（僅需在 Supabase Auth 開啟「Allow anonymous sign-ins」）
 *   2. 呼叫 /functions/v1/spin 取得「伺服器決定」的停輪結果
 *   3. 呼叫 /functions/v1/round 做斷線重連還原
 *
 * ⚠️ 這裡只會出現 Publishable / Anon Key（設計上可公開）。
 *    Service Role Key、Secret Key、DB 密碼絕對不能出現在前端。
 *
 * 設定方式：在 index.html 载入本檔前，先定義：
 *   window.__SLOT_BACKEND__ = {
 *     url: 'https://<你的專案>.supabase.co',
 *     publishableKey: '<SUPABASE_PUBLISHABLE_KEY>'
 *   };
 * 若未定義，遊戲會自動退回純前端 Demo RNG 模式。
 * ============================================================================
 */
(() => {
  'use strict';

  class BackendClient {
    constructor(cfg) {
      this.url = String(cfg.url || '').replace(/\/$/, '');
      this.key = cfg.publishableKey;
      this.accessToken = null;
      this.available = !!(this.url && this.key && this.key.indexOf('<') === -1);
      this.degraded = false;
    }

    /** 匿名登入：失敗時標記降級，不阻斷遊戲 */
    async ensureSession() {
      if (!this.available) return null;
      if (this.accessToken) return this.accessToken;
      try {
        const res = await fetch(`${this.url}/auth/v1/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': this.key },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`匿名登入失敗 ${res.status}`);
        const data = await res.json();
        if (!data.access_token) throw new Error('匿名登入未回傳 access_token');
        this.accessToken = data.access_token;
        return this.accessToken;
      } catch (err) {
        console.warn('[backend] 匿名登入失敗，將退回 Demo 模式：', err);
        this.degraded = true;
        return null;
      }
    }

    async _call(path, body) {
      const token = await this.ensureSession();
      if (!token) throw new Error('NO_SESSION');

      const res = await fetch(`${this.url}/functions/v1/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': this.key,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return data;
    }

    /** 伺服器權威旋轉：回傳 { roundId, stopIndices, winAmount, credits } */
    async spin(bet) {
      return this._call('spin', { bet });
    }

    /** 斷線重連：依 roundId 還原該局 */
    async restore(roundId) {
      return this._call('round', { roundId });
    }
  }

  // 暴露給 game.js 使用；未設定 config 時為 null
  const cfg = window.__SLOT_BACKEND__;
  window.__slotBackend = cfg ? new BackendClient(cfg) : null;
})();
