BEGIN;

DO $predecessor$
BEGIN
  IF pg_catalog.to_regprocedure('public.publish_story(uuid,text,text,text)') IS NULL
    OR pg_catalog.to_regclass('public.story_content') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('storage.objects') AND relrowsecurity) THEN
    RAISE EXCEPTION 'Unmodified story-interactions.sql and RLS-enabled Storage schema are mandatory predecessors';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id IN ('story-media-quarantine-v3','story-media-public-v3')) THEN
    RAISE EXCEPTION 'Candidate bucket already exists; automatic adoption is forbidden';
  END IF;
  IF NOT pg_catalog.has_table_privilege(current_user,'storage.objects','TRIGGER')
    OR NOT pg_catalog.has_table_privilege(current_user,'storage.buckets','TRIGGER')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = 'storage.objects'::regclass
      AND pg_catalog.pg_has_role(current_user,relowner,'USAGE'))
    OR (SELECT count(*) FROM information_schema.columns AS actual JOIN (VALUES ('id','uuid'),('bucket_id','text'),('name','text'),
      ('owner','uuid'),('owner_id','text'),('version','text'),('metadata','jsonb'),('user_metadata','jsonb'),('created_at','timestamptz')) AS expected(name,type)
      ON actual.column_name = expected.name AND actual.udt_name = expected.type WHERE actual.table_schema = 'storage' AND actual.table_name = 'objects') <> 9 THEN
    RAISE EXCEPTION 'Storage DDL ownership, TRIGGER privileges and current user_metadata schema require isolated preflight; do not override ownership';
  END IF;
END;
$predecessor$;

CREATE TABLE public.story_media_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  publication_required boolean NOT NULL DEFAULT false,
  storage_policy_approved boolean NOT NULL DEFAULT false,
  quota_approved boolean NOT NULL DEFAULT false,
  retention_approved boolean NOT NULL DEFAULT false,
  storage_policy_ref uuid, quota_policy_ref uuid, retention_policy_ref uuid,
  policy_epoch integer NOT NULL DEFAULT 1 CHECK (policy_epoch > 0),
  photo_bytes integer NOT NULL DEFAULT 8388608 CHECK (photo_bytes BETWEEN 1 AND 8388608),
  video_bytes integer NOT NULL DEFAULT 26214400 CHECK (video_bytes BETWEEN 1 AND 26214400),
  video_ms integer NOT NULL DEFAULT 30000 CHECK (video_ms BETWEEN 1 AND 30000),
  max_pixels integer NOT NULL DEFAULT 16777216 CHECK (max_pixels BETWEEN 1 AND 16777216),
  pending_per_owner integer NOT NULL DEFAULT 3 CHECK (pending_per_owner BETWEEN 1 AND 3),
  requests_per_day integer NOT NULL DEFAULT 20 CHECK (requests_per_day BETWEEN 1 AND 20),
  bytes_per_day integer NOT NULL DEFAULT 104857600 CHECK (bytes_per_day BETWEEN 1 AND 104857600),
  cleanup_enabled boolean NOT NULL DEFAULT false,
  cleanup_min_age_seconds integer NOT NULL DEFAULT 86400 CHECK (cleanup_min_age_seconds BETWEEN 0 AND 2592000),
  cleanup_epoch integer NOT NULL DEFAULT 1 CHECK (cleanup_epoch > 0),
  CHECK (NOT cleanup_enabled OR (retention_approved AND retention_policy_ref IS NOT NULL AND storage_policy_approved AND storage_policy_ref IS NOT NULL)),
  CHECK (NOT enabled OR (publication_required AND storage_policy_approved AND quota_approved AND retention_approved
    AND storage_policy_ref IS NOT NULL AND quota_policy_ref IS NOT NULL AND retention_policy_ref IS NOT NULL))
);
INSERT INTO public.story_media_settings DEFAULT VALUES;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  VALUES ('story-media-quarantine-v3','story-media-quarantine-v3',false,26214400,ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/webm']),
    ('story-media-public-v3','story-media-public-v3',false,26214400,ARRAY['image/jpeg','image/png','image/webp','video/mp4','video/webm']);

CREATE TABLE public.story_media_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), owner uuid NOT NULL, request_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('photo','video')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm')),
  declared_bytes integer NOT NULL CHECK (declared_bytes BETWEEN 1 AND 26214400),
  bucket text NOT NULL DEFAULT 'story-media-quarantine-v3' CHECK (bucket = 'story-media-quarantine-v3'),
  object_key text NOT NULL UNIQUE, media_url text UNIQUE,
  object_id uuid UNIQUE, object_version text,
  public_bucket text NOT NULL DEFAULT 'story-media-public-v3' CHECK (public_bucket = 'story-media-public-v3'),
  public_key_id uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(), public_key text UNIQUE,
  public_object_id uuid UNIQUE, public_object_version text, public_sha256 text,
  promotion_token uuid, promotion_started_at timestamptz,
  policy_epoch integer NOT NULL, epoch integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','validating','attested','promoting','approved','failed','cancelled','published')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(), expires_at timestamptz NOT NULL,
  renewed_at timestamptz, renewals integer NOT NULL DEFAULT 0 CHECK (renewals BETWEEN 0 AND 3),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'), actual_bytes integer,
  width integer, height integer, duration_ms integer, parser text, failure_code text,
  published_story_id uuid UNIQUE REFERENCES public.stories_v2(id),
  UNIQUE(owner,request_id),
  CHECK (expires_at = coalesce(renewed_at,created_at) + interval '15 minutes'),
  CHECK ((renewals = 0 AND renewed_at IS NULL) OR (renewals > 0 AND renewed_at IS NOT NULL
    AND renewed_at >= created_at AND renewed_at <= created_at + interval '24 hours')),
  CHECK (status NOT IN ('attested','promoting','approved','published') OR (sha256 IS NOT NULL AND actual_bytes IS NOT NULL AND actual_bytes = declared_bytes
    AND width IS NOT NULL AND height IS NOT NULL AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192 AND width::bigint * height <= 16777216
    AND parser IS NOT NULL AND object_id IS NOT NULL AND object_version IS NOT NULL AND public_key IS NOT NULL AND media_url IS NOT NULL
    AND ((kind = 'photo' AND duration_ms IS NULL) OR (kind = 'video' AND duration_ms IS NOT NULL AND duration_ms BETWEEN 1 AND 30000)))),
  CHECK (status NOT IN ('approved','published') OR (public_object_id IS NOT NULL AND public_object_version IS NOT NULL
    AND public_sha256 IS NOT NULL AND public_sha256 = sha256))
);
CREATE INDEX story_media_owner_budget ON public.story_media_reservations(owner,created_at);
CREATE TABLE public.story_media_publish_intents (
  owner uuid PRIMARY KEY, transaction_id bigint NOT NULL, reservation_id uuid NOT NULL REFERENCES public.story_media_reservations(id),
  request_id uuid NOT NULL, sha256 text NOT NULL
);
CREATE TABLE public.story_media_cleanup_plans (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), operation_id uuid NOT NULL UNIQUE,
  reservation_id uuid NOT NULL REFERENCES public.story_media_reservations(id), owner uuid NOT NULL, request_id uuid NOT NULL,
  reservation_epoch integer NOT NULL, cleanup_epoch integer NOT NULL, retention_policy_ref uuid NOT NULL, storage_policy_ref uuid NOT NULL,
  holds jsonb NOT NULL, objects jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(objects) = 'array' AND pg_catalog.jsonb_array_length(objects) BETWEEN 1 AND 2),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'dry_run' CHECK (status IN ('dry_run','claimed','metadata_deleted')),
  approval_ref uuid, lease_token uuid, lease_until timestamptz,
  worker_lease_token uuid, worker_lease_until timestamptz,
  worker_attempts integer NOT NULL DEFAULT 0 CHECK (worker_attempts BETWEEN 0 AND 10),
  deleted_objects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (pg_catalog.jsonb_typeof(deleted_objects) = 'array' AND pg_catalog.jsonb_array_length(deleted_objects) <= 2),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, confirmed_at timestamptz,
  CHECK (expires_at = created_at + interval '5 minutes'),
  CHECK (status = 'dry_run' OR (approval_ref IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX story_media_cleanup_reservation ON public.story_media_cleanup_plans(reservation_id,expires_at);

CREATE TABLE public.story_media_cleanup_intents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), plan_id uuid NOT NULL REFERENCES public.story_media_cleanup_plans(id),
  reservation_id uuid NOT NULL REFERENCES public.story_media_reservations(id), owner uuid NOT NULL,
  object_id uuid NOT NULL, bucket text NOT NULL CHECK (bucket IN ('story-media-quarantine-v3','story-media-public-v3')),
  object_key text NOT NULL CHECK (pg_catalog.length(object_key) BETWEEN 1 AND 256),
  object_version text NOT NULL CHECK (pg_catalog.length(object_version) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','claimed','object_delete_requested','completed','unknown')),
  metadata_deleted_at timestamptz, delete_requested_at timestamptz,
  request_lease_token uuid, authorized_delete_lease_token uuid,
  delete_attempts integer NOT NULL DEFAULT 0 CHECK (delete_attempts BETWEEN 0 AND 3),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','storage_api_deleted','storage_api_absent_backend_unknown','unknown')),
  delete_http_status integer, absence_http_status integer, api_ack jsonb, observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((state = 'completed') = (outcome = 'storage_api_deleted')),
  CHECK (state <> 'completed' OR (metadata_deleted_at IS NOT NULL AND delete_requested_at IS NOT NULL
    AND authorized_delete_lease_token IS NOT NULL AND request_lease_token IS NOT DISTINCT FROM authorized_delete_lease_token
    AND observed_at IS NOT NULL AND delete_http_status IS NOT NULL AND delete_http_status = 200
    AND absence_http_status IS NOT NULL AND absence_http_status = 404 AND api_ack IS NOT NULL)),
  UNIQUE(plan_id,object_id)
);
CREATE INDEX story_media_cleanup_pending ON public.story_media_cleanup_intents(reservation_id,state);

DO $cleanup_recovery_schema$
BEGIN
  ALTER TABLE public.story_media_cleanup_plans
    ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
    ADD COLUMN IF NOT EXISTS cancellation_ref uuid CHECK ((superseded_at IS NULL) = (cancellation_ref IS NULL)
      AND (superseded_at IS NULL OR (status IN ('dry_run','claimed') AND deleted_objects = '[]'::jsonb)));
  ALTER TABLE public.story_media_cleanup_intents
    ADD COLUMN IF NOT EXISTS cancelled_at timestamptz CHECK (cancelled_at IS NULL OR (state IN ('planned','claimed')
      AND outcome = 'pending' AND delete_attempts = 0 AND delete_requested_at IS NULL AND metadata_deleted_at IS NULL
      AND request_lease_token IS NULL AND authorized_delete_lease_token IS NULL AND delete_http_status IS NULL
      AND absence_http_status IS NULL AND api_ack IS NULL AND observed_at IS NULL));
END;
$cleanup_recovery_schema$;

CREATE FUNCTION public._story_media_settings_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  NEW.policy_epoch := OLD.policy_epoch + CASE WHEN ROW(NEW.enabled,NEW.publication_required,NEW.storage_policy_approved,
    NEW.quota_approved,NEW.retention_approved,NEW.storage_policy_ref,NEW.quota_policy_ref,NEW.retention_policy_ref,
    NEW.photo_bytes,NEW.video_bytes,NEW.video_ms,NEW.max_pixels,NEW.pending_per_owner,NEW.requests_per_day,NEW.bytes_per_day)
    IS DISTINCT FROM ROW(OLD.enabled,OLD.publication_required,OLD.storage_policy_approved,
    OLD.quota_approved,OLD.retention_approved,OLD.storage_policy_ref,OLD.quota_policy_ref,OLD.retention_policy_ref,
    OLD.photo_bytes,OLD.video_bytes,OLD.video_ms,OLD.max_pixels,OLD.pending_per_owner,OLD.requests_per_day,OLD.bytes_per_day)
    THEN 1 ELSE 0 END;
  NEW.cleanup_epoch := OLD.cleanup_epoch + CASE WHEN ROW(NEW.cleanup_enabled,NEW.cleanup_min_age_seconds,NEW.retention_approved,
    NEW.retention_policy_ref,NEW.storage_policy_approved,NEW.storage_policy_ref) IS DISTINCT FROM ROW(OLD.cleanup_enabled,
    OLD.cleanup_min_age_seconds,OLD.retention_approved,OLD.retention_policy_ref,OLD.storage_policy_approved,OLD.storage_policy_ref) THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER story_media_settings_epoch BEFORE UPDATE ON public.story_media_settings
  FOR EACH ROW EXECUTE FUNCTION public._story_media_settings_epoch();

CREATE FUNCTION public._story_media_bucket_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.id IN ('story-media-quarantine-v3','story-media-public-v3') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Candidate bucket removal is not authorized' USING ERRCODE = 'PT403'; END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name THEN
      RAISE EXCEPTION 'Candidate bucket identity is immutable' USING ERRCODE = 'PT403';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.id = 'story-media-quarantine-v3' AND NEW.public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Raw Story quarantine must remain private' USING ERRCODE = 'PT403';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER story_media_bucket_guard BEFORE INSERT OR UPDATE OR DELETE ON storage.buckets
  FOR EACH ROW EXECUTE FUNCTION public._story_media_bucket_guard();

CREATE FUNCTION public._story_media_guards_present()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = 'storage.objects'::regclass AND relrowsecurity)
    AND (SELECT count(*) FROM information_schema.columns AS actual JOIN (VALUES ('id','uuid'),('bucket_id','text'),('name','text'),
      ('owner','uuid'),('owner_id','text'),('version','text'),('metadata','jsonb'),('user_metadata','jsonb'),('created_at','timestamptz')) AS expected(name,type)
      ON actual.column_name = expected.name AND actual.udt_name = expected.type WHERE actual.table_schema = 'storage' AND actual.table_name = 'objects') = 9
    AND (SELECT count(*) FROM pg_catalog.pg_trigger AS guard JOIN (VALUES
      ('storage.objects'::regclass,'story_media_storage_guard',pg_catalog.to_regprocedure('public._story_media_storage_guard()'),31),
      ('storage.objects'::regclass,'story_media_storage_bound',pg_catalog.to_regprocedure('public._story_media_storage_bound()'),5),
      ('storage.buckets'::regclass,'story_media_bucket_guard',pg_catalog.to_regprocedure('public._story_media_bucket_guard()'),31),
      ('public.story_content'::regclass,'story_media_publication_gate',pg_catalog.to_regprocedure('public._story_media_publication_gate()'),23)
    ) AS expected(relation,name,routine,type) ON guard.tgrelid = expected.relation AND guard.tgname = expected.name
      AND guard.tgfoid = expected.routine AND guard.tgtype = expected.type AND guard.tgenabled IN ('O','A') AND guard.tgqual IS NULL) = 4;
