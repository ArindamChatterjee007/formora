BEGIN;

DO $preflight$
BEGIN
  IF (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename='notifications') IS DISTINCT FROM ARRAY['notifs_ins','notifs_read','notifs_upd']::text[] THEN
    RAISE EXCEPTION 'Notification admission requires the reviewed core policy baseline' USING ERRCODE='55000';
  END IF;
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.notifications'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION 'Notification row security must already be enabled' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.notifications WHERE left(id,3)='n2_') THEN
    RAISE EXCEPTION 'Existing server notification identities require reconciliation' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM (
    SELECT uid AS identity FROM public.profiles UNION ALL SELECT author FROM public.posts
    UNION ALL SELECT author FROM public.comments UNION ALL SELECT from_uid FROM public.messages
    UNION ALL SELECT to_uid FROM public.messages UNION ALL SELECT from_uid FROM public.requests
    UNION ALL SELECT to_uid FROM public.requests UNION ALL SELECT actor FROM public.notifications
    UNION ALL SELECT uid FROM public.notifications
  ) AS identities WHERE identity IS NULL OR identity !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Legacy notification source identities require reconciliation' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

DROP POLICY notifs_ins ON public.notifications;
REVOKE INSERT,UPDATE ON public.notifications FROM PUBLIC,anon,authenticated;
REVOKE INSERT(id,uid,type,actor,post_id,body,read,ts),UPDATE(id,uid,type,actor,post_id,body,read,ts)
  ON public.notifications FROM PUBLIC,anon,authenticated;
GRANT UPDATE(read) ON public.notifications TO authenticated;
CREATE INDEX notifications_actor_date ON public.notifications(actor,ts DESC);
CREATE INDEX notifications_actor_recipient_date ON public.notifications(actor,uid,ts DESC) WHERE left(id,3)='n2_';
CREATE INDEX notifications_recipient_date ON public.notifications(uid,ts DESC) WHERE left(id,3)='n2_';

