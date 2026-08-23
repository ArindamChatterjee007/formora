-- ============================================================
-- Formora — Supabase security hardening (Row Level Security)
--
-- STATUS: STAGED. Do NOT run blindly against production. Enabling RLS
-- without the matching auth migration will break the current anon-key
-- app (this is exactly what broke the app during the v78 migration).
-- Apply this through the `beta` stage together with Supabase Auth, then
-- verify the QA regression before promoting to `main`.
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

-- 2. Remove the blanket anon privileges granted during the v76 revert -----
--    (the anon role should reach data ONLY through the vetted RPCs below).
revoke all on public.profiles, public.posts, public.requests,
                public.comments, public.stories, public.messages,
                public.notifications from anon;

-- 3. Owner-only write policies (requires Supabase Auth: auth.uid()) --------
--    Identity must come from a verified session, never a client string.
--    'uid' columns are expected to equal the authenticated user id.
do $$
begin
  -- profiles
  create policy profiles_read       on public.profiles for select using (true);
  create policy profiles_write_self on public.profiles for insert with check (auth.uid()::text = uid);
  create policy profiles_update_self on public.profiles for update using (auth.uid()::text = uid);
  -- posts
  create policy posts_read        on public.posts for select using (true);
  create policy posts_write_self  on public.posts for insert with check (auth.uid()::text = author);
  create policy posts_update_self on public.posts for update using (auth.uid()::text = author);
  create policy posts_delete_self on public.posts for delete using (auth.uid()::text = author);
  -- comments
  create policy comments_read       on public.comments for select using (true);
  create policy comments_write_self on public.comments for insert with check (auth.uid()::text = author);
  create policy comments_delete_self on public.comments for delete using (auth.uid()::text = author);
  -- stories
  create policy stories_read       on public.stories for select using (true);
  create policy stories_write_self on public.stories for insert with check (auth.uid()::text = author);
  create policy stories_delete_self on public.stories for delete using (auth.uid()::text = author);
  -- requests (connect requests)
  create policy requests_read       on public.requests for select using (true);
  create policy requests_write_self on public.requests for insert with check (auth.uid()::text = from_uid);
  -- messages (private DMs): ONLY the sender or recipient can read — closes the DM leak (OWASP A01)
  create policy messages_read on public.messages for select using (auth.uid()::text = from_uid or auth.uid()::text = to_uid);
  create policy messages_send on public.messages for insert with check (auth.uid()::text = from_uid);
  create policy messages_edit on public.messages for update using (auth.uid()::text = from_uid);
  create policy messages_del  on public.messages for delete using (auth.uid()::text = from_uid);
  -- notifications: only the recipient reads/clears; the actor creates them
  create policy notifs_read   on public.notifications for select using (auth.uid()::text = uid);
  create policy notifs_create on public.notifications for insert with check (auth.uid()::text = actor);
  create policy notifs_mark   on public.notifications for update using (auth.uid()::text = uid);
exception when duplicate_object then null;  -- idempotent re-runs
end $$;

-- 4. Data minimisation: the public read RPC must NOT leak biometric/health
--    fields (weight, bmi, height, gender) to unauthenticated callers.
--    Redefine get_state (SECURITY DEFINER) to strip sensitive keys from the
--    profile JSON for anon; return them only to the profile's owner.
--    (Adjust column/JSON shape to match your live schema before applying.)
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

-- 5. Storage: restrict the public 'media' bucket to authenticated uploads.
--    (Reads can stay public; writes should require a session.)
--    Run in the Storage policies UI or:
-- create policy media_upload_authed on storage.objects for insert to authenticated
--   with check (bucket_id = 'media');
-- create policy media_read_public on storage.objects for select using (bucket_id = 'media');

-- ROLLBACK (if the app breaks during staging):
--   alter table public.profiles disable row level security;  -- etc. per table
--   grant select, insert, update, delete on public.profiles to anon;  -- etc.
