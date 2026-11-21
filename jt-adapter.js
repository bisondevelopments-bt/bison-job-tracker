/* Bison Job Tracker: Supabase adapter.
   The tracker was built against Claude's artifact runtime (window.claude.use("db" | "assets" | "sample" | "mcp" | "downloads")).
   This file provides the same calls, backed by Supabase, so the app code stays the same:
     db        -> table jt_docs (one row per record), live updates over Supabase Realtime
     assets    -> private storage bucket jt-files; files are served at blob/<id> by sw.js
     sample    -> server function jt-ai (AI key stays on the server; provider is a setting there)
     mcp Gmail -> server function jt-mail (sends from the shared Bison Gmail)
     downloads -> a normal browser download
   It also shows the sign-in screen before the app loads its data. */
(function () {
  "use strict";
  const CFG = window.JT_CONFIG || {};
  const sb = window.supabase.createClient(CFG.url, CFG.anon, { auth: { persistSession: true, autoRefreshToken: true } });
  window.jtSupabase = sb;

  /* ---------- sign-in ---------- */
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const okUser = (s) => !!(s && s.user && s.user.app_metadata && s.user.app_metadata.jt === true);

  function loginScreen(msg) {
    let el = document.getElementById("jt-login");
    if (!el) {
      el = document.createElement("div");
      el.id = "jt-login";
      el.innerHTML = `<style>
#jt-login{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:#1D2733;font:16px/1.45 "Barlow",system-ui,-apple-system,sans-serif;padding:16px}
#jt-login form{background:#fff;color:#1D2733;border-radius:12px;padding:28px 24px;width:min(380px,100%);display:grid;gap:14px;box-shadow:0 20px 50px rgba(0,0,0,.35)}
#jt-login .b{display:flex;align-items:center;gap:10px;font:700 24px "Barlow Semi Condensed","Barlow",system-ui,sans-serif}
#jt-login .m{width:32px;height:32px;background:#F5B700;border-radius:5px;display:grid;place-items:center;font-size:19px}
#jt-login label{display:grid;gap:5px;font-size:14px;font-weight:600;color:#5C6975}
#jt-login input{font:inherit;color:#1D2733;border:1px solid #D2D8D5;border-radius:6px;padding:10px 12px}
#jt-login input:focus{outline:3px solid #F5B700;outline-offset:1px}
#jt-login button{font:inherit;font-weight:700;border:0;border-radius:6px;padding:11px;background:#F5B700;color:#1D2733;cursor:pointer}
#jt-login button:disabled{opacity:.6}
#jt-login p{margin:0;font-size:14px;min-height:20px;color:#B83227}</style>
<form autocomplete="on"><div class="b"><span class="m">J</span>Job Tracker</div>
<label>Email<input id="jt-email" type="email" autocomplete="username" required></label>
<label>Password<input id="jt-pass" type="password" autocomplete="current-password" required></label>
<button id="jt-go">Sign in</button><p id="jt-msg" role="alert"></p></form>`;
      document.body.appendChild(el);
      el.querySelector("#jt-email").value = CFG.teamEmail || "";
      el.querySelector("form").onsubmit = async (e) => {
        e.preventDefault();
        const btn = el.querySelector("#jt-go"), m = el.querySelector("#jt-msg");
        btn.disabled = true; btn.textContent = "Signing in…"; m.textContent = "";
        const { data, error } = await sb.auth.signInWithPassword({
          email: el.querySelector("#jt-email").value.trim(), password: el.querySelector("#jt-pass").value,
        });
        btn.disabled = false; btn.textContent = "Sign in";
        if (error) { m.textContent = "That email or password didn't work."; return; }
        if (!okUser(data.session)) { m.textContent = "This login isn't set up for the Job Tracker."; await sb.auth.signOut(); return; }
        el.remove(); start(data.session);
      };
    }
    if (msg) el.querySelector("#jt-msg").textContent = msg;
    setTimeout(() => (el.querySelector(CFG.teamEmail ? "#jt-pass" : "#jt-email") || {}).focus?.(), 50);
  }

  /* ---------- service worker: serves uploaded files at blob/<id> with the sign-in token ---------- */
  let swReady = Promise.resolve();
  async function sendToken(s) {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const msg = { type: "jt-auth", token: s ? s.access_token : null, cfg: { url: CFG.url, anon: CFG.anon } };
    (navigator.serviceWorker.controller || reg.active)?.postMessage(msg);
  }
  if ("serviceWorker" in navigator) {
    swReady = navigator.serviceWorker.register("sw.js").then(() => {
      if (navigator.serviceWorker.controller) return;
      return new Promise((r) => { navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }); setTimeout(r, 4000); });
    }).catch((e) => console.warn("File viewer unavailable:", e));
    navigator.serviceWorker.addEventListener("message", async (e) => {
      if (e.data && e.data.type === "jt-need-token" && e.ports[0]) {
        const { data } = await sb.auth.getSession();
        e.ports[0].postMessage({ token: data.session ? data.session.access_token : null });
      }
    });
  }

  async function start(session) {
    await swReady;
    await sendToken(session);
    resolveReady(session);
  }
  sb.auth.onAuthStateChange((evt, s) => {
    if (evt === "TOKEN_REFRESHED" || evt === "SIGNED_IN") sendToken(s);
    if (evt === "SIGNED_OUT") { sendToken(null); location.reload(); }
  });
  window.jtSignOut = () => sb.auth.signOut();
  if (/[?&]logout\b/.test(location.search)) sb.auth.signOut();

  const boot = async () => {
    const { data } = await sb.auth.getSession();
    if (okUser(data.session)) start(data.session); else loginScreen();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  /* ---------- helpers ---------- */
  const err = (code, message) => Object.assign(new Error(message || code), { code, message: message || code });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const rid = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };
  const hex32 = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); };
  function deepMerge(a, b) {
    if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return clone(b);
    const r = { ...a };
    for (const k of Object.keys(b)) {
      const v = b[k];
      r[k] = v && typeof v === "object" && !Array.isArray(v) && r[k] && typeof r[k] === "object" && !Array.isArray(r[k]) ? deepMerge(r[k], v) : clone(v);
    }
    return r;
  }
  const split = (path) => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };
  const dbErr = (e) => err(/quota|limit/i.test(e && e.message) ? "quota_exceeded" : e && (e.code === "42501" || e.status === 401) ? "not_granted" : "unavailable", e && e.message);

  /* ---------- db ---------- */
  const cache = new Map();      // coll -> Map(id -> data)
  const loading = new Map();    // coll -> Promise
  const collSubs = new Map();   // coll -> Set(fn)
  const docSubs = new Map();    // "coll/id" -> Set(fn)
  let channel = null;

  async function loadColl(coll) {
    if (cache.has(coll)) return;
    if (!loading.has(coll)) loading.set(coll, (async () => {
      const m = new Map();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("jt_docs").select("id,data").eq("coll", coll).range(from, from + 999);
        if (error) throw dbErr(error);
        data.forEach((r) => m.set(r.id, r.data));
        if (data.length < 1000) break;
      }
      cache.set(coll, m);
    })().finally(() => loading.delete(coll)));
    return loading.get(coll);
  }
  async function resync() {
    const colls = [...cache.keys()];
    cache.clear();
    for (const c of colls) { await loadColl(c).catch(() => {}); notify(c, null); }
  }
  function ensureChannel() {
    if (channel) return;
    let dropped = false;
    channel = sb.channel("jt-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "jt_docs" }, (p) => {
        const row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row || !cache.has(row.coll)) return;
        if (p.eventType === "DELETE") cache.get(row.coll).delete(row.id); else cache.get(row.coll).set(row.id, row.data);
        notify(row.coll, row.id);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && dropped) { dropped = false; resync(); }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") dropped = true;
      });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && dropped) resync(); });
  }
  const collSnap = (coll) => {
    const m = cache.get(coll) || new Map();
    const docs = [...m].map(([id, d]) => ({ id, exists: true, data: () => clone(d) }));
    return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
  };
  const docSnap = (coll, id) => {
    const d = cache.get(coll)?.get(id);
    return { id, exists: d !== undefined, data: () => clone(d) };
  };
  function notify(coll, id) {
    queueMicrotask(() => {
      (collSubs.get(coll) || []).forEach((f) => { try { f(collSnap(coll)); } catch (e) { console.error(e); } });
      for (const [k, set] of docSubs) {
        const [c, i] = split(k);
        if (c === coll && (id === null || i === id)) set.forEach((f) => { try { f(docSnap(c, i)); } catch (e) { console.error(e); } });
      }
    });
  }
  const local = (coll, id, data) => { const m = cache.get(coll); if (!m) return; if (data === undefined) m.delete(id); else m.set(id, data); notify(coll, id); };

  function collection(coll) {
    return {
      async add(data) {
        const id = rid(20);
        local(coll, id, clone(data));
        const { error } = await sb.from("jt_docs").insert({ coll, id, data });
        if (error) { local(coll, id, undefined); throw dbErr(error); }
        return { id };
      },
      doc: (id) => doc(coll + "/" + id),
      async get() { await loadColl(coll); return collSnap(coll); },
      onSnapshot(fn, onErr) {
        if (!collSubs.has(coll)) collSubs.set(coll, new Set());
        collSubs.get(coll).add(fn);
        ensureChannel();
        loadColl(coll).then(() => fn(collSnap(coll)), (e) => onErr && onErr(e));
        return () => collSubs.get(coll).delete(fn);
      },
    };
  }
  function doc(path) {
    const [coll, id] = split(path);
    return {
      id,
      async get() { await loadColl(coll); return docSnap(coll, id); },
      async set(data) {
        const before = cache.get(coll)?.get(id);
        local(coll, id, clone(data));
        const { error } = await sb.from("jt_docs").upsert({ coll, id, data });
        if (error) { local(coll, id, before); throw dbErr(error); }
      },
      async update(patch) {
        const before = cache.get(coll)?.get(id);
        local(coll, id, deepMerge(before || {}, patch));
        const { data, error } = await sb.rpc("jt_patch", { p_coll: coll, p_id: id, p_patch: patch });
        if (error) { local(coll, id, before); throw dbErr(error); }
        local(coll, id, data);
      },
      async delete() {
        const before = cache.get(coll)?.get(id);
        local(coll, id, undefined);
        const { error } = await sb.from("jt_docs").delete().eq("coll", coll).eq("id", id);
        if (error) { local(coll, id, before); throw dbErr(error); }
      },
      onSnapshot(fn, onErr) {
        if (!docSubs.has(path)) docSubs.set(path, new Set());
        docSubs.get(path).add(fn);
        ensureChannel();
        loadColl(coll).then(() => fn(docSnap(coll, id)), (e) => onErr && onErr(e));
        return () => docSubs.get(path).delete(fn);
      },
    };
  }
  const dbApi = Object.freeze({ collection, doc });

  /* ---------- assets (file storage) ---------- */
  const bucket = () => sb.storage.from("jt-files");
  const assetsApi = Object.freeze({
    async upload(blob, opts = {}) {
      if (blob.size > 25 * 1024 * 1024) throw err("too_large", "File is over 25 MB");
      const id = hex32(), contentType = opts.type || blob.type || "application/octet-stream";
      const { error } = await bucket().upload(id, blob, { contentType, upsert: false });
      if (error) throw err(/size/i.test(error.message) ? "too_large" : "quota_or_state", error.message);
      return { id, url: "blob/" + id, contentType, sizeBytes: blob.size };
    },
    async delete(id) { const { error } = await bucket().remove([id]); if (error) throw err("unavailable", error.message); },
    async list() {
      const { data, error } = await bucket().list("", { limit: 1000 });
      if (error) throw err("unavailable", error.message);
      return { assets: data.map((f) => ({ id: f.name, url: "blob/" + f.name, sizeBytes: f.metadata?.size, contentType: f.metadata?.mimetype })), usage: {} };
    },
  });

  /* ---------- server functions ---------- */
  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let info = {};
      try { info = await error.context.json(); } catch (_) {}
      throw err(info.code || "unavailable", info.message || error.message);
    }
    return data;
  }

  /* ---------- sample (AI) ---------- */
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  function parseJSON(t) {
    const s = String(t || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    try { return JSON.parse(s); } catch (_) {}
    const m = s.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    throw err("invalid_json", "The answer wasn't valid JSON");
  }
  async function run(input, opts, wantJson) {
    opts = opts || {};
    const sig = opts.signal;
    const stop = () => { if (sig && sig.aborted) throw err("cancelled", "Stopped"); };
    let msgs = typeof input === "string" ? [{ role: "user", content: input }] : input.map((m) => ({ role: m.role, content: String(m.content) }));
    if (opts.images) {
      const list = opts.images instanceof Blob ? [opts.images] : Array.from(opts.images);
      const imgs = await Promise.all(list.slice(0, 5).map(async (b) => ({ media_type: b.type || "image/jpeg", data: await b64(b) })));
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { msgs[i].images = imgs; break; }
    }
    const tools = (opts.tools || []).map((t) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object", properties: {} } }));
    let text = "", truncated = false;
    for (let round = 0; round < 8; round++) {
      stop();
      const r = await callFn("jt-ai", { messages: msgs, tools, tier: opts.modelTier || "default", json: !!wantJson });
      stop();
      text = r.text || "";
      truncated = r.stop === "truncated";
      if (!r.tool_calls || !r.tool_calls.length) break;
      msgs = msgs.concat([{ role: "assistant", content: text, tool_calls: r.tool_calls }]);
      for (const c of r.tool_calls) {
        const t = (opts.tools || []).find((x) => x.name === c.name);
        let out;
        try { out = t ? await t.execute(c.input || {}, { signal: sig }) : { error: "No such tool" }; }
        catch (e) { out = { error: String((e && e.message) || e) }; }
        msgs.push({ role: "tool", tool_call_id: c.id, content: typeof out === "string" ? out : JSON.stringify(out === undefined ? null : out) });
      }
    }
    if (opts.onText && text) opts.onText({ text, delta: text });
    return { text, truncated, modelTierApplied: opts.modelTier || "default" };
  }
  const sampleApi = Object.assign((input, opts) => run(input, opts, false), {
    json: async (input, opts) => parseJSON((await run(input, opts, true)).text),
    limits: async () => ({ maxInputBytes: 65536, images: { maxCount: 5, maxBytes: 5 * 1024 * 1024, mediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] }, tools: true }),
  });

  /* ---------- mcp (Gmail send) ---------- */
  async function callTool(server, tool, args) {
    if (server === "Gmail" && tool === "send_message") return { payload: await callFn("jt-mail", args || {}) };
    throw err("server_not_connected", `${server} isn't connected in this app`);
  }
  const mcpApi = Object.freeze({ callTool, server: async (name) => new Proxy({}, { get: (_, t) => (args) => callTool(name, t, args).then((r) => r.payload) }) });

  /* ---------- downloads ---------- */
  const downloadsApi = Object.freeze({
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || "application/octet-stream" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { saved: true };
    },
  });

  const APIS = { db: dbApi, assets: assetsApi, sample: sampleApi, mcp: mcpApi, downloads: downloadsApi };
  window.claude = Object.freeze({ use: (name) => ready.then(() => APIS[name] || null) });
})();