$function$;

CREATE FUNCTION public._story_media_ready()
RETURNS public.story_media_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings%ROWTYPE;
BEGIN
  SELECT * INTO settings FROM public.story_media_settings WHERE singleton FOR SHARE;
  IF NOT FOUND OR NOT settings.enabled OR NOT settings.publication_required
    OR NOT EXISTS (SELECT 1 FROM public.story_settings WHERE singleton AND enabled AND public_bucket = 'story-media-public-v3'
      AND media_origin IS NOT NULL AND permission_policy_approved AND media_audience_approved AND public_media_approved
      AND retention_approved AND operator_policy_ref IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'story-media-public-v3' AND public AND file_size_limit BETWEEN 1 AND 26214400)
    OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'story-media-quarantine-v3' AND NOT public AND file_size_limit BETWEEN 1 AND 26214400)
    OR public._story_media_guards_present() IS NOT TRUE THEN
    RAISE EXCEPTION 'Story media unavailable pending isolated Storage and policy approval' USING ERRCODE = 'PT503';
  END IF;
  RETURN settings;
END;
$function$;
CREATE FUNCTION public._story_media_receipt(p_row public.story_media_reservations)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('schema_version',2,'reservation_id',p_row.id,'request_id',p_row.request_id,
    'owner',p_row.owner,'bucket',p_row.bucket,'object_key',p_row.object_key,'media_url',p_row.media_url,
    'public_bucket',p_row.public_bucket,'public_key_id',p_row.public_key_id,'public_key',p_row.public_key,
    'public_object_id',p_row.public_object_id,'public_object_version',p_row.public_object_version,
    'kind',p_row.kind,'content_type',p_row.content_type,'declared_bytes',p_row.declared_bytes,
    'expires_at',p_row.expires_at,'status',p_row.status,'sha256',p_row.sha256,'actual_bytes',p_row.actual_bytes,
    'width',p_row.width,'height',p_row.height,'duration_ms',p_row.duration_ms,
    'duration_verified',p_row.kind = 'video' AND p_row.duration_ms IS NOT NULL,'policy_epoch',p_row.policy_epoch,
    'failure_code',p_row.failure_code,'renewals',p_row.renewals,
    'uploaded',p_row.object_id IS NOT NULL);
$function$;

CREATE FUNCTION public.reserve_story_media(p_request_id uuid,p_kind text,p_content_type text,p_declared_bytes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); settings public.story_media_settings := public._story_media_ready();
  reservation public.story_media_reservations%ROWTYPE; payload_hash text; extension text; stamp timestamptz := pg_catalog.clock_timestamp();
  request_count bigint; byte_count bigint; pending_count bigint;
