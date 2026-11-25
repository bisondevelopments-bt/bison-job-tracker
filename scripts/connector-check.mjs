// Live check (v2: more detail on email) of the Job Tracker connector (read-only). Run by .github/workflows/connector-check.yml.
// It uses a temporary link for the office login that the workflow makes and then turns off again.
// Output goes to stdout as JSON; the workflow encrypts it before it reaches the public log.
import { ImapFlow } from "imapflow";

const BASE = process.env.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/jt-mcp";
const LINK = BASE + "/k/" + process.env.CHECK_TOKEN;
const out = { at: new Date().toISOString() };
let id = 0;
async function rpc(method, params, url = LINK) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t: t.slice(0, 400) };
}
async function tool(name, args = {}) {
  const t0 = Date.now(), r = await rpc("tools/call", { name, arguments: args });
  const res = r.j && r.j.result, text = res ? (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") : r.t;
  return { ms: Date.now() - t0, status: r.status, error: !res || !!res.isError, text, data: res && res.structuredContent, content: res && res.content };
}
const safe = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { crash: String(e && e.message || e).slice(0, 300), step: out._step, response: e && (e.responseText || e.response), code: e && (e.serverResponseCode || e.code), auth: e && e.authenticationFailed }; } };

await safe("initialize", async () => { const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } }); return { status: r.status, server: r.j?.result?.serverInfo, proto: r.j?.result?.protocolVersion, err: r.j?.error || (r.j ? undefined : r.t) }; });
await safe("tools", async () => { const r = await rpc("tools/list", {}); return r.j?.result?.tools?.map((t) => t.name) || r.t; });
await safe("whoami", async () => { const r = await tool("whoami"); return r.error ? r.text : r.data; });
let homes = [];
await safe("list_homes", async () => { const r = await tool("list_homes", { stage: "all" }); homes = r.data?.homes || []; return r.error ? r.text : { ms: r.ms, count: r.data.count, sample: homes.slice(0, 3) }; });
await safe("get_home", async () => {
  const h = homes.find((x) => /Active/.test(x.stage)); if (!h) return "no active homes";
  const r = await tool("get_home", { home: h.id }); if (r.error) return r.text;
  return { ms: r.ms, name: r.data.name, progress: r.data.progress, phases: r.data.phases?.map((p) => `${p.phase}: ${p.tasks.length}`), docs: r.data.documents?.length, notes: r.data.notes?.length };
});
await safe("find_tasks", async () => { const r = await tool("find_tasks", { status: "inspection_pending" }); return r.error ? r.text : { ms: r.ms, count: r.data.count, sample: r.data.tasks.slice(0, 3) }; });
let docs = [];
await safe("list_documents", async () => { const r = await tool("list_documents", {}); docs = r.data?.documents || []; return r.error ? r.text : { ms: r.ms, count: r.data.count, financial: docs.filter((d) => d.financial).length }; });
await safe("get_document", async () => {
  const d = docs.find((x) => x.type === "application/pdf"); if (!d) return "no pdf";
  const r = await tool("get_document", { document_id: d.document_id });
  return { ms: r.ms, error: r.error, name: d.name, chars: r.text.length, has_link: /link works/.test(r.text), start: r.text.slice(0, 160).replace(/https?:\S+/g, "<link>") };
});
await safe("list_contacts", async () => { const r = await tool("list_contacts", {}); return r.error ? r.text : { count: r.data.count }; });
await safe("list_people", async () => { const r = await tool("list_people", {}); return r.error ? r.text : r.data.people.length; });
await safe("bad_link", async () => (await rpc("tools/list", {}, BASE + "/k/not-a-real-link-not-a-real-link-xyz")).status);

// Email: find a recent message with a PDF in the Bison Gmail, then ask the connector about it by its Gmail id.
await safe("email", async () => {
  const c = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }, logger: false });
  out._step = "connect"; await c.connect();
  out._step = "list"; out.mailboxes = (await c.list()).map((m) => m.path + (m.specialUse ? " " + m.specialUse : ""));
  let gid = null;
  try {
    out._step = "open"; const all = (await c.list()).find((m) => m.specialUse === "\\All") ; const lock = await c.getMailboxLock(all ? all.path : "INBOX");
    try {
      out._step = "search"; const uids = await c.search({ since: new Date(Date.now() - 20 * 86400000) }, { uid: true });
      for (const uid of (uids || []).slice(-60).reverse()) {
        const m = await c.fetchOne(String(uid), { bodyStructure: true, emailId: true }, { uid: true });
        const has = JSON.stringify(m.bodyStructure || {}).toLowerCase().includes("pdf");
        if (has) { gid = BigInt(m.emailId).toString(16); break; }
      }
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
  if (!gid) return "no recent email with a PDF";
  const r = await tool("email_attachments", { gmail_message_id: gid });
  return { ms: r.ms, error: r.error, attachments: r.data?.attachments?.map((a) => ({ i: a.index, type: a.type, kb: a.size_kb, text: (a.text_start || "").length })) || r.text.slice(0, 400) };
});
console.log(JSON.stringify(out, null, 1));
