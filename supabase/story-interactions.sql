BEGIN;

CREATE TABLE public.story_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  permission_policy_approved boolean NOT NULL DEFAULT false,
  media_audience_approved boolean NOT NULL DEFAULT false,
  public_media_approved boolean NOT NULL DEFAULT false,
  retention_approved boolean NOT NULL DEFAULT false,
  operator_policy_ref uuid,
  media_origin text CHECK (media_origin ~ '^https://[a-z0-9-]+[.]supabase[.]co$'),
  public_bucket text CHECK (public_bucket ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  actor_minute integer NOT NULL DEFAULT 100 CHECK (actor_minute BETWEEN 1 AND 100),
  actor_day integer NOT NULL DEFAULT 500 CHECK (actor_day BETWEEN 1 AND 500),
  target_minute integer NOT NULL DEFAULT 200 CHECK (target_minute BETWEEN 1 AND 200),
  target_day integer NOT NULL DEFAULT 2000 CHECK (target_day BETWEEN 1 AND 2000),
  recipient_minute integer NOT NULL DEFAULT 100 CHECK (recipient_minute BETWEEN 1 AND 100),
  recipient_day integer NOT NULL DEFAULT 1000 CHECK (recipient_day BETWEEN 1 AND 1000),
  cleanup_minute integer NOT NULL DEFAULT 10 CHECK (cleanup_minute BETWEEN 1 AND 10),
  cleanup_day integer NOT NULL DEFAULT 100 CHECK (cleanup_day BETWEEN 1 AND 100),
  notification_per_minute integer NOT NULL DEFAULT 20 CHECK (notification_per_minute BETWEEN 1 AND 20),
  notification_per_day integer NOT NULL DEFAULT 100 CHECK (notification_per_day BETWEEN 1 AND 100),
  notification_actor_per_minute integer NOT NULL DEFAULT 5 CHECK (notification_actor_per_minute BETWEEN 1 AND 5),
  notification_actor_per_day integer NOT NULL DEFAULT 20 CHECK (notification_actor_per_day BETWEEN 1 AND 20),
  CHECK (NOT enabled OR (permission_policy_approved AND media_audience_approved AND public_media_approved
    AND retention_approved AND operator_policy_ref IS NOT NULL AND media_origin IS NOT NULL AND public_bucket IS NOT NULL))
);
INSERT INTO public.story_settings DEFAULT VALUES;
CREATE TABLE public.stories_v2 (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), owner uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('photo','video')),
  audience text NOT NULL CHECK (audience = 'authenticated'),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, deleted_at timestamptz,
  CHECK (expires_at = created_at + interval '24 hours')
);
CREATE INDEX stories_v2_feed ON public.stories_v2 (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX stories_v2_owner ON public.stories_v2 (owner, created_at DESC);
CREATE TABLE public.story_content (
  story_id uuid PRIMARY KEY REFERENCES public.stories_v2(id),
  media_url text NOT NULL CHECK (length(media_url) BETWEEN 1 AND 2048)
);
CREATE TABLE public.story_interactions (
  story_id uuid NOT NULL REFERENCES public.stories_v2(id), viewer uuid NOT NULL,
  qualified_at timestamptz, liked boolean NOT NULL DEFAULT false, PRIMARY KEY (story_id, viewer)
);
CREATE INDEX story_qualified_viewers ON public.story_interactions (story_id, qualified_at DESC, viewer DESC) WHERE qualified_at IS NOT NULL;
CREATE TABLE public.story_blocks (
  blocker uuid NOT NULL, blocked uuid NOT NULL, PRIMARY KEY (blocker, blocked), CHECK (blocker <> blocked)
);
CREATE TABLE public.story_notification_preferences (
  uid uuid PRIMARY KEY, likes boolean NOT NULL DEFAULT false, replies boolean NOT NULL DEFAULT false,
  sound boolean NOT NULL DEFAULT false, reply_permission text NOT NULL DEFAULT 'none' CHECK (reply_permission IN ('none','authenticated')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE public.story_rate_limits (
  scope text NOT NULL CHECK (scope IN ('actor','target','recipient','cleanup')), subject uuid NOT NULL,
  minute_start timestamptz NOT NULL, minute_count integer NOT NULL,
  day_start timestamptz NOT NULL, day_count integer NOT NULL, PRIMARY KEY (scope, subject)
);
CREATE TABLE public.story_action_receipts (
  actor uuid NOT NULL, request_id uuid NOT NULL, action text NOT NULL,
  payload_digest text NOT NULL CHECK (length(payload_digest) = 64),
  response jsonb NOT NULL CHECK (octet_length(response::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(), PRIMARY KEY (actor, request_id)
);
CREATE TABLE public.story_message_context (
  message_id text PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  story_id uuid NOT NULL REFERENCES public.stories_v2(id)
);
CREATE TABLE public.story_notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), recipient uuid NOT NULL, actor uuid NOT NULL,
  story_id uuid NOT NULL REFERENCES public.stories_v2(id), kind text NOT NULL CHECK (kind IN ('like','reply')),
  message_id text REFERENCES public.messages(id) ON DELETE CASCADE, request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(), read_at timestamptz,
  UNIQUE (story_id, actor, kind), UNIQUE (actor, request_id)
);
CREATE INDEX story_notifications_recipient ON public.story_notifications (recipient, created_at DESC, id DESC);
CREATE TABLE public.story_notification_events (
  story_id uuid NOT NULL REFERENCES public.stories_v2(id), actor uuid NOT NULL, recipient uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('like','reply')), enqueued boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL, PRIMARY KEY (story_id, actor, kind), CHECK (actor <> recipient)
);
CREATE INDEX story_notification_events_fanout ON public.story_notification_events (recipient, created_at DESC, actor) WHERE enqueued;
CREATE TABLE public.story_reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), reporter uuid NOT NULL,
  story_id uuid NOT NULL REFERENCES public.stories_v2(id), message_id text REFERENCES public.messages(id) ON DELETE SET NULL,
  reported_uid uuid NOT NULL, reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'received' CHECK (status = 'received'), created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION public._story_actor(p_gated boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := auth.uid(); settings public.story_settings%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE uid = caller::text) THEN
    RAISE EXCEPTION 'Member unavailable' USING ERRCODE = 'PT403';
  END IF;
  IF p_gated THEN
    SELECT * INTO settings FROM public.story_settings WHERE singleton FOR SHARE;
    IF NOT FOUND OR NOT (settings.enabled AND settings.permission_policy_approved AND settings.media_audience_approved
      AND settings.public_media_approved AND settings.retention_approved AND settings.operator_policy_ref IS NOT NULL
      AND settings.media_origin IS NOT NULL AND settings.public_bucket IS NOT NULL) THEN
      RAISE EXCEPTION 'Stories unavailable pending operator policy review' USING ERRCODE = 'PT503';
    END IF;
  END IF;
  RETURN caller;
END;
$function$;
CREATE FUNCTION public._story_eligible(p_id uuid, p_actor uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT p_actor IS NOT NULL AND EXISTS (SELECT 1 FROM public.stories_v2 AS story
    JOIN public.profiles AS profile ON profile.uid = story.owner::text
    WHERE story.id = p_id AND story.audience = 'authenticated' AND story.deleted_at IS NULL
      AND story.expires_at > pg_catalog.clock_timestamp()
      AND (story.owner = p_actor OR coalesce(profile.data->>'privacy', 'public') = 'public')
      AND NOT EXISTS (SELECT 1 FROM public.story_blocks WHERE
        (blocker = p_actor AND blocked = story.owner) OR (blocker = story.owner AND blocked = p_actor)));
$function$;
CREATE FUNCTION public._story_shape(p_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('id', story.id, 'author', story.owner, 'photo', content.media_url,
    'kind', story.kind, 'audience', story.audience, 'ts', (extract(epoch FROM story.created_at)*1000)::bigint,
    'expires_at', story.expires_at, 'mine', story.owner = p_actor,
    'seen', coalesce(interaction.qualified_at IS NOT NULL, false), 'liked', coalesce(interaction.liked, false),
    'view_count', CASE WHEN story.owner = p_actor THEN (SELECT count(*) FROM public.story_interactions WHERE story_id = p_id AND qualified_at IS NOT NULL) END,
    'like_count', CASE WHEN story.owner = p_actor THEN (SELECT count(*) FROM public.story_interactions WHERE story_id = p_id AND liked) END)
  FROM public.stories_v2 AS story JOIN public.story_content AS content ON content.story_id = story.id
  LEFT JOIN public.story_interactions AS interaction ON interaction.story_id = story.id AND interaction.viewer = p_actor
  WHERE story.id = p_id AND public._story_eligible(p_id, p_actor);
$function$;
CREATE FUNCTION public.get_story(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); recipient uuid; result jsonb;
BEGIN
  SELECT owner INTO recipient FROM public.stories_v2 WHERE id = p_id;
  PERFORM public._story_lock(caller, p_id, recipient);
  PERFORM public._story_budget(caller, CASE WHEN caller = recipient THEN NULL ELSE p_id END, NULL);
  SELECT public._story_shape(p_id, caller) INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE = 'PT404'; END IF;
  RETURN result;
END;
$function$;

CREATE FUNCTION public._story_lock(p_actor uuid, p_target uuid, p_recipient uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE lock_key bigint;
BEGIN
  FOR lock_key IN SELECT DISTINCT pg_catalog.hashtextextended('stories-v2:' || subject::text, 0)
    FROM pg_catalog.unnest(ARRAY[p_actor,p_target,p_recipient]) AS scopes(subject) WHERE subject IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(lock_key);
  END LOOP;
  PERFORM uid FROM public.profiles WHERE uid IN (p_actor::text,p_recipient::text) ORDER BY uid FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE uid = p_actor::text) THEN
    RAISE EXCEPTION 'Member unavailable' USING ERRCODE = 'PT403';
  END IF;
END;
$function$;
CREATE FUNCTION public._story_budget(p_actor uuid, p_target uuid, p_recipient uuid, p_cleanup boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings jsonb; scope_row record; counter public.story_rate_limits%ROWTYPE;
  stamp timestamptz := pg_catalog.clock_timestamp(); minute_window timestamptz; day_window timestamptz; retry_seconds integer;
BEGIN
  SELECT pg_catalog.to_jsonb(policy) INTO settings FROM public.story_settings AS policy WHERE singleton FOR SHARE;
  IF settings IS NULL THEN RAISE EXCEPTION 'Stories unavailable' USING ERRCODE = 'PT503'; END IF;
  minute_window := pg_catalog.date_trunc('minute', stamp); day_window := pg_catalog.date_trunc('day', stamp, 'UTC');
  FOR scope_row IN SELECT * FROM (VALUES (CASE WHEN p_cleanup THEN 'cleanup' ELSE 'actor' END,p_actor),
    ('target',p_target),('recipient',p_recipient)) AS scopes(name,uid) WHERE uid IS NOT NULL ORDER BY name LOOP
    INSERT INTO public.story_rate_limits AS quota VALUES (scope_row.name,scope_row.uid,minute_window,1,day_window,1)
    ON CONFLICT (scope,subject) DO UPDATE SET
      minute_count = CASE WHEN quota.minute_start = minute_window THEN quota.minute_count + 1 ELSE 1 END,
      day_count = CASE WHEN quota.day_start = day_window THEN quota.day_count + 1 ELSE 1 END,
      minute_start = minute_window, day_start = day_window RETURNING * INTO counter;
    IF counter.minute_count > (settings->>(scope_row.name || '_minute'))::integer OR counter.day_count > (settings->>(scope_row.name || '_day'))::integer THEN
      retry_seconds := greatest(1,least(86400,ceil(extract(epoch FROM
        (CASE WHEN counter.day_count > (settings->>(scope_row.name || '_day'))::integer THEN day_window + interval '1 day' ELSE minute_window + interval '1 minute' END) - stamp))::integer));
      RAISE EXCEPTION 'Story limit reached' USING ERRCODE = 'PT429', DETAIL = pg_catalog.jsonb_build_object('retry_after_seconds',retry_seconds)::text;
    END IF;
  END LOOP;
END;
$function$;
CREATE FUNCTION public._story_digest(p_action text, p_payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(p_action,p_payload)::text,'UTF8')),'hex');
$function$;
CREATE FUNCTION public._story_begin(p_action text, p_request_id uuid, p_payload jsonb, p_target uuid, p_recipient uuid, p_gated boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(p_gated); prior public.story_action_receipts%ROWTYPE;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request UUID required' USING ERRCODE = '22023'; END IF;
  PERFORM public._story_lock(caller,p_target,p_recipient);
  SELECT * INTO prior FROM public.story_action_receipts WHERE actor = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.action <> p_action OR prior.payload_digest <> public._story_digest(p_action,p_payload) THEN
      RAISE EXCEPTION 'Request UUID payload conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN prior.response || '{"duplicate":true}'::jsonb;
  END IF;
  PERFORM public._story_budget(caller,
    CASE WHEN p_action = 'delete' OR (p_action = 'view' AND p_recipient = caller) THEN NULL ELSE p_target END,
    CASE WHEN p_action IN ('delete','view','like','publish','read_notifications') THEN NULL ELSE p_recipient END,
    p_action = 'delete');
  RETURN NULL;
END;
$function$;
CREATE FUNCTION public._story_finish(p_action text, p_request_id uuid, p_payload jsonb, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE result jsonb := p_result || pg_catalog.jsonb_build_object('action',p_action,'request_id',p_request_id,'committed',true,'duplicate',false);
BEGIN
  INSERT INTO public.story_action_receipts(actor,request_id,action,payload_digest,response)
    VALUES (auth.uid(),p_request_id,p_action,public._story_digest(p_action,p_payload),result);
  RETURN result;
END;
$function$;
CREATE FUNCTION public._story_notify(p_kind text, p_id uuid, p_actor uuid, p_recipient uuid, p_request_id uuid, p_message_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_settings%ROWTYPE; stamp timestamptz := pg_catalog.clock_timestamp();
  minute_window timestamptz; day_window timestamptz;
  recipient_minute_count bigint; recipient_day_count bigint; pair_minute_count bigint; pair_day_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.story_notification_preferences WHERE uid = p_recipient AND
    CASE p_kind WHEN 'like' THEN likes WHEN 'reply' THEN replies ELSE false END) THEN RETURN; END IF;
  INSERT INTO public.story_notification_events(story_id,actor,recipient,kind,created_at)
    VALUES (p_id,p_actor,p_recipient,p_kind,stamp) ON CONFLICT (story_id,actor,kind) DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO settings FROM public.story_settings WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stories unavailable' USING ERRCODE = 'PT503'; END IF;
  minute_window := pg_catalog.date_trunc('minute',stamp); day_window := pg_catalog.date_trunc('day',stamp,'UTC');
  SELECT count(*) FILTER (WHERE created_at >= minute_window), count(*),
    count(*) FILTER (WHERE actor = p_actor AND created_at >= minute_window), count(*) FILTER (WHERE actor = p_actor)
    INTO recipient_minute_count,recipient_day_count,pair_minute_count,pair_day_count
    FROM public.story_notification_events WHERE recipient = p_recipient AND enqueued AND created_at >= day_window;
  IF recipient_minute_count >= settings.notification_per_minute OR recipient_day_count >= settings.notification_per_day
    OR pair_minute_count >= settings.notification_actor_per_minute OR pair_day_count >= settings.notification_actor_per_day THEN RETURN; END IF;
  INSERT INTO public.story_notifications(recipient,actor,story_id,kind,request_id,message_id,created_at)
    VALUES (p_recipient,p_actor,p_id,p_kind,p_request_id,p_message_id,stamp) ON CONFLICT (story_id,actor,kind) DO NOTHING;
  IF FOUND THEN
    UPDATE public.story_notification_events SET enqueued = true WHERE story_id = p_id AND actor = p_actor AND kind = p_kind;
  END IF;
END;
$function$;
CREATE FUNCTION public.publish_story(p_request_id uuid, p_media_url text, p_kind text, p_audience text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); prior jsonb; payload jsonb := pg_catalog.jsonb_build_array(p_media_url,p_kind,p_audience);
  settings public.story_settings%ROWTYPE; prefix text; filename text; story_id uuid; stamp timestamptz;
BEGIN
  IF p_media_url IS NULL OR length(p_media_url) NOT BETWEEN 1 AND 2048 OR p_kind IS NULL OR p_kind NOT IN ('photo','video')
    OR p_audience IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'Unsupported story media or audience' USING ERRCODE = '22023'; END IF;
  prior := public._story_begin('publish',p_request_id,payload,NULL,caller);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  SELECT * INTO settings FROM public.story_settings WHERE singleton;
  prefix := settings.media_origin || '/storage/v1/object/public/' || settings.public_bucket || '/stories/' || caller::text || '/';
  filename := pg_catalog.substr(p_media_url,length(prefix)+1);
  IF pg_catalog.left(p_media_url,length(prefix)) <> prefix OR filename !~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}[.](jpg|jpeg|png|webp|mp4|webm)$'
    OR (p_kind = 'photo' AND filename !~ '[.](jpg|jpeg|png|webp)$') OR (p_kind = 'video' AND filename !~ '[.](mp4|webm)$') THEN
    RAISE EXCEPTION 'Approved owner media URL required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE uid = caller::text AND coalesce(data->>'privacy','public') = 'public') THEN
    RAISE EXCEPTION 'Restricted profile media is unsupported' USING ERRCODE = 'PT403';
  END IF;
  stamp := pg_catalog.clock_timestamp();
  INSERT INTO public.stories_v2(owner,kind,audience,created_at,expires_at) VALUES (caller,p_kind,p_audience,stamp,stamp+interval '24 hours') RETURNING id INTO story_id;
  INSERT INTO public.story_content VALUES (story_id,p_media_url);
  RETURN public._story_finish('publish',p_request_id,payload,pg_catalog.jsonb_build_object('id',story_id,'author',caller,'created_at',stamp,'expires_at',stamp+interval '24 hours'));
END;
$function$;
CREATE FUNCTION public.delete_story(p_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); recipient uuid; prior jsonb; stamp timestamptz; payload jsonb := pg_catalog.jsonb_build_array(p_id);
BEGIN
  SELECT owner INTO recipient FROM public.stories_v2 WHERE id = p_id;
  IF recipient IS DISTINCT FROM caller THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE = 'PT404'; END IF;
  prior := public._story_begin('delete',p_request_id,payload,p_id,recipient);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  UPDATE public.stories_v2 SET deleted_at = coalesce(deleted_at,pg_catalog.clock_timestamp()) WHERE id = p_id RETURNING deleted_at INTO stamp;
  RETURN public._story_finish('delete',p_request_id,payload,pg_catalog.jsonb_build_object('id',p_id,'author',caller,'deleted_at',stamp));
END;
$function$;
CREATE FUNCTION public.record_story_view(p_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); recipient uuid; prior jsonb; qualified timestamptz; payload jsonb := pg_catalog.jsonb_build_array(p_id);
BEGIN
  SELECT owner INTO recipient FROM public.stories_v2 WHERE id = p_id;
  prior := public._story_begin('view',p_request_id,payload,p_id,recipient);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF NOT public._story_eligible(p_id,caller) THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE = 'PT404'; END IF;
  IF recipient <> caller THEN
    INSERT INTO public.story_interactions AS interaction(story_id,viewer,qualified_at) VALUES (p_id,caller,pg_catalog.clock_timestamp())
      ON CONFLICT (story_id,viewer) DO UPDATE SET qualified_at = coalesce(interaction.qualified_at,excluded.qualified_at) RETURNING qualified_at INTO qualified;
  END IF;
  RETURN public._story_finish('view',p_request_id,payload,pg_catalog.jsonb_build_object('id',p_id,'qualified',qualified IS NOT NULL,'qualified_at',qualified));
END;
$function$;
CREATE FUNCTION public.set_story_like(p_id uuid, p_desired boolean, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); recipient uuid; prior jsonb; was_liked boolean;
  payload jsonb := pg_catalog.jsonb_build_array(p_id,p_desired);
BEGIN
  IF p_desired IS NULL THEN RAISE EXCEPTION 'Desired state required' USING ERRCODE = '22023'; END IF;
  SELECT owner INTO recipient FROM public.stories_v2 WHERE id = p_id;
  prior := public._story_begin('like',p_request_id,payload,p_id,recipient);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF NOT public._story_eligible(p_id,caller) THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE = 'PT404'; END IF;
  IF recipient = caller THEN RAISE EXCEPTION 'Cannot like own story' USING ERRCODE = '22023'; END IF;
  was_liked := coalesce((SELECT liked FROM public.story_interactions WHERE story_id = p_id AND viewer = caller),false);
  INSERT INTO public.story_interactions(story_id,viewer,liked) VALUES (p_id,caller,p_desired)
    ON CONFLICT (story_id,viewer) DO UPDATE SET liked = excluded.liked;
  IF p_desired AND NOT was_liked THEN PERFORM public._story_notify('like',p_id,caller,recipient,p_request_id); END IF;
  RETURN public._story_finish('like',p_request_id,payload,pg_catalog.jsonb_build_object('id',p_id,'liked',p_desired));
END;
$function$;
CREATE FUNCTION public.reply_to_story(p_id uuid, p_text text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); recipient uuid; prior jsonb; message_id text; stamp timestamptz;
  payload jsonb := pg_catalog.jsonb_build_array(p_id,p_text);
BEGIN
  IF p_text IS NULL OR length(trim(p_text)) NOT BETWEEN 1 AND 512 OR length(p_text) > 512 OR octet_length(p_text) > 2048
    OR p_text ~ '[<>]' OR pg_catalog.regexp_replace(p_text,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Plain text reply must contain 1 to 512 characters' USING ERRCODE = '22023';
  END IF;
  SELECT owner INTO recipient FROM public.stories_v2 WHERE id = p_id;
  prior := public._story_begin('reply',p_request_id,payload,p_id,recipient);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF NOT public._story_eligible(p_id,caller) THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE = 'PT404'; END IF;
  IF recipient = caller THEN RAISE EXCEPTION 'Cannot reply to own story' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.story_notification_preferences WHERE uid = recipient AND reply_permission = 'authenticated') THEN
    RAISE EXCEPTION 'Story replies not permitted' USING ERRCODE = 'PT403';
  END IF;
  message_id := pg_catalog.gen_random_uuid()::text; stamp := pg_catalog.clock_timestamp();
  INSERT INTO public.messages(id,from_uid,to_uid,body,ts) VALUES (message_id,caller::text,recipient::text,trim(p_text),stamp);
  INSERT INTO public.story_message_context VALUES (message_id,p_id);
  PERFORM public._story_notify('reply',p_id,caller,recipient,p_request_id,message_id);
  RETURN public._story_finish('reply',p_request_id,payload,pg_catalog.jsonb_build_object('id',message_id,'story_id',p_id,
    'from',caller,'to',recipient,'ts',(extract(epoch FROM stamp)*1000)::bigint));
END;
$function$;
CREATE FUNCTION public.resolve_story_reply_context(p_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); target_story uuid; recipient uuid; result jsonb;
BEGIN
  IF p_message_id IS NULL OR length(p_message_id) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid message id' USING ERRCODE = '22023'; END IF;
  SELECT context.story_id, story.owner INTO target_story, recipient FROM public.story_message_context AS context
    JOIN public.messages AS message ON message.id = context.message_id JOIN public.stories_v2 AS story ON story.id = context.story_id
    WHERE message.id = p_message_id AND (message.from_uid = caller::text OR message.to_uid = caller::text) AND message.to_uid = story.owner::text;
  PERFORM public._story_lock(caller,target_story,recipient);
  PERFORM public._story_budget(caller,CASE WHEN caller = recipient THEN NULL ELSE target_story END,NULL);
  PERFORM message.id FROM public.messages AS message JOIN public.story_message_context AS context ON context.message_id = message.id
    WHERE message.id = p_message_id AND context.story_id = target_story AND message.to_uid = recipient::text
      AND (message.from_uid = caller::text OR message.to_uid = caller::text) FOR SHARE OF message;
  IF FOUND THEN SELECT public._story_shape(target_story,caller) INTO result; END IF;
  IF result IS NULL THEN RETURN '{"available":false}'::jsonb; END IF;
  RETURN pg_catalog.jsonb_build_object('available',true,'story',result);
END;
$function$;
-- Reference marker only: which of these already-visible messages are Story replies. Never returns a story id, media, caption or body.
CREATE FUNCTION public.story_reply_references(p_message_ids text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); ids text[]; result jsonb;
BEGIN
  IF p_message_ids IS NULL OR pg_catalog.cardinality(p_message_ids) NOT BETWEEN 1 AND 50
    OR pg_catalog.array_position(p_message_ids,NULL) IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_message_ids) AS requested(id) WHERE length(requested.id) NOT BETWEEN 1 AND 255) THEN
    RAISE EXCEPTION 'One to fifty message ids required' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT id ORDER BY id) INTO ids FROM pg_catalog.unnest(p_message_ids) AS requested(id);
  PERFORM public._story_lock(caller,NULL,NULL);
  PERFORM public._story_budget(caller,NULL,NULL);
  SELECT pg_catalog.jsonb_agg(matched.message_id ORDER BY matched.message_id) INTO result FROM
    (SELECT DISTINCT context.message_id FROM public.story_message_context AS context
      JOIN public.messages AS message ON message.id = context.message_id
      JOIN public.stories_v2 AS story ON story.id = context.story_id
      WHERE message.id = ANY(ids) AND message.to_uid = story.owner::text
        AND (message.from_uid = caller::text OR message.to_uid = caller::text)) AS matched;
  RETURN pg_catalog.jsonb_build_object('message_ids',coalesce(result,'[]'::jsonb));
