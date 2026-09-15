BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.like_post(p_id text, p_uid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  actor text := auth.uid()::text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF p_uid IS NOT NULL AND p_uid <> actor THEN RAISE EXCEPTION 'Actor mismatch' USING ERRCODE = 'PT403'; END IF;
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid post' USING ERRCODE = '22023'; END IF;
  UPDATE public.posts SET likes = coalesce(likes, '{}'::jsonb) || pg_catalog.jsonb_build_object(actor, true) WHERE id = p_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlike_post(p_id text, p_uid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  actor text := auth.uid()::text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF p_uid IS NOT NULL AND p_uid <> actor THEN RAISE EXCEPTION 'Actor mismatch' USING ERRCODE = 'PT403'; END IF;
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid post' USING ERRCODE = '22023'; END IF;
  UPDATE public.posts SET likes = coalesce(likes, '{}'::jsonb) - actor WHERE id = p_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.like_post(text,text), public.unlike_post(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.like_post(text,text), public.unlike_post(text,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;