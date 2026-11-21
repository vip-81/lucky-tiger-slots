// ============================================================================
// Supabase Edge Function：/functions/v1/spin
// 伺服器權威 RNG 入口。前端只送 { bet }，停輪結果完全由資料庫 RPC 決定。
// ⚠️ 本檔案不含任何憑證，所有金鑰由 Supabase 執行環境的 env 提供。
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  // 1. CORS preflight（瀏覽器必須）
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  try {
    // 2. 驗證前端傳來的 JWT（不可信，必須驗）
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: 'MISSING_TOKEN' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // 用 anon key + 使用者 token 驗證身份（RLS 生效）
    const supabaseAuth = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: 'INVALID_TOKEN' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // 3. 讀取請求內容
    const body = await req.json().catch(() => ({}));
    const bet = Number(body.bet ?? 10);
    if (!Number.isInteger(bet) || bet < 1 || bet > 1000) {
      return new Response(JSON.stringify({ ok: false, error: 'INVALID_BET' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // 4. 用 service role 呼叫 SECURITY DEFINER RPC（只有後端能執行）
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data, error } = await supabaseAdmin.rpc('spin', {
      p_user_id: user.id,
      p_bet: bet,
    });
    if (error) throw error;

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[spin] error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
});
