-- Run once in a NEW Supabase project's SQL editor. No private key is needed in the website.
begin;

create table public.universe_settings (
  singleton boolean primary key default true check (singleton),
  initial_score integer not null default 80 check (initial_score between 0 and 100),
  created_at timestamptz not null default now()
);
insert into public.universe_settings (singleton) values (true);

create table public.universe_members (
  person text primary key check (person in ('him', 'her')),
  user_id uuid not null unique references auth.users(id) on delete cascade
);

create table public.universe_entries (
  sequence bigint generated always as identity unique,
  id uuid primary key,
  person text not null check (person in ('him', 'her')),
  delta integer not null check (delta between -100 and 100 and delta <> 0),
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  created_at timestamptz not null default clock_timestamp(),
  actor uuid not null,
  undo_of uuid unique references public.universe_entries(id)
);

alter table public.universe_settings enable row level security;
alter table public.universe_members enable row level security;
alter table public.universe_entries enable row level security;
revoke all on public.universe_settings, public.universe_members, public.universe_entries from public, anon, authenticated;
grant select on public.universe_settings, public.universe_members, public.universe_entries to authenticated;
create policy members_read_self on public.universe_members for select to authenticated using (user_id = (select auth.uid()));
create policy members_read_settings on public.universe_settings for select to authenticated using (exists(select 1 from public.universe_members where user_id = (select auth.uid())));
create policy members_read_entries on public.universe_entries for select to authenticated using (exists(select 1 from public.universe_members where user_id = (select auth.uid())));

create function public.universe_snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists(select 1 from public.universe_members where user_id = auth.uid()) then
    raise exception '这个账号不在你们的共同空间中。';
  end if;
  select jsonb_build_object(
    'profile', (select jsonb_build_object('person', m.person) from public.universe_members m where m.user_id = auth.uid()),
    'state', jsonb_build_object('version', 1, 'initialScore', s.initial_score, 'createdAt', s.created_at,
      'records', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'person', e.person, 'delta', e.delta, 'reason', e.reason, 'createdAt', e.created_at, 'undoOf', e.undo_of) order by e.sequence) from public.universe_entries e), '[]'::jsonb))
  ) into result from public.universe_settings s where s.singleton;
  return result;
end;
$$;

create function public.universe_add(p_id uuid, p_person text, p_delta integer, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_actor text; v_initial integer; v_score integer; v_existing public.universe_entries; v_time timestamptz;
begin
  select person into v_actor from public.universe_members where user_id = auth.uid();
  if v_actor is null then raise exception '请使用你们的账号登录。'; end if;
  if p_person is null or p_person not in ('him', 'her') or p_person = v_actor then raise exception '只能给对方评分。'; end if;
  if p_delta is null or p_delta = 0 or p_delta < -100 or p_delta > 100 then raise exception '请输入非零整数分数。'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then raise exception '请填写 1～300 字的理由。'; end if;
  if p_id is null then raise exception '记录标识不能为空。'; end if;
  -- A single row lock serializes both users' writes and guarantees the score bounds.
  select initial_score into v_initial from public.universe_settings where singleton for update;
  select * into v_existing from public.universe_entries where id = p_id;
  if found then
    if v_existing.actor = auth.uid() and v_existing.person = p_person and v_existing.delta = p_delta and v_existing.reason = btrim(p_reason) and v_existing.undo_of is null then return; end if;
    raise exception '记录标识已被使用，请刷新后重试。';
  end if;
  select v_initial + coalesce(sum(delta), 0) into v_score from public.universe_entries where person = p_person;
  if v_score + p_delta < 0 or v_score + p_delta > 100 then raise exception '调整后总分需保持在 0～100 分，请刷新后修改分数。'; end if;
  select greatest(clock_timestamp(), coalesce(max(created_at), '-infinity'::timestamptz) + interval '1 millisecond') into v_time from public.universe_entries;
  insert into public.universe_entries(id, person, delta, reason, actor, created_at) values (p_id, p_person, p_delta, btrim(p_reason), auth.uid(), v_time);
end;
$$;

create function public.universe_undo(p_record_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare original public.universe_entries; v_initial integer; v_score integer; v_time timestamptz;
begin
  if not exists(select 1 from public.universe_members where user_id = auth.uid()) then raise exception '请使用你们的账号登录。'; end if;
  select initial_score into v_initial from public.universe_settings where singleton for update;
  select * into original from public.universe_entries where id = p_record_id;
  if not found or original.undo_of is not null or original.actor <> auth.uid() then raise exception '只能撤销自己给对方的评分。'; end if;
  if exists(select 1 from public.universe_entries where undo_of = p_record_id) then return; end if;
  select v_initial + coalesce(sum(delta), 0) into v_score from public.universe_entries where person = original.person;
  if v_score - original.delta < 0 or v_score - original.delta > 100 then raise exception '撤销后总分会超出 0～100 分，暂时无法撤销。'; end if;
  select greatest(clock_timestamp(), max(created_at) + interval '1 millisecond') into v_time from public.universe_entries;
  insert into public.universe_entries(id, person, delta, reason, actor, undo_of, created_at)
    values (gen_random_uuid(), original.person, -original.delta, left('撤销：' || original.reason, 150), auth.uid(), original.id, v_time);
end;
$$;

revoke all on function public.universe_snapshot() from public, anon;
revoke all on function public.universe_add(uuid, text, integer, text) from public, anon;
revoke all on function public.universe_undo(uuid) from public, anon;
grant execute on function public.universe_snapshot() to authenticated;
grant execute on function public.universe_add(uuid, text, integer, text) to authenticated;
grant execute on function public.universe_undo(uuid) to authenticated;
commit;

-- After creating the two users in Authentication → Users, replace their UUIDs below
-- and run the two inserts separately. Do not run these placeholders unchanged.
-- insert into public.universe_members(person, user_id) values ('him', 'HIS_AUTH_USER_UUID');
-- insert into public.universe_members(person, user_id) values ('her', 'HER_AUTH_USER_UUID');
