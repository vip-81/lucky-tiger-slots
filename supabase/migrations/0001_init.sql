-- ============================================================================
-- 金輝虎將 Lucky Tiger Slots — 伺服器權威 RNG / RTP 資料庫結構
-- ============================================================================
-- 套用方式：Supabase Dashboard → SQL Editor → 貼上執行
-- ⚠️ 本檔案不含任何憑證或金鑰。
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. 玩家資料（與 auth.users 一對一，餘額唯一真相來源）
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  credits      bigint not null default 1000 check (credits >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. 遊戲設定（僅 service role 可寫；RTP 調整在這裡）
-- ---------------------------------------------------------------------------
create table if not exists public.game_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.game_config (key, value) values
  ('symbol_weights', '[2,5,9,13,24,32]'::jsonb),
  ('paytable', '{"seven":{"p3":100,"p2":10},"diamond":{"p3":50,"p2":5},"gold":{"p3":25,"p2":3},"bell":{"p3":15,"p2":2},"cherry":{"p3":10,"p2":0},"lemon":{"p3":5,"p2":0}}'::jsonb),
  -- rtp_factor：派彩倍率調整係數。1.0 = 完全依照 paytable。
  -- ⚠️ 正式上線前必須用 Monte Carlo 模擬驗證實際 RTP，不要只改這個數字就宣稱 RTP。
  ('rtp_factor', '1.0'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. 旋轉紀錄（伺服器決定的結果，寫入後不可竄改）
-- ---------------------------------------------------------------------------
create table if not exists public.rounds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id),
  bet          bigint not null check (bet > 0),
  stop_indices int[] not null check (cardinality(stop_indices) = 3),
  win_amount   bigint not null default 0 check (win_amount >= 0),
  created_at   timestamptz not null default now()
);

