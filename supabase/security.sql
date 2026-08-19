-- ============================================================
-- FORMORA — SUPABASE SECURITY HARDENING (Row Level Security)
-- ============================================================
-- WHAT THIS DOES
--   Turns on Postgres Row Level Security (RLS) on every table so a
--   user can only touch their OWN rows. This is the real "sandbox
--   every user" mechanism — it is enforced by the database and CANNOT
--   be bypassed by the browser, unlike any client-side check.
--
-- PREREQUISITE (IMPORTANT — read before running)
--   Today the app talks to Supabase with the PUBLIC anon key and a
--   client-chosen identity (an email slug). Postgres cannot trust that,
--   so RLS has nothing real to check. You MUST first enable a real
--   login so requests carry a verified JWT:
--     1. Supabase Dashboard → Authentication → Providers → enable Email.
--     2. The app must send the signed-in user's access_token as the
--        `Authorization: Bearer <token>` header on PostgREST/Storage
--        calls (keep the anon key only in the `apikey` header).
--        (Ask me — I can wire this into auth.js/cloud.js.)
--   The policies below derive each user's existing text uid from their
--   verified email, so your current schema (text uids) keeps working.
--
-- HOW TO APPLY
--   Supabase Dashboard → SQL Editor → paste this whole file → Run.
--   Re-runnable (drop-if-exists guards). Test with a second account
--   before relying on it.
-- ============================================================

-- ---- identity helper: the caller's uid, derived from their VERIFIED email ----
-- Mirrors Cloud.uidFor(email) in the client so existing rows keep matching.
create or replace function public.me_uid()
returns text
language sql
stable
as $$
  select case
    when auth.jwt() is null then null
    else left(regexp_replace(lower(coalesce(auth.jwt() ->> 'email', '')), '[^a-z0-9]', '_', 'g'), 60)
  end;
$$;

-- ============================================================
-- Enable RLS on every table (default-deny once enabled)
-- ============================================================
alter table if exists public.accounts        enable row level security;
alter table if exists public.profiles       enable row level security;
alter table if exists public.posts           enable row level security;
alter table if exists public.comments        enable row level security;
alter table if exists public.messages        enable row level security;
alter table if exists public.notifications   enable row level security;
alter table if exists public.stories         enable row level security;
alter table if exists public.requests        enable row level security;

-- ============================================================
-- ACCOUNTS  (PRIVATE per-user backup of workouts/food/weight/profile)
-- Only YOU can read or write your own account row — never anyone else.
-- ============================================================
drop policy if exists accounts_read   on public.accounts;
drop policy if exists accounts_write  on public.accounts;
drop policy if exists accounts_update on public.accounts;
drop policy if exists accounts_delete on public.accounts;
create policy accounts_read   on public.accounts for select to authenticated using (uid = public.me_uid());
create policy accounts_write  on public.accounts for insert to authenticated with check (uid = public.me_uid());
create policy accounts_update on public.accounts for update to authenticated using (uid = public.me_uid()) with check (uid = public.me_uid());
create policy accounts_delete on public.accounts for delete to authenticated using (uid = public.me_uid());

-- ============================================================
-- PROFILES  (directory is readable by any signed-in member; you edit only your own)
-- ============================================================
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated using (true);
create policy profiles_write  on public.profiles for insert to authenticated with check (uid = public.me_uid());
create policy profiles_update on public.profiles for update to authenticated using (uid = public.me_uid()) with check (uid = public.me_uid());
create policy profiles_delete on public.profiles for delete to authenticated using (uid = public.me_uid());

-- ============================================================
-- POSTS  (feed readable by members; only the author may create/edit/delete)
-- likes are changed through the like_post/unlike_post RPCs (see bottom), not direct UPDATE
-- ============================================================
drop policy if exists posts_read   on public.posts;
drop policy if exists posts_write  on public.posts;
drop policy if exists posts_update on public.posts;
drop policy if exists posts_delete on public.posts;
create policy posts_read   on public.posts for select to authenticated using (true);
create policy posts_write  on public.posts for insert to authenticated with check (author = public.me_uid());
create policy posts_update on public.posts for update to authenticated using (author = public.me_uid()) with check (author = public.me_uid());
create policy posts_delete on public.posts for delete to authenticated using (author = public.me_uid());

-- ============================================================
-- COMMENTS  (readable by members; author-only create/edit/delete)
-- ============================================================
drop policy if exists comments_read   on public.comments;
drop policy if exists comments_write  on public.comments;
drop policy if exists comments_update on public.comments;
drop policy if exists comments_delete on public.comments;
create policy comments_read   on public.comments for select to authenticated using (true);
create policy comments_write  on public.comments for insert to authenticated with check (author = public.me_uid());
create policy comments_update on public.comments for update to authenticated using (author = public.me_uid()) with check (author = public.me_uid());
create policy comments_delete on public.comments for delete to authenticated using (author = public.me_uid());

