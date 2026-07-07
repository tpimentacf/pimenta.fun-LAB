# ai-agent — Pimenta Lab

A **chat agent** on Cloudflare Workers that is *connected to* the
[`ai-mcp`](../ai-mcp) remote MCP server. It runs a classic tool-calling loop:

```
user message
   │
   ▼
Workers AI (llama-3.3-70b, function calling)  ◀──┐
   │  decides: answer  or  call a tool           │ feed tool result back
   ▼                                             │
MCP  tools/call  →  ai-mcp server  →  D1 / KV / Workers AI
   └─────────────────────────────────────────────┘
```

The agent is the MCP **client**; the MCP server owns the data (D1 notes, KV,
`ask_ai`). It speaks the MCP **Streamable HTTP** transport by hand with `fetch`
(+ SSE parsing), so it needs **no MCP SDK dependency**.

Powers the **AI Chat Agent** page at <https://www.pimenta.fun/agent/>.

## Endpoint

`POST /agent/api`

```jsonc
// request
{ "messages": [ { "role": "user", "content": "list my notes" } ] }
// or the shorthand
{ "message": "save a note titled Groceries with body milk, eggs" }
```

```jsonc
// response
{
  "reply": "You have 2 notes: ...",
  "steps": [ { "tool": "list_notes", "args": { "limit": 20 }, "result": "..." } ],
  "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "toolCount": 7
}
```

A `GET /agent/api` returns a small JSON probe (service, MCP URL, model).

## How it works

1. `initialize` + `tools/list` against `MCP_URL` — discover the server's tools.
2. Map each MCP tool's JSON-Schema `inputSchema` into the Workers AI `tools` format.
3. `env.AI.run(model, { messages, tools })` — the model either answers or emits `tool_calls`.
4. For each tool call, `tools/call` on the MCP server, append the result as a `tool` message, loop (capped by `MAX_STEPS`).
5. When the model stops calling tools, its text is the reply.

## Configuration (`wrangler.jsonc` vars)

| var             | default                                     | purpose                                  |
| --------------- | ------------------------------------------- | ---------------------------------------- |
| `MCP_URL`       | `https://www.pimenta.fun/mcp`               | remote MCP server (Streamable HTTP)      |
| `AGENT_MODEL`   | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`  | tool-calling model (must support tools)  |
| `AI_GATEWAY_ID` | `pimenta-lab`                               | AI Gateway id for observability          |
| `MAX_STEPS`     | `5`                                         | safety cap on tool-loop iterations       |

Bindings: `AI` (Workers AI). No D1/KV binding here — those live on the MCP server.

## Deploy — step by step

```sh
# 0) Make sure the MCP server it talks to is already deployed
#    (workers/ai-mcp -> https://www.pimenta.fun/mcp)

cd workers/ai-agent

# 1) Install tooling
npm install

# 2) Deploy (uses the ai binding + route in wrangler.jsonc)
npx wrangler deploy
```

## Test

```sh
# probe
curl -sS https://www.pimenta.fun/agent/api

# a real turn
curl -sS https://www.pimenta.fun/agent/api \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"list my notes"}]}'
```

## Security

This endpoint is **unauthenticated** and fronts an unauthenticated MCP server —
fine for a lab, not for production. For real use, put it behind Cloudflare
Access or a rate-limit rule, and never point the loop at MCP servers whose tools
you don't trust. See the
[MCP authorization guide](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/).