END;
$function$;
CREATE FUNCTION public.get_story_notification_preferences()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(false); result jsonb;
BEGIN
  PERFORM public._story_lock(caller,NULL,NULL); PERFORM public._story_budget(caller,NULL,NULL);
  SELECT pg_catalog.to_jsonb(preference) - 'uid' INTO result FROM public.story_notification_preferences AS preference WHERE uid = caller;
  RETURN coalesce(result,'{"likes":false,"replies":false,"sound":false,"reply_permission":"none","version":0}'::jsonb);
END;
$function$;
CREATE FUNCTION public.set_story_notification_preferences(p_likes boolean, p_replies boolean, p_sound boolean, p_reply_permission text, p_version integer, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(false); prior jsonb; result jsonb;
  payload jsonb := pg_catalog.jsonb_build_array(p_likes,p_replies,p_sound,p_reply_permission,p_version);
BEGIN
  IF p_likes IS NULL OR p_replies IS NULL OR p_sound IS NULL OR p_reply_permission IS NULL OR p_reply_permission NOT IN ('none','authenticated')
    OR p_version IS NULL OR p_version < 0 THEN RAISE EXCEPTION 'Invalid preferences' USING ERRCODE = '22023'; END IF;
  prior := public._story_begin('preferences',p_request_id,payload,NULL,NULL,false);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF coalesce((SELECT version FROM public.story_notification_preferences WHERE uid = caller),0) <> p_version THEN
    RAISE EXCEPTION 'Preferences changed; refresh' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO public.story_notification_preferences AS preference(uid,likes,replies,sound,reply_permission,version)
    VALUES (caller,p_likes,p_replies,p_sound,p_reply_permission,p_version+1)
    ON CONFLICT (uid) DO UPDATE SET likes=excluded.likes,replies=excluded.replies,sound=excluded.sound,reply_permission=excluded.reply_permission,version=excluded.version
    RETURNING pg_catalog.to_jsonb(preference) - 'uid' INTO result;
  RETURN public._story_finish('preferences',p_request_id,payload,result);
END;
$function$;
CREATE FUNCTION public.set_story_block(p_member uuid, p_blocked boolean, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); prior jsonb; payload jsonb := pg_catalog.jsonb_build_array(p_member,p_blocked);
BEGIN
  IF p_member IS NULL OR p_member = caller OR p_blocked IS NULL THEN RAISE EXCEPTION 'Invalid block' USING ERRCODE = '22023'; END IF;
  prior := public._story_begin('block',p_request_id,payload,p_member,p_member);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE uid = p_member::text) THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE = 'PT404'; END IF;
  IF p_blocked THEN INSERT INTO public.story_blocks VALUES (caller,p_member) ON CONFLICT DO NOTHING;
  ELSE DELETE FROM public.story_blocks WHERE blocker = caller AND blocked = p_member; END IF;
  RETURN public._story_finish('block',p_request_id,payload,pg_catalog.jsonb_build_object('id',p_member,'blocked',p_blocked));
