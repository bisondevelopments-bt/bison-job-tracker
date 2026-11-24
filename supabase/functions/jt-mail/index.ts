// Job Tracker email: sends from the shared Bison Gmail using an app password.
// Secrets: GMAIL_USER (bisondevelopments@gmail.com), GMAIL_APP_PASSWORD, optional MAIL_SIGNATURE.
import nodemailer from "npm:nodemailer@6.9.14";
import { cors, json, requirePerson } from "../_shared/auth.ts";

const user = Deno.env.get("GMAIL_USER") || "bisondevelopments@gmail.com";
const transport = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465, // Supabase blocks 25 and 587; 465 (SSL) is allowed.
  secure: true,
  auth: { user, pass: Deno.env.get("GMAIL_APP_PASSWORD") || "" },
});
const SIGNATURE = Deno.env.get("MAIL_SIGNATURE") || "";
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const who = await requirePerson(req, ["admin", "project_manager", "field_supervisor"]);
  if (!who) return json({ code: "not_granted", message: "Your role can't send email from the Job Tracker." }, 403);
  try {
    const a = await req.json();
    const to = (Array.isArray(a.to) ? a.to : String(a.to || "").split(/[,;\s]+/)).map((x: string) => x.trim()).filter(Boolean);
    const cc = (Array.isArray(a.cc) ? a.cc : String(a.cc || "").split(/[,;\s]+/)).map((x: string) => x.trim()).filter(Boolean);
    if (!to.length || ![...to, ...cc].every(isEmail)) return json({ code: "tool_error", message: "Add a valid email address." }, 400);
    const text = String(a.body || "") + (a.includeSignature && SIGNATURE ? "\n\n" + SIGNATURE : "");
    const attachments = (a.attachments || []).slice(0, 10).map((f: { content: string; filename: string; mimeType?: string }) => ({
      filename: f.filename, content: f.content, encoding: "base64", contentType: f.mimeType || "application/octet-stream",
    }));
    const info = await transport.sendMail({ from: `Bison Developments <${user}>`, to, cc: cc.length ? cc : undefined, subject: String(a.subject || ""), text, attachments });
    return json({ ok: true, id: info.messageId });
  } catch (e) {
    return json({ code: "tool_error", message: (e as Error).message || "Couldn't send" }, 502);
  }
});
