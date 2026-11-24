// Shared helpers for the hub's server functions.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Server-side client with full access. Only ever used inside these functions.
export function admin() {
  const key = Deno.env.get("HUB_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type Person = { id: string; name: string; email: string | null; role: string; work_role: string | null; active: boolean };

// Supabase checks the sign-in token's signature before a function runs (JWT verification is on by default).
// Here we read whose token it is and look that person up on the team list.
export async function requirePerson(req: Request, roles?: string[]): Promise<Person | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  let claims: { sub?: string; role?: string; exp?: number };
  try {
    claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
  } catch {
    return null;
  }
  if (claims.role !== "authenticated" || !claims.sub || (claims.exp && claims.exp * 1000 < Date.now())) return null;
  const { data } = await admin().from("people").select("id,name,email,role,work_role,active").eq("auth_user_id", claims.sub).eq("active", true).maybeSingle();
  if (!data) return null;
  if (roles && !roles.includes(data.role)) return null;
  return data as Person;
}
