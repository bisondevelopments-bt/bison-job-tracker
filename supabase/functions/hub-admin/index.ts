// People & sign-ins (admins only): list the team, add someone, change their role, send an invite, turn a sign-in off.
// The invite email comes from the shared Bison Gmail (set up as the sign-in email sender by the deploy).
import { admin, cors, json, requirePerson } from "../_shared/auth.ts";

const ROLES = ["admin", "project_manager", "field_supervisor", "accounting"];
const WORK_ROLES = ["Project manager", "Field supervisor", "Excavation field supervisor", "Operations", ""];
const SITE = (Deno.env.get("HUB_SITE_URL") || "").replace(/\/?$/, "/");
const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await requirePerson(req, ["admin"]);
  if (!me) return json({ code: "not_granted", message: "Only admins can manage people." }, 403);
  const sb = admin();
  try {
    const a = await req.json();

    if (a.action === "list") {
      const { data: people, error } = await sb.from("people").select("*").order("name");
      if (error) throw error;
      const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
      const byId = new Map((users?.users || []).map((u) => [u.id, u]));
      return json({
        people: people.map((p) => {
          const u = p.auth_user_id ? byId.get(p.auth_user_id) : null;
          const status = !p.active ? "off" : !u ? "no_login" : u.last_sign_in_at ? "active" : "invited";
          return { ...p, status, last_sign_in_at: u?.last_sign_in_at || null, invited_at: u?.invited_at || null };
        }),
      });
    }

    if (a.action === "save") {
      const row: Record<string, unknown> = {};
      if ("name" in a) { const n = String(a.name || "").trim(); if (!n) return json({ code: "invalid", message: "Name is required." }, 400); row.name = n; }
      if ("email" in a) { const e = String(a.email || "").trim().toLowerCase(); if (e && !isEmail(e)) return json({ code: "invalid", message: "That email doesn't look right." }, 400); row.email = e || null; }
      if ("phone" in a) row.phone = String(a.phone || "").trim() || null;
      if ("role" in a) { if (!ROLES.includes(a.role)) return json({ code: "invalid", message: "Unknown role." }, 400); row.role = a.role; }
      if ("work_role" in a) { if (!WORK_ROLES.includes(a.work_role || "")) return json({ code: "invalid", message: "Unknown work role." }, 400); row.work_role = a.work_role || null; }
      if (a.id === me.id && (row.role && row.role !== "admin")) return json({ code: "invalid", message: "You can't remove your own admin access. Ask another admin." }, 400);
      const q = a.id ? sb.from("people").update(row).eq("id", a.id) : sb.from("people").insert(row);
      const { data, error } = await q.select().single();
      if (error) throw error;
      // Keep the sign-in's email in step with the person's email.
      if (a.id && row.email && data.auth_user_id) await sb.auth.admin.updateUserById(data.auth_user_id, { email: row.email as string, email_confirm: true });
      return json({ person: data });
    }

    if (a.action === "invite") {
      const { data: p, error } = await sb.from("people").select("*").eq("id", a.id).single();
      if (error) throw error;
      if (!p.email) return json({ code: "invalid", message: "Add their email first." }, 400);
      if (!p.active) return json({ code: "invalid", message: "Turn their sign-in back on first." }, 400);
      const redirectTo = SITE || undefined;
      let link: string | null = null, emailed = false;
      if (!p.auth_user_id) {
        const r = await sb.auth.admin.inviteUserByEmail(p.email, { redirectTo, data: { name: p.name } });
        if (!r.error && r.data.user) {
          emailed = true;
          await sb.from("people").update({ auth_user_id: r.data.user.id }).eq("id", p.id);
        } else {
          // Email didn't go out (or they already have a login): make a link the admin can text them instead.
          const g = await sb.auth.admin.generateLink({ type: "invite", email: p.email, options: { redirectTo } });
          if (g.error) {
            const existing = await sb.auth.admin.listUsers({ perPage: 1000 });
            const u = existing.data?.users.find((x) => (x.email || "").toLowerCase() === p.email);
            if (!u) throw g.error;
            await sb.from("people").update({ auth_user_id: u.id }).eq("id", p.id);
            const rec = await sb.auth.admin.generateLink({ type: "recovery", email: p.email, options: { redirectTo } });
            if (rec.error) throw rec.error;
            link = rec.data.properties.action_link;
          } else {
            await sb.from("people").update({ auth_user_id: g.data.user.id }).eq("id", p.id);
            link = g.data.properties.action_link;
          }
        }
      } else {
        // Already has a login: send a fresh "set your password" email, and hand back a link as well.
        const r = await sb.auth.resetPasswordForEmail(p.email, { redirectTo });
        emailed = !r.error;
        const rec = await sb.auth.admin.generateLink({ type: "recovery", email: p.email, options: { redirectTo } });
        if (!rec.error) link = rec.data.properties.action_link;
      }
      return json({ emailed, link });
    }

    if (a.action === "active") {
      if (a.id === me.id && !a.active) return json({ code: "invalid", message: "You can't turn off your own sign-in." }, 400);
      const { data: p, error } = await sb.from("people").update({ active: !!a.active }).eq("id", a.id).select().single();
      if (error) throw error;
      if (p.auth_user_id) await sb.auth.admin.updateUserById(p.auth_user_id, { ban_duration: a.active ? "none" : "876000h" });
      return json({ person: p });
    }

    return json({ code: "invalid", message: "Unknown action" }, 400);
  } catch (e) {
    const m = (e as { message?: string }).message || String(e);
    return json({ code: /duplicate|unique/i.test(m) ? "invalid" : "unavailable", message: /people_name_active/.test(m) ? "Someone with that name is already on the team." : /email/.test(m) && /unique|duplicate/.test(m) ? "That email is already on the team." : m }, 400);
  }
});
