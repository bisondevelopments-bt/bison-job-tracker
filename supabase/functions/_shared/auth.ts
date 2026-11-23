// Shared helpers for the Job Tracker server functions.

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Only signed-in Job Tracker users may call these functions.
// Supabase checks the sign-in token's signature before the function runs (JWT verification is on by default),
// so here we only read who it is and whether that login is marked for the Job Tracker.
export function requireJtUser(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (claims.role !== "authenticated" || (claims.exp && claims.exp * 1000 < Date.now())) return null;
    return claims.app_metadata?.jt === true ? claims : null;
  } catch {
    return null;
  }
}
