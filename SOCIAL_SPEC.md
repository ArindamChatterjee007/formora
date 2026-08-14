# Formora — Social Layer Spec (v36)

Architecture note: static vanilla JS front-end (GitHub Pages) + Supabase (Postgres + REST).
Shared social data lives in Supabase; personal logs stay in localStorage and sync per-account.

## Data model (Supabase)
- profiles(uid, data jsonb {name,username,avatar,physique,bio,streak,socials}, updated_at)
- posts(id, author, data jsonb {text,photo,gradient,tag}, likes jsonb {uid:true}, ts)
- requests(id = from__to, from_uid, to_uid, status pending|accepted, ts)
- accounts(uid, data jsonb = full personal Store.state, updated_at)   — cross-device sync
- **comments(id, post_id, author, body, parent_id, mentions jsonb, ts)** — threaded (parent_id=null → top-level; else a reply)
- **notifications(id, uid recipient, type, actor, post_id, body, ts, read bool)** — types: like, comment, reply, mention, connect, accept

## RPCs
- get_state() → {users, posts, requests, comments}  (comments grouped for the feed)
- like_post(p_id,p_uid) / unlike_post(p_id,p_uid)

## Features
1. Comments — cloud-synced; anyone connected/viewing sees them. Post shows count + thread.
2. Replies — one level of threading under a comment.
3. @mentions — type @handle; mentions highlighted + notify the mentioned user.
4. Notifications — bell in top bar with unread badge; panel lists like/comment/reply/mention/connect/accept; tap marks read + opens context.
5. Profile tabs — Progress (own graph), Posts (grid/list), Clips (media-only posts, Formora name = "Flex Clips").
6. Animations — unique per action: heart pop (like), ripple (buttons), slide/fade (cards, modal, toast), bell shake (new notif).

## Content naming (branded)
- Photo/video posts surfaced under **"Clips"** tab (our reels/shorts equivalent).

## QA scenarios (must pass, multi-account)
- Comment appears cross-user; reply nests; mention highlights + notifies.
- Like/unlike updates notif; connect/accept notif both sides.
- Notif unread badge increments; mark-read clears.
- Profile tabs switch; own shows graph; others show posts/clips.
- No JS errors; 31/31 unit tests; login never blocks.
