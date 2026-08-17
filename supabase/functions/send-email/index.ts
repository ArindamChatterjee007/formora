// ============================================================
// Supabase Edge Function: send-email
// Sends transactional moderation emails via Resend.
//
// Deploy:
//   supabase functions deploy send-email --no-verify-jwt
// Secrets (set once):
//   supabase secrets set RESEND_API_KEY=re_xxx EMAIL_FROM="Formora <noreply@yourdomain>" MOD_TOKEN=<random-secret>
//
// Call (admin only — must send the x-mod-token header):
//   POST <function-url>  { "to":"user@x.com", "type":"suspended", "name":"Mia", "details":"impersonation" }
// types: content_removed | warning | suspended | verify | custom
// ============================================================
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("EMAIL_FROM") || "Formora <onboarding@resend.dev>";
const MOD_TOKEN = Deno.env.get("MOD_TOKEN"); // shared admin secret; if set, callers must match it

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-mod-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

function esc(s: string) {
  return (s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

function template(type: string, name: string, details: string) {
  const hi = `<p>Hi ${esc(name) || "there"},</p>`;
  const d = details ? ` <span style="color:#b00">(${esc(details)})</span>` : "";
  let subject = "A message from Formora", body = `${hi}<p>${esc(details)}</p>`;
  if (type === "content_removed") {
    subject = "Your Formora content was removed";
    body = `${hi}<p>Some of your content on Formora was <b>removed</b> because it violated our Community Guidelines${d}.</p>
      <p>Please review our rules — repeated violations can lead to your account being suspended.</p>`;
  } else if (type === "warning") {
    subject = "⚠️ A warning from Formora";
    body = `${hi}<p>This is a <b>warning</b>. Your recent activity may violate our Community Guidelines${d}. Please review our rules to avoid further action.</p>`;
  } else if (type === "suspended") {
    subject = "Your Formora account has been suspended";
    body = `${hi}<p>Your Formora account has been <b>suspended</b> for violating our Community Guidelines${d}, and your content has been removed.</p>
      <p>If you believe this is a mistake, you can <b>appeal by verifying your identity</b> — just reply to this email.</p>`;
  } else if (type === "verify") {
    subject = "Please verify your identity on Formora";
    body = `${hi}<p>To keep Formora authentic, please <b>verify your identity</b>. Reply to this email with a photo of your ID or a selfie that matches your profile.</p>`;
  } else if (type === "code") {
    subject = "Your Formora verification code";
    body = `${hi}<p>Your Formora verification code is:</p>
      <div style="font-size:30px;font-weight:800;letter-spacing:8px;background:#faf7f5;border:1px solid #eee;border-radius:12px;padding:16px 8px;text-align:center;margin:14px 0">${esc(details)}</div>
      <p style="color:#888;font-size:13px">Enter this code to verify your email. It expires shortly. If you didn't request it, ignore this email.</p>`;
  }
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:auto">
    <div style="background:linear-gradient(135deg,#ff9d4d,#ff3d7f);padding:20px 24px;border-radius:14px 14px 0 0;color:#fff">
      <div style="font-weight:800;letter-spacing:2px;font-size:20px">FORM<span style="opacity:.85">ORA</span></div>
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 14px 14px;padding:24px;color:#1a1a1a;line-height:1.6">
      ${body}
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
      <div style="font-size:12px;color:#888">Formora · Train. Track. Connect.<br>You can reply to this email to contact the moderation team.</div>
    </div></div>`;
  return { subject, html };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    if (MOD_TOKEN && req.headers.get("x-mod-token") !== MOD_TOKEN) return json({ error: "unauthorized" }, 401);
    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 500);
    const { to, type, name, details } = await req.json();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "valid 'to' email required" }, 400);
    const { subject, html } = template(type || "custom", name || "", details || "");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, reply_to: "support@formora.app" }),
    });
    const data = await r.json();
    return json({ ok: r.ok, id: data.id, error: r.ok ? undefined : data }, r.ok ? 200 : 502);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