BEGIN
  IF p_request_id IS NULL OR p_kind IS NULL OR p_content_type IS NULL OR p_declared_bytes IS NULL
    OR NOT ((p_kind = 'photo' AND p_content_type IN ('image/jpeg','image/png','image/webp') AND p_declared_bytes BETWEEN 1 AND 8388608)
      OR (p_kind = 'video' AND p_content_type IN ('video/mp4','video/webm') AND p_declared_bytes BETWEEN 1 AND 26214400)) THEN
    RAISE EXCEPTION 'Unsupported Story media declaration' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('story-media:' || caller::text,0));
  payload_hash := public._story_digest('reserve_media',pg_catalog.jsonb_build_array(p_kind,p_content_type,p_declared_bytes));
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = caller AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF reservation.payload_digest <> payload_hash THEN RAISE EXCEPTION 'Media request conflict' USING ERRCODE = 'PT409'; END IF;
    IF reservation.status = 'cancelled' AND reservation.failure_code IN ('policy_changed','reservation_expired','promotion_review_required') THEN
      RETURN public._story_media_receipt(reservation);
    END IF;
    IF reservation.status IN ('cancelled','failed') THEN
      RAISE EXCEPTION 'Media reservation unavailable; choose a new draft' USING ERRCODE = 'PT409';
    END IF;
    IF reservation.status <> 'published' AND (reservation.expires_at <= stamp OR reservation.policy_epoch <> settings.policy_epoch) THEN
      IF reservation.status IN ('reserved','validating','attested') AND reservation.promotion_started_at IS NULL
        AND reservation.public_object_id IS NULL AND reservation.renewals < 3 AND reservation.attempts < 3
        AND stamp <= reservation.created_at + interval '24 hours'
        AND reservation.declared_bytes <= (CASE reservation.kind WHEN 'photo' THEN settings.photo_bytes ELSE settings.video_bytes END)
        AND (SELECT count(*) FROM public.story_media_reservations AS other WHERE other.owner = caller AND other.id <> reservation.id
          AND other.status IN ('reserved','validating','attested','promoting','approved') AND other.expires_at > stamp) < settings.pending_per_owner
        AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = reservation.public_bucket AND name = reservation.public_key)
        AND (reservation.object_id IS NULL OR EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.object_id
          AND bucket_id = reservation.bucket AND name = reservation.object_key AND owner_id = caller::text AND version = reservation.object_version)) THEN
        UPDATE public.story_media_reservations SET status = 'reserved',policy_epoch = settings.policy_epoch,epoch = epoch + 1,
          lease_token = NULL,lease_until = NULL,sha256 = NULL,actual_bytes = NULL,width = NULL,height = NULL,duration_ms = NULL,
          parser = NULL,public_key = NULL,media_url = NULL,failure_code = NULL,renewals = renewals + 1,renewed_at = stamp,expires_at = stamp + interval '15 minutes'
          WHERE id = reservation.id RETURNING * INTO reservation;
      ELSE
        UPDATE public.story_media_reservations SET status = 'cancelled',epoch = epoch + 1,lease_token = NULL,lease_until = NULL,
          failure_code = CASE WHEN promotion_started_at IS NOT NULL OR public_object_id IS NOT NULL THEN 'promotion_review_required'
            WHEN policy_epoch <> settings.policy_epoch THEN 'policy_changed' ELSE 'reservation_expired' END
          WHERE id = reservation.id RETURNING * INTO reservation;
      END IF;
    END IF;
    RETURN public._story_media_receipt(reservation);
  END IF;
  IF p_declared_bytes > (CASE p_kind WHEN 'photo' THEN settings.photo_bytes ELSE settings.video_bytes END) THEN
    RAISE EXCEPTION 'Unsupported Story media declaration under the current policy' USING ERRCODE = '22023';
  END IF;
  SELECT count(*),coalesce(sum(declared_bytes),0) INTO request_count,byte_count FROM public.story_media_reservations
    WHERE owner = caller AND created_at >= pg_catalog.date_trunc('day',stamp,'UTC');
  SELECT count(*) INTO pending_count FROM public.story_media_reservations WHERE owner = caller
    AND status IN ('reserved','validating','attested','promoting','approved') AND expires_at > stamp;
  IF request_count >= settings.requests_per_day OR byte_count + p_declared_bytes > settings.bytes_per_day
    OR pending_count >= settings.pending_per_owner THEN RAISE EXCEPTION 'Story media technical limit reached' USING ERRCODE = 'PT429'; END IF;
  extension := CASE p_content_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp'
    WHEN 'video/mp4' THEN 'mp4' WHEN 'video/webm' THEN 'webm' END;
  reservation.id := pg_catalog.gen_random_uuid();
  reservation.object_key := 'stories/' || caller::text || '/' || reservation.id::text || '.' || extension;
  INSERT INTO public.story_media_reservations(id,owner,request_id,payload_digest,kind,content_type,declared_bytes,
    object_key,policy_epoch,created_at,expires_at)
    VALUES(reservation.id,caller,p_request_id,payload_hash,p_kind,p_content_type,p_declared_bytes,reservation.object_key,
      settings.policy_epoch,stamp,stamp+interval '15 minutes')
    RETURNING * INTO reservation;
  RETURN public._story_media_receipt(reservation);
END;
$function$;

CREATE FUNCTION public._story_media_storage_insert(p_bucket text,p_name text,p_owner text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT coalesce(p_bucket = 'story-media-quarantine-v3' AND p_owner = auth.uid()::text AND EXISTS (
    SELECT 1 FROM public.story_media_reservations AS reservation JOIN public.story_media_settings AS settings ON settings.singleton
    WHERE reservation.owner = auth.uid() AND reservation.bucket = p_bucket AND reservation.object_key = p_name
      AND reservation.status = 'reserved' AND reservation.object_id IS NULL AND reservation.expires_at > pg_catalog.clock_timestamp()
      AND reservation.policy_epoch = settings.policy_epoch AND settings.enabled AND settings.publication_required),false);
$function$;
CREATE FUNCTION public._story_media_storage_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE reservation public.story_media_reservations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.bucket_id IN ('story-media-quarantine-v3','story-media-public-v3')
      OR (TG_OP = 'UPDATE' AND NEW.bucket_id IN ('story-media-quarantine-v3','story-media-public-v3')) THEN
      IF TG_OP = 'DELETE' AND public._story_media_cleanup_delete(OLD) IS TRUE THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'Candidate Story objects are immutable outside approved cleanup' USING ERRCODE = 'PT403';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.bucket_id NOT IN ('story-media-quarantine-v3','story-media-public-v3') THEN RETURN NEW; END IF;
  PERFORM public._story_media_ready();
  IF NEW.bucket_id = 'story-media-public-v3' THEN
    SELECT * INTO reservation FROM public.story_media_reservations WHERE public_bucket = NEW.bucket_id AND public_key = NEW.name FOR UPDATE;
    IF NOT FOUND OR pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role'
      OR reservation.status <> 'promoting' OR reservation.public_object_id IS NOT NULL
      OR reservation.lease_until <= pg_catalog.clock_timestamp() OR reservation.expires_at <= pg_catalog.clock_timestamp()
      OR reservation.policy_epoch <> (SELECT policy_epoch FROM public.story_media_settings WHERE singleton)
      OR reservation.promotion_token IS NULL OR reservation.sha256 IS NULL
      OR NEW.user_metadata IS DISTINCT FROM pg_catalog.jsonb_build_object('reservation_id',reservation.id,'owner',reservation.owner,
        'sha256',reservation.sha256,'epoch',reservation.epoch,'lease_token',reservation.lease_token,'promotion_token',reservation.promotion_token)
      OR (NEW.owner IS NOT NULL AND NEW.owner <> reservation.owner)
      OR (NEW.owner_id IS NOT NULL AND NEW.owner_id <> reservation.owner::text)
      OR NEW.id IS NULL OR NEW.version IS NULL OR pg_catalog.length(NEW.version) NOT BETWEEN 1 AND 128
      OR coalesce(NEW.metadata->>'mimetype','') <> reservation.content_type
      OR coalesce(NEW.metadata->>'size','') <> reservation.actual_bytes::text
      OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.object_id AND bucket_id = reservation.bucket
        AND name = reservation.object_key AND owner_id = reservation.owner::text AND version = reservation.object_version) THEN
      RAISE EXCEPTION 'Exact service-leased attested public promotion required' USING ERRCODE = 'PT403';
    END IF;
    NEW.owner := reservation.owner; NEW.owner_id := reservation.owner::text;
    RETURN NEW;
  END IF;
  SELECT * INTO reservation FROM public.story_media_reservations WHERE bucket = NEW.bucket_id AND object_key = NEW.name FOR UPDATE;
  IF NOT FOUND OR public._story_media_storage_insert(NEW.bucket_id,NEW.name,NEW.owner_id) IS NOT TRUE
    OR (NEW.owner IS NOT NULL AND NEW.owner <> reservation.owner) OR NEW.id IS NULL
    OR NEW.version IS NULL OR pg_catalog.length(NEW.version) NOT BETWEEN 1 AND 128
    OR coalesce(NEW.metadata->>'mimetype','') <> reservation.content_type
    OR coalesce(NEW.metadata->>'size','') <> reservation.declared_bytes::text THEN
    RAISE EXCEPTION 'Exact owned Story reservation required' USING ERRCODE = 'PT403';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE FUNCTION public._story_media_storage_bound()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NEW.bucket_id = 'story-media-quarantine-v3' THEN
    UPDATE public.story_media_reservations SET object_id = NEW.id,object_version = NEW.version
      WHERE bucket = NEW.bucket_id AND object_key = NEW.name AND object_id IS NULL;
  ELSIF NEW.bucket_id = 'story-media-public-v3' THEN
    UPDATE public.story_media_reservations SET public_object_id = NEW.id,public_object_version = NEW.version,public_sha256 = NEW.user_metadata->>'sha256'
      WHERE public_bucket = NEW.bucket_id AND public_key = NEW.name AND public_object_id IS NULL AND status = 'promoting';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER story_media_storage_guard BEFORE INSERT OR UPDATE OR DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public._story_media_storage_guard();
CREATE TRIGGER story_media_storage_bound AFTER INSERT ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public._story_media_storage_bound();
CREATE POLICY story_media_insert_boundary ON storage.objects AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (bucket_id NOT IN ('story-media-quarantine-v3','story-media-public-v3') OR public._story_media_storage_insert(bucket_id,name,owner_id));
CREATE POLICY story_media_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (public._story_media_storage_insert(bucket_id,name,owner_id));
CREATE POLICY story_media_read_boundary ON storage.objects AS RESTRICTIVE FOR SELECT TO PUBLIC
  USING (bucket_id NOT IN ('story-media-quarantine-v3','story-media-public-v3') OR owner_id = auth.uid()::text);
CREATE POLICY story_media_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('story-media-quarantine-v3','story-media-public-v3') AND owner_id = auth.uid()::text);
CREATE POLICY story_media_update_boundary ON storage.objects AS RESTRICTIVE FOR UPDATE TO PUBLIC
  USING (bucket_id NOT IN ('story-media-quarantine-v3','story-media-public-v3')) WITH CHECK (bucket_id NOT IN ('story-media-quarantine-v3','story-media-public-v3'));
CREATE POLICY story_media_delete_boundary ON storage.objects AS RESTRICTIVE FOR DELETE TO PUBLIC
  USING (bucket_id NOT IN ('story-media-quarantine-v3','story-media-public-v3'));

