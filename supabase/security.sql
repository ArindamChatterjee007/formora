-- ============================================================
-- Formora — Supabase security hardening (Row Level Security)
--
-- STATUS: APPLIED to production on 2026-08-23 with the v98 auth cutover
-- (USE_SUPABASE_AUTH=true). Identity is the Supabase user UUID (auth.uid());
-- the app sends uid/author/from_uid = auth.uid() (see js/cloud.js
-- _ensureIdentity). Verified live: the public anon key is DENIED (HTTP 401)
-- on every member-data table; authenticated users can read/write ONLY their
-- own rows and cannot spoof another identity. Idempotent — safe to re-run.
--
-- Fixes: OWASP A01 (Broken Access Control). The public anon key must NOT
-- grant direct read/write of member data or destructive deletes.
-- ============================================================

-- 1. Turn RLS ON for every member-data table -----------------------------
alter table if exists public.profiles enable row level security;
alter table if exists public.posts    enable row level security;
alter table if exists public.requests enable row level security;
alter table if exists public.comments enable row level security;
alter table if exists public.stories  enable row level security;
alter table if exists public.messages      enable row level security;  -- private DMs
alter table if exists public.notifications enable row level security;  -- private notifications
alter table if exists public.accounts      enable row level security;  -- full per-user state backup (biometrics live here)

-- 2. Remove the blanket anon privileges granted during the v76 revert -----
--    (the anon role should reach data ONLY through the vetted get_state RPC).
revoke all on public.profiles, public.posts, public.requests,
                public.comments, public.stories, public.messages,
                public.notifications, public.accounts from anon;

-- 3. Owner-only policies (requires Supabase Auth: auth.uid()) --------------
--    Identity must come from a verified session, never a client string.
--    First DROP any prior policies (incl. legacy me_uid()/email-slug ones)
--    so this set is the single source of truth, then (re)create them. This
--    avoids the "first duplicate aborts the whole block" trap.
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname='public'
    and tablename in ('profiles','posts','requests','comments','stories','messages','notifications','accounts')
  loop execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- profiles / posts / comments / stories / requests are readable by any signed-in
-- user (the social feed); writes are owner-only.
create policy profiles_read on public.profiles for select using (true);
create policy profiles_ins  on public.profiles for insert with check (auth.uid()::text = uid);
create policy profiles_upd  on public.profiles for update using (auth.uid()::text = uid);
create policy posts_read on public.posts for select using (true);
create policy posts_ins  on public.posts for insert with check (auth.uid()::text = author);
create policy posts_upd  on public.posts for update using (auth.uid()::text = author);
create policy posts_del  on public.posts for delete using (auth.uid()::text = author);
create policy comments_read on public.comments for select using (true);
create policy comments_ins  on public.comments for insert with check (auth.uid()::text = author);
create policy comments_del  on public.comments for delete using (auth.uid()::text = author);
create policy stories_read on public.stories for select using (true);
create policy stories_ins  on public.stories for insert with check (auth.uid()::text = author);
create policy stories_del  on public.stories for delete using (auth.uid()::text = author);
create policy requests_read on public.requests for select using (true);
create policy requests_ins  on public.requests for insert with check (auth.uid()::text = from_uid);
-- messages (private DMs): ONLY the sender or recipient can read — closes the DM leak.
create policy messages_read on public.messages for select using (auth.uid()::text = from_uid or auth.uid()::text = to_uid);
create policy messages_ins  on public.messages for insert with check (auth.uid()::text = from_uid);
create policy messages_upd  on public.messages for update using (auth.uid()::text = from_uid);
create policy messages_del  on public.messages for delete using (auth.uid()::text = from_uid);
-- notifications: only the recipient reads/clears; the actor creates them.
create policy notifs_read on public.notifications for select using (auth.uid()::text = uid);
create policy notifs_ins  on public.notifications for insert with check (auth.uid()::text = actor);
create policy notifs_upd  on public.notifications for update using (auth.uid()::text = uid);
-- accounts: the full per-user state backup (biometrics/logs) — strictly owner-only.
create policy accounts_read on public.accounts for select using (auth.uid()::text = uid);
create policy accounts_ins  on public.accounts for insert with check (auth.uid()::text = uid);
create policy accounts_upd  on public.accounts for update using (auth.uid()::text = uid);

-- 4. get_state (SECURITY DEFINER) — the ONLY way the app reaches the social
--    feed; it bypasses RLS but returns feed data only (never messages,
--    notifications or accounts). Signed-in users MUST have execute (granted
--    below). The biometric-stripping in the body is optional defense-in-depth:
--    since v96 the app no longer uploads biometrics to profiles, so there is
--    nothing to strip. Kept for fresh installs / legacy rows.
create or replace function public.get_state()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users', coalesce((
      select jsonb_object_agg(p.uid,
        case when auth.uid()::text = p.uid
          then p.data
          else p.data - 'weightKg' - 'bmi' - 'heightCm' - 'gender'
        end)
      from public.profiles p
    ), '{}'::jsonb),
    'posts',    coalesce((select jsonb_object_agg(id, data) from public.posts), '{}'::jsonb),
    'requests', coalesce((select jsonb_object_agg(id, data) from public.requests), '{}'::jsonb),
    'comments', coalesce((select jsonb_object_agg(id, data) from public.comments), '{}'::jsonb),
    'stories',  coalesce((select jsonb_object_agg(id, data) from public.stories), '{}'::jsonb)
  );
$$;

grant execute on function public.get_state() to authenticated;  -- required for the feed

-- 5. Storage: restrict the public 'media' bucket to authenticated uploads.
--    (Reads can stay public; writes should require a session.)
--    Run in the Storage policies UI or:
-- create policy media_upload_authed on storage.objects for insert to authenticated
--   with check (bucket_id = 'media');
-- create policy media_read_public on storage.objects for select using (bucket_id = 'media');

-- ROLLBACK (if the app breaks): flip USE_SUPABASE_AUTH=false in js/config.js and
-- redeploy, then per table:
--   alter table public.profiles disable row level security;
--   grant select, insert, update, delete on public.profiles to anon;