END;
$function$;

CREATE FUNCTION public._story_cursor(p_cursor jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF p_cursor IS NULL THEN RETURN; END IF;
  IF pg_catalog.jsonb_typeof(p_cursor) <> 'object' OR octet_length(p_cursor::text) > 200
    OR NOT (p_cursor ?& ARRAY['at','id']) OR p_cursor - ARRAY['at','id'] <> '{}'::jsonb
    OR pg_catalog.jsonb_typeof(p_cursor->'at') <> 'string' OR pg_catalog.jsonb_typeof(p_cursor->'id') <> 'string'
    OR p_cursor->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' OR NOT pg_catalog.isfinite((p_cursor->>'at')::timestamptz) THEN
    RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023';
  END IF;
  PERFORM (p_cursor->>'id')::uuid;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023';
END;
$function$;
CREATE FUNCTION public._story_page(p_rows jsonb, p_time_key text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('items',coalesce((SELECT pg_catalog.jsonb_agg(value ORDER BY ordinality)
    FROM pg_catalog.jsonb_array_elements(p_rows) WITH ORDINALITY WHERE ordinality <= 50),'[]'::jsonb),
    'next_cursor',CASE WHEN pg_catalog.jsonb_array_length(p_rows) > 50 THEN pg_catalog.jsonb_build_object('at',p_rows->49->p_time_key,'id',p_rows->49->'id') END);
$function$;
CREATE FUNCTION public.story_feed(p_cursor jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); result jsonb;
BEGIN
  PERFORM public._story_cursor(p_cursor); PERFORM public._story_lock(caller,NULL,NULL); PERFORM public._story_budget(caller,NULL,NULL);
  SELECT pg_catalog.jsonb_agg(story.payload || pg_catalog.jsonb_build_object('created_at',story.created_at)
    ORDER BY story.created_at DESC, story.id DESC) INTO result FROM
    (SELECT source.id,source.created_at,checked.payload FROM public.stories_v2 AS source
      CROSS JOIN LATERAL (SELECT public._story_shape(source.id,caller) AS payload OFFSET 0) AS checked
      WHERE source.deleted_at IS NULL AND source.expires_at > pg_catalog.clock_timestamp() AND checked.payload IS NOT NULL
        AND (p_cursor IS NULL OR (source.created_at,source.id) < ((p_cursor->>'at')::timestamptz,(p_cursor->>'id')::uuid))
      ORDER BY source.created_at DESC,source.id DESC LIMIT 51) AS story;
  RETURN public._story_page(result,'created_at');
END;
$function$;
CREATE FUNCTION public.story_viewers(p_id uuid, p_cursor jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); recipient uuid; result jsonb;
BEGIN
  PERFORM public._story_cursor(p_cursor); SELECT owner INTO recipient FROM public.stories_v2 WHERE id = p_id;
  PERFORM public._story_lock(caller,p_id,recipient);
  IF recipient IS DISTINCT FROM caller OR NOT public._story_eligible(p_id,caller) THEN RAISE EXCEPTION 'Story unavailable' USING ERRCODE = 'PT404'; END IF;
  PERFORM public._story_budget(caller,NULL,NULL);
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',interaction.viewer,'qualified_at',interaction.qualified_at,'liked',interaction.liked,
    'name',interaction.name,'username',interaction.username)
    ORDER BY interaction.qualified_at DESC,interaction.viewer DESC) INTO result FROM
    (SELECT source.viewer,source.qualified_at,source.liked,
      pg_catalog.left(coalesce(profile.data->>'name',''),80) AS name,pg_catalog.left(coalesce(profile.data->>'username',''),64) AS username
      FROM public.story_interactions AS source JOIN public.profiles AS profile ON profile.uid = source.viewer::text
      WHERE source.story_id = p_id AND source.qualified_at IS NOT NULL AND coalesce(profile.data->>'privacy','public') = 'public'
        AND NOT EXISTS (SELECT 1 FROM public.story_blocks WHERE
          (blocker = caller AND blocked = source.viewer) OR (blocker = source.viewer AND blocked = caller))
        AND (p_cursor IS NULL OR (source.qualified_at,source.viewer) < ((p_cursor->>'at')::timestamptz,(p_cursor->>'id')::uuid))
      ORDER BY source.qualified_at DESC,source.viewer DESC LIMIT 51) AS interaction;
  RETURN public._story_page(result,'qualified_at');
