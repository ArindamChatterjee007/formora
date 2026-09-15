BEGIN;
SET LOCAL lock_timeout='5s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.activation_config') IS NULL
    OR pg_catalog.to_regclass('public.billing_analytics_consent') IS NULL
    OR pg_catalog.to_regclass('public.analytics_delivery_config') IS NULL
    OR pg_catalog.to_regclass('auth.identities') IS NULL
    OR pg_catalog.to_regprocedure('public._activation_verified_account(uuid)') IS NULL
    OR pg_catalog.to_regclass('public.registration_consent_config') IS NOT NULL THEN
    RAISE EXCEPTION 'Registration consent requires the reviewed activation baseline and a fresh installation' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='public._activation_verified_account(uuid)'::regprocedure
    AND NOT prosecdef AND prorettype='boolean'::regtype AND pg_catalog.btrim(prosrc)=pg_catalog.btrim($baseline$
  SELECT EXISTS (SELECT 1 FROM auth.users AS account
    WHERE account.id = p_uid AND account.deleted_at IS NULL AND NOT COALESCE(account.is_anonymous, false)
      AND account.created_at IS NOT NULL AND pg_catalog.isfinite(account.created_at)
      AND account.created_at <= pg_catalog.clock_timestamp()
      AND COALESCE(account.email_confirmed_at, account.phone_confirmed_at) >= account.created_at
      AND COALESCE(account.email_confirmed_at, account.phone_confirmed_at) <= pg_catalog.clock_timestamp()
      AND account.raw_app_meta_data #>> '{activation,cohort}' = 'production');
$baseline$)) THEN
    RAISE EXCEPTION 'Registration consent requires the exact reviewed activation verifier' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._activation_verified_account(p_uid uuid) RETURNS boolean
LANGUAGE sql SET search_path = '' AS $function$
  SELECT EXISTS (SELECT 1 FROM auth.users AS account
    WHERE account.id = p_uid AND account.deleted_at IS NULL AND NOT COALESCE(account.is_anonymous, false)
      AND account.created_at IS NOT NULL AND pg_catalog.isfinite(account.created_at)
      AND account.created_at <= pg_catalog.clock_timestamp()
      AND COALESCE(account.email_confirmed_at, account.phone_confirmed_at) >= account.created_at
      AND COALESCE(account.email_confirmed_at, account.phone_confirmed_at) <= pg_catalog.clock_timestamp()
      AND (account.raw_app_meta_data #>> '{activation,cohort}' = 'production'
        OR (account.raw_app_meta_data #>> '{activation,cohort}' = 'local_test'
          AND EXISTS(SELECT 1 FROM public.activation_config WHERE singleton AND source_mode='local_test'))));
$function$;

ALTER TABLE public.analytics_delivery_config ADD CONSTRAINT analytics_qat_collection_disabled
  CHECK(consent_version NOT LIKE 'qat-%' OR (NOT collection_enabled AND NOT delivery_enabled));

CREATE TABLE public.registration_consent_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  notice_version text NOT NULL DEFAULT 'qat-registration-v1' CHECK(notice_version ~ '^qat-[a-z0-9-]{1,59}$'),
  notice_sha256 text CHECK(notice_sha256 ~ '^[a-f0-9]{64}$'),
  epoch uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  CHECK(NOT enabled OR notice_sha256 IS NOT NULL)
);
INSERT INTO public.registration_consent_config DEFAULT VALUES;
CREATE TABLE public.registration_consent_receipts (
  proof_hash bytea PRIMARY KEY CHECK(octet_length(proof_hash)=32),
  identity_hash bytea NOT NULL CHECK(octet_length(identity_hash)=32),
  notice_version text NOT NULL,
  notice_sha256 text NOT NULL,
  policy_epoch uuid NOT NULL,
  source_epoch uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK(expires_at=captured_at+interval '15 minutes')
);
CREATE INDEX registration_consent_expiry ON public.registration_consent_receipts(expires_at);
CREATE TABLE public.registration_consent_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  minute_start timestamptz NOT NULL DEFAULT '-infinity',
  minute_count integer NOT NULL DEFAULT 0 CHECK(minute_count BETWEEN 0 AND 20)
);
INSERT INTO public.registration_consent_limits DEFAULT VALUES;

ALTER TABLE public.registration_consent_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_consent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_consent_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_consent_config,public.registration_consent_receipts,public.registration_consent_limits
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,UPDATE ON public.registration_consent_config TO service_role;

CREATE FUNCTION public._registration_consent_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $function$
BEGIN
  NEW.epoch:=pg_catalog.gen_random_uuid();
  RETURN NEW;
END;
$function$;
CREATE TRIGGER registration_consent_epoch BEFORE UPDATE ON public.registration_consent_config
  FOR EACH ROW EXECUTE FUNCTION public._registration_consent_epoch();

CREATE FUNCTION public._registration_consent_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT EXISTS(SELECT 1 FROM public.registration_consent_config policy,public.activation_config activation,
    public.analytics_delivery_config analytics WHERE policy.singleton AND activation.singleton AND analytics.singleton
      AND policy.enabled AND policy.notice_sha256 IS NOT NULL AND activation.collection_enabled
      AND activation.source_mode='local_test' AND activation.enabled_at IS NOT NULL
      AND activation.consent_version=policy.notice_version AND analytics.consent_version=policy.notice_version
      AND NOT analytics.collection_enabled AND NOT analytics.delivery_enabled);
$function$;

CREATE FUNCTION public.get_registration_consent_policy() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT pg_catalog.jsonb_build_object('enabled',public._registration_consent_ready(),
    'version',notice_version,'notice_sha256',notice_sha256,'stage','qat') FROM public.registration_consent_config WHERE singleton;
$function$;

CREATE FUNCTION public.issue_registration_consent(p_granted boolean,p_version text,p_notice_sha256 text,p_identity_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE policy public.registration_consent_config%ROWTYPE; source_id uuid; proof text; captured timestamptz;
BEGIN
  IF p_granted IS NOT TRUE THEN RETURN NULL; END IF;
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Pre-signup consent only' USING ERRCODE='PT403'; END IF;
  SELECT * INTO policy FROM public.registration_consent_config WHERE singleton FOR SHARE;
  IF public._registration_consent_ready() IS NOT TRUE THEN RAISE EXCEPTION 'Registration measurement is disabled' USING ERRCODE='PT503'; END IF;
  IF p_version IS DISTINCT FROM policy.notice_version OR p_notice_sha256 IS DISTINCT FROM policy.notice_sha256 THEN
    RAISE EXCEPTION 'Current explicit notice choice required' USING ERRCODE='22023';
  END IF;
  IF p_identity_hash IS NULL OR p_identity_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'A private signup identity commitment is required' USING ERRCODE='22023';
  END IF;
  SELECT source_epoch INTO source_id FROM public.activation_config WHERE singleton FOR SHARE;
  UPDATE public.registration_consent_limits SET minute_start=pg_catalog.date_trunc('minute',pg_catalog.clock_timestamp()),
    minute_count=CASE WHEN minute_start=pg_catalog.date_trunc('minute',pg_catalog.clock_timestamp()) THEN minute_count+1 ELSE 1 END
    WHERE singleton AND (minute_start<>pg_catalog.date_trunc('minute',pg_catalog.clock_timestamp()) OR minute_count<20);
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration consent capacity reached' USING ERRCODE='PT429'; END IF;
  DELETE FROM public.registration_consent_receipts WHERE proof_hash IN
    (SELECT proof_hash FROM public.registration_consent_receipts WHERE expires_at<pg_catalog.clock_timestamp() ORDER BY expires_at LIMIT 100);
  IF (SELECT count(*) FROM public.registration_consent_receipts)>=300 THEN
    RAISE EXCEPTION 'Registration consent capacity reached' USING ERRCODE='PT429';
  END IF;
  proof:=replace(pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text,'-','');
  captured:=pg_catalog.clock_timestamp();
  INSERT INTO public.registration_consent_receipts(proof_hash,identity_hash,notice_version,notice_sha256,policy_epoch,source_epoch,captured_at,expires_at)
    VALUES(pg_catalog.sha256(pg_catalog.convert_to(proof,'UTF8')),pg_catalog.decode(p_identity_hash,'hex'),policy.notice_version,policy.notice_sha256,policy.epoch,source_id,captured,captured+interval '15 minutes');
  RETURN pg_catalog.jsonb_build_object('proof',proof,'version',policy.notice_version,'notice_sha256',policy.notice_sha256,
    'captured_at',captured,'expires_at',captured+interval '15 minutes');
END;
$function$;

CREATE FUNCTION public._bind_registration_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='500ms' AS $function$
DECLARE proof text; binding text; choice public.registration_consent_receipts%ROWTYPE; policy public.registration_consent_config%ROWTYPE;
BEGIN
  proof:=NEW.raw_user_meta_data->>'registration_consent_proof';
  binding:=NEW.raw_user_meta_data->>'registration_consent_binding';
  NEW.raw_user_meta_data:=coalesce(NEW.raw_user_meta_data,'{}'::jsonb)-'registration_consent_proof'-'registration_consent_binding';
  IF TG_OP<>'INSERT' OR proof IS NULL OR proof !~ '^[a-f0-9]{64}$' OR binding IS NULL OR binding !~ '^[a-f0-9]{64}$'
    OR NEW.email IS NULL OR coalesce(NEW.is_anonymous,false) THEN RETURN NEW; END IF;
  SELECT * INTO policy FROM public.registration_consent_config WHERE singleton FOR SHARE;
  PERFORM 1 FROM public.activation_config WHERE singleton FOR SHARE;
  IF public._registration_consent_ready() IS NOT TRUE THEN RETURN NEW; END IF;
  DELETE FROM public.registration_consent_receipts WHERE proof_hash=pg_catalog.sha256(pg_catalog.convert_to(proof,'UTF8'))
    AND identity_hash=pg_catalog.sha256(pg_catalog.convert_to(binding||':'||pg_catalog.lower(pg_catalog.btrim(NEW.email)),'UTF8'))
    AND policy_epoch=policy.epoch AND notice_version=policy.notice_version AND notice_sha256=policy.notice_sha256
    AND source_epoch=(SELECT source_epoch FROM public.activation_config WHERE singleton)
    AND captured_at<=NEW.created_at AND expires_at>pg_catalog.clock_timestamp()
    RETURNING * INTO choice;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.billing_analytics_consent(uid,granted,version,captured_at)
    VALUES(NEW.id::text,true,choice.notice_version,choice.captured_at) ON CONFLICT(uid) DO NOTHING;
  IF NOT FOUND THEN RETURN NEW; END IF;
  NEW.raw_app_meta_data:=coalesce(NEW.raw_app_meta_data,'{}'::jsonb)||
    pg_catalog.jsonb_build_object('activation',pg_catalog.jsonb_build_object('cohort','local_test','history','native_only'));
  RETURN NEW;
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
  RETURN NEW;
END;
$function$;
CREATE TRIGGER activation_bind_registration_consent BEFORE INSERT OR UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public._bind_registration_consent();

CREATE FUNCTION public._strip_registration_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $function$
BEGIN
  NEW.identity_data:=NEW.identity_data-'registration_consent_proof'-'registration_consent_binding';
  RETURN NEW;
END;
$function$;
CREATE TRIGGER activation_strip_registration_identity BEFORE INSERT OR UPDATE OF identity_data ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION public._strip_registration_identity();

REVOKE ALL ON FUNCTION public._registration_consent_epoch(),public._registration_consent_ready(),
  public.get_registration_consent_policy(),public.issue_registration_consent(boolean,text,text,text),public._bind_registration_consent(),
  public._strip_registration_identity()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_registration_consent_policy(),public.issue_registration_consent(boolean,text,text,text) TO anon;

NOTIFY pgrst, 'reload schema';

COMMIT;