CREATE FUNCTION public.cancel_story_media(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(false); reservation public.story_media_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = caller AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR reservation.status = 'published' THEN RAISE EXCEPTION 'Media reservation unavailable' USING ERRCODE = 'PT404'; END IF;
  UPDATE public.story_media_reservations SET status = 'cancelled',epoch = epoch + 1,lease_token = NULL,lease_until = NULL,failure_code = 'user_cancelled'
    WHERE id = reservation.id RETURNING * INTO reservation;
  RETURN public._story_media_receipt(reservation);
END;
$function$;
CREATE FUNCTION public.claim_story_media_validation(p_owner uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings := public._story_media_ready(); reservation public.story_media_reservations%ROWTYPE;
  stamp timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = p_owner AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Media reservation unavailable' USING ERRCODE = 'PT404'; END IF;
  IF reservation.status = 'published' THEN RETURN public._story_media_receipt(reservation); END IF;
  IF reservation.expires_at <= stamp OR reservation.policy_epoch <> settings.policy_epoch OR reservation.status IN ('cancelled','failed') THEN
    RAISE EXCEPTION 'Media reservation unavailable' USING ERRCODE = 'PT409';
  END IF;
  IF reservation.status = 'approved' THEN RETURN public._story_media_receipt(reservation); END IF;
  IF reservation.object_id IS NULL OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.object_id
    AND bucket_id = reservation.bucket AND name = reservation.object_key AND owner_id = reservation.owner::text
    AND version IS NOT DISTINCT FROM reservation.object_version) THEN
    RAISE EXCEPTION 'Story upload not confirmed' USING ERRCODE = 'PT409';
  END IF;
  IF reservation.attempts >= 3 OR reservation.lease_until > stamp THEN
    RAISE EXCEPTION 'Validation already pending or technical retry limit reached' USING ERRCODE = 'PT429';
  END IF;
  UPDATE public.story_media_reservations SET status = CASE WHEN status IN ('attested','promoting') THEN status ELSE 'validating' END,
    attempts = attempts + 1,epoch = epoch + 1,
    lease_token = pg_catalog.gen_random_uuid(),lease_until = least(expires_at,stamp + interval '30 seconds')
    WHERE id = reservation.id RETURNING * INTO reservation;
  RETURN public._story_media_receipt(reservation) || pg_catalog.jsonb_build_object('epoch',reservation.epoch,
    'lease_token',reservation.lease_token,'object_id',reservation.object_id,'object_version',reservation.object_version,
    'limits',pg_catalog.jsonb_build_object('photo_bytes',settings.photo_bytes,'video_bytes',settings.video_bytes,
      'video_ms',settings.video_ms,'max_pixels',settings.max_pixels));
END;
$function$;

CREATE FUNCTION public.attest_story_media(p_owner uuid,p_request_id uuid,p_epoch integer,p_lease_token uuid,
  p_sha256 text,p_actual_bytes integer,p_content_type text,p_width integer,p_height integer,p_duration_ms integer,p_failure_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings := public._story_media_ready(); reservation public.story_media_reservations%ROWTYPE; promoted_key text; origin text;
BEGIN
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = p_owner AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR reservation.status <> 'validating' OR reservation.epoch IS DISTINCT FROM p_epoch
    OR reservation.lease_token IS DISTINCT FROM p_lease_token OR reservation.lease_until <= pg_catalog.clock_timestamp()
    OR reservation.expires_at <= pg_catalog.clock_timestamp() OR reservation.policy_epoch <> settings.policy_epoch
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.object_id AND bucket_id = reservation.bucket
      AND name = reservation.object_key AND owner_id = reservation.owner::text AND version IS NOT DISTINCT FROM reservation.object_version) THEN
    RAISE EXCEPTION 'Stale Story validation' USING ERRCODE = 'PT409';
  END IF;
  IF p_failure_code IS NOT NULL AND p_failure_code NOT IN ('invalid_media','size_mismatch','validation_timeout','storage_unavailable') THEN
    RAISE EXCEPTION 'Invalid failure code' USING ERRCODE = '22023';
  END IF;
  IF p_failure_code IS NULL AND (p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
    OR p_actual_bytes IS DISTINCT FROM reservation.declared_bytes OR p_content_type IS DISTINCT FROM reservation.content_type
    OR p_width IS NULL OR p_height IS NULL OR p_width NOT BETWEEN 1 AND 8192 OR p_height NOT BETWEEN 1 AND 8192
    OR p_width::bigint * p_height > settings.max_pixels
    OR (reservation.kind = 'photo' AND (p_actual_bytes > settings.photo_bytes OR p_duration_ms IS NOT NULL))
    OR (reservation.kind = 'video' AND (p_actual_bytes > settings.video_bytes OR p_duration_ms IS NULL OR p_duration_ms NOT BETWEEN 1 AND settings.video_ms))) THEN
    RAISE EXCEPTION 'Invalid binary attestation' USING ERRCODE = '22023';
  END IF;
  IF p_failure_code IS NULL THEN
    promoted_key := 'stories/' || reservation.owner::text || '/' || reservation.public_key_id::text || '_' || p_sha256 || '.' ||
      CASE reservation.content_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp'
        WHEN 'video/mp4' THEN 'mp4' WHEN 'video/webm' THEN 'webm' END;
    SELECT media_origin INTO origin FROM public.story_settings WHERE singleton;
  END IF;
  UPDATE public.story_media_reservations SET status = CASE WHEN p_failure_code IS NULL THEN 'attested'
      WHEN p_failure_code IN ('invalid_media','size_mismatch') THEN 'failed' ELSE 'reserved' END,
    sha256 = CASE WHEN p_failure_code IS NULL THEN p_sha256 END,actual_bytes = CASE WHEN p_failure_code IS NULL THEN p_actual_bytes END,
    width = CASE WHEN p_failure_code IS NULL THEN p_width END,height = CASE WHEN p_failure_code IS NULL THEN p_height END,
    duration_ms = CASE WHEN p_failure_code IS NULL THEN p_duration_ms END,parser = 'file-type@22.0.2+mediainfo.js@0.3.7',
    public_key = promoted_key,media_url = origin || '/storage/v1/object/public/story-media-public-v3/' || promoted_key,
    failure_code = p_failure_code,lease_token = CASE WHEN p_failure_code IS NULL THEN lease_token END,
    lease_until = CASE WHEN p_failure_code IS NULL THEN lease_until END WHERE id = reservation.id RETURNING * INTO reservation;
  RETURN public._story_media_receipt(reservation);
END;
$function$;

CREATE FUNCTION public.claim_story_media_promotion(p_owner uuid,p_request_id uuid,p_epoch integer,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings := public._story_media_ready(); reservation public.story_media_reservations%ROWTYPE; may_write boolean := false;
BEGIN
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = p_owner AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR reservation.status NOT IN ('attested','promoting') OR reservation.epoch IS DISTINCT FROM p_epoch
    OR reservation.lease_token IS DISTINCT FROM p_lease_token OR reservation.lease_until <= pg_catalog.clock_timestamp()
    OR reservation.expires_at <= pg_catalog.clock_timestamp() OR reservation.policy_epoch <> settings.policy_epoch
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.object_id AND bucket_id = reservation.bucket
      AND name = reservation.object_key AND owner_id = reservation.owner::text AND version = reservation.object_version) THEN
    RAISE EXCEPTION 'Stale Story promotion' USING ERRCODE = 'PT409';
  END IF;
  IF reservation.status = 'attested' THEN
    UPDATE public.story_media_reservations SET status = 'promoting',promotion_token = pg_catalog.gen_random_uuid(),promotion_started_at = pg_catalog.clock_timestamp()
      WHERE id = reservation.id AND promotion_started_at IS NULL RETURNING * INTO reservation;
    IF NOT FOUND THEN RAISE EXCEPTION 'Promotion outcome unknown; no repeat PUT permitted' USING ERRCODE = 'PT409'; END IF;
    may_write := true;
  END IF;
  RETURN public._story_media_receipt(reservation) || pg_catalog.jsonb_build_object('epoch',reservation.epoch,'lease_token',reservation.lease_token,
    'promotion_token',reservation.promotion_token,'write_allowed',may_write);
END;
$function$;

CREATE FUNCTION public.finalize_story_media(p_owner uuid,p_request_id uuid,p_epoch integer,p_lease_token uuid,
  p_sha256 text,p_public_object_id uuid,p_public_object_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings := public._story_media_ready(); reservation public.story_media_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = p_owner AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR p_sha256 IS NULL OR reservation.sha256 IS DISTINCT FROM p_sha256
    OR p_public_object_id IS NULL OR reservation.public_object_id IS DISTINCT FROM p_public_object_id
    OR p_public_object_version IS NULL OR reservation.public_object_version IS DISTINCT FROM p_public_object_version
    OR reservation.public_sha256 IS DISTINCT FROM p_sha256
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.public_object_id AND bucket_id = reservation.public_bucket
      AND name = reservation.public_key AND owner_id = reservation.owner::text AND version = reservation.public_object_version
      AND user_metadata->>'sha256' = reservation.sha256) THEN
    RAISE EXCEPTION 'Exact stored public object, version and validated hash required' USING ERRCODE = 'PT409';
  END IF;
  IF reservation.status IN ('approved','published') THEN RETURN public._story_media_receipt(reservation); END IF;
  IF reservation.status <> 'promoting' OR reservation.epoch IS DISTINCT FROM p_epoch OR reservation.lease_token IS DISTINCT FROM p_lease_token
    OR reservation.lease_until <= pg_catalog.clock_timestamp() OR reservation.expires_at <= pg_catalog.clock_timestamp()
    OR reservation.policy_epoch <> settings.policy_epoch THEN RAISE EXCEPTION 'Stale Story finalization' USING ERRCODE = 'PT409'; END IF;
  UPDATE public.story_media_reservations SET status = 'approved',lease_token = NULL,lease_until = NULL WHERE id = reservation.id RETURNING * INTO reservation;
  RETURN public._story_media_receipt(reservation);
END;
$function$;

CREATE FUNCTION public._story_media_publication_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE reservation public.story_media_reservations%ROWTYPE; story public.stories_v2%ROWTYPE;
  intent public.story_media_publish_intents%ROWTYPE; settings public.story_media_settings%ROWTYPE;
BEGIN
  SELECT * INTO settings FROM public.story_media_settings WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Media settings missing' USING ERRCODE = 'PT503'; END IF;
  IF NOT settings.publication_required AND NOT EXISTS (SELECT 1 FROM public.story_media_reservations
    WHERE media_url = NEW.media_url OR (TG_OP = 'UPDATE' AND media_url = OLD.media_url)) THEN RETURN NEW; END IF;
  settings := public._story_media_ready();
  SELECT * INTO story FROM public.stories_v2 WHERE id = NEW.story_id;
  SELECT * INTO intent FROM public.story_media_publish_intents WHERE owner = auth.uid() AND transaction_id = pg_catalog.txid_current();
  IF NOT FOUND OR TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Validated Story publication required' USING ERRCODE = 'PT403'; END IF;
  SELECT * INTO reservation FROM public.story_media_reservations WHERE id = intent.reservation_id FOR UPDATE;
  IF NOT FOUND OR reservation.owner IS DISTINCT FROM auth.uid() OR story.owner IS DISTINCT FROM reservation.owner
    OR story.kind IS DISTINCT FROM reservation.kind OR reservation.request_id IS DISTINCT FROM intent.request_id
    OR NEW.media_url IS DISTINCT FROM reservation.media_url OR intent.sha256 IS DISTINCT FROM reservation.sha256
    OR reservation.status <> 'approved' OR reservation.policy_epoch <> settings.policy_epoch
    OR reservation.expires_at <= pg_catalog.clock_timestamp() OR reservation.actual_bytes IS DISTINCT FROM reservation.declared_bytes
    OR (reservation.kind = 'video' AND reservation.duration_ms IS NULL)
    OR reservation.public_sha256 IS DISTINCT FROM reservation.sha256
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE id = reservation.public_object_id AND bucket_id = reservation.public_bucket
      AND name = reservation.public_key AND owner_id = reservation.owner::text AND version = reservation.public_object_version
      AND user_metadata->>'sha256' = reservation.sha256) THEN
    RAISE EXCEPTION 'Exact immutable binary attestation required' USING ERRCODE = 'PT403';
  END IF;
  UPDATE public.story_media_reservations SET status = 'published',published_story_id = NEW.story_id WHERE id = reservation.id;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER story_media_publication_gate BEFORE INSERT OR UPDATE ON public.story_content
  FOR EACH ROW EXECUTE FUNCTION public._story_media_publication_gate();