-- ============================================================
-- MESSAGES (Direct Messages) — the sensitive one
-- Only the two people in a thread can read it; only the sender can write/delete.
-- ============================================================
drop policy if exists messages_read   on public.messages;
drop policy if exists messages_write  on public.messages;
drop policy if exists messages_delete on public.messages;
create policy messages_read   on public.messages for select to authenticated using (from_uid = public.me_uid() or to_uid = public.me_uid());
create policy messages_write  on public.messages for insert to authenticated with check (from_uid = public.me_uid());
create policy messages_delete on public.messages for delete to authenticated using (from_uid = public.me_uid());

-- ============================================================
-- NOTIFICATIONS  (you only see your own; the "actor" cannot be forged)
-- ============================================================
drop policy if exists notifs_read   on public.notifications;
drop policy if exists notifs_write  on public.notifications;
drop policy if exists notifs_update on public.notifications;
drop policy if exists notifs_delete on public.notifications;
create policy notifs_read   on public.notifications for select to authenticated using (uid = public.me_uid());
create policy notifs_write  on public.notifications for insert to authenticated with check (actor = public.me_uid());
create policy notifs_update on public.notifications for update to authenticated using (uid = public.me_uid()) with check (uid = public.me_uid());
create policy notifs_delete on public.notifications for delete to authenticated using (uid = public.me_uid());

-- ============================================================
-- STORIES  (readable by members; author-only create/delete)
-- ============================================================
drop policy if exists stories_read   on public.stories;
drop policy if exists stories_write  on public.stories;
drop policy if exists stories_delete on public.stories;
create policy stories_read   on public.stories for select to authenticated using (true);
create policy stories_write  on public.stories for insert to authenticated with check (author = public.me_uid());
create policy stories_delete on public.stories for delete to authenticated using (author = public.me_uid());

-- ============================================================
-- REQUESTS (connect/follow) — only the two parties see it; sender creates, recipient accepts
-- ============================================================
drop policy if exists req_read   on public.requests;
drop policy if exists req_write  on public.requests;
drop policy if exists req_update on public.requests;
drop policy if exists req_delete on public.requests;
create policy req_read   on public.requests for select to authenticated using (from_uid = public.me_uid() or to_uid = public.me_uid());
create policy req_write  on public.requests for insert to authenticated with check (from_uid = public.me_uid());
create policy req_update on public.requests for update to authenticated using (to_uid = public.me_uid()) with check (to_uid = public.me_uid());
create policy req_delete on public.requests for delete to authenticated using (from_uid = public.me_uid() or to_uid = public.me_uid());

-- ============================================================
-- STORAGE ('media' bucket): a user may only write inside a folder named
-- after their own uid (path shape: "<folder>/<uid>/<file>"). Reads stay public.
-- ============================================================
drop policy if exists media_read   on storage.objects;
drop policy if exists media_write  on storage.objects;
drop policy if exists media_update on storage.objects;
drop policy if exists media_delete on storage.objects;
create policy media_read   on storage.objects for select using (bucket_id = 'media');
create policy media_write  on storage.objects for insert to authenticated with check (bucket_id = 'media' and (storage.foldername(name))[2] = public.me_uid());
create policy media_update on storage.objects for update to authenticated using (bucket_id = 'media' and (storage.foldername(name))[2] = public.me_uid());
create policy media_delete on storage.objects for delete to authenticated using (bucket_id = 'media' and (storage.foldername(name))[2] = public.me_uid());

-- ============================================================
-- RPC hardening: make like/unlike trust the JWT, not a client-passed uid.
-- Replace the body of your existing functions so they ignore p_uid and use me_uid().
-- (Adjust to match your current get_state/like_post definitions.)
-- ============================================================
-- Example — like_post should key the like on the CALLER, not an argument:
--   create or replace function public.like_post(p_id text, p_uid text default null)
--   returns void language plpgsql security definer set search_path = public as $$
--   begin
--     update public.posts
--        set likes = coalesce(likes,'{}'::jsonb) || jsonb_build_object(public.me_uid(), true)
--      where id = p_id and public.me_uid() is not null;
--   end; $$;

-- ============================================================
-- Grant the authenticated role DML on these tables (RLS still restricts WHICH
-- rows). Without this, logged-in requests could be denied outright once RLS is on.
-- ============================================================
grant select, insert, update, delete on
  public.profiles, public.posts, public.comments, public.messages,
  public.notifications, public.stories, public.requests, public.accounts
  to authenticated;

-- ============================================================
-- Lock the door on the anon role: with real logins, table access should go
-- through the authenticated role only. (Auth endpoints /auth/v1 are unaffected.)
-- ============================================================
revoke all on public.profiles, public.posts, public.comments, public.messages,
             public.notifications, public.stories, public.requests, public.accounts
  from anon;