CREATE FUNCTION public.lock_source_notifications()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('social-notification:'||auth.uid()::text,0));
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.admit_social_notification(p_type text,p_recipient text,p_post_id text DEFAULT NULL,p_event_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE
  actor_id text := auth.uid()::text;
  event_key text;
  actual_type text := p_type;
  target_post text;
  post_owner text;
  reply_owner text;
  source_comment public.comments%ROWTYPE;
  notification_id text;
  contextual_message boolean := false;
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='PT401'; END IF;
  IF p_recipient IS NULL OR p_recipient=actor_id
    OR p_recipient !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_type IS NULL OR p_type NOT IN ('message','like','comment','reply','mention','connect','accept','follow','reshare')
    OR (p_event_id IS NOT NULL AND (length(p_event_id) NOT BETWEEN 1 AND 255 OR p_event_id ~ '[[:cntrl:]]'))
    OR (p_post_id IS NOT NULL AND (length(p_post_id) NOT BETWEEN 1 AND 255 OR p_post_id ~ '[[:cntrl:]]')) THEN RETURN false; END IF;
  IF p_type IN ('message','connect','accept','follow') AND p_post_id IS NOT NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('social-notification:'||actor_id,0));

  CASE p_type
    WHEN 'message' THEN
      SELECT id INTO event_key FROM public.messages WHERE id=p_event_id AND from_uid=actor_id AND to_uid=p_recipient FOR KEY SHARE;
      IF pg_catalog.to_regclass('public.story_message_context') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.story_message_context WHERE message_id=$1)'
          INTO contextual_message USING p_event_id;
        IF contextual_message THEN RETURN false; END IF;
      END IF;
    WHEN 'like' THEN
      SELECT id, id INTO event_key,target_post FROM public.posts WHERE id=p_post_id AND author=p_recipient
        AND likes->actor_id='true'::jsonb FOR KEY SHARE;
    WHEN 'comment','reply','mention' THEN
      SELECT * INTO source_comment FROM public.comments WHERE id=p_event_id AND author=actor_id AND post_id=p_post_id FOR KEY SHARE;
      IF NOT FOUND THEN RETURN false; END IF;
      SELECT author INTO post_owner FROM public.posts WHERE id=source_comment.post_id FOR KEY SHARE;
      IF NOT FOUND THEN RETURN false; END IF;
      SELECT author INTO reply_owner FROM public.comments WHERE id=source_comment.parent_id AND post_id=source_comment.post_id FOR KEY SHARE;
      IF p_recipient=post_owner THEN actual_type:='comment';
      ELSIF p_recipient=reply_owner THEN actual_type:='reply';
      ELSIF source_comment.mentions ? p_recipient THEN actual_type:='mention';
      ELSE RETURN false;
      END IF;
      event_key:=source_comment.id; target_post:=source_comment.post_id;
    WHEN 'connect' THEN
      SELECT id||':'||extract(epoch FROM ts)::text INTO event_key FROM public.requests WHERE from_uid=actor_id AND to_uid=p_recipient AND status='pending' FOR KEY SHARE;
    WHEN 'accept' THEN
      SELECT id||':'||extract(epoch FROM ts)::text INTO event_key FROM public.requests WHERE from_uid=p_recipient AND to_uid=actor_id AND status='accepted' FOR KEY SHARE;
    WHEN 'follow' THEN
      SELECT uid INTO event_key FROM public.profiles WHERE uid=actor_id AND data->'following' ? p_recipient FOR KEY SHARE;
    WHEN 'reshare' THEN
      SELECT shared.id,original.id INTO event_key,target_post FROM public.posts shared JOIN public.posts original
        ON original.id=p_post_id AND original.author=p_recipient
        WHERE shared.id='rs_'||actor_id||'__'||p_post_id AND shared.author=actor_id
          AND shared.data->>'reshareOf'=original.id AND shared.data->>'resharedFrom'=original.author FOR KEY SHARE OF shared,original;
    ELSE RETURN false;
  END CASE;
  IF event_key IS NULL THEN RETURN false; END IF;
  notification_id:='n2_'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(actor_id,p_recipient,actual_type,event_key)::text,'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM public.notifications WHERE id=notification_id) THEN RETURN true; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('social-notification-recipient:'||p_recipient,0)) THEN
    RAISE EXCEPTION 'Notification recipient busy; retry later' USING ERRCODE='PT429';
  END IF;
  IF (SELECT count(*) FROM public.notifications WHERE actor=actor_id AND left(id,3)='n2_' AND ts>pg_catalog.clock_timestamp()-interval '1 minute')>=60
    OR (SELECT count(*) FROM public.notifications WHERE actor=actor_id AND left(id,3)='n2_' AND ts>pg_catalog.clock_timestamp()-interval '1 day')>=500
    OR (SELECT count(*) FROM public.notifications WHERE actor=actor_id AND uid=p_recipient AND left(id,3)='n2_' AND ts>pg_catalog.clock_timestamp()-interval '1 minute')>=50
    OR (SELECT count(*) FROM public.notifications WHERE actor=actor_id AND uid=p_recipient AND left(id,3)='n2_' AND ts>pg_catalog.clock_timestamp()-interval '1 day')>=250
    OR (SELECT count(*) FROM public.notifications WHERE uid=p_recipient AND left(id,3)='n2_' AND ts>pg_catalog.clock_timestamp()-interval '1 minute')>=100
    OR (SELECT count(*) FROM public.notifications WHERE uid=p_recipient AND left(id,3)='n2_' AND ts>pg_catalog.clock_timestamp()-interval '1 day')>=1000 THEN
    RAISE EXCEPTION 'Notification action limit reached; try later' USING ERRCODE='PT429';
  END IF;
  INSERT INTO public.notifications(id,uid,type,actor,post_id,body,read)
    VALUES(notification_id,p_recipient,actual_type,actor_id,target_post,NULL,false) ON CONFLICT(id) DO NOTHING;
  RETURN true;
END;
$function$;

CREATE FUNCTION public.emit_source_notifications()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE
  actor_id text := auth.uid()::text;
  recipient text;
  original_post text;
  targets integer := 0;
  previous_following jsonb := '[]'::jsonb;
