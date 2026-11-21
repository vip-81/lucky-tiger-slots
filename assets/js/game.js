/**
 * ============================================================================
 * 金輝虎將 Lucky Tiger Slots — 輕量級 Canvas 2D 老虎機（客戶端表現層）
 * ============================================================================
 * 設計目標：
 *  1. 單一 IIFE，零依賴、零Build，直接在靜態託管平台運行。
 *  2. 有限狀態機 (FSM)：IDLE → SPINNING → STOPPING → EVALUATING → CELEBRATING → IDLE
 *  3. 物件池 (Object Pool) 管理金幣粒子，避免 GC 卡頓，維持 60 FPS。
 *  4. Web Audio API 音效，針對 iOS Safari 做「首次觸控解鎖」處理。
 *  5. DPR 自適應 + RWD，支援橫/豎屏。
 *
 * ⚠️ 防作弊最重要的觀念（務必牢記）：
 *  此檔的 RNG 使用 Math.random()，「僅供前端動畫表現」。
 *  正式博弈環境必須採用 Server-Authoritative 架構：
 *    - 停輪結果由伺服器 RNG + RTP 模型計算後回傳；
 *    - 前端只「播放」伺服器指定的目標符號，不得自行決定中獎；
 *    - 押注、餘額、派彩全部以伺服器為準，前端數字只是快取顯示。
 *  詳見 README.md「上線前檢查清單」。
 * ============================================================================
 */
