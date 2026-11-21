/* Serves the tracker's uploaded files at <site>/blob/<id> from private Supabase storage,
   using the signed-in user's token, so links, thumbnails and the PDF viewer work as before. */
const STORE = "jt-auth-v1";
let auth = null; // { token, cfg: { url, anon } }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "jt-auth") {
    auth = { token: e.data.token, cfg: e.data.cfg };
    e.waitUntil(caches.open(STORE).then((c) => c.put("/__jt_auth", new Response(JSON.stringify(auth)))));
  }
});

async function restore() {
  if (auth && auth.token) return;
  const r = await (await caches.open(STORE)).match("/__jt_auth");
  if (r) auth = await r.json();
}

// Ask an open tab for a fresh token (it refreshes the session if needed).
async function freshToken() {
  const tabs = await self.clients.matchAll({ type: "window" });
  for (const tab of tabs) {
    const token = await new Promise((res) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => res(null), 3000);
      ch.port1.onmessage = (m) => { clearTimeout(t); res(m.data && m.data.token); };
      tab.postMessage({ type: "jt-need-token" }, [ch.port2]);
    });
    if (token) { auth = { ...(auth || {}), token }; return token; }
  }
  return null;
}

async function serve(id) {
  await restore();
  if (!auth || !auth.cfg) return new Response("Sign in to the Job Tracker to view this file.", { status: 401 });
  const get = (token) => fetch(`${auth.cfg.url}/storage/v1/object/authenticated/jt-files/${encodeURIComponent(id)}`, {
    headers: { Authorization: "Bearer " + token, apikey: auth.cfg.anon },
  });
  let r = auth.token ? await get(auth.token) : null;
  if (!r || [400, 401, 403].includes(r.status)) {
    const t = await freshToken();
    if (t) r = await get(t);
  }
  if (!r) return new Response("Sign in to the Job Tracker to view this file.", { status: 401 });
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("Content-Type") || "application/octet-stream", "Cache-Control": "private, max-age=600" },
  });
}

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url), scope = new URL(self.registration.scope);
  const prefix = scope.pathname + "blob/";
  if (u.origin === scope.origin && u.pathname.startsWith(prefix)) e.respondWith(serve(decodeURIComponent(u.pathname.slice(prefix.length))));
});
