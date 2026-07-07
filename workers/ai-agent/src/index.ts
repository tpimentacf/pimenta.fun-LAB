/**
 * ai-agent — Pimenta Lab
 *
 * A chat agent on Cloudflare Workers that is *connected to* the pimenta-ai-mcp
 * server (https://www.pimenta.fun/mcp). It runs a classic tool-calling loop:
 *
 *   1. MCP  tools/list          -> discover the server's tools
 *   2. Workers AI run(messages, tools)  -> model decides: answer or call a tool
 *   3. MCP  tools/call          -> execute the chosen tool on the MCP server
 *   4. feed the result back      -> repeat until the model gives a final answer
 *
 * The agent is the MCP *client*; the MCP server (workers/ai-mcp) owns D1/KV/AI.
 * Speaks the MCP Streamable HTTP transport by hand (fetch + SSE framing), so it
 * needs no MCP SDK dependency.
 *
 * Endpoint (POST): /agent/api   body: { messages:[{role,content}], ... }
 *                  returns { reply, steps:[{tool,args,result}], model, toolCount }
 *
 * Docs:
 *   Function calling  https://developers.cloudflare.com/workers-ai/features/function-calling/traditional/
 *   MCP transport     https://modelcontextprotocol.io/specification/draft/basic/transports/#streamable-http
 *   createMcpHandler  https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
 *
 * SECURITY NOTE: this endpoint is unauthenticated (it fronts an unauthenticated
 * MCP server). Keep destructive tools off untrusted MCP servers, and front with
 * Cloudflare Access / a rate-limit rule for anything real.
 */

export interface Env {
  AI: Ai; // Workers AI binding (env.AI)
  MCP_URL?: string; // remote MCP endpoint (Streamable HTTP)
  AI_GATEWAY_ID?: string; // AI Gateway id for observability
  AGENT_MODEL?: string; // tool-calling model
  MAX_STEPS?: string; // safety cap on tool-loop iterations
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_MCP_URL = "https://www.pimenta.fun/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MAX_STEPS = 5;

const SYSTEM_PROMPT = [
  "You are the Pimenta Lab assistant, a helpful agent connected to a remote MCP",
  "(Model Context Protocol) server via tool calling. The MCP server exposes",
  "tools for a notes database (D1), a key/value store (KV), and an ask_ai tool",
  "(Workers AI). When the user asks you to store, list, fetch, or delete notes,",
  "or to read/write key/value data, CALL THE MATCHING TOOL rather than guessing.",
  "Only call a tool when it is needed to answer; for small talk just reply.",
  "After a tool returns, summarise the result for the user in plain language.",
  "Never invent note ids or values \u2014 read them from tool results.",
].join(" ");

type Msg = { role: string; content: string };
type Json = Record<string, any>;

/* ---------------------------------------------------------------- MCP client */

/**
 * One JSON-RPC round-trip to the MCP server over Streamable HTTP. The server
 * (createMcpHandler, default transport) answers request-bearing POSTs with an
 * SSE stream, so we accept both and parse whichever came back.
 */
async function mcpRpc(
  url: string,
  method: string,
  params: Json | undefined,
  id: number,
  sessionId?: string,
): Promise<{ result?: Json; error?: Json; sessionId?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const newSession = res.headers.get("mcp-session-id") || sessionId;
  const ctype = res.headers.get("content-type") || "";
  const bodyText = await res.text();

  if (!res.ok && !bodyText) {
    return { error: { code: res.status, message: `HTTP ${res.status}` }, sessionId: newSession };
  }

  const payload = ctype.includes("text/event-stream")
    ? parseSse(bodyText, id)
    : safeJson(bodyText);

  if (!payload) return { error: { code: -1, message: "Unparseable MCP response" }, sessionId: newSession };
  return { result: payload.result, error: payload.error, sessionId: newSession };
}

/** Pull the JSON-RPC message matching `id` out of an SSE stream (data: lines). */
function parseSse(text: string, id: number): Json | undefined {
  const datas: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const obj = safeJson(t.slice(5).trim());
    if (obj) datas.push(obj);
  }
  return datas.find((d) => d.id === id) || datas[datas.length - 1];
}

function safeJson(s: string): Json | undefined {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

/** Handshake + tools/list. Returns the tool list and the (optional) session id. */
async function mcpListTools(url: string): Promise<{ tools: Json[]; sessionId?: string }> {
  let id = 1;
  const init = await mcpRpc(
    url,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pimenta-ai-agent", version: "1.0.0" },
    },
    id++,
  );
  const sessionId = init.sessionId;

  // Politeness: tell the server we're initialized (notifications carry no id).
  if (sessionId) {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    } catch {
      /* best effort */
    }
  }

  const listed = await mcpRpc(url, "tools/list", {}, id++, sessionId);
  const tools = (listed.result?.tools as Json[]) || [];
  return { tools, sessionId: listed.sessionId };
}

