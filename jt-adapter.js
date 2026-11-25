/* Bison Job Tracker: connection to the Bison hub (Supabase).
   The tracker was built against Claude's artifact runtime (window.claude.use("db" | "assets" | "sample" | "mcp" | "downloads")).
   This file provides the same calls, backed by the hub's shared tables, so the app code stays almost the same:
     app "jobs"      -> shared jobs table (stage active/archived) + jt_job_details + shared documents
     app "pipeline"  -> shared jobs table (stage under_contract): the same ID carries through when the build starts
     app "contacts"  -> shared vendors table
     app config/team -> shared people table (read-only here; admins manage people on people.html)
     everything else -> jt_docs (templates, document library, areas, inbox)
     assets          -> storage bucket "documents"; files are served at blob/<id> by sw.js
     sample / mcp    -> server functions jt-ai / jt-mail
   It also handles sign-in: each person has their own login, and the database decides what their role may see and change. */
(function () {
  "use strict";
  const CFG = window.JT_CONFIG || {};
  // Invite and password-reset links land here with #...type=invite|recovery; note it before the client reads the link.
  const LINK_TYPE = ((location.hash || "").match(/type=(invite|recovery|signup|magiclink)/) || [])[1] || "";
  const sb = window.supabase.createClient(CFG.url, CFG.anon, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  window.jtSupabase = sb;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  // The app reads its "You are" name as it starts, so set it from the last signed-in person right away.
  if (lsGet("jt_person_name") && !lsGet("jt_me_set_" + lsGet("jt_person_id"))) {
    lsSet("jt_me", lsGet("jt_person_name")); lsSet("jt_me_set_" + lsGet("jt_person_id"), "1");
  }

  const ROLE_LABEL = { admin: "Admin", project_manager: "Project manager", field_supervisor: "Field supervisor", accounting: "Accounting" };
  const hub = { me: null, role: null, ready: null };
  window.jtHub = hub;

  /* ---------- sign-in screens ---------- */
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  hub.ready = ready;

  const STYLE = `<style>
#jt-login{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:#1D2733;font:16px/1.45 "Barlow",system-ui,-apple-system,sans-serif;padding:16px;overflow:auto}
#jt-login form{background:#fff;color:#1D2733;border-radius:12px;padding:28px 24px;width:min(380px,100%);display:grid;gap:14px;box-shadow:0 20px 50px rgba(0,0,0,.35)}
#jt-login .b{display:flex;align-items:center;gap:10px;font:700 24px "Barlow Semi Condensed","Barlow",system-ui,sans-serif}
#jt-login .m{width:32px;height:32px;background:#F5B700;border-radius:5px;display:grid;place-items:center;font-size:19px}
#jt-login label{display:grid;gap:5px;font-size:14px;font-weight:600;color:#5C6975}
#jt-login input{font:inherit;color:#1D2733;border:1px solid #D2D8D5;border-radius:6px;padding:10px 12px}
#jt-login input:focus{outline:3px solid #F5B700;outline-offset:1px}
#jt-login button{font:inherit;font-weight:700;border:0;border-radius:6px;padding:11px;background:#F5B700;color:#1D2733;cursor:pointer}
#jt-login button.link{background:none;padding:0;font-weight:600;color:#2F5F8A;justify-self:start;font-size:14px}
#jt-login button:disabled{opacity:.6}
#jt-login p{margin:0;font-size:14px;min-height:20px;color:#B83227}#jt-login p.ok{color:#2E7D4F}
#jt-login .note{color:#5C6975;font-size:14px;margin:-6px 0 0}</style>`;
  const BRAND = `<div class="b"><span class="m">J</span>Job Tracker</div>`;
  function screen(html) {
    let el = document.getElementById("jt-login");
    if (!el) { el = document.createElement("div"); el.id = "jt-login"; document.body.appendChild(el); }
    el.innerHTML = STYLE + html;
    return el;
  }
  function loginScreen(msg) {
    const el = screen(`<form autocomplete="on">${BRAND}
<label>Email<input id="jt-email" type="email" autocomplete="username" required></label>
<label>Password<input id="jt-pass" type="password" autocomplete="current-password" required></label>
<button id="jt-go">Sign in</button><button type="button" class="link" id="jt-forgot">Forgot your password?</button><p id="jt-msg" role="alert"></p></form>`);
    const m = el.querySelector("#jt-msg");
    if (msg) m.textContent = msg;
    el.querySelector("#jt-email").value = lsGet("jt_last_email") || "";
    el.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const btn = el.querySelector("#jt-go");
      const email = el.querySelector("#jt-email").value.trim();
      btn.disabled = true; btn.textContent = "Signing in…"; m.textContent = "";
      const { data, error } = await sb.auth.signInWithPassword({ email, password: el.querySelector("#jt-pass").value });
      btn.disabled = false; btn.textContent = "Sign in";
      if (error) { m.textContent = "That email or password didn't work."; return; }
      lsSet("jt_last_email", email);
      afterSignIn(data.session, true);
    };
    el.querySelector("#jt-forgot").onclick = async () => {
      const email = el.querySelector("#jt-email").value.trim();
      if (!email) { m.textContent = "Type your email above first."; return; }
      await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      m.className = "ok"; m.textContent = "If that email is on the team, a link to set a new password is on its way.";
    };
    setTimeout(() => el.querySelector(lsGet("jt_last_email") ? "#jt-pass" : "#jt-email").focus(), 50);
  }
  function setPasswordScreen(session, kind) {
    const el = screen(`<form autocomplete="on">${BRAND}
<p class="note">${kind === "invite" ? "Welcome! Choose a password for your Job Tracker sign-in." : "Choose a new password."}</p>
<input type="email" autocomplete="username" value="${(session.user.email || "").replace(/"/g, "")}" hidden>
<label>New password<input id="jt-p1" type="password" autocomplete="new-password" minlength="8" required></label>
<label>Type it again<input id="jt-p2" type="password" autocomplete="new-password" minlength="8" required></label>
<button id="jt-go">Save password</button><p id="jt-msg" role="alert"></p></form>`);
    const m = el.querySelector("#jt-msg");
    el.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const p1 = el.querySelector("#jt-p1").value, p2 = el.querySelector("#jt-p2").value;
      if (p1 !== p2) { m.textContent = "The two passwords don't match."; return; }
      if (p1.length < 8) { m.textContent = "Use at least 8 characters."; return; }
      const { error } = await sb.auth.updateUser({ password: p1 });
      if (error) { m.textContent = error.message || "Couldn't save the password."; return; }
      lsSet("jt_last_email", session.user.email || "");
      history.replaceState(null, "", location.pathname + location.search);
      afterSignIn(session, true);
    };
    setTimeout(() => el.querySelector("#jt-p1").focus(), 50);
  }

  async function afterSignIn(session, fresh) {
    const { data: me, error } = await sb.rpc("hub_me");
    const person = me && (Array.isArray(me) ? me[0] : me);
    if (error || !person || !person.id) {
      await sb.auth.signOut({ scope: "local" });
      loginScreen("Your sign-in works, but you're not on the team list yet. Ask an admin to add you.");
      return;
    }
    hub.me = person; hub.role = person.role;
    const changed = lsGet("jt_person_id") !== person.id;
    lsSet("jt_person_id", person.id); lsSet("jt_person_name", person.name);
    if (fresh && changed) {
      // The app picks up who is signed in as it starts, so start it fresh for a new person.
      lsSet("jt_me", person.work_role ? person.name : ""); lsSet("jt_me_set_" + person.id, "1");
      location.replace(location.pathname + location.search);
      return;
    }
    const el = document.getElementById("jt-login"); if (el) el.remove();
    await swReady; await sendToken(session);
    try { await loadAll(); } catch (e) { console.error(e); }
    ensureChannel();
    resolveReady(session);
    decorate();
  }
  sb.auth.onAuthStateChange((evt, s) => {
    if (evt === "TOKEN_REFRESHED" || evt === "SIGNED_IN") sendToken(s);
    if (evt === "SIGNED_OUT") { sendToken(null); lsSet("jt_person_id", ""); lsSet("jt_person_name", ""); location.replace(location.pathname); }
  });
  hub.signOut = () => sb.auth.signOut();
  if (/[?&]logout\b/.test(location.search)) sb.auth.signOut();

  const boot = async () => {
    const { data } = await sb.auth.getSession();
    const s = data.session;
    if (s && (LINK_TYPE === "invite" || LINK_TYPE === "recovery")) return setPasswordScreen(s, LINK_TYPE);
    if (s) afterSignIn(s, false); else loginScreen();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  // Small additions to the app once it's running: who's signed in, read-only notice, People page for admins.
  function decorate() {
    const add = () => {
      if (hub.role === "admin" && typeof MENU !== "undefined" && !MENU.some((x) => x.go === "people")) {
        MENU.push({ go: "people", label: "People & sign-ins", hint: "Add people, set roles, send sign-in invites",
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/></svg>` });
      }
      if (typeof MENU !== "undefined" && !MENU.some((x) => x.go === "connect")) {
        MENU.push({ go: "connect", label: "Connect Claude or Grok", hint: "Your private link for AI assistants",
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>` });
      }
      if (typeof MENU !== "undefined" && !MENU.some((x) => x.go === "signout")) {
        MENU.push({ go: "signout", label: "Sign out", hint: `Signed in as ${hub.me.name} (${ROLE_LABEL[hub.role]})`,
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/></svg>` });
      }
    };
    add(); setTimeout(add, 500);
    document.addEventListener("click", (e) => {
      const g = e.target.closest && e.target.closest("[data-menugo]");
      if (!g) return;
      if (g.dataset.menugo === "people") { e.stopImmediatePropagation(); location.href = "people.html"; }
      if (g.dataset.menugo === "signout") { e.stopImmediatePropagation(); hub.signOut(); }
      if (g.dataset.menugo === "connect") { e.stopImmediatePropagation(); location.href = "connect.html"; }
    }, true);
    if (hub.role === "accounting") {
      const b = document.createElement("div");
      b.textContent = "Read-only: accounting can view jobs here but not change them.";
      b.style.cssText = "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:50;background:#1D2733;color:#fff;font:600 13px system-ui,sans-serif;padding:6px 12px;border-radius:14px;opacity:.9;pointer-events:none";
      document.body.appendChild(b);
    }
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

  /* ---------- helpers ---------- */
  const err = (code, message) => Object.assign(new Error(message || code), { code, message: message || code });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const rid = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); };
  const hex32 = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); };
  function deepMerge(a, b) {
    if (!isObj(a) || !isObj(b)) return clone(b);
    const r = { ...a };
    for (const k of Object.keys(b)) r[k] = isObj(b[k]) && isObj(r[k]) ? deepMerge(r[k], b[k]) : clone(b[k]);
    return r;
  }
  const split = (path) => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };
  const dbErr = (e) => err(/quota|limit/i.test(e && e.message) ? "quota_exceeded" : e && (e.code === "42501" || /row-level security|permission/i.test(e.message || "")) ? "not_granted" : "unavailable", e && e.message);
  const blank = (v) => v === undefined || v === null || v === "";
  const nul = (v) => (blank(v) ? null : v);
  const pick = (o, keys) => keys.some((k) => k in o);
  function canEdit(table) {
    if (!hub.role) throw err("not_granted", "Not signed in");
    if (hub.role === "accounting" && table !== "vendors") throw err("not_granted", "Accounting has read-only access to the Job Tracker.");
  }

  /* ---------- the hub's tables, kept in memory and live ---------- */
  const T = { jobs: new Map(), details: new Map(), docs: new Map(), vendors: new Map(), people: new Map(), jt: new Map() };
  const TABLES = { jobs: "jobs", details: "jt_job_details", docs: "documents", vendors: "vendors", people: "people", jt: "jt_docs" };
  const keyOf = (t, r) => (t === "details" ? r.job_id : t === "jt" ? r.coll + "/" + r.id : r.id);
  async function fetchAll(t) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(TABLES[t]).select("*").range(from, from + 999);
      if (error) throw dbErr(error);
      out.push(...data);
      if (data.length < 1000) break;
    }
    T[t] = new Map(out.map((r) => [keyOf(t, r), r]));
  }
  let loadedOnce = null;
  function loadAll() { return (loadedOnce = loadedOnce || Promise.all(Object.keys(TABLES).map(fetchAll))); }
  async function refetch(t, key) {
    let q = sb.from(TABLES[t]).select("*");
    if (t === "details") q = q.eq("job_id", key);
    else if (t === "jt") { const [c, i] = split(key); q = q.eq("coll", c).eq("id", i); }
    else q = q.eq("id", key);
    const { data } = await q;
    if (data && data[0]) T[t].set(key, data[0]); else T[t].delete(key);
  }

  /* People by name and id (the app refers to people by name) */
  const personName = (id) => (id && T.people.get(id) ? T.people.get(id).name : "");
  function personId(name) {
    if (blank(name)) return null;
    const n = String(name).toLowerCase();
    let best = null;
    for (const p of T.people.values()) if (p.name.toLowerCase() === n) { if (p.active) return p.id; best = best || p.id; }
    return best;
  }

  /* ---------- mapping: app records <-> hub rows ---------- */
  const JOB_OPTS = { street: "street", city: "city", state: "state", zip: "zip", county: "county", inCity: "in_city", homeType: "home_type", days: "build_days" };
  const DOC_COLS = { name: "name", cat: "category", asset: "asset_id", type: "mime_type", size: "size_bytes", added: "added", order: "sort_order" };
  const docsOf = (jobId) => {
    const out = {};
    for (const d of T.docs.values()) if (d.job_id === jobId) {
      const o = { ...(d.source || {}) };
      for (const [k, c] of Object.entries(DOC_COLS)) if (!blank(d[c])) o[k] = d[c];
      if (d.sensitivity === "financial") o.financial = true;
      out[d.doc_key || d.id] = o;
    }
    return out;
  };
  // A file's key is only unique within its home, so the shared row id is "<job id>/<key>".
  const docId = (jobId, key) => jobId + "/" + key;
  const docRow = (key, jobId, o) => {
    const row = { id: docId(jobId, key), doc_key: key, job_id: jobId, source: {} };
    for (const [k, v] of Object.entries(o)) {
      if (k in DOC_COLS) row[DOC_COLS[k]] = k === "size" || k === "order" ? (blank(v) ? null : Number(v)) : nul(v);
      else if (k === "financial") row.sensitivity = v ? "financial" : "general";
      else row.source[k] = v;
    }
    if (!row.name) row.name = "Document";
    if (!row.asset_id) row.asset_id = "";
    return row;
  };
  function toJob(r) {
    const d = clone((T.details.get(r.id) || {}).data || {});
    const o = { ...d, name: r.name };
    if (!blank(r.subdivision)) o.subdivision = r.subdivision;
    const pm = personName(r.pm_id) || d.pm, su = personName(r.supervisor_id) || d.super;
    if (pm) o.pm = pm; else delete o.pm;
    if (su) o.super = su; else delete o.super;
    if (!blank(r.closing_date)) o.closing = r.closing_date;
    if (r.stage === "archived" || r.stage === "closed") o.archived = true;
    const opts = { ...(d.opts || {}) };
    for (const [k, c] of Object.entries(JOB_OPTS)) if (!blank(r[c])) opts[k] = r[c];
    o.opts = opts;
    const docs = docsOf(r.id);
    if (Object.keys(docs).length) o.docs = docs; else delete o.docs;
    return o;
  }
  function toPipe(r) {
    const d = clone((T.details.get(r.id) || {}).data || {});
    const o = { ...d, name: r.name };
    if (!blank(r.subdivision)) o.subdivision = r.subdivision;
    if (!blank(r.street)) o.address = r.street;
    if (!blank(r.contract_date)) o.contract = r.contract_date;
    if (!blank(r.closing_date)) o.closing = r.closing_date;
    if (!blank(r.expected_start)) o.expStart = r.expected_start;
    const pm = personName(r.pm_id) || d.pm, su = personName(r.supervisor_id) || d.super;
    if (pm) o.pm = pm; else delete o.pm;
    if (su) o.super = su; else delete o.super;
    const docs = docsOf(r.id);
    if (Object.keys(docs).length) o.docs = docs; else delete o.docs;
    return o;
  }
  // Split an app record (or a change to one) into: job columns, Job Tracker details, document changes.
  function fromJobLike(kind, p) {
    const core = {}, rest = {}, docs = isObj(p.docs) ? p.docs : null;
    for (const [k, v] of Object.entries(p)) {
      if (k === "docs") continue;
      if (k === "name") core.name = blank(v) ? "Untitled" : v;
      else if (k === "subdivision") core.subdivision = nul(v);
      else if (k === "pm" || k === "super") {
        const id = personId(v), col = k === "pm" ? "pm_id" : "supervisor_id";
        core[col] = id;
        rest[k] = id || blank(v) ? null : v; // a name not on the people list is kept as text
      }
      else if (k === "closing") core.closing_date = nul(v);
      else if (kind === "job" && k === "archived") core.stage = v ? "archived" : "active";
      else if (kind === "job" && k === "opts" && isObj(v)) {
        const ro = {};
        for (const [ok, ov] of Object.entries(v)) { if (ok in JOB_OPTS) core[JOB_OPTS[ok]] = ok === "days" ? (blank(ov) ? null : Number(ov)) : ok === "inCity" ? (blank(ov) ? null : !!ov) : nul(ov); else ro[ok] = ov; }
        if (Object.keys(ro).length) rest.opts = ro;
      }
      else if (kind === "pipe" && k === "address") core.street = nul(v);
      else if (kind === "pipe" && k === "contract") core.contract_date = nul(v);
      else if (kind === "pipe" && k === "expStart") core.expected_start = nul(v);
      else rest[k] = v;
    }
    return { core, rest, docs };
  }
  const CONTACT_COLS = { company: "company", name: "contact", email: "email", phone: "phone", area: "area", role: "role", notes: "notes" };
  function toContact(r) {
    const o = clone(r.extra || {});
    for (const [k, c] of Object.entries(CONTACT_COLS)) o[k] = r[c] == null ? "" : r[c];
    o.types = r.types || [];
    return o;
  }
  function fromContact(p) {
    const core = {}, extra = {};
    for (const [k, v] of Object.entries(p)) {
      if (k in CONTACT_COLS) core[CONTACT_COLS[k]] = nul(v);
      else if (k === "types") core.types = Array.isArray(v) ? v : [];
      else extra[k] = v;
    }
    return { core, extra };
  }

  /* Virtual collections the app sees */
  const isPipeStage = (s) => s === "under_contract" || s === "lead";
  function collDocs(coll) {
    const out = [];
    if (coll === "jobs") { for (const r of T.jobs.values()) if (!isPipeStage(r.stage)) out.push([r.id, toJob(r)]); }
    else if (coll === "pipeline") { for (const r of T.jobs.values()) if (isPipeStage(r.stage)) out.push([r.id, toPipe(r)]); }
    else if (coll === "contacts") { for (const r of T.vendors.values()) out.push([r.id, toContact(r)]); }
    else {
      for (const [k, r] of T.jt) if (r.coll === coll) out.push([r.id, clone(r.data)]);
      if (coll === "config") out.push(["team", teamDoc()]);
    }
    return out;
  }
  function teamDoc() {
    const members = [...T.people.values()].filter((p) => p.active && p.work_role).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ name: p.name, role: p.work_role }));
    return { members };
  }
  function oneDoc(coll, id) {
    if (coll === "jobs") { const r = T.jobs.get(id); return r && !isPipeStage(r.stage) ? toJob(r) : undefined; }
    if (coll === "pipeline") { const r = T.jobs.get(id); return r && isPipeStage(r.stage) ? toPipe(r) : undefined; }
    if (coll === "contacts") { const r = T.vendors.get(id); return r ? toContact(r) : undefined; }
    if (coll === "config" && id === "team") return teamDoc();
    const r = T.jt.get(coll + "/" + id); return r ? clone(r.data) : undefined;
  }

  /* ---------- live updates ---------- */
  const collSubs = new Map(), docSubs = new Map();
  let channel = null, pending = new Set(), flushQueued = false;
  function touched(t, row) {
    if (t === "jobs") { pending.add("jobs"); pending.add("pipeline"); }
    else if (t === "details" || t === "docs") { pending.add("jobs"); pending.add("pipeline"); }
    else if (t === "vendors") pending.add("contacts");
    else if (t === "people") { pending.add("config"); pending.add("jobs"); pending.add("pipeline"); }
    else if (t === "jt") pending.add(row.coll);
    if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
  }
  function flush() {
    flushQueued = false;
    const colls = [...pending]; pending.clear();
    for (const c of colls) {
      const snap = collSnap(c);
      (collSubs.get(c) || []).forEach((f) => { try { f(snap); } catch (e) { console.error(e); } });
      for (const [k, set] of docSubs) { const [dc, di] = split(k); if (dc === c) set.forEach((f) => { try { f(docSnap(dc, di)); } catch (e) { console.error(e); } }); }
    }
  }
  function ensureChannel() {
    if (channel) return;
    let dropped = false;
    channel = sb.channel("hub");
    for (const [t, table] of Object.entries(TABLES)) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, (p) => {
        const row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row) return;
        const k = keyOf(t, row);
        if (p.eventType === "DELETE") T[t].delete(k); else T[t].set(k, row);
        touched(t, row);
      });
    }
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" && dropped) { dropped = false; resync(); }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") dropped = true;
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && dropped) resync(); });
  }
  async function resync() {
    loadedOnce = null;
    await loadAll().catch(() => {});
    ["jobs", "pipeline", "contacts", "config", ...new Set([...T.jt.values()].map((r) => r.coll))].forEach((c) => pending.add(c));
    flush();
  }
  const collSnap = (coll) => {
    const docs = collDocs(coll).map(([id, d]) => ({ id, exists: true, data: () => clone(d) }));
    return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
  };
  const docSnap = (coll, id) => { const d = oneDoc(coll, id); return { id, exists: d !== undefined, data: () => clone(d) }; };

  /* ---------- writes ---------- */
  // A row the rules don't let you change comes back empty instead of an error; treat that as "not allowed".
  async function upd(t, match, values) {
    let q = sb.from(TABLES[t]).update(values);
    for (const [c, v] of Object.entries(match)) q = q.eq(c, v);
    const { data, error } = await q.select();
    if (error) throw dbErr(error);
    if (!data.length) throw err("not_granted", "You don't have permission to change that.");
    data.forEach((r) => T[t].set(keyOf(t, r), r));
    return data[0];
  }
  async function ins(t, rows, upsert) {
    const q = upsert ? sb.from(TABLES[t]).upsert(rows) : sb.from(TABLES[t]).insert(rows);
    const { data, error } = await q.select();
    if (error) throw dbErr(error);
    data.forEach((r) => T[t].set(keyOf(t, r), r));
    return data;
  }
  async function del(t, match) {
    let q = sb.from(TABLES[t]).delete();
    for (const [c, v] of Object.entries(match)) q = q.eq(c, v);
    const { data, error } = await q.select();
    if (error) throw dbErr(error);
    if (!data.length) throw err("not_granted", "You don't have permission to delete that.");
    data.forEach((r) => T[t].delete(keyOf(t, r)));
  }
  async function patchDetails(jobId, rest) {
    if (!Object.keys(rest).length) return;
    const { data, error } = await sb.rpc("jt_patch_details", { p_job: jobId, p_patch: rest });
    if (error) throw dbErr(error);
    T.details.set(jobId, { ...(T.details.get(jobId) || { job_id: jobId }), data });
  }
  async function applyDocs(jobId, docs, replace) {
    if (!docs && !replace) return;
    const cur = docsOf(jobId);
    const ups = [], gone = [];
    for (const [id, v] of Object.entries(docs || {})) {
      if (v === null) { if (cur[id]) gone.push(id); continue; }
      ups.push(docRow(id, jobId, cur[id] && !replace ? deepMerge(cur[id], v) : v));
    }
    if (replace) for (const id of Object.keys(cur)) if (!(docs && id in docs)) gone.push(id);
    if (ups.length) await ins("docs", ups, true);
    for (const key of gone) await del("docs", { id: docId(jobId, key) });
  }
  // Show a change at once, then confirm it with the hub; if it's refused, put things back as they were.
  async function optimistic(apply, run, undoKeys) {
    const saved = undoKeys.map(([t, k]) => [t, k, T[t].has(k) ? clone(T[t].get(k)) : undefined]);
    apply();
    try { return await run(); }
    catch (e) {
      for (const [t, k, v] of saved) if (v === undefined) T[t].delete(k); else T[t].set(k, v);
      for (const [t, k] of undoKeys) { touched(t, T[t].get(k) || { coll: split(k)[0] }); refetch(t, k).then(() => touched(t, T[t].get(k) || { coll: split(k)[0] })).catch(() => {}); }
      throw e;
    }
  }
  function localJob(id, coreVals, rest, docs, replace) {
    const r = { ...(T.jobs.get(id) || { id }), ...coreVals };
    T.jobs.set(id, r);
    const d = T.details.get(id) || { job_id: id, data: {} };
    T.details.set(id, { ...d, data: replace ? clone(rest) : deepMerge(d.data || {}, rest) });
    if (replace) for (const [k, v] of [...T.docs]) if (v.job_id === id) T.docs.delete(k);
    for (const [key, v] of Object.entries(docs || {})) {
      const did = docId(id, key);
      if (v === null) T.docs.delete(did);
      else T.docs.set(did, docRow(key, id, !replace && T.docs.has(did) ? deepMerge(docsOf(id)[key] || {}, v) : v));
    }
    touched("jobs", r);
  }
  const jobKeys = (id) => [["jobs", id], ["details", id], ...[...T.docs.values()].filter((d) => d.job_id === id).map((d) => ["docs", d.id])];

  async function writeJobLike(kind, id, data, mode) {
    canEdit("jobs");
    const { core, rest, docs } = fromJobLike(kind, data);
    const exists = T.jobs.has(id);
    if (mode !== "update" || !exists) {
      if (!("name" in core)) core.name = "Untitled";
      if (!("stage" in core)) core.stage = kind === "pipe" ? "under_contract" : "active";
    }
    const replace = mode === "set";
    return optimistic(() => localJob(id, core, rest, docs, replace || !exists), async () => {
      if (!exists) await ins("jobs", [{ id, ...core }]);
      else if (Object.keys(core).length) await upd("jobs", { id }, core);
      if (replace || !exists) {
        const { error, data: rows } = await sb.from("jt_job_details").upsert({ job_id: id, data: rest }).select();
        if (error) throw dbErr(error);
        rows.forEach((r) => T.details.set(r.job_id, r));
      } else await patchDetails(id, rest);
      await applyDocs(id, docs, replace || !exists);
      touched("jobs", T.jobs.get(id));
    }, jobKeys(id));
  }
  async function writeContact(id, data, mode) {
    canEdit("vendors");
    const { core, extra } = fromContact(data);
    const exists = T.vendors.has(id);
    const before = T.vendors.get(id);
    return optimistic(() => {
      const r = mode === "update" && before ? { ...before, ...core, extra: deepMerge(before.extra || {}, extra) } : { id, types: [], ...core, extra };
      T.vendors.set(id, r); touched("vendors", r);
    }, async () => {
      if (mode !== "update" || !exists) await ins("vendors", [{ id, types: [], ...core, extra }], mode === "set");
      else {
        if (Object.keys(core).length) await upd("vendors", { id }, core);
        if (Object.keys(extra).length) {
          const { data: ex, error } = await sb.rpc("vendor_patch_extra", { p_id: id, p_patch: extra });
          if (error) throw dbErr(error);
          T.vendors.set(id, { ...T.vendors.get(id), extra: ex });
        }
      }
      touched("vendors", T.vendors.get(id));
    }, [["vendors", id]]);
  }
  async function writeJt(coll, id, data, mode) {
    canEdit("jt_docs");
    if (coll === "config" && id === "team") throw err("not_granted", "People are managed on the People & sign-ins page (menu).");
    const k = coll + "/" + id, before = T.jt.get(k);
    return optimistic(() => {
      T.jt.set(k, { coll, id, data: mode === "update" && before ? deepMerge(before.data, data) : clone(data) }); touched("jt", { coll });
    }, async () => {
      if (mode === "update") {
        const { data: out, error } = await sb.rpc("jt_patch", { p_coll: coll, p_id: id, p_patch: data });
        if (error) throw dbErr(error);
        T.jt.set(k, { ...(T.jt.get(k) || { coll, id }), data: out });
      } else await ins("jt", [{ coll, id, data }], true);
      touched("jt", { coll });
    }, [["jt", k]]);
  }
  function write(coll, id, data, mode) {
    if (coll === "jobs") return writeJobLike("job", id, data, mode);
    if (coll === "pipeline") return writeJobLike("pipe", id, data, mode);
    if (coll === "contacts") return writeContact(id, data, mode);
    return writeJt(coll, id, data, mode);
  }
  async function remove(coll, id) {
    if (coll === "jobs" || coll === "pipeline") {
      canEdit("jobs");
      return optimistic(() => { T.jobs.delete(id); T.details.delete(id); for (const [k, v] of [...T.docs]) if (v.job_id === id) T.docs.delete(k); touched("jobs", {}); },
        () => del("jobs", { id }), jobKeys(id));
    }
    if (coll === "contacts") { canEdit("vendors"); return optimistic(() => { T.vendors.delete(id); touched("vendors", {}); }, () => del("vendors", { id }), [["vendors", id]]); }
    canEdit("jt_docs");
    const k = coll + "/" + id;
    return optimistic(() => { T.jt.delete(k); touched("jt", { coll }); }, () => del("jt", { coll, id }), [["jt", k]]);
  }

  // A pipeline lot starting its build keeps its ID: the same job moves from "under contract" to "active".
  hub.promote = async (id, jobData) => {
    canEdit("jobs");
    const before = T.jobs.get(id);
    if (!before) throw err("not_found", "That pipeline lot is gone");
    const { core, rest, docs } = fromJobLike("job", jobData);
    core.stage = "active";
    await optimistic(() => localJob(id, core, rest, docs, false), async () => {
      await upd("jobs", { id }, core);
      await patchDetails(id, rest);
      await applyDocs(id, docs, false);
      touched("jobs", T.jobs.get(id));
    }, jobKeys(id));
    return id;
  };
  // Used once by the import page: bring an old record in with its original ID.
  hub.importRecord = (coll, id, data) => write(coll, id, data, "set");
  hub.tables = T;

  const db = Object.freeze({
    collection(coll) {
      return {
        async add(data) { const id = coll === "jobs" || coll === "pipeline" || coll === "contacts" ? rid(20) : rid(20); await write(coll, id, data, "set"); return { id }; },
        doc: (id) => db.doc(coll + "/" + id),
        async get() { await loadAll(); return collSnap(coll); },
        onSnapshot(fn, onErr) {
          if (!collSubs.has(coll)) collSubs.set(coll, new Set());
          collSubs.get(coll).add(fn);
          loadAll().then(() => fn(collSnap(coll)), (e) => onErr && onErr(e));
          return () => collSubs.get(coll).delete(fn);
        },
      };
    },
    doc(path) {
      const [coll, id] = split(path);
      return {
        id,
        async get() { await loadAll(); return docSnap(coll, id); },
        set: (data) => write(coll, id, data, "set"),
        update: (patch) => write(coll, id, patch, "update"),
        delete: () => remove(coll, id),
        onSnapshot(fn, onErr) {
          if (!docSubs.has(path)) docSubs.set(path, new Set());
          docSubs.get(path).add(fn);
          loadAll().then(() => fn(docSnap(coll, id)), (e) => onErr && onErr(e));
          return () => docSubs.get(path).delete(fn);
        },
      };
    },
  });

  /* ---------- assets (file storage) ---------- */
  const bucket = () => sb.storage.from("documents");
  const assetsApi = Object.freeze({
    async upload(blob, opts = {}) {
      canEdit("documents");
      if (blob.size > 25 * 1024 * 1024) throw err("too_large", "File is over 25 MB");
      const id = hex32(), contentType = opts.type || blob.type || "application/octet-stream";
      const { error } = await bucket().upload(id, blob, { contentType, upsert: false });
      if (error) throw err(/size/i.test(error.message) ? "too_large" : /security|permission/i.test(error.message) ? "not_granted" : "quota_or_state", error.message);
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
  hub.callFn = callFn;

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

  const APIS = { db, assets: assetsApi, sample: sampleApi, mcp: mcpApi, downloads: downloadsApi };
  window.claude = Object.freeze({ use: (name) => ready.then(() => APIS[name] || null) });
})();
