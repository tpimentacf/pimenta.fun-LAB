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
  MCP?: Fetcher; // Service binding to the ai-mcp Worker (preferred transport)
  MCP_URL?: string; // remote MCP endpoint (Streamable HTTP) — fallback / external
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
type RpcResult = {
  result?: Json;
  error?: Json;
  sessionId?: string;
  status?: number; // HTTP status of the round-trip
  ctype?: string; // response content-type
  raw?: string; // first slice of the raw body, for diagnostics
};

async function mcpRpc(
  url: string,
  method: string,
  params: Json | undefined,
  id: number,
  sessionId?: string,
  fetcher?: Fetcher,
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  let res: Response;
  try {
    res = await pickFetch(fetcher)(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  } catch (e: any) {
    // fetch itself threw (DNS, subrequest loop, TLS…) — the usual "silent" cause.
    return { error: { code: -2, message: `fetch failed: ${String(e?.message || e)}` } };
  }

  const newSession = res.headers.get("mcp-session-id") || sessionId;
  const ctype = res.headers.get("content-type") || "";
  const bodyText = await res.text();
  const raw = bodyText.slice(0, 300);

  if (!res.ok && !bodyText) {
    return { error: { code: res.status, message: `HTTP ${res.status}` }, sessionId: newSession, status: res.status, ctype, raw };
  }

  const payload = ctype.includes("text/event-stream")
    ? parseSse(bodyText, id)
    : safeJson(bodyText);

  if (!payload) {
    return { error: { code: -1, message: "Unparseable MCP response" }, sessionId: newSession, status: res.status, ctype, raw };
  }
  return { result: payload.result, error: payload.error, sessionId: newSession, status: res.status, ctype, raw };
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

/**
 * Prefer a Service binding (direct Worker-to-Worker RPC) when present; else fall
 * back to a public fetch. A Worker fetching its OWN zone's hostname does not
 * re-run Workers routing — the subrequest hits the origin and misses the /mcp
 * Worker route (returns the site's 404 HTML). The binding avoids DNS/routing
 * entirely, so it is the reliable transport for a same-zone MCP server.
 */
function pickFetch(fetcher?: Fetcher): typeof fetch {
  return fetcher ? (fetcher.fetch.bind(fetcher) as unknown as typeof fetch) : fetch;
}

type McpDebug = {
  url: string;
  transport: "service-binding" | "fetch";
  initStatus?: number;
  initError?: string;
  initCtype?: string;
  sessionId?: string;
  listStatus?: number;
  listError?: string;
  listCtype?: string;
  listRaw?: string;
  retried: boolean;
  toolCount: number;
};

/** Handshake + tools/list. Returns the tool list, session id, and diagnostics. */
async function mcpListTools(url: string, fetcher?: Fetcher): Promise<{ tools: Json[]; sessionId?: string; debug: McpDebug }> {
  const debug: McpDebug = { url, transport: fetcher ? "service-binding" : "fetch", retried: false, toolCount: 0 };
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
    undefined,
    fetcher,
  );
  debug.initStatus = init.status;
  debug.initCtype = init.ctype;
  if (init.error) debug.initError = String(init.error.message ?? JSON.stringify(init.error));
  const sessionId = init.sessionId;
  debug.sessionId = sessionId;

  // Politeness: tell the server we're initialized (notifications carry no id).
  if (sessionId) {
    try {
      await pickFetch(fetcher)(url, {
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

  let listed = await mcpRpc(url, "tools/list", {}, id++, sessionId, fetcher);
  let tools = (listed.result?.tools as Json[]) || [];
  // The server is stateless; a rare empty/failed list is transient — retry once.
  if (!tools.length) {
    debug.retried = true;
    listed = await mcpRpc(url, "tools/list", {}, id++, listed.sessionId ?? sessionId, fetcher);
    tools = (listed.result?.tools as Json[]) || [];
  }
  debug.listStatus = listed.status;
  debug.listCtype = listed.ctype;
  debug.listRaw = listed.raw;
  if (listed.error) debug.listError = String(listed.error.message ?? JSON.stringify(listed.error));
  debug.toolCount = tools.length;
  return { tools, sessionId: listed.sessionId ?? sessionId, debug };
}

/** Execute one tool and return its result flattened to text. */
async function mcpCallTool(
  url: string,
  name: string,
  args: Json,
  sessionId: string | undefined,
  fetcher?: Fetcher,
): Promise<string> {
  const r = await mcpRpc(url, "tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6) + 10, sessionId, fetcher);
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

/** The model's plain-text answer, wherever this model variant puts it. */
function textOf(resp: any): string {
  return (resp?.response ?? resp?.result ?? "").toString().trim();
}

/** Best-effort JSON parse of a model string that may be fenced or prose-wrapped. */
function looseJson(s: string): Json | Json[] | undefined {
  const stripped = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const whole = safeJson(stripped);
  if (whole) return whole;
  const m = stripped.match(/[\[{][\s\S]*[\]}]/);
  return m ? safeJson(m[0]) : undefined;
}

/**
 * Normalise however this model expressed tool calls into {name, arguments}[].
 * Some Workers AI models return structured `tool_calls`; others (json variant)
 * emit the call as JSON *text* in `response`, sometimes keyed `parameters`.
 */
function extractCalls(resp: any, known: Set<string>): { name: string; arguments: Json }[] {
  const norm = (o: any) => ({
    name: (o?.name || o?.function?.name || "") as string,
    arguments: coerceArgs(o?.arguments ?? o?.parameters ?? o?.function?.arguments),
  });

  const structured: any[] = Array.isArray(resp?.tool_calls) ? resp.tool_calls : [];
  if (structured.length) return structured.map(norm).filter((c) => c.name);

  // Text-form fallback: only treat as a call when the name is a real MCP tool,
  // so a genuine JSON answer is never mistaken for a tool invocation.
  const parsed = looseJson(textOf(resp));
  if (!parsed) return [];
  const arr: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Json).tool_calls)
      ? (parsed as Json).tool_calls
      : [parsed];
  return arr.map(norm).filter((c) => c.name && known.has(c.name));
}

/* --------------------------------------------------------------- agent loop */

async function runAgent(env: Env, userMessages: Msg[]) {
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  const mcpUrl = env.MCP_URL || DEFAULT_MCP_URL;
  const maxSteps = Number(env.MAX_STEPS) || DEFAULT_MAX_STEPS;
  const gateway = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
  const mcpFetch = env.MCP; // Service binding to ai-mcp, when configured

  const { tools: mcpTools, sessionId, debug: mcpDebug } = await mcpListTools(mcpUrl, mcpFetch);
  const aiTools = mcpTools.map(toAiTool);
  const toolNames = new Set<string>(mcpTools.map((t) => t.name));

  // If the MCP server gave us no tools, do NOT let the model freewheel and
  // hallucinate fake tool calls — say so plainly and hand back the diagnostics.
  if (!aiTools.length) {
    return {
      reply:
        "I couldn't load any tools from the MCP server, so I can't act on that yet. " +
        "This usually means the agent Worker can't reach " +
        `${mcpUrl} (see mcpDebug).`,
      steps: [],
      model,
      toolCount: 0,
      mcpDebug,
    };
  }

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...userMessages.filter((m) => m && m.role && typeof m.content === "string"),
  ];

  const steps: { tool: string; args: Json; result: string }[] = [];
  let reply = "";

  for (let step = 0; step < maxSteps; step++) {
    // NEVER pass an empty tools array — Workers AI 400s on it. Omit instead.
    const runInput: Json = aiTools.length ? { messages, tools: aiTools } : { messages };
    const resp: any = await env.AI.run(model, runInput, gateway as any);
    const calls = extractCalls(resp, toolNames);

    if (!calls.length) {
      reply = textOf(resp);
      break;
    }

    // Execute every tool the model asked for this turn, then loop again.
    for (const call of calls) {
      const { name, arguments: args } = call;
      const result = await mcpCallTool(mcpUrl, name, args, sessionId, mcpFetch);
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
    reply = textOf(resp) || "(no answer)";
  }

  return { reply, steps, model, toolCount: mcpTools.length, mcpDebug };
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

    // GET probe: does a LIVE tools/list so you can diagnose in a browser.
    if (request.method === "GET") {
      const mcpUrl = env.MCP_URL || DEFAULT_MCP_URL;
      let toolNames: string[] = [];
      let mcpDebug: McpDebug | { error: string };
      try {
        const listed = await mcpListTools(mcpUrl, env.MCP);
        toolNames = listed.tools.map((t) => String(t.name));
        mcpDebug = listed.debug;
      } catch (e: any) {
        mcpDebug = { error: String(e?.message || e) } as any;
      }
      return json({
        ok: toolNames.length > 0,
        service: "ai-agent",
        mcp: mcpUrl,
        model: env.AGENT_MODEL || DEFAULT_MODEL,
        toolCount: toolNames.length,
        toolNames,
        mcpDebug,
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