/** Execute one tool and return its result flattened to text. */
async function mcpCallTool(
  url: string,
  name: string,
  args: Json,
  sessionId: string | undefined,
): Promise<string> {
  const r = await mcpRpc(url, "tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6) + 10, sessionId);
  if (r.error) return `Tool error: ${r.error.message ?? JSON.stringify(r.error)}`;
  const content = (r.result?.content as Json[]) || [];
  const txt = content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
  return txt || JSON.stringify(r.result ?? {});
}

/* --------------------------------------------------- MCP tool -> AI tool spec */

/** Map an MCP tool (JSON Schema inputSchema) to the Workers AI tools format. */
function toAiTool(t: Json): Json {
  const schema = t.inputSchema || t.input_schema || { type: "object", properties: {} };
  return {
    name: t.name,
    description: t.description || t.name,
    parameters: {
      type: "object",
      properties: schema.properties || {},
      required: schema.required || [],
    },
  };
}

/** tool_calls arguments arrive as an object or a JSON string depending on model. */
function coerceArgs(a: unknown): Json {
  if (a && typeof a === "object") return a as Json;
  if (typeof a === "string") return safeJson(a) || {};
  return {};
}

/* --------------------------------------------------------------- agent loop */

async function runAgent(env: Env, userMessages: Msg[]) {
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  const mcpUrl = env.MCP_URL || DEFAULT_MCP_URL;
  const maxSteps = Number(env.MAX_STEPS) || DEFAULT_MAX_STEPS;
  const gateway = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;

  const { tools: mcpTools, sessionId } = await mcpListTools(mcpUrl);
  const aiTools = mcpTools.map(toAiTool);

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...userMessages.filter((m) => m && m.role && typeof m.content === "string"),
  ];

  const steps: { tool: string; args: Json; result: string }[] = [];
  let reply = "";

  for (let step = 0; step < maxSteps; step++) {
    const resp: any = await env.AI.run(model, { messages, tools: aiTools }, gateway as any);
    const calls: Json[] = resp?.tool_calls || [];

    if (!calls.length) {
      reply = (resp?.response ?? resp?.result ?? "").toString().trim();
      break;
    }

    // Execute every tool the model asked for this turn, then loop again.
    for (const call of calls) {
      const name = call.name || call.function?.name;
      const args = coerceArgs(call.arguments ?? call.function?.arguments);
      if (!name || !mcpTools.some((t) => t.name === name)) {
        steps.push({ tool: String(name), args, result: "Unknown tool (not offered by MCP server)" });
        messages.push({ role: "assistant", content: JSON.stringify(call) });
        messages.push({ role: "tool", content: "Error: unknown tool" });
        continue;
      }
      const result = await mcpCallTool(mcpUrl, name, args, sessionId);
      steps.push({ tool: name, args, result });
      messages.push({ role: "assistant", content: JSON.stringify({ name, arguments: args }) });
      messages.push({ role: "tool", content: result });
    }
  }

  if (!reply) {
    // Ran out of steps while still tool-calling; ask for a final wrap-up.
    const resp: any = await env.AI.run(
      model,
      { messages: [...messages, { role: "user", content: "Summarise the result for me in plain language." }] },
      gateway as any,
    );
    reply = (resp?.response ?? "").toString().trim() || "(no answer)";
  }

  return { reply, steps, model, toolCount: mcpTools.length };
}

/* --------------------------------------------------------------- HTTP entry */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    // Tiny GET probe so the endpoint is inspectable in a browser.
    if (request.method === "GET") {
      return json({
        ok: true,
        service: "ai-agent",
        mcp: env.MCP_URL || DEFAULT_MCP_URL,
        model: env.AGENT_MODEL || DEFAULT_MODEL,
        usage: "POST { messages:[{role,content}] } to this URL",
      });
    }

    if (request.method !== "POST") return json({ error: "Use POST" }, 405);

    let payload: Json;
    try {
      payload = (await request.json()) as Json;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Accept either { messages:[...] } or a single { message:"..." }.
    let messages: Msg[] = Array.isArray(payload.messages) ? payload.messages : [];
    if (!messages.length && typeof payload.message === "string") {
      messages = [{ role: "user", content: payload.message }];
    }
    if (!messages.length) return json({ error: "Provide messages[] or message" }, 400);

    try {
      const out = await runAgent(env, messages);
      return json(out);
    } catch (err: any) {
      return json({ error: "Agent failed", detail: String(err?.message || err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