BEGIN
  IF actor_id IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='messages' THEN
    PERFORM public.admit_social_notification('message',NEW.to_uid,NULL,NEW.id);
  ELSIF TG_TABLE_NAME='requests' THEN
    IF TG_OP='INSERT' THEN PERFORM public.admit_social_notification('connect',NEW.to_uid);
    ELSIF NEW.status='accepted' AND OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM public.admit_social_notification('accept',NEW.from_uid);
    END IF;
  ELSIF TG_TABLE_NAME='comments' THEN
    FOR recipient IN SELECT DISTINCT target FROM (
      SELECT author AS target FROM public.posts WHERE id=NEW.post_id
      UNION ALL SELECT author FROM public.comments WHERE id=NEW.parent_id AND post_id=NEW.post_id
      UNION ALL SELECT value FROM pg_catalog.jsonb_array_elements_text(NEW.mentions)
    ) AS recipients WHERE target IS NOT NULL AND target<>actor_id LIMIT 21 LOOP
      targets:=targets+1;
      IF targets>20 THEN RAISE EXCEPTION 'Too many notification recipients' USING ERRCODE='PT429'; END IF;
      PERFORM public.admit_social_notification('mention',recipient,NEW.post_id,NEW.id);
    END LOOP;
  ELSIF TG_TABLE_NAME='posts' THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.likes->actor_id='true'::jsonb AND OLD.likes->actor_id IS DISTINCT FROM 'true'::jsonb THEN
        PERFORM public.admit_social_notification('like',NEW.author,NEW.id,NEW.id);
      END IF;
    ELSIF NEW.id LIKE 'rs_'||actor_id||'__%' THEN
      original_post:=substr(NEW.id,length('rs_'||actor_id||'__')+1);
      SELECT author INTO recipient FROM public.posts WHERE id=original_post;
      PERFORM public.admit_social_notification('reshare',recipient,original_post,NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='profiles' AND NEW.uid=actor_id THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    previous_following:=coalesce(OLD.data->'following','[]'::jsonb);
    IF pg_catalog.jsonb_typeof(NEW.data->'following')='array' THEN
      IF (SELECT count(*) FROM (
        SELECT DISTINCT value FROM pg_catalog.jsonb_array_elements_text(NEW.data->'following')
        WHERE NOT previous_following ? value LIMIT 21
      ) AS additions)>20 THEN RETURN NEW; END IF;
      FOR recipient IN SELECT DISTINCT value FROM pg_catalog.jsonb_array_elements_text(NEW.data->'following')
        WHERE NOT previous_following ? value LIMIT 21 LOOP
        targets:=targets+1;
        PERFORM public.admit_social_notification('follow',recipient);
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER lock_message_notifications BEFORE INSERT OR UPDATE OR DELETE ON public.messages FOR EACH STATEMENT EXECUTE FUNCTION public.lock_source_notifications();
CREATE TRIGGER lock_comment_notifications BEFORE INSERT OR UPDATE OR DELETE ON public.comments FOR EACH STATEMENT EXECUTE FUNCTION public.lock_source_notifications();
CREATE TRIGGER lock_request_notifications BEFORE INSERT OR UPDATE OR DELETE ON public.requests FOR EACH STATEMENT EXECUTE FUNCTION public.lock_source_notifications();
CREATE TRIGGER lock_post_notifications BEFORE INSERT OR UPDATE OR DELETE ON public.posts FOR EACH STATEMENT EXECUTE FUNCTION public.lock_source_notifications();
CREATE TRIGGER lock_follow_notifications BEFORE INSERT OR UPDATE OR DELETE ON public.profiles FOR EACH STATEMENT EXECUTE FUNCTION public.lock_source_notifications();
CREATE CONSTRAINT TRIGGER notify_message_source AFTER INSERT ON public.messages DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.emit_source_notifications();
CREATE TRIGGER notify_comment_source AFTER INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION public.emit_source_notifications();
CREATE TRIGGER notify_request_source AFTER INSERT OR UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION public.emit_source_notifications();
CREATE TRIGGER notify_post_source AFTER INSERT OR UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.emit_source_notifications();
CREATE TRIGGER notify_follow_source AFTER INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.emit_source_notifications();

REVOKE ALL ON FUNCTION public.admit_social_notification(text,text,text,text),public.emit_source_notifications(),public.lock_source_notifications()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admit_social_notification(text,text,text,text) TO authenticated;

DO $permissions$
DECLARE column_name text; role_name text;
BEGIN
  IF pg_catalog.has_any_column_privilege('authenticated','public.notifications','INSERT')
    OR pg_catalog.has_table_privilege('authenticated','public.notifications','UPDATE')
    OR NOT pg_catalog.has_column_privilege('authenticated','public.notifications','read','UPDATE')
    OR pg_catalog.has_any_column_privilege('anon','public.notifications','SELECT,INSERT,UPDATE')
    OR pg_catalog.has_function_privilege('anon','public.admit_social_notification(text,text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege('service_role','public.admit_social_notification(text,text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.emit_source_notifications()','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.lock_source_notifications()','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected effective notification admission privileges' USING ERRCODE='42501';
  END IF;
  FOREACH column_name IN ARRAY ARRAY['id','uid','type','actor','post_id','body','ts'] LOOP
    IF pg_catalog.has_column_privilege('authenticated','public.notifications',column_name,'UPDATE') THEN
      RAISE EXCEPTION 'Notification references must remain immutable to members' USING ERRCODE='42501';
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF pg_catalog.has_function_privilege(role_name,'public.emit_source_notifications()','EXECUTE')
      OR pg_catalog.has_function_privilege(role_name,'public.lock_source_notifications()','EXECUTE') THEN
      RAISE EXCEPTION 'Notification trigger helpers must not be callable' USING ERRCODE='42501';
    END IF;
  END LOOP;
END;
$permissions$;

COMMIT;