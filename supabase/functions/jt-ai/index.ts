// Job Tracker AI: one server function that holds the AI key and talks to the provider.
// Switch providers with secrets only (no code change):
//   AI_PROVIDER = anthropic | xai | openai        (default anthropic)
//   ANTHROPIC_API_KEY / XAI_API_KEY / OPENAI_API_KEY
//   AI_MODEL_QUICK, AI_MODEL_DEFAULT, AI_MODEL_COMPLEX  (optional; Anthropic has defaults)
//
// The app sends a provider-neutral conversation:
//   { tier, json, messages: [
//       {role:"user", content:"...", images:[{media_type, data(base64)}]},
//       {role:"assistant", content:"...", tool_calls:[{id,name,input}]},
//       {role:"tool", tool_call_id, content:"..."} ],
//     tools: [{name, description, input_schema}] }
// and gets back { text, tool_calls:[{id,name,input}], stop }.
import { cors, json, requireJtUser } from "../_shared/auth.ts";

type Img = { media_type: string; data: string };
type Msg =
  | { role: "user"; content: string; images?: Img[] }
  | { role: "assistant"; content: string; tool_calls?: { id: string; name: string; input: unknown }[] }
  | { role: "tool"; tool_call_id: string; content: string };
type Tool = { name: string; description?: string; input_schema?: Record<string, unknown> };

const PROVIDER = (Deno.env.get("AI_PROVIDER") || "anthropic").toLowerCase();
const DEFAULT_MODELS: Record<string, Record<string, string>> = {
  anthropic: { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" },
};
function model(tier: string) {
  const env = Deno.env.get("AI_MODEL_" + tier.toUpperCase()) || Deno.env.get("AI_MODEL_DEFAULT");
  const m = env || DEFAULT_MODELS[PROVIDER]?.[tier] || DEFAULT_MODELS[PROVIDER]?.default;
  if (!m) throw new Error(`Set AI_MODEL_DEFAULT for provider "${PROVIDER}"`);
  return m;
}
const JSON_RULE = "\n\nReply with only the JSON value requested: no explanation, no code fences.";

async function anthropic(msgs: Msg[], tools: Tool[], tier: string, wantJson: boolean) {
  const out: unknown[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      const blocks: unknown[] = (m.images || []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } }));
      blocks.push({ type: "text", text: m.content });
      out.push({ role: "user", content: blocks });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const t of m.tool_calls || []) blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input ?? {} });
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no text)" }] });
    } else {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
      const last = out[out.length - 1] as { role: string; content: unknown[] } | undefined;
      if (last && last.role === "user" && Array.isArray(last.content) && (last.content[0] as { type?: string })?.type === "tool_result") last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  const body: Record<string, unknown> = { model: model(tier), max_tokens: wantJson ? 8000 : 4000, messages: out };
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description || "", input_schema: t.input_schema || { type: "object", properties: {} } }));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw { status: r.status, message: d?.error?.message || "AI request failed" };
  const text = (d.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const tool_calls = (d.content || []).filter((b: { type: string }) => b.type === "tool_use").map((b: { id: string; name: string; input: unknown }) => ({ id: b.id, name: b.name, input: b.input }));
  return { text, tool_calls, stop: d.stop_reason === "max_tokens" ? "truncated" : tool_calls.length ? "tool_use" : "end" };
}

// xAI (Grok) and OpenAI share the same chat-completions format.
async function openaiStyle(base: string, key: string, msgs: Msg[], tools: Tool[], tier: string, wantJson: boolean) {
  const out = msgs.map((m) => {
    if (m.role === "user") {
      if (!m.images?.length) return { role: "user", content: m.content };
      return { role: "user", content: [...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.media_type};base64,${i.data}` } })), { type: "text", text: m.content }] };
    }
    if (m.role === "assistant") {
      const o: Record<string, unknown> = { role: "assistant", content: m.content || "" };
      if (m.tool_calls?.length) o.tool_calls = m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }));
      return o;
    }
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  });
  const body: Record<string, unknown> = { model: model(tier), messages: out, max_tokens: wantJson ? 8000 : 4000 };
  if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw { status: r.status, message: d?.error?.message || "AI request failed" };
  const c = d.choices?.[0] || {};
  const tool_calls = (c.message?.tool_calls || []).map((t: { id: string; function: { name: string; arguments: string } }) => {
    let input: unknown = {};
    try { input = JSON.parse(t.function.arguments || "{}"); } catch { /* keep {} */ }
    return { id: t.id, name: t.function.name, input };
  });
  return { text: c.message?.content || "", tool_calls, stop: c.finish_reason === "length" ? "truncated" : tool_calls.length ? "tool_use" : "end" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await requireJtUser(req))) return json({ code: "not_granted", message: "Sign in to the Job Tracker first." }, 401);
  try {
    const { messages, tools = [], tier = "default", json: wantJson = false } = await req.json();
    if (!Array.isArray(messages) || !messages.length) return json({ code: "invalid_request", message: "No messages" }, 400);
    const msgs: Msg[] = messages.map((m: Msg, i: number) =>
      wantJson && m.role === "user" && i === messages.length - 1 ? { ...m, content: m.content + JSON_RULE } : m);
    const t = ["quick", "default", "complex"].includes(tier) ? tier : "default";
    let res;
    if (PROVIDER === "anthropic") res = await anthropic(msgs, tools, t, wantJson);
    else if (PROVIDER === "xai") res = await openaiStyle("https://api.x.ai/v1", Deno.env.get("XAI_API_KEY") || "", msgs, tools, t, wantJson);
    else if (PROVIDER === "openai") res = await openaiStyle("https://api.openai.com/v1", Deno.env.get("OPENAI_API_KEY") || "", msgs, tools, t, wantJson);
    else return json({ code: "unavailable", message: `Unknown AI_PROVIDER "${PROVIDER}"` }, 500);
    return json(res);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const code = err.status === 429 ? "rate_limited" : "unavailable";
    return json({ code, message: err.message || String(e) }, err.status === 429 ? 429 : 502);
  }
});