CREATE FUNCTION public.publish_validated_story(p_request_id uuid,p_reservation_id uuid,p_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); settings public.story_media_settings := public._story_media_ready();
  reservation public.story_media_reservations%ROWTYPE; result jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('story-media:' || caller::text,0));
  SELECT * INTO reservation FROM public.story_media_reservations WHERE owner = caller AND id = p_reservation_id FOR UPDATE;
  IF NOT FOUND OR reservation.request_id IS DISTINCT FROM p_request_id OR reservation.sha256 IS DISTINCT FROM p_sha256
    OR p_sha256 IS NULL OR reservation.status NOT IN ('approved','published') THEN
    RAISE EXCEPTION 'Matching media receipt required' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO public.story_media_publish_intents VALUES(caller,pg_catalog.txid_current(),reservation.id,p_request_id,p_sha256);
  result := public.publish_story(p_request_id,reservation.media_url,reservation.kind,'authenticated');
  IF result->>'id' IS DISTINCT FROM (SELECT published_story_id::text FROM public.story_media_reservations WHERE id = reservation.id) THEN
    RAISE EXCEPTION 'Story request was used outside this media reservation' USING ERRCODE = 'PT409';
  END IF;
  DELETE FROM public.story_media_publish_intents WHERE owner = caller;
  RETURN result;
END;
$function$;

CREATE FUNCTION public._story_media_cleanup_holds(p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s' AS $function$
DECLARE holds jsonb;
BEGIN
  IF pg_catalog.to_regprocedure('public.account_rights_hold_state(uuid)') IS NULL
    OR pg_catalog.to_regclass('public.account_rights_holds') IS NULL OR pg_catalog.to_regclass('public.account_rights_requests') IS NULL
    OR pg_catalog.to_regclass('public.account_rights_actions') IS NULL OR pg_catalog.to_regclass('public.report_cases') IS NULL
    OR pg_catalog.to_regclass('public.report_evidence_holds') IS NULL THEN
    RAISE EXCEPTION 'Unknown rights or report hold mapping blocks cleanup' USING ERRCODE = 'PT409';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || p_owner::text,0));
  LOCK TABLE public.account_rights_holds,public.account_rights_requests,public.account_rights_actions,
    public.report_cases,public.report_evidence_holds IN SHARE MODE;
  EXECUTE 'SELECT public.account_rights_hold_state($1)' INTO holds USING p_owner;
  IF holds->>'hold_status' IS DISTINCT FROM 'clear' THEN
    RAISE EXCEPTION 'Active or unknown evidence holds block cleanup' USING ERRCODE = 'PT409';
  END IF;
  RETURN holds;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  RAISE EXCEPTION 'Unknown rights or report hold mapping blocks cleanup' USING ERRCODE = 'PT409';
END;
$function$;
CREATE FUNCTION public._story_media_cleanup_eligible(p_row public.story_media_reservations)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT coalesce((p_row.lease_until IS NULL OR p_row.lease_until <= pg_catalog.clock_timestamp())
    AND (p_row.status IN ('failed','cancelled') OR p_row.expires_at <= pg_catalog.clock_timestamp()
      OR (p_row.status = 'published' AND EXISTS (SELECT 1 FROM public.stories_v2 WHERE id = p_row.published_story_id AND deleted_at IS NOT NULL)))
    AND (p_row.published_story_id IS NULL OR EXISTS (SELECT 1 FROM public.stories_v2 WHERE id = p_row.published_story_id
      AND owner = p_row.owner AND (deleted_at IS NOT NULL OR expires_at <= pg_catalog.clock_timestamp())))
    AND NOT EXISTS (SELECT 1 FROM public.story_content AS content JOIN public.stories_v2 AS story ON story.id = content.story_id
      WHERE content.media_url = p_row.media_url AND (story.owner <> p_row.owner
        OR (story.deleted_at IS NULL AND story.expires_at > pg_catalog.clock_timestamp()))),false);
$function$;
CREATE OR REPLACE FUNCTION public._story_media_cleanup_receipt(p_plan public.story_media_cleanup_plans)
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('plan_id',p_plan.id,'operation_id',p_plan.operation_id,'reservation_id',p_plan.reservation_id,'request_id',p_plan.request_id,
    'reservation_epoch',p_plan.reservation_epoch,'retention_policy_ref',p_plan.retention_policy_ref,'objects',p_plan.objects,
    'snapshot_sha256',p_plan.snapshot_sha256,'status',p_plan.status,'dry_run',p_plan.status = 'dry_run' AND p_plan.superseded_at IS NULL,'approval_ref',p_plan.approval_ref,
    'lease_token',p_plan.lease_token,'lease_until',p_plan.lease_until,'expires_at',p_plan.expires_at,'deleted_objects',p_plan.deleted_objects,
    'superseded_at',p_plan.superseded_at,'cancellation_ref',p_plan.cancellation_ref,
    'storage_delete_authorized',p_plan.superseded_at IS NULL AND p_plan.status = 'claimed' AND p_plan.lease_until > pg_catalog.clock_timestamp(),
    'physical_delete_confirmed',false,'account_deleted',false);
$function$;
CREATE OR REPLACE FUNCTION public._story_media_cleanup_policy_check(p_plan public.story_media_cleanup_plans)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings%ROWTYPE; reservation public.story_media_reservations%ROWTYPE;
BEGIN
  IF p_plan.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cleanup plan was superseded; fresh dry run and independent approval required' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO settings FROM public.story_media_settings WHERE singleton FOR SHARE;
  IF NOT FOUND OR NOT settings.cleanup_enabled OR NOT settings.retention_approved
    OR settings.retention_policy_ref IS DISTINCT FROM p_plan.retention_policy_ref OR settings.cleanup_epoch <> p_plan.cleanup_epoch
    OR NOT settings.storage_policy_approved OR settings.storage_policy_ref IS DISTINCT FROM p_plan.storage_policy_ref
    OR public._story_media_guards_present() IS NOT TRUE THEN
    RAISE EXCEPTION 'Cleanup policy or lease unavailable' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO reservation FROM public.story_media_reservations WHERE id = p_plan.reservation_id FOR UPDATE;
  IF NOT FOUND OR reservation.owner IS DISTINCT FROM p_plan.owner OR reservation.request_id IS DISTINCT FROM p_plan.request_id
    OR reservation.epoch <> p_plan.reservation_epoch OR public._story_media_cleanup_eligible(reservation) IS NOT TRUE THEN
    RAISE EXCEPTION 'Cleanup request changed or active Story needs a tombstone first' USING ERRCODE = 'PT409';
  END IF;
  IF public._story_media_cleanup_holds(reservation.owner) IS DISTINCT FROM p_plan.holds THEN
    RAISE EXCEPTION 'Evidence hold state changed; a new dry run is required' USING ERRCODE = 'PT409';
  END IF;
END;
$function$;
CREATE FUNCTION public._story_media_cleanup_check(p_plan public.story_media_cleanup_plans)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  PERFORM public._story_media_cleanup_policy_check(p_plan);
  IF p_plan.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Cleanup dry run expired; no new approval or implicit extension' USING ERRCODE = 'PT409';
  END IF;
END;
$function$;

