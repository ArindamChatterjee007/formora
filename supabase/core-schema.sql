BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'f', 'v', 'm')
  ) THEN
    RAISE EXCEPTION 'Fresh-install bootstrap requires an empty public schema; existing data is never replaced'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

CREATE TABLE public.accounts (
  uid text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profiles (
  uid text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.posts (
  id text PRIMARY KEY,
  author text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  likes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(likes) = 'object'),
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.comments (
  id text PRIMARY KEY,
  post_id text NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  parent_id text,
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mentions) = 'array'),
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.messages (
  id text PRIMARY KEY,
  from_uid text NOT NULL,
  to_uid text NOT NULL,
  body text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.requests (
  id text PRIMARY KEY,
  from_uid text NOT NULL,
  to_uid text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.notifications (
  id text PRIMARY KEY,
  uid text NOT NULL,
  type text NOT NULL,
  actor text NOT NULL,
  post_id text,
  body text,
  read boolean NOT NULL DEFAULT false,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.stories (
  id text PRIMARY KEY,
  author text NOT NULL,
  photo text,
  kind text NOT NULL DEFAULT 'photo',
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.entitlements (
  uid text PRIMARY KEY,
  tier text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'inactive',
  provider text,
  subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid text NOT NULL,
  type text NOT NULL,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid text NOT NULL,
  email text,
  subject text NOT NULL,
  message text NOT NULL,
  tier text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posts_recent ON public.posts(ts DESC);
CREATE INDEX comments_post_recent ON public.comments(post_id, ts);
CREATE INDEX messages_sender_recent ON public.messages(from_uid, ts DESC);
CREATE INDEX messages_recipient_recent ON public.messages(to_uid, ts DESC);
CREATE INDEX requests_recipient ON public.requests(to_uid, status);
CREATE INDEX notifications_owner_recent ON public.notifications(uid, ts DESC);

DO $permissions$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['accounts', 'profiles', 'posts', 'comments', 'messages',
    'requests', 'notifications', 'stories', 'entitlements', 'billing_events', 'support_tickets']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END;
$permissions$;

CREATE POLICY support_tickets_insert ON public.support_tickets FOR INSERT TO authenticated
  WITH CHECK (uid = auth.uid()::text);
CREATE POLICY support_tickets_read ON public.support_tickets FOR SELECT TO authenticated
  USING (uid = auth.uid()::text);
GRANT SELECT, INSERT ON public.support_tickets TO authenticated;

COMMIT;