create index if not exists rounds_user_created_idx on public.rounds (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. 帳務流水（每筆下注 / 派彩都可稽核）
-- ---------------------------------------------------------------------------
create table if not exists public.transactions (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id),
  round_id   uuid references public.rounds(id),
  type       text not null check (type in ('bet','win','adjust')),
  amount     bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_idx on public.transactions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.rounds       enable row level security;
alter table public.transactions enable row level security;
alter table public.game_config  enable row level security;

-- 玩家只能讀自己的資料（寫入全部交給 SECURITY DEFINER RPC）
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "rounds_select_own" on public.rounds;
create policy "rounds_select_own" on public.rounds
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own" on public.transactions
  for select to authenticated using (auth.uid() = user_id);

-- game_config 不开放给一般使用者读取
drop policy if exists "game_config_service_only" on public.game_config;
create policy "game_config_service_only" on public.game_config
  for select to service_role using (true);

-- ---------------------------------------------------------------------------
-- 6. 核心 RPC：spin（伺服器 RNG + 派彩 + 帳務，一筆交易完成）
--    前端只傳 user_id 與 bet，停輪結果完全由伺服器決定。
-- ---------------------------------------------------------------------------
create or replace function public.spin(p_user_id uuid, p_bet bigint default 10)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile      public.profiles%rowtype;
  v_weights      int[];
  v_paytable     jsonb;
  v_rtp_factor   numeric;
  v_indices      int[] := '{}';
  v_i            int;
  v_total        int;
  v_r            double precision;
  v_sym          int;
  v_acc          int;
  v_a            int; v_b int; v_c int;
  v_raw_win      bigint := 0;
  v_win          bigint := 0;
  v_pay          jsonb;
  v_round_id     uuid;
  v_bet          bigint := least(greatest(coalesce(p_bet, 10), 1), 1000);
begin
  -- 6.1 鎖定玩家列，避免並發雙花（double spend）
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    insert into public.profiles (id, credits) values (p_user_id, 1000)
    returning * into v_profile;
  end if;

  if v_profile.credits < v_bet then
    return json_build_object('ok', false, 'error', 'INSUFFICIENT_CREDITS', 'credits', v_profile.credits);
  end if;

  -- 6.2 讀取伺服器端設定
  select value into v_weights    from public.game_config where key = 'symbol_weights';
  select value into v_paytable   from public.game_config where key = 'paytable';
  select value into v_rtp_factor from public.game_config where key = 'rtp_factor';

  -- 6.3 伺服器 RNG：依加權表抽出三輪結果（前端無法干预）
  select sum(x) into v_total from unnest(v_weights) x;
  for v_i in 1..3 loop
    v_r := random() * v_total;
    v_sym := array_length(v_weights, 1);
    v_acc := 0;
    for i in 1..array_length(v_weights, 1) loop
      v_acc := v_acc + v_weights[i];
      if v_r < v_acc then
        v_sym := i - 1;   -- 轉成 0-based，對應前端 SYMBOLS 索引
        exit;
      end if;
    end loop;
    v_indices := array_append(v_indices, v_sym);
  end loop;

  v_a := v_indices[1]; v_b := v_indices[2]; v_c := v_indices[3];

  -- 6.4 派彩計算（symbol 索引 → paytable key）
  if v_a = v_b and v_b = v_c then
    v_pay := v_paytable -> (array['seven','diamond','gold','bell','cherry','lemon'])[v_a + 1];
    v_raw_win := (v_pay ->> 'p3')::bigint * v_bet;
  elsif v_a = v_b or v_b = v_c or v_a = v_c then
    -- 找出重複符號
    if v_a = v_b then v_sym := v_a; elsif v_b = v_c then v_sym := v_b; else v_sym := v_a; end if;
    v_pay := v_paytable -> (array['seven','diamond','gold','bell','cherry','lemon'])[v_sym + 1];
    v_raw_win := (v_pay ->> 'p2')::bigint * v_bet;
  end if;

  -- 6.5 RTP 調整係數（正式環境需經 Monte Carlo 驗證）
  v_win := floor(coalesce(v_raw_win, 0) * coalesce(v_rtp_factor, 1));

  -- 6.6 原子更新餘額 + 寫入紀錄與流水
  update public.profiles
     set credits = credits - v_bet + v_win, updated_at = now()
   where id = p_user_id
   returning credits into v_profile.credits;

  insert into public.rounds (user_id, bet, stop_indices, win_amount)
  values (p_user_id, v_bet, v_indices, v_win)
  returning id into v_round_id;

  insert into public.transactions (user_id, round_id, type, amount)
  values (p_user_id, v_round_id, 'bet', -v_bet);

  if v_win > 0 then
    insert into public.transactions (user_id, round_id, type, amount)
    values (p_user_id, v_round_id, 'win', v_win);
  end if;

  return json_build_object(
    'ok', true,
    'roundId', v_round_id,
    'bet', v_bet,
    'stopIndices', v_indices,
    'winAmount', v_win,
    'credits', v_profile.credits
  );
end;
$$;

revoke all on function public.spin(uuid, bigint) from public;
grant execute on function public.spin(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 7. 斷線重連：依 roundId 還原該局結果（避免「轉了但沒派彩」爭議）
-- ---------------------------------------------------------------------------
create or replace function public.get_round(p_round_id uuid, p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round json;
begin
  select json_build_object(
    'roundId', r.id,
    'bet', r.bet,
    'stopIndices', r.stop_indices,
    'winAmount', r.win_amount,
    'createdAt', r.created_at
  ) into v_round
  from public.rounds r
  where r.id = p_round_id and r.user_id = p_user_id;

  if v_round is null then
    return json_build_object('ok', false, 'error', 'ROUND_NOT_FOUND');
  end if;
  return json_build_object('ok', true, 'round', v_round);
end;
$$;

revoke all on function public.get_round(uuid, uuid) from public;
grant execute on function public.get_round(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. 讀取餘額
-- ---------------------------------------------------------------------------
create or replace function public.get_balance(p_user_id uuid)
returns bigint
language sql
security definer
set search_path = public
as $$
  select credits from public.profiles where id = p_user_id;
$$;

revoke all on function public.get_balance(uuid) from public;
grant execute on function public.get_balance(uuid) to service_role;