CREATE FUNCTION public._story_media_cleanup_object_check(p_plan public.story_media_cleanup_plans,p_intent public.story_media_cleanup_intents)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE reservation public.story_media_reservations%ROWTYPE; object_count integer; exact_count integer;
BEGIN
  SELECT * INTO reservation FROM public.story_media_reservations WHERE id = p_plan.reservation_id;
  IF NOT FOUND OR p_intent.plan_id IS DISTINCT FROM p_plan.id OR p_intent.reservation_id IS DISTINCT FROM reservation.id
    OR p_intent.owner IS DISTINCT FROM p_plan.owner
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_plan.objects) AS target WHERE target->>'object_id' = p_intent.object_id::text
      AND target->>'bucket' = p_intent.bucket AND target->>'object_key' = p_intent.object_key AND target->>'object_version' = p_intent.object_version)
    OR ((p_intent.object_id = reservation.object_id AND p_intent.bucket = reservation.bucket AND p_intent.object_key = reservation.object_key
      AND p_intent.object_version = reservation.object_version) OR (p_intent.object_id = reservation.public_object_id
      AND p_intent.bucket = reservation.public_bucket AND p_intent.object_key = reservation.public_key
      AND p_intent.object_version = reservation.public_object_version AND reservation.public_sha256 = reservation.sha256)) IS NOT TRUE THEN
    RAISE EXCEPTION 'Cleanup object binding changed' USING ERRCODE = 'PT409';
  END IF;
  SELECT count(*),count(*) FILTER (WHERE stored.id = p_intent.object_id AND stored.bucket_id = p_intent.bucket
    AND stored.name = p_intent.object_key AND stored.version = p_intent.object_version AND stored.owner_id = p_plan.owner::text
    AND (stored.owner IS NULL OR stored.owner = p_plan.owner)
    AND (stored.bucket_id <> reservation.public_bucket OR stored.user_metadata->>'sha256' = reservation.sha256))
    INTO object_count,exact_count FROM storage.objects AS stored
    WHERE stored.id = p_intent.object_id OR (stored.bucket_id = p_intent.bucket AND stored.name = p_intent.object_key);
  IF object_count = 0 THEN
    IF p_intent.metadata_deleted_at IS NULL OR p_intent.delete_requested_at IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_plan.deleted_objects) AS deleted
        WHERE deleted->>'object_id' = p_intent.object_id::text AND deleted->>'object_version' = p_intent.object_version) THEN
      RAISE EXCEPTION 'Missing catalog object without an owned delete audit; outcome unknown' USING ERRCODE = 'PT409';
    END IF;
    RETURN false;
  END IF;
  IF object_count <> 1 OR exact_count <> 1 OR p_intent.metadata_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cleanup owner, key, ID or version changed; no replacement deletion' USING ERRCODE = 'PT409';
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_story_media_cleanup(p_plan_id uuid,p_snapshot_sha256 text,p_cancellation_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE; intent public.story_media_cleanup_intents%ROWTYPE;
  reservation public.story_media_reservations%ROWTYPE; stamp timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO plan FROM public.story_media_cleanup_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR p_cancellation_ref IS NULL OR plan.snapshot_sha256 IS DISTINCT FROM p_snapshot_sha256 THEN
    RAISE EXCEPTION 'Exact cleanup snapshot and cancellation reference required' USING ERRCODE = 'PT409';
  END IF;
  IF plan.superseded_at IS NOT NULL THEN
    IF plan.cancellation_ref IS DISTINCT FROM p_cancellation_ref THEN
      RAISE EXCEPTION 'Cleanup cancellation reference conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN public._story_media_cleanup_receipt(plan);
  END IF;
  IF plan.status NOT IN ('dry_run','claimed') OR plan.deleted_objects <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Delete evidence forbids cleanup supersession; original inventory retained' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO reservation FROM public.story_media_reservations WHERE id = plan.reservation_id FOR UPDATE;
  IF NOT FOUND OR reservation.owner IS DISTINCT FROM plan.owner OR reservation.request_id IS DISTINCT FROM plan.request_id
    OR (SELECT count(*) FROM public.story_media_cleanup_intents WHERE plan_id = plan.id) <> pg_catalog.jsonb_array_length(plan.objects) THEN
    RAISE EXCEPTION 'Complete exact cleanup mapping required for cancellation' USING ERRCODE = 'PT409';
  END IF;
  FOR intent IN SELECT * FROM public.story_media_cleanup_intents WHERE plan_id = plan.id ORDER BY object_id FOR UPDATE LOOP
    IF intent.cancelled_at IS NOT NULL OR intent.state NOT IN ('planned','claimed') OR intent.outcome <> 'pending'
      OR intent.delete_attempts <> 0 OR intent.delete_requested_at IS NOT NULL OR intent.metadata_deleted_at IS NOT NULL
      OR intent.request_lease_token IS NOT NULL OR intent.authorized_delete_lease_token IS NOT NULL
      OR intent.delete_http_status IS NOT NULL OR intent.absence_http_status IS NOT NULL OR intent.api_ack IS NOT NULL OR intent.observed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Only untouched cleanup intents may be cancelled; original inventory retained' USING ERRCODE = 'PT409';
    END IF;
    PERFORM public._story_media_cleanup_object_check(plan,intent);
  END LOOP;
  UPDATE public.story_media_cleanup_intents SET cancelled_at = stamp WHERE plan_id = plan.id;
  UPDATE public.story_media_cleanup_plans SET superseded_at = stamp,cancellation_ref = p_cancellation_ref
    WHERE id = plan.id RETURNING * INTO plan;
  RETURN public._story_media_cleanup_receipt(plan);
END;
$function$;

CREATE OR REPLACE FUNCTION public.prepare_story_media_cleanup(p_operation_id uuid,p_reservation_id uuid,p_epoch integer,p_object_ids uuid[],p_retention_policy_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE settings public.story_media_settings%ROWTYPE; reservation public.story_media_reservations%ROWTYPE;
  plan public.story_media_cleanup_plans%ROWTYPE; objects jsonb; holds jsonb; snapshot text; stamp timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_operation_id IS NULL OR p_reservation_id IS NULL OR p_epoch IS NULL OR p_retention_policy_ref IS NULL
    OR p_object_ids IS NULL OR pg_catalog.array_ndims(p_object_ids) IS DISTINCT FROM 1 OR pg_catalog.cardinality(p_object_ids) NOT BETWEEN 1 AND 2
    OR pg_catalog.cardinality(p_object_ids) <> (SELECT count(DISTINCT object_id) FROM pg_catalog.unnest(p_object_ids) AS object_id) THEN
    RAISE EXCEPTION 'One or two exact object IDs and request version are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO plan FROM public.story_media_cleanup_plans WHERE operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF plan.reservation_id IS DISTINCT FROM p_reservation_id OR plan.reservation_epoch IS DISTINCT FROM p_epoch
      OR plan.retention_policy_ref IS DISTINCT FROM p_retention_policy_ref
      OR (SELECT pg_catalog.array_agg((target->>'object_id')::uuid ORDER BY (target->>'object_id')::uuid)
        FROM pg_catalog.jsonb_array_elements(plan.objects) AS target)
        IS DISTINCT FROM (SELECT pg_catalog.array_agg(object_id ORDER BY object_id) FROM pg_catalog.unnest(p_object_ids) AS object_id) THEN
      RAISE EXCEPTION 'Cleanup operation conflict; retry the original exact snapshot' USING ERRCODE = 'PT409';
    END IF;
    RETURN public._story_media_cleanup_receipt(plan);
  END IF;
  SELECT * INTO settings FROM public.story_media_settings WHERE singleton FOR SHARE;
  IF NOT FOUND OR NOT settings.cleanup_enabled OR NOT settings.retention_approved OR settings.retention_policy_ref IS DISTINCT FROM p_retention_policy_ref
    OR public._story_media_guards_present() IS NOT TRUE THEN RAISE EXCEPTION 'Approved cleanup policy is disabled or unknown' USING ERRCODE = 'PT503'; END IF;
  SELECT * INTO reservation FROM public.story_media_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND OR reservation.epoch <> p_epoch OR public._story_media_cleanup_eligible(reservation) IS NOT TRUE THEN
    RAISE EXCEPTION 'Exact inactive request version required; published Stories need a tombstone' USING ERRCODE = 'PT409';
  END IF;
  holds := public._story_media_cleanup_holds(reservation.owner);
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('object_id',stored.id,'bucket',stored.bucket_id,'object_key',stored.name,
    'object_version',stored.version,'sha256',reservation.sha256) ORDER BY stored.id) INTO objects
    FROM storage.objects AS stored WHERE stored.id = ANY(p_object_ids) AND stored.owner_id = reservation.owner::text
      AND stored.created_at <= stamp - pg_catalog.make_interval(secs => settings.cleanup_min_age_seconds)
      AND ((stored.id = reservation.object_id AND stored.bucket_id = reservation.bucket AND stored.name = reservation.object_key AND stored.version = reservation.object_version)
        OR (stored.id = reservation.public_object_id AND stored.bucket_id = reservation.public_bucket AND stored.name = reservation.public_key
          AND stored.version = reservation.public_object_version AND stored.user_metadata->>'sha256' = reservation.sha256));
  IF objects IS NULL OR pg_catalog.jsonb_array_length(objects) <> pg_catalog.cardinality(p_object_ids) THEN
    RAISE EXCEPTION 'Exact retained object IDs, versions and policy age are required' USING ERRCODE = 'PT409';
  END IF;
  snapshot := public._story_digest('story_media_cleanup',pg_catalog.jsonb_build_array(reservation.id,reservation.owner,reservation.request_id,
    reservation.epoch,settings.cleanup_epoch,p_retention_policy_ref,settings.storage_policy_ref,holds,objects));
  SELECT * INTO plan FROM public.story_media_cleanup_plans WHERE operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF plan.snapshot_sha256 <> snapshot THEN RAISE EXCEPTION 'Cleanup operation conflict' USING ERRCODE = 'PT409'; END IF;
    RETURN public._story_media_cleanup_receipt(plan);
  END IF;
  IF EXISTS (SELECT 1 FROM public.story_media_cleanup_plans AS existing WHERE existing.reservation_id = reservation.id
    AND ((existing.superseded_at IS NULL AND existing.expires_at > stamp AND existing.status IN ('dry_run','claimed'))
      OR (existing.approval_ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.story_media_cleanup_intents AS intent
        WHERE intent.plan_id = existing.id AND intent.object_id = ANY(p_object_ids) AND intent.cancelled_at IS NULL)))) THEN
    RAISE EXCEPTION 'An exact cleanup plan already exists; do not mint duplicate claims' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO public.story_media_cleanup_plans(operation_id,reservation_id,owner,request_id,reservation_epoch,cleanup_epoch,
    retention_policy_ref,storage_policy_ref,holds,objects,snapshot_sha256,created_at,expires_at)
    VALUES(p_operation_id,reservation.id,reservation.owner,reservation.request_id,reservation.epoch,settings.cleanup_epoch,
      p_retention_policy_ref,settings.storage_policy_ref,holds,objects,snapshot,stamp,stamp + interval '5 minutes') RETURNING * INTO plan;
  INSERT INTO public.story_media_cleanup_intents(plan_id,reservation_id,owner,object_id,bucket,object_key,object_version)
    SELECT plan.id,reservation.id,reservation.owner,(target->>'object_id')::uuid,target->>'bucket',target->>'object_key',target->>'object_version'
      FROM pg_catalog.jsonb_array_elements(objects) AS target;
  RETURN public._story_media_cleanup_receipt(plan);