(() => {
  'use strict';

  /* --------------------------------------------------------------------------
   * 1. 常數與設定
   * ------------------------------------------------------------------------ */
  const CFG = {
    W: 960, H: 640,                 // 邏輯畫布尺寸（實際縮放由 DPR 處理）
    REEL_COUNT: 3,                  // 滾輪數
    REEL_W: 210, REEL_H: 330,       // 單輪可視窗尺寸
    REEL_GAP: 26,                   // 輪間距
    SYMBOL_H: 110,                  // 單格符號高度
    COST_PER_SPIN: 10,              // 每次旋轉成本
    START_CREDIT: 1000,             // 起始籌碼（Demo）
    SPIN_SPEED: 17,                 // 旋轉速度（符號/秒）
    STOP_DURATION: 0.55,            // 煞車緩動時間（秒）
    STOP_STAGGER: 0.30,             // 各輪延遲停止間隔（秒）
    WIN_HOLD: 1.6,                  // 中獎展示停留時間（秒）
  };

  // 符號表：pay3 = 三連賠率倍數，pay2 = 兩連（僅部分符號）賠率倍數
  const SYMBOLS = [
    { id: 'seven',   glyph: '7',  color: '#e53935', accent: '#ff8a80', pay3: 100, pay2: 10, emoji: '7️⃣' },
    { id: 'diamond', glyph: '◆',  color: '#29b6f6', accent: '#81d4fa', pay3: 50,  pay2: 5,  emoji: '💎' },
    { id: 'gold',    glyph: '★',  color: '#fbc02d', accent: '#fff59d', pay3: 25,  pay2: 3,  emoji: '🪙' },
    { id: 'bell',    glyph: '♟',  color: '#ab47bc', accent: '#ce93d8', pay3: 15,  pay2: 2,  emoji: '🔔' },
    { id: 'cherry',  glyph: '●',  color: '#66bb6a', accent: '#a5d6a7', pay3: 10,  pay2: 0,  emoji: '🍒' },
    { id: 'lemon',   glyph: '▲',  color: '#ffa726', accent: '#ffcc80', pay3: 5,   pay2: 0,  emoji: '🍋' },
  ];

  // 加權表（僅供 Demo 視覺用；正式環境請移除並改用伺服器結果）
  const WEIGHTS = [2, 5, 9, 13, 24, 32];

  const STATE = Object.freeze({
    IDLE: 'IDLE',
    SPINNING: 'SPINNING',
    STOPPING: 'STOPPING',
    EVALUATING: 'EVALUATING',
    CELEBRATING: 'CELEBRATING',
  });

  /* --------------------------------------------------------------------------
   * 2. 工具函式：緩動、加權隨機、圓角矩形
   * ------------------------------------------------------------------------ */
  const Easing = {
    linear: t => t,
    easeOutCubic: t => 1 - Math.pow(1 - t, 3),
    easeOutBack: t => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    easeInOutQuad: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  };

  function weightedIndex() {
    const total = WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < WEIGHTS.length; i++) {
      r -= WEIGHTS[i];
      if (r < 0) return i;
    }
    return WEIGHTS.length - 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /* --------------------------------------------------------------------------
   * 3. 音效管理器（Web Audio API）
   *    - iOS Safari 限制：AudioContext 必須在使用者手勢中建立/resume。
   *    - 全部音效用 Oscillator 即時合成，無需外部音檔 → 更加輕量。
   * ------------------------------------------------------------------------ */
  class AudioManager {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.unlocked = false;
    }

    unlock() {
      if (this.unlocked) {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // 不支援 Web Audio 時靜默降級
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.ctx.destination);
      this.unlocked = true;
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    tone(freq, duration, type = 'sine', volume = 0.3, delay = 0) {
      if (!this.unlocked || !this.ctx) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    playSpin() { this.tone(180, 0.12, 'square', 0.2); }
    playStop() { this.tone(320, 0.09, 'triangle', 0.25); this.tone(240, 0.12, 'triangle', 0.2, 0.04); }

    playWin(level) {
      const seq = level >= 3 ? [523, 659, 784, 1047] : level === 2 ? [523, 659, 784] : [523, 784];
      seq.forEach((f, i) => this.tone(f, 0.22, 'sine', 0.3, i * 0.09));
    }

    playBigWin() {
      const seq = [392, 523, 659, 784, 1047, 1319];
      seq.forEach((f, i) => this.tone(f, 0.35, 'sawtooth', 0.22, i * 0.11));
    }

    playCoin() { this.tone(1200 + Math.random() * 400, 0.06, 'square', 0.12); }
  }

  /* --------------------------------------------------------------------------
   * 4. 粒子系統 + 物件池（金幣噴發）
   *    預先配置固定數量物件，重複利用，避免執行期 new 造成 GC 抖動。
   * ------------------------------------------------------------------------ */
  class Particle {
    constructor() { this.active = false; }

    spawn(x, y, vx, vy, color, life, size, spin) {
      this.x = x; this.y = y;
      this.vx = vx; this.vy = vy;
      this.color = color;
      this.life = life; this.maxLife = life;
      this.size = size;
      this.rot = Math.random() * Math.PI * 2;
      this.spin = spin;
      this.active = true;
    }

    update(dt) {
      if (!this.active) return;
      this.vy += 1400 * dt;          // 重力
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.rot += this.spin * dt;
      this.life -= dt;
      if (this.life <= 0 || this.y > CFG.H + 60) this.active = false;
    }

    draw(ctx) {
      if (!this.active) return;
      const a = Math.max(0, Math.min(1, this.life / this.maxLife));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(this.x, this.y);
      ctx.rotate(this.rot);
      ctx.fillStyle = this.color;
      ctx.strokeStyle = '#fff3c4';
      ctx.lineWidth = 2;
      const s = this.size;
      ctx.beginPath();
      ctx.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  class ParticlePool {
    constructor(size = 320) {
      this.items = Array.from({ length: size }, () => new Particle());
    }

    /** 從池中取出一个闲置粒子；若全忙則跳過（避免無限擴充） */
    spawn(opts) {
      for (let i = 0; i < this.items.length; i++) {
        const p = this.items[i];
        if (!p.active) {
          p.spawn(opts.x, opts.y, opts.vx, opts.vy, opts.color, opts.life, opts.size, opts.spin);
          return p;
        }
      }
      return null;
    }

    burst(x, y, count, color) {
      for (let i = 0; i < count; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
        const speed = 260 + Math.random() * 520;
        this.spawn({
          x: x + (Math.random() - 0.5) * 60,
          y: y + (Math.random() - 0.5) * 20,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed,
          color: Math.random() > 0.3 ? color : '#ffd54f',
          life: 0.9 + Math.random() * 0.9,
          size: 7 + Math.random() * 7,
          spin: (Math.random() - 0.5) * 16,
        });
      }
    }

    update(dt) { for (const p of this.items) p.update(dt); }

    draw(ctx) { for (const p of this.items) if (p.active) p.draw(ctx); }
  }

  /* --------------------------------------------------------------------------
   * 5. 滾輪 Reel
   *    position 為浮點數（單位＝符號格）。中心符号 = floor(position + 0.5) % n
   *    旋轉時持續累加；停止時緩動到能讓目標符號落在中心的對齊位置。
   * ------------------------------------------------------------------------ */
  class Reel {
    constructor(index) {
      this.index = index;
      this.position = Math.random() * SYMBOLS.length;
      this.mode = 'idle';           // idle | spinning | braking
      this.stopDelay = 0;
      this.stopPos = 0;
      this.brakeFrom = 0;
      this.brakeTime = 0;
      this.targetIndex = 0;
    }

    startSpin() {
      this.mode = 'spinning';
      this.stopDelay = 0;
    }

    /** 要求在 delay 秒後開始煞車，並停在 targetIndex 符號 */
    beginStop(targetIndex, delay) {
      this.mode = 'braking-wait';
      this.targetIndex = targetIndex;
      this.stopDelay = delay;
    }

    /** 依據目前位置計算煞車終點（至少再多轉 4 格，避免瞬停） */
    _prepareBrake() {
      const n = SYMBOLS.length;
      const minPos = this.position + 4 + Math.random() * 3;
      let k = Math.ceil((minPos - this.targetIndex) / n);
      this.stopPos = this.targetIndex + k * n;
      this.brakeFrom = this.position;
      this.brakeTime = 0;
      this.mode = 'braking';
    }

    update(dt) {
      if (this.mode === 'spinning') {
        this.position += CFG.SPIN_SPEED * dt;
      } else if (this.mode === 'braking-wait') {
        this.position += CFG.SPIN_SPEED * dt;
        this.stopDelay -= dt;
        if (this.stopDelay <= 0) this._prepareBrake();
      } else if (this.mode === 'braking') {
        this.brakeTime += dt;
        const t = Math.min(1, this.brakeTime / CFG.STOP_DURATION);
        // easeOutBack 讓煞車帶一點回彈，手感更佳
        const e = Easing.easeOutBack(t);
        this.position = this.brakeFrom + (this.stopPos - this.brakeFrom) * e;
        if (t >= 1) {
          this.position = this.stopPos;
          this.mode = 'idle';
          return true; // 通知外部：本輪已停止
        }
      }
      return false;
    }

    /** 回傳目前中心符號索引 */
    centerIndex() {
      const n = SYMBOLS.length;
      return ((Math.floor(this.position + 0.5) % n) + n) % n;
    }

    draw(ctx, x, y) {
      const { REEL_W: rw, REEL_H: rh, SYMBOL_H: sh } = CFG;
      // 裁切可視窗
      ctx.save();
      roundRect(ctx, x, y, rw, rh, 14);
      ctx.clip();

      // 背景
      const g = ctx.createLinearGradient(0, y, 0, y + rh);
      g.addColorStop(0, '#0b2239');
      g.addColorStop(0.5, '#123b5e');
      g.addColorStop(1, '#0b2239');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, rw, rh);

      // 計算需要繪製的符號範圍（以中心為基準，上下各多畫一格避免空隙）
      const center = Math.floor(this.position + 0.5);
      const frac = this.position + 0.5 - center; // 0..1 像素偏移比例
      const centerY = y + rh / 2;
      const n = SYMBOLS.length;

      for (let k = -3; k <= 3; k++) {
        const idx = center + k;
        const symIndex = ((idx % n) + n) % n;
        const sym = SYMBOLS[symIndex];
        const sy = centerY + (k - frac) * sh;
        if (sy + sh < y - sh || sy > y + rh + sh) continue;
        drawSymbol(ctx, x + 8, sy - sh / 2 + 4, rw - 16, sh - 8, sym);
      }

      // 高速旋轉時的動態模糊遮罩
      if (this.mode === 'spinning' || this.mode === 'braking-wait') {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x, y, rw, rh);
      }
      ctx.restore();

      // 外框
      ctx.save();
      roundRect(ctx, x, y, rw, rh, 14);
      ctx.strokeStyle = 'rgba(255,215,120,0.85)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 繪製單一符號格 */
  function drawSymbol(ctx, x, y, w, h, sym) {
    roundRect(ctx, x, y, w, h, 12);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, sym.accent);
    g.addColorStop(1, sym.color);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.font = 'bold 52px "Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sym.glyph, x + w / 2, y + h / 2 + 2);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  /* --------------------------------------------------------------------------
   * 6. 主遊戲類別
   * ------------------------------------------------------------------------ */
  class SlotGame {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.audio = new AudioManager();
      this.particles = new ParticlePool(320);
      this.backend = window.__slotBackend || null;   // 後端客戶端（未設定則為 Demo 模式）
      this.pendingIndices = null;
      this.serverResult = null;

      this.reels = Array.from({ length: CFG.REEL_COUNT }, (_, i) => new Reel(i));
      this.state = STATE.IDLE;
      this.credit = CFG.START_CREDIT;
      this.bet = CFG.COST_PER_SPIN;
      this.winAmount = 0;
      this.lastWin = null;

      this.stateTimer = 0;
      this.celebrateTime = 0;
      this.bigWin = false;
      this.shake = 0;

      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.lastTs = 0;

      this.ui = {
        credit: document.getElementById('credit'),
        bet: document.getElementById('bet'),
        win: document.getElementById('win'),
        status: document.getElementById('status'),
        spinBtn: document.getElementById('spinBtn'),
        toast: document.getElementById('toast'),
      };

      this._bindEvents();
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this._syncUI();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    /* ---------------- 事件綁定 ---------------- */
    _bindEvents() {
      const unlock = () => this.audio.unlock();
      document.addEventListener('pointerdown', unlock, { once: true });
      document.addEventListener('keydown', unlock, { once: true });

      if (this.ui.spinBtn) {
        this.ui.spinBtn.addEventListener('click', () => this.spin());
      }
      // 空白鍵 / Enter 亦可旋轉（ accessibility ）
      document.addEventListener('keydown', (e) => {
        if ((e.code === 'Space' || e.code === 'Enter') && this.state === STATE.IDLE) {
          if (e.target && /INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
          e.preventDefault();
          this.spin();
        }
      });
    }

    /* ---------------- DPR / RWD ---------------- */
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const sx = this.canvas.width / CFG.W;
      const sy = this.canvas.height / CFG.H;
      this.ctx.setTransform(sx, 0, 0, sy, 0, 0);
    }

    /* ---------------- 狀態機：旋轉 ---------------- */
    spin() {
      if (this.state !== STATE.IDLE) return;
      if (this.credit < this.bet) {
        this._toast('籌碼不足，請重置遊戲。');
        return;
      }
      this.credit -= this.bet;              // 樂觀扣款；伺服器回傳後會以權威值覆蓋
      this.winAmount = 0;
      this.lastWin = null;
      this.bigWin = false;
      this.serverResult = null;
      this.pendingIndices = null;
      this.state = STATE.SPINNING;
      this._syncUI();
      this._setStatus('滾輪旋轉中…');
      this._setButton(false);
      this.audio.playSpin();

      if (this.backend && this.backend.available) {
        // ✅ 正式模式：結果由伺服器 RNG 決定，前端只負責播放
        this._setStatus('伺服器結算中…');
        this.backend.spin(this.bet)
          .then((res) => {
            if (this.state !== STATE.SPINNING) return;  // 已被重置/中斷
            this.serverResult = res;
            this.pendingIndices = res.stopIndices;
            if (typeof res.credits === 'number') this.credit = res.credits;
            this._syncUI();
            // 記錄 roundId，供斷線重連使用
            try { sessionStorage.setItem('slot:lastRound', res.roundId); } catch (_) {}
            if (this.stateTimer <= 0) this._beginStopping();
          })
          .catch((err) => {
            console.warn('[slot] 後端不可用，退回 Demo RNG：', err);
            this._fallbackToDemo();
          });
      } else {
        // Demo 模式：前端自行抽樣（僅供表現，不可用於營運）
        this.pendingIndices = Array.from({ length: CFG.REEL_COUNT }, () => weightedIndex());
      }

      this.reels.forEach((r) => r.startSpin());
      this.stateTimer = 0.45 + Math.random() * 0.35; // 最短旋轉時間
    }

    /** 後端失敗時的降級：改用前端 RNG，並提示玩家 */
    _fallbackToDemo() {
      if (this.state !== STATE.SPINNING) return;
      this.serverResult = null;
      this.pendingIndices = Array.from({ length: CFG.REEL_COUNT }, () => weightedIndex());
      this._toast('連線不穩，已切換單機模式');
      if (this.stateTimer <= 0) this._beginStopping();
    }

    /** 斷線重連：嘗試還原最後一局 */
    async restoreLastRound() {
      if (!this.backend || !this.backend.available) return;
      let roundId = null;
      try { roundId = sessionStorage.getItem('slot:lastRound'); } catch (_) {}
      if (!roundId) return;
      try {
        const res = await this.backend.restore(roundId);
        if (res && res.round) {
          this.credit = this.backend.currentCredits ?? this.credit;
          this._syncUI();
          this._toast('已還原上一局結果');
        }
      } catch (err) {
        console.warn('[slot] 還原失敗：', err);
      }
    }

    _beginStopping() {
      this.state = STATE.STOPPING;
      this.reels.forEach((r, i) => r.beginStop(this.pendingIndices[i], i * CFG.STOP_STAGGER));
      this._setStatus('正在停輪…');
    }

    _evaluate() {
      this.state = STATE.EVALUATING;
      const idx = this.reels.map((r) => r.centerIndex());
      const a = idx[0], b = idx[1], c = idx[2];

      let win = 0, combo = 0, sym = null;
      if (a === b && b === c) {
        combo = 3;
        sym = SYMBOLS[a];
      } else if (a === b || b === c || a === c) {
        // 找出重複的符號，僅有 pay2 者給予兩連獎
        let dup = a === b ? a : (b === c ? b : a);
        if (SYMBOLS[dup].pay2 > 0) {
          combo = 2;
          sym = SYMBOLS[dup];
        }
      }

      if (this.serverResult) {
        // ✅ 伺服器模式：派彩與餘額以伺服器為唯一真相來源
        win = this.serverResult.winAmount || 0;
        if (typeof this.serverResult.credits === 'number') this.credit = this.serverResult.credits;
      } else {
        // Demo 模式：僅供前端表現，不可用於營運
        if (combo === 3 && sym) win = sym.pay3 * this.bet;
        else if (combo === 2 && sym && sym.pay2 > 0) win = sym.pay2 * this.bet;
        if (win > 0) this.credit += win;   // Demo 模式才需本地入帳
      }

      this.lastWin = { idx, combo, sym, win };
      this.winAmount = win;

      if (win > 0) {
        this.credit += win;
        this.bigWin = win >= this.bet * 25 && combo === 3;
        this.state = STATE.CELEBRATING;
        this.celebrateTime = 0;
        this._setStatus(`中獎！獲得 ${win} 籌碼`);
        if (this.bigWin) {
          this.audio.playBigWin();
          this.shake = this.reduceMotion ? 0 : 1;
          this._toast('BIG WIN！大獎！', true);
        } else {
          this.audio.playWin(combo);
        }
        // 金幣噴發（以中線為中心）
        const totalW = CFG.REEL_W * CFG.REEL_COUNT + CFG.REEL_GAP * (CFG.REEL_COUNT - 1);
        const startX = (CFG.W - totalW) / 2;
        const cx = startX + totalW / 2;
        this.particles.burst(cx, CFG.H / 2 - 20, this.bigWin ? 90 : 30, sym.color);
        if (this.bigWin) {
          // 二波延遲噴發
          setTimeout(() => this.particles.burst(cx - 120, CFG.H / 2, 40, '#ffd54f'), 180);
          setTimeout(() => this.particles.burst(cx + 120, CFG.H / 2, 40, '#ffd54f'), 320);
        }
      } else {
        // 未中獎：直接回到 IDLE 並解鎖按鈕（避免狀態卡死）
        this._setStatus('未中獎，準備再試一次');
        this._toast('未中獎');
        this.state = STATE.IDLE;
        this._setButton(true);
      }
      this._syncUI();
    }

    /* ---------------- UI 同步 ---------------- */
    _syncUI() {
      if (this.ui.credit) this.ui.credit.textContent = this.credit.toLocaleString('zh-Hant');
      if (this.ui.bet) this.ui.bet.textContent = this.bet.toLocaleString('zh-Hant');
      if (this.ui.win) this.ui.win.textContent = this.winAmount.toLocaleString('zh-Hant');
    }
    _setStatus(t) { if (this.ui.status) this.ui.status.textContent = t; }
    _setButton(enabled) {
      if (!this.ui.spinBtn) return;
      this.ui.spinBtn.disabled = !enabled;
      this.ui.spinBtn.setAttribute('aria-disabled', String(!enabled));
    }
    _toast(msg, big = false) {
      if (!this.ui.toast) return;
      this.ui.toast.textContent = msg;
      this.ui.toast.className = 'toast show' + (big ? ' big' : '');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.ui.toast.className = 'toast'; }, big ? 1800 : 1100);
    }

    reset() {
      if (this.state !== STATE.IDLE) return;
      this.credit = CFG.START_CREDIT;
      this.winAmount = 0;
      this.lastWin = null;
      this._syncUI();
      this._setStatus('已重置籌碼');
      this._toast('籌碼已重置');
    }

    /* ---------------- 主迴圈 ---------------- */
    _loop(ts) {
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000 || 0);
      this.lastTs = ts;

      this._update(dt);
      this._render();
      requestAnimationFrame(this._loop);
    }

    _update(dt) {
      // 滾輪更新
      let allStopped = true;
      for (const r of this.reels) {
        const stopped = r.update(dt);
        if (r.mode !== 'idle') allStopped = false;
        if (stopped) this.audio.playStop();
      }

      if (this.state === STATE.SPINNING) {
        this.stateTimer -= dt;
        // 必須同時滿足「最短旋轉時間已到」與「已取得結果（伺服器或 Demo）」
        if (this.stateTimer <= 0 && this.pendingIndices) this._beginStopping();
      } else if (this.state === STATE.STOPPING && allStopped) {
        this._evaluate();
      } else if (this.state === STATE.CELEBRATING) {
        this.celebrateTime += dt;
        if (this.celebrateTime > CFG.WIN_HOLD) {
          this.state = STATE.IDLE;
          this._setStatus('準備就緒，按下旋轉');
          this._setButton(true);
        }
      }

      // 粒子與震屏
      this.particles.update(dt);
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.6);
    }

    _render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, CFG.W, CFG.H);
      ctx.save();

      // 震屏效果（尊重 prefers-reduced-motion）
      if (this.shake > 0 && !this.reduceMotion) {
        const m = this.shake * 10;
        ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      }

      this._drawBackground(ctx);
      this._drawPayline(ctx);
      this._drawReels(ctx);
      this.particles.draw(ctx);
      this._drawWinBanner(ctx);

      ctx.restore();
    }

    _drawBackground(ctx) {
      const g = ctx.createRadialGradient(CFG.W / 2, CFG.H / 2, 60, CFG.W / 2, CFG.H / 2, CFG.W * 0.7);
      g.addColorStop(0, '#123a5e');
      g.addColorStop(1, '#061523');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, CFG.W, CFG.H);

      // 裝飾燈泡（靜態，低成本）
      ctx.fillStyle = 'rgba(255,215,120,0.18)';
      for (let i = 0; i < 18; i++) {
        const x = (i / 17) * CFG.W;
        ctx.beginPath();
        ctx.arc(x, 56, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    _drawPayline(ctx) {
      const totalW = CFG.REEL_W * CFG.REEL_COUNT + CFG.REEL_GAP * (CFG.REEL_COUNT - 1);
      const startX = (CFG.W - totalW) / 2;
      const reelY = (CFG.H - CFG.REEL_H) / 2 + 22;
      const y = reelY + CFG.REEL_H / 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,215,120,0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(startX - 16, y);
      ctx.lineTo(startX + totalW + 16, y);
      ctx.stroke();
      ctx.restore();
    }

    _drawReels(ctx) {
      const totalW = CFG.REEL_W * CFG.REEL_COUNT + CFG.REEL_GAP * (CFG.REEL_COUNT - 1);
      const startX = (CFG.W - totalW) / 2;
      const reelY = (CFG.H - CFG.REEL_H) / 2 + 22;
      this.reels.forEach((r, i) => r.draw(ctx, startX + i * (CFG.REEL_W + CFG.REEL_GAP), reelY));
    }

    _drawWinBanner(ctx) {
      if (this.state !== STATE.CELEBRATING || !this.lastWin || this.lastWin.win <= 0) return;
      const t = Math.min(1, this.celebrateTime / 0.35);
      const scale = Easing.easeOutBack(t);
      ctx.save();
      ctx.translate(CFG.W / 2, CFG.H * 0.16);
      ctx.scale(scale, scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const text = this.bigWin ? 'BIG WIN!' : `+${this.lastWin.win}`;
      ctx.font = `900 ${this.bigWin ? 84 : 64}px system-ui, sans-serif`;
      ctx.lineWidth = 10;
      ctx.strokeStyle = '#7a3b00';
      ctx.strokeText(text, 0, 0);
      const grad = ctx.createLinearGradient(0, -40, 0, 40);
      grad.addColorStop(0, '#fff9c4');
      grad.addColorStop(0.5, '#ffd54f');
      grad.addColorStop(1, '#ff8f00');
      ctx.fillStyle = grad;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }

  /* --------------------------------------------------------------------------
   * 7. 啟動（DOMContentLoaded 後）
   * ------------------------------------------------------------------------ */
  function boot() {
    const canvas = document.getElementById('gameCanvas');
    if (!canvas) return;
    const game = new SlotGame(canvas);
    window.__slotGame = game; // 方便除錯 / 自動化測試
    game.restoreLastRound();  // 斷線重連：嘗試還原最後一局
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => game.reset());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