END;
$function$;
CREATE FUNCTION public.list_story_notifications(p_cursor jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); result jsonb;
BEGIN
  PERFORM public._story_cursor(p_cursor); PERFORM public._story_lock(caller,NULL,NULL); PERFORM public._story_budget(caller,NULL,NULL);
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(notification) || pg_catalog.jsonb_build_object('available',public._story_eligible(notification.story_id,caller))
    ORDER BY notification.created_at DESC,notification.id DESC) INTO result FROM
    (SELECT id,actor,story_id,kind,message_id,created_at,read_at FROM public.story_notifications WHERE recipient = caller
      AND (p_cursor IS NULL OR (created_at,id) < ((p_cursor->>'at')::timestamptz,(p_cursor->>'id')::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51) AS notification;
  RETURN public._story_page(result,'created_at');
END;
$function$;
CREATE FUNCTION public.mark_story_notifications_read(p_ids uuid[], p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); ids uuid[]; payload jsonb; prior jsonb;
BEGIN
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) NOT BETWEEN 1 AND 50 OR pg_catalog.array_position(p_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'One to fifty notification ids required' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT id ORDER BY id) INTO ids FROM pg_catalog.unnest(p_ids) AS requested(id);
  payload := pg_catalog.to_jsonb(ids); prior := public._story_begin('read_notifications',p_request_id,payload,NULL,caller);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF (SELECT count(*) FROM public.story_notifications WHERE recipient = caller AND id = ANY(ids)) <> pg_catalog.cardinality(ids) THEN
    RAISE EXCEPTION 'Notification unavailable' USING ERRCODE = 'PT404';
  END IF;
  UPDATE public.story_notifications SET read_at = coalesce(read_at,pg_catalog.clock_timestamp()) WHERE recipient = caller AND id = ANY(ids);
  RETURN public._story_finish('read_notifications',p_request_id,payload,pg_catalog.jsonb_build_object('ids',ids,'read',true));
END;
$function$;
CREATE FUNCTION public.story_action_receipt(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(false); result jsonb;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request UUID required' USING ERRCODE = '22023'; END IF;
  SELECT response INTO result FROM public.story_action_receipts WHERE actor = caller AND request_id = p_request_id;
  IF result IS NULL THEN RAISE EXCEPTION 'Receipt unavailable' USING ERRCODE = 'PT404'; END IF;
  RETURN result || '{"duplicate":true}'::jsonb;
END;
$function$;
CREATE FUNCTION public.report_story_content(p_id uuid, p_message_id text, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); reported uuid; prior jsonb; report_id uuid;
  payload jsonb := pg_catalog.jsonb_build_array(p_id,p_message_id,p_reason);
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 512 OR length(p_reason) > 512
    OR p_reason ~ '[<>[:cntrl:]]' OR (p_message_id IS NOT NULL AND length(p_message_id) NOT BETWEEN 1 AND 255) THEN
    RAISE EXCEPTION 'Invalid report' USING ERRCODE = '22023';
  END IF;
  IF p_message_id IS NULL THEN SELECT owner INTO reported FROM public.stories_v2 WHERE id = p_id;
  ELSE SELECT message.from_uid::uuid INTO reported FROM public.messages AS message JOIN public.story_message_context AS context ON context.message_id = message.id
    WHERE message.id = p_message_id AND message.to_uid = caller::text AND context.story_id = p_id; END IF;
  prior := public._story_begin('report',p_request_id,payload,p_id,reported);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  IF p_message_id IS NOT NULL THEN
    PERFORM message.id FROM public.messages AS message JOIN public.story_message_context AS context ON context.message_id = message.id
      WHERE message.id = p_message_id AND message.to_uid = caller::text AND message.from_uid = reported::text AND context.story_id = p_id FOR SHARE OF message;
    IF NOT FOUND THEN RAISE EXCEPTION 'Report target unavailable' USING ERRCODE = 'PT404'; END IF;
  END IF;
  IF reported IS NULL OR reported = caller OR (p_message_id IS NULL AND NOT public._story_eligible(p_id,caller)) THEN
    RAISE EXCEPTION 'Report target unavailable' USING ERRCODE = 'PT404';
  END IF;
  INSERT INTO public.story_reports(reporter,story_id,message_id,reported_uid,reason) VALUES (caller,p_id,p_message_id,reported,trim(p_reason)) RETURNING id INTO report_id;
  RETURN public._story_finish('report',p_request_id,payload,pg_catalog.jsonb_build_object('id',report_id,'status','received'));
END;
$function$;
CREATE FUNCTION public.cleanup_story_rate_limits(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid cleanup bound' USING ERRCODE = '22023'; END IF;
  DELETE FROM public.story_rate_limits WHERE (scope,subject) IN (SELECT scope,subject FROM public.story_rate_limits
    WHERE day_start < pg_catalog.clock_timestamp() - interval '2 days' ORDER BY day_start,scope,subject LIMIT p_limit FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS removed = ROW_COUNT; RETURN removed;
END;
$function$;

DO $permissions$
DECLARE table_name text; function_row record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['story_settings','stories_v2','story_content','story_interactions','story_blocks','story_notification_preferences',
    'story_rate_limits','story_action_receipts','story_message_context','story_notifications','story_notification_events','story_reports'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE pg_catalog.format('CREATE POLICY story_deny_raw ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false)', table_name);
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', table_name);
  END LOOP;
  FOR function_row IN SELECT procedure.oid::pg_catalog.regprocedure AS signature FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public' AND procedure.proname IN ('_story_actor','_story_eligible','_story_shape','_story_lock','_story_budget',
      '_story_digest','_story_begin','_story_finish','_story_notify','get_story','publish_story','delete_story','record_story_view',
      'set_story_like','reply_to_story','resolve_story_reply_context','story_reply_references','get_story_notification_preferences','set_story_notification_preferences','set_story_block',
      '_story_cursor','_story_page','story_feed','story_viewers','list_story_notifications','mark_story_notifications_read','story_action_receipt','report_story_content','cleanup_story_rate_limits') LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',function_row.signature);
  END LOOP;
END;
$permissions$;
GRANT SELECT, UPDATE ON public.story_settings TO service_role;
GRANT SELECT ON public.story_reports TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_story_rate_limits(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_story(uuid), public.publish_story(uuid,text,text,text), public.delete_story(uuid,uuid),
  public.record_story_view(uuid,uuid), public.set_story_like(uuid,boolean,uuid), public.reply_to_story(uuid,text,uuid),
  public.resolve_story_reply_context(text), public.story_reply_references(text[]), public.get_story_notification_preferences(),
  public.set_story_notification_preferences(boolean,boolean,boolean,text,integer,uuid), public.set_story_block(uuid,boolean,uuid),
  public.story_feed(jsonb), public.story_viewers(uuid,jsonb), public.list_story_notifications(jsonb), public.mark_story_notifications_read(uuid[],uuid),
  public.story_action_receipt(uuid), public.report_story_content(uuid,text,text,uuid) TO authenticated;

COMMIT;