END;
$function$;
CREATE OR REPLACE FUNCTION public.confirm_story_media_cleanup(p_plan_id uuid,p_snapshot_sha256 text,p_approval_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO plan FROM public.story_media_cleanup_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR p_approval_ref IS NULL OR plan.snapshot_sha256 IS DISTINCT FROM p_snapshot_sha256
    OR plan.superseded_at IS NOT NULL OR plan.status NOT IN ('dry_run','claimed','metadata_deleted')
    OR (plan.status <> 'dry_run' AND plan.approval_ref IS DISTINCT FROM p_approval_ref) THEN
    RAISE EXCEPTION 'Exact dry run and explicit approval reference required' USING ERRCODE = 'PT409';
  END IF;
  IF plan.status = 'dry_run' AND EXISTS (SELECT 1 FROM public.story_media_cleanup_plans AS previous
    WHERE previous.reservation_id = plan.reservation_id AND previous.superseded_at IS NOT NULL AND previous.approval_ref = p_approval_ref) THEN
    RAISE EXCEPTION 'Fresh independent cleanup approval reference required' USING ERRCODE = 'PT409';
  END IF;
  IF plan.status = 'metadata_deleted' THEN RETURN public._story_media_cleanup_receipt(plan); END IF;
  PERFORM public._story_media_cleanup_check(plan);
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(plan.objects) AS target
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(plan.deleted_objects) AS deleted WHERE deleted->>'object_id' = target->>'object_id')
    AND NOT EXISTS (SELECT 1 FROM storage.objects AS stored
    WHERE stored.id::text = target->>'object_id' AND stored.bucket_id = target->>'bucket' AND stored.name = target->>'object_key'
      AND stored.version = target->>'object_version' AND stored.owner_id = plan.owner::text)) THEN
    RAISE EXCEPTION 'Cleanup objects changed since the dry run' USING ERRCODE = 'PT409';
  END IF;
  IF plan.status = 'claimed' THEN
    IF plan.approval_ref IS DISTINCT FROM p_approval_ref OR plan.lease_until <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'Cleanup claim expired or approval changed; no replay extension' USING ERRCODE = 'PT409';
    END IF;
    RETURN public._story_media_cleanup_receipt(plan);
  END IF;
  UPDATE public.story_media_cleanup_plans SET status = 'claimed',approval_ref = p_approval_ref,lease_token = pg_catalog.gen_random_uuid(),
    confirmed_at = pg_catalog.clock_timestamp(),lease_until = least(expires_at,pg_catalog.clock_timestamp() + interval '30 seconds')
    WHERE id = plan.id RETURNING * INTO plan;
  UPDATE public.story_media_cleanup_intents SET state = 'claimed' WHERE plan_id = plan.id AND state = 'planned';
  RETURN public._story_media_cleanup_receipt(plan);
END;
$function$;
CREATE OR REPLACE FUNCTION public._story_media_cleanup_delete(p_object storage.objects)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RETURN false; END IF;
  SELECT * INTO plan FROM public.story_media_cleanup_plans AS candidate WHERE candidate.status = 'claimed'
    AND candidate.superseded_at IS NULL AND candidate.approval_ref IS NOT NULL AND candidate.lease_token IS NOT NULL
    AND ((candidate.lease_until > pg_catalog.clock_timestamp() AND candidate.expires_at > pg_catalog.clock_timestamp())
      OR (candidate.worker_lease_token IS NOT NULL AND candidate.worker_lease_until > pg_catalog.clock_timestamp()
        AND EXISTS (SELECT 1 FROM public.story_media_cleanup_intents AS intent WHERE intent.plan_id = candidate.id
          AND intent.object_id = p_object.id AND intent.state = 'object_delete_requested'
          AND intent.request_lease_token = candidate.worker_lease_token)))
    AND candidate.owner::text = p_object.owner_id
    AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(candidate.objects) AS target WHERE target->>'object_id' = p_object.id::text
      AND target->>'bucket' = p_object.bucket_id AND target->>'object_key' = p_object.name AND target->>'object_version' = p_object.version)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(candidate.deleted_objects) AS deleted WHERE deleted->>'object_id' = p_object.id::text)
    ORDER BY candidate.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public._story_media_cleanup_policy_check(plan);
  PERFORM public._story_media_cleanup_object_check(plan,intent) FROM public.story_media_cleanup_intents AS intent
    WHERE intent.plan_id = plan.id AND intent.object_id = p_object.id;
  UPDATE public.story_media_cleanup_intents SET state = 'object_delete_requested',
    delete_requested_at = coalesce(delete_requested_at,pg_catalog.clock_timestamp()),metadata_deleted_at = pg_catalog.clock_timestamp()
    WHERE plan_id = plan.id AND object_id = p_object.id AND object_version = p_object.version
      AND bucket = p_object.bucket_id AND object_key = p_object.name AND owner = plan.owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Durable exact cleanup intent required' USING ERRCODE = 'PT409'; END IF;
  UPDATE public.story_media_cleanup_plans SET deleted_objects = deleted_objects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'object_id',p_object.id,'object_version',p_object.version,'storage_metadata_deleted_at',pg_catalog.clock_timestamp(),'physical_delete_confirmed',false)),
    status = CASE WHEN pg_catalog.jsonb_array_length(deleted_objects) + 1 = pg_catalog.jsonb_array_length(objects) THEN 'metadata_deleted' ELSE 'claimed' END
    WHERE id = plan.id;
  RETURN true;
END;
$function$;

CREATE FUNCTION public._story_media_cleanup_worker_receipt(p_plan public.story_media_cleanup_plans)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('schema_version',1,'operation_id',p_plan.operation_id,'claim_id',p_plan.id,
    'reservation_id',reservation.id,'owner',p_plan.owner,'request_id',p_plan.request_id,'reservation_epoch',p_plan.reservation_epoch,
    'cleanup_epoch',p_plan.cleanup_epoch,'retention_policy_ref',p_plan.retention_policy_ref,'storage_policy_ref',p_plan.storage_policy_ref,
    'approval_ref',p_plan.approval_ref,'snapshot_sha256',p_plan.snapshot_sha256,'lease_token',p_plan.worker_lease_token,
    'lease_until',p_plan.worker_lease_until,'content_type',reservation.content_type,'public_key_id',reservation.public_key_id,'sha256',reservation.sha256,
    'objects',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('intent_id',intent.id,'object_id',intent.object_id,
      'bucket',intent.bucket,'object_key',intent.object_key,'object_version',intent.object_version,'state',intent.state,'outcome',intent.outcome,
      'metadata_deleted',intent.metadata_deleted_at IS NOT NULL,'delete_requested',intent.delete_requested_at IS NOT NULL,
      'delete_attempts',intent.delete_attempts) ORDER BY intent.bucket,intent.id)
      FROM public.story_media_cleanup_intents AS intent WHERE intent.plan_id = p_plan.id),
    'physical_delete_confirmed',false,'account_deleted',false)
    FROM public.story_media_reservations AS reservation WHERE reservation.id = p_plan.reservation_id;
$function$;

CREATE FUNCTION public.claim_story_media_cleanup(p_operation_id uuid,p_claim_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE; intent public.story_media_cleanup_intents%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO plan FROM public.story_media_cleanup_plans WHERE operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR (p_claim_id IS NOT NULL AND p_claim_id <> plan.id) OR plan.approval_ref IS NULL
    OR plan.confirmed_at IS NULL OR plan.status NOT IN ('claimed','metadata_deleted') THEN
    RAISE EXCEPTION 'Original explicitly approved cleanup operation required' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public._story_media_cleanup_policy_check(plan);
  IF (SELECT count(*) FROM public.story_media_cleanup_intents WHERE plan_id = plan.id) <> pg_catalog.jsonb_array_length(plan.objects) THEN
    RAISE EXCEPTION 'Complete durable object inventory required' USING ERRCODE = 'PT409';
  END IF;
  FOR intent IN SELECT * FROM public.story_media_cleanup_intents WHERE plan_id = plan.id FOR UPDATE LOOP
    PERFORM public._story_media_cleanup_object_check(plan,intent);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.story_media_cleanup_intents WHERE plan_id = plan.id AND state <> 'completed') THEN
    RETURN public._story_media_cleanup_worker_receipt(plan);
  END IF;
  IF plan.worker_lease_until > pg_catalog.clock_timestamp() THEN RAISE EXCEPTION 'Cleanup worker already leased' USING ERRCODE = 'PT409'; END IF;
  IF plan.worker_attempts >= 10 THEN RAISE EXCEPTION 'Cleanup worker budget exhausted; durable intent requires operator review' USING ERRCODE = 'PT429'; END IF;
  UPDATE public.story_media_cleanup_plans SET worker_lease_token = pg_catalog.gen_random_uuid(),
    worker_lease_until = pg_catalog.clock_timestamp() + interval '30 seconds',worker_attempts = worker_attempts + 1
    WHERE id = plan.id RETURNING * INTO plan;
  RETURN public._story_media_cleanup_worker_receipt(plan);
END;
$function$;

CREATE FUNCTION public._story_media_cleanup_worker_check(p_operation_id uuid,p_claim_id uuid,p_lease_token uuid)
RETURNS public.story_media_cleanup_plans LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO plan FROM public.story_media_cleanup_plans WHERE id = p_claim_id AND operation_id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR plan.worker_lease_token IS DISTINCT FROM p_lease_token
    OR plan.worker_lease_until IS NULL OR plan.worker_lease_until <= pg_catalog.clock_timestamp() OR plan.approval_ref IS NULL THEN
    RAISE EXCEPTION 'Current exact cleanup worker lease required' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public._story_media_cleanup_policy_check(plan);
  RETURN plan;
END;
$function$;

CREATE FUNCTION public.request_story_media_cleanup_object(p_operation_id uuid,p_claim_id uuid,p_intent_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE; intent public.story_media_cleanup_intents%ROWTYPE; present boolean; allowed boolean;
BEGIN
  plan := public._story_media_cleanup_worker_check(p_operation_id,p_claim_id,p_lease_token);
  SELECT * INTO intent FROM public.story_media_cleanup_intents WHERE id = p_intent_id AND plan_id = plan.id FOR UPDATE;
  IF NOT FOUND OR intent.state = 'planned' THEN RAISE EXCEPTION 'Exact approved object intent required' USING ERRCODE = 'PT409'; END IF;
  present := public._story_media_cleanup_object_check(plan,intent);
  allowed := present AND intent.state <> 'completed' AND intent.request_lease_token IS DISTINCT FROM p_lease_token;
  IF allowed AND intent.delete_attempts >= 3 THEN RAISE EXCEPTION 'Exact object delete budget exhausted; intent retained' USING ERRCODE = 'PT429'; END IF;
  IF intent.state <> 'completed' THEN
    UPDATE public.story_media_cleanup_intents SET request_lease_token = p_lease_token,
      authorized_delete_lease_token = CASE WHEN allowed THEN p_lease_token ELSE authorized_delete_lease_token END,
      state = CASE WHEN present THEN 'object_delete_requested' ELSE 'unknown' END,
      delete_requested_at = CASE WHEN allowed THEN coalesce(delete_requested_at,pg_catalog.clock_timestamp()) ELSE delete_requested_at END,
      delete_attempts = delete_attempts + CASE WHEN allowed THEN 1 ELSE 0 END
      WHERE id = intent.id;
  END IF;
  RETURN public._story_media_cleanup_worker_receipt(plan) || pg_catalog.jsonb_build_object('intent_id',intent.id,'delete_allowed',allowed);
END;
$function$;

CREATE FUNCTION public.finish_story_media_cleanup_object(p_operation_id uuid,p_claim_id uuid,p_intent_id uuid,p_lease_token uuid,
  p_result text,p_delete_status integer,p_ack jsonb,p_get_status integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s' AS $function$
DECLARE plan public.story_media_cleanup_plans%ROWTYPE; intent public.story_media_cleanup_intents%ROWTYPE; present boolean;
BEGIN
  plan := public._story_media_cleanup_worker_check(p_operation_id,p_claim_id,p_lease_token);
  SELECT * INTO intent FROM public.story_media_cleanup_intents WHERE id = p_intent_id AND plan_id = plan.id FOR UPDATE;
  IF NOT FOUND OR intent.request_lease_token IS DISTINCT FROM p_lease_token OR intent.state NOT IN ('object_delete_requested','unknown','completed')
    OR p_result IS NULL OR p_result NOT IN ('storage_api_deleted','storage_api_absent_backend_unknown','unknown')
    OR p_delete_status IS NULL OR p_delete_status NOT BETWEEN 0 AND 599 OR p_get_status IS NULL OR p_get_status NOT BETWEEN 0 AND 599 THEN
    RAISE EXCEPTION 'Exact requested object and bounded service observation required' USING ERRCODE = 'PT409';
  END IF;
  present := public._story_media_cleanup_object_check(plan,intent);
  IF p_result <> 'unknown' AND (present OR p_get_status <> 404) THEN
    RAISE EXCEPTION 'Owned catalog-delete audit and authenticated object absence required' USING ERRCODE = 'PT409';
  END IF;
  IF p_result = 'storage_api_deleted' THEN
    IF intent.authorized_delete_lease_token IS DISTINCT FROM p_lease_token THEN
      RAISE EXCEPTION 'Delete authorization under this exact worker lease required' USING ERRCODE = 'PT409';
    END IF;
    IF p_delete_status <> 200 OR p_ack IS NULL OR pg_catalog.jsonb_typeof(p_ack) <> 'object' OR pg_catalog.octet_length(p_ack::text) > 1024
      OR p_ack->>'name' IS DISTINCT FROM intent.object_key
      OR (p_ack ? 'id' AND p_ack->>'id' IS DISTINCT FROM intent.object_id::text)
      OR (p_ack ? 'bucket_id' AND p_ack->>'bucket_id' IS DISTINCT FROM intent.bucket)
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_ack) AS field WHERE field NOT IN ('name','id','bucket_id')) THEN
      RAISE EXCEPTION 'Exact successful Storage remove acknowledgement required' USING ERRCODE = 'PT409';
    END IF;
  ELSIF p_ack IS NOT NULL OR (p_result = 'storage_api_absent_backend_unknown' AND p_delete_status NOT IN (0,200,404)) THEN
    RAISE EXCEPTION 'Ambiguous or empty acknowledgement is not deletion proof' USING ERRCODE = 'PT409';
  END IF;
  IF intent.state = 'completed' THEN
    IF p_result IS DISTINCT FROM intent.outcome OR p_delete_status IS DISTINCT FROM intent.delete_http_status
      OR p_get_status IS DISTINCT FROM intent.absence_http_status OR p_ack IS DISTINCT FROM intent.api_ack THEN
      RAISE EXCEPTION 'Completed cleanup observation is immutable' USING ERRCODE = 'PT409';
    END IF;
    RETURN public._story_media_cleanup_worker_receipt(plan);
  END IF;
  UPDATE public.story_media_cleanup_intents SET state = CASE WHEN p_result = 'storage_api_deleted' THEN 'completed' ELSE 'unknown' END,
    outcome = p_result,delete_http_status = p_delete_status,absence_http_status = p_get_status,api_ack = p_ack,
    observed_at = pg_catalog.clock_timestamp() WHERE id = intent.id;
  RETURN public._story_media_cleanup_worker_receipt(plan);
END;
$function$;

CREATE OR REPLACE FUNCTION public.preview_story_media_cleanup(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE result jsonb;
BEGIN
  IF pg_catalog.current_setting('role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Bounded inventory required' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('reservation_id',candidate.id,'bucket',candidate.bucket,
    'object_key',candidate.object_key,'object_id',candidate.object_id,'sha256',candidate.sha256,'status',candidate.status,
    'object_version',candidate.object_version,'request_id',candidate.request_id,'epoch',candidate.epoch,
    'public_bucket',candidate.public_bucket,'public_key',candidate.public_key,'public_object_id',candidate.public_object_id,'public_object_version',candidate.public_object_version,
    'pending_intents',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('intent_id',intent.id,'operation_id',plan.operation_id,
      'claim_id',plan.id,'object_id',intent.object_id,'bucket',intent.bucket,'object_key',intent.object_key,'object_version',intent.object_version,
      'state',intent.state,'outcome',intent.outcome,'delete_attempts',intent.delete_attempts,
      'metadata_deleted_at',intent.metadata_deleted_at,'physical_delete_confirmed',false) ORDER BY intent.created_at,intent.id),'[]'::jsonb)
      FROM public.story_media_cleanup_intents AS intent JOIN public.story_media_cleanup_plans AS plan ON plan.id = intent.plan_id
      WHERE intent.reservation_id = candidate.id AND intent.state <> 'completed' AND intent.cancelled_at IS NULL),
    'declared_bytes',candidate.declared_bytes) ORDER BY candidate.id),'[]'::jsonb) INTO result FROM (
    SELECT reservation.* FROM public.story_media_reservations AS reservation LEFT JOIN public.stories_v2 AS story ON story.id = reservation.published_story_id
    WHERE (p_after IS NULL OR reservation.id > p_after) AND ((reservation.object_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM storage.objects WHERE id IN (reservation.object_id,reservation.public_object_id))
      AND ((reservation.status <> 'published' AND (reservation.expires_at <= pg_catalog.clock_timestamp() OR reservation.status IN ('failed','cancelled')))
        OR (reservation.status = 'published' AND (story.deleted_at IS NOT NULL OR story.expires_at <= pg_catalog.clock_timestamp()))))
      OR EXISTS (SELECT 1 FROM public.story_media_cleanup_intents AS intent WHERE intent.reservation_id = reservation.id
        AND intent.state <> 'completed' AND intent.cancelled_at IS NULL))
    ORDER BY reservation.id LIMIT p_limit) AS candidate;
  RETURN pg_catalog.jsonb_build_object('dry_run',true,'physical_delete_allowed',false,'items',result,
    'next_cursor',CASE WHEN pg_catalog.jsonb_array_length(result) = p_limit THEN result->(p_limit-1)->>'reservation_id' END,
    'retention_policy_ref',(SELECT retention_policy_ref FROM public.story_media_settings WHERE singleton));
END;
$function$;

DO $grants$
DECLARE relation text; routine record;
BEGIN
  FOREACH relation IN ARRAY ARRAY['story_media_settings','story_media_reservations','story_media_publish_intents','story_media_cleanup_plans','story_media_cleanup_intents'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role',relation);
  END LOOP;
  FOR routine IN SELECT procedure.oid::regprocedure AS signature FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.pronamespace = 'public'::regnamespace AND (procedure.proname LIKE '%story_media%' OR procedure.proname = 'publish_validated_story') LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',routine.signature);
  END LOOP;
END;
$grants$;
GRANT SELECT,UPDATE ON public.story_media_settings TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_story_media(uuid,text,text,integer),public.cancel_story_media(uuid),
  public.publish_validated_story(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public._story_media_storage_insert(text,text,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_story_media_validation(uuid,uuid),
  public.attest_story_media(uuid,uuid,integer,uuid,text,integer,text,integer,integer,integer,text),
  public.claim_story_media_promotion(uuid,uuid,integer,uuid),
  public.finalize_story_media(uuid,uuid,integer,uuid,text,uuid,text),
  public.prepare_story_media_cleanup(uuid,uuid,integer,uuid[],uuid),public.confirm_story_media_cleanup(uuid,text,uuid),
  public.cancel_story_media_cleanup(uuid,text,uuid),
  public.claim_story_media_cleanup(uuid,uuid),public.request_story_media_cleanup_object(uuid,uuid,uuid,uuid),
  public.finish_story_media_cleanup_object(uuid,uuid,uuid,uuid,text,integer,jsonb,integer),
  public.preview_story_media_cleanup(uuid,integer) TO service_role;

COMMIT;