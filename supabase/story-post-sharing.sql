BEGIN;

DO $predecessor$
BEGIN
  IF pg_catalog.to_regprocedure('public.publish_story(uuid,text,text,text)') IS NULL
    OR pg_catalog.to_regclass('public.posts') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.stories_v2'::regclass
      AND attname='post_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Reviewed Story and post schemas without post sharing are required';
  END IF;
END;
$predecessor$;

ALTER TABLE public.stories_v2 ADD COLUMN post_id text;
ALTER TABLE public.stories_v2 ADD COLUMN post_author uuid;
ALTER TABLE public.stories_v2 ADD COLUMN post_created_at timestamptz;
ALTER TABLE public.stories_v2 DROP CONSTRAINT stories_v2_kind_check;
ALTER TABLE public.stories_v2 ADD CONSTRAINT stories_v2_kind_check CHECK (
  (kind IN ('photo','video') AND post_id IS NULL AND post_author IS NULL AND post_created_at IS NULL)
  OR (kind='post' AND post_id IS NOT NULL AND post_author IS NOT NULL AND post_created_at IS NOT NULL
    AND pg_catalog.isfinite(post_created_at) AND length(post_id) BETWEEN 1 AND 255 AND post_id !~ '[[:cntrl:]]'));
CREATE INDEX stories_v2_source_post ON public.stories_v2(post_id) WHERE post_id IS NOT NULL;

CREATE FUNCTION public._story_post_visible(p_post_id text, p_actor uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT p_actor IS NOT NULL AND EXISTS (SELECT 1 FROM public.posts AS post
    JOIN public.profiles AS profile ON profile.uid=post.author
    WHERE post.id=p_post_id AND coalesce(profile.data->>'privacy','public')='public'
      AND post.ts IS NOT NULL AND pg_catalog.isfinite(post.ts)
      AND post.author ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND NOT EXISTS (SELECT 1 FROM public.story_blocks WHERE
        (blocker=p_actor AND blocked::text=post.author) OR (blocked=p_actor AND blocker::text=post.author)));
$function$;

CREATE FUNCTION public.get_shareable_story_post(p_post_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); result jsonb; photo text; origin text; photo_status text;
BEGIN
  IF p_post_id IS NULL OR length(p_post_id) NOT BETWEEN 1 AND 255 OR p_post_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Post identifier required' USING ERRCODE='22023';
  END IF;
  PERFORM public._story_lock(caller,NULL,NULL);
  PERFORM public._story_budget(caller,NULL,NULL);
  IF NOT public._story_post_visible(p_post_id,caller) THEN
    RAISE EXCEPTION 'Public post unavailable' USING ERRCODE='PT404';
  END IF;
  SELECT pg_catalog.jsonb_build_object('id',post.id,'author',post.author,'created_at',post.ts,
    'name',left(coalesce(profile.data->>'name','Member'),80),
    'username',left(coalesce(profile.data->>'username',''),80),
    'text',left(coalesce(post.data->>'text',''),1600),
    'has_video',coalesce(length(post.data->>'video')>0,false)),
    coalesce(post.data->>'photo',post.data->'photos'->>0)
    INTO result,photo FROM public.posts AS post JOIN public.profiles AS profile ON profile.uid=post.author
    WHERE post.id=p_post_id AND public._story_post_visible(post.id,caller);
  IF result IS NULL THEN RAISE EXCEPTION 'Public post unavailable' USING ERRCODE='PT404'; END IF;
  SELECT media_origin INTO origin FROM public.story_settings WHERE singleton;
  photo_status := CASE WHEN photo IS NULL THEN 'none' ELSE 'available' END;
  IF photo IS NOT NULL AND NOT (
    (octet_length(photo)<=2097152 AND photo ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$')
    OR (length(photo)<=2048 AND left(photo,length(origin)+26)=origin||'/storage/v1/object/public/'
      AND photo ~ '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/[A-Za-z0-9_./-]+$'
        AND photo !~ '(^|/)[.][.]?(/|$)')) THEN photo := NULL; photo_status := 'unavailable'; END IF;
      RETURN result||pg_catalog.jsonb_build_object('photo',photo,'photo_status',photo_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public._story_eligible(p_id uuid, p_actor uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT p_actor IS NOT NULL AND EXISTS (SELECT 1 FROM public.stories_v2 AS story
    JOIN public.profiles AS profile ON profile.uid=story.owner::text
    WHERE story.id=p_id AND story.audience='authenticated' AND story.deleted_at IS NULL
      AND story.expires_at>pg_catalog.clock_timestamp()
      AND (story.owner=p_actor OR coalesce(profile.data->>'privacy','public')='public')
      AND NOT EXISTS (SELECT 1 FROM public.story_blocks WHERE
        (blocker=p_actor AND blocked=story.owner) OR (blocker=story.owner AND blocked=p_actor))
      AND (story.kind<>'post' OR (public._story_post_visible(story.post_id,p_actor)
        AND public._story_post_visible(story.post_id,story.owner)
        AND EXISTS(SELECT 1 FROM public.posts WHERE id=story.post_id AND author=story.post_author::text AND ts=story.post_created_at))));
$function$;

CREATE OR REPLACE FUNCTION public._story_shape(p_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('id',story.id,'author',story.owner,'photo',content.media_url,
    'kind',story.kind,'audience',story.audience,'ts',(extract(epoch FROM story.created_at)*1000)::bigint,
    'expires_at',story.expires_at,'mine',story.owner=p_actor,
    'seen',coalesce(interaction.qualified_at IS NOT NULL,false),'liked',coalesce(interaction.liked,false),
    'view_count',CASE WHEN story.owner=p_actor THEN (SELECT count(*) FROM public.story_interactions WHERE story_id=p_id AND qualified_at IS NOT NULL) END,
    'like_count',CASE WHEN story.owner=p_actor THEN (SELECT count(*) FROM public.story_interactions WHERE story_id=p_id AND liked) END)
    ||CASE WHEN story.kind='post' THEN pg_catalog.jsonb_build_object('post_id',story.post_id,
      'post_author',story.post_author,'post_created_at',story.post_created_at) ELSE '{}'::jsonb END
    FROM public.stories_v2 AS story LEFT JOIN public.story_content AS content ON content.story_id=story.id
    LEFT JOIN public.story_interactions AS interaction ON interaction.story_id=story.id AND interaction.viewer=p_actor
    WHERE story.id=p_id AND public._story_eligible(p_id,p_actor) AND (story.kind='post' OR content.story_id IS NOT NULL);
$function$;

CREATE FUNCTION public.publish_post_story(p_request_id uuid, p_post_id text, p_post_author uuid, p_post_created_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE caller uuid := public._story_actor(); prior jsonb; post_owner uuid; story_id uuid; stamp timestamptz;
  payload jsonb := pg_catalog.jsonb_build_array(p_post_id,p_post_author,p_post_created_at);
BEGIN
  IF p_post_id IS NULL OR length(p_post_id) NOT BETWEEN 1 AND 255 OR p_post_id ~ '[[:cntrl:]]'
    OR p_post_author IS NULL OR p_post_created_at IS NULL OR NOT pg_catalog.isfinite(p_post_created_at) THEN
    RAISE EXCEPTION 'Post identifier required' USING ERRCODE='22023';
  END IF;
  post_owner := p_post_author;
  prior := public._story_begin('publish_post',p_request_id,payload,NULL,post_owner);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  PERFORM id FROM public.posts WHERE id=p_post_id FOR SHARE;
  IF NOT public._story_post_visible(p_post_id,caller) OR NOT EXISTS (
    SELECT 1 FROM public.posts WHERE id=p_post_id AND author=p_post_author::text AND ts=p_post_created_at) THEN
    RAISE EXCEPTION 'Public post unavailable' USING ERRCODE='PT404';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE uid=caller::text AND coalesce(data->>'privacy','public')='public') THEN
    RAISE EXCEPTION 'Restricted profile Stories are unsupported' USING ERRCODE='PT403';
  END IF;
  stamp := pg_catalog.clock_timestamp();
  INSERT INTO public.stories_v2(owner,kind,post_id,post_author,post_created_at,audience,created_at,expires_at)
    VALUES(caller,'post',p_post_id,p_post_author,p_post_created_at,'authenticated',stamp,stamp+interval '24 hours') RETURNING id INTO story_id;
  RETURN public._story_finish('publish_post',p_request_id,payload,pg_catalog.jsonb_build_object(
    'id',story_id,'author',caller,'post_id',p_post_id,'post_author',p_post_author,'post_created_at',p_post_created_at,
    'created_at',stamp,'expires_at',stamp+interval '24 hours'));
END;
$function$;

REVOKE ALL ON FUNCTION public._story_post_visible(text,uuid), public.get_shareable_story_post(text),
  public.publish_post_story(uuid,text,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_shareable_story_post(text), public.publish_post_story(uuid,text,uuid,timestamptz) TO authenticated;

COMMIT;