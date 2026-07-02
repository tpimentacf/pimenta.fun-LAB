# ai-mcp Worker

A **remote MCP server** on Cloudflare Workers, wired to a **real backend**:

- **D1** (SQL) — notes CRUD + an `ai_calls` audit log
- **KV** — key/value store
- **Workers AI via AI Gateway** — LLM inference with caching/observability

It is **stateless** (uses `createMcpHandler`, no Durable Objects) and speaks the
**Streamable HTTP** MCP transport at `/mcp`.

Powers the **AI & MCP Lab** at <https://www.pimenta.fun/ai-lab/>.

## Tools

| Tool          | Backend      | Description                                        |
| ------------- | ------------ | -------------------------------------------------- |
| `create_note` | D1           | Insert a note (`title`, `body`) → returns id       |
| `list_notes`  | D1           | List notes, newest first (`limit`)                 |
| `get_note`    | D1           | Fetch one note by `id`                             |
| `delete_note` | D1           | Delete a note by `id`                              |
| `kv_put`      | KV           | Store `key`=`value` (optional `ttl_seconds`)       |
| `kv_get`      | KV           | Read a value by `key`                              |
| `ask_ai`      | Workers AI   | Run an LLM through AI Gateway; logs the call to D1  |

## Files

| File              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `src/index.ts`    | MCP server + tools (D1 / KV / Workers AI)      |
| `wrangler.jsonc`  | Bindings (AI, D1, KV), vars, observability     |
| `schema.sql`      | D1 tables (`notes`, `ai_calls`)                |
| `package.json`    | Dependencies + scripts                         |

## Prerequisites

- Node 18+ and **Wrangler ≥ 4.36.0**
- A Cloudflare account with Workers AI enabled

## Deploy — step by step

```bash
cd workers/ai-mcp
npm install

# 1) Create the D1 database, then copy the printed database_id into wrangler.jsonc
npx wrangler d1 create pimenta-ai-mcp

# 2) Create the KV namespace, then copy the printed id into wrangler.jsonc
npx wrangler kv namespace create KV

# 3) Apply the D1 schema (remote)
npx wrangler d1 execute pimenta-ai-mcp --remote --file=./schema.sql

# 4) (Optional) create a named AI Gateway called "pimenta-lab" in the dashboard
#    Dashboard → AI → AI Gateway → Create. Or leave AI_GATEWAY_ID = "default".

# 5) Deploy
npx wrangler deploy
```

Your MCP endpoint will be:

```
https://ai-mcp.<your-subdomain>.workers.dev/mcp
```

## Test

**MCP Inspector** (interactive client):

```bash
npx @modelcontextprotocol/inspector@latest
# open the printed URL, enter your /mcp endpoint, Connect → List Tools
```

**Cloudflare AI Playground** — a hosted remote MCP client:
<https://playground.ai.cloudflare.com/> → add your `/mcp` URL.

**Claude Desktop** (via the mcp-remote proxy):

```json
{
  "mcpServers": {
    "pimenta-ai-mcp": {
      "command": "npx",
      "args": ["mcp-remote", "https://ai-mcp.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

**Raw curl** (initialize handshake — Streamable HTTP):

```bash
curl -sS https://ai-mcp.<your-subdomain>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## Local dev

```bash
npx wrangler d1 execute pimenta-ai-mcp --local --file=./schema.sql
npx wrangler dev
# MCP endpoint: http://localhost:8787/mcp
```

Note: Workers AI always runs against your Cloudflare account (billable) even in
local dev.

## Securing it (production)

This template is **unauthenticated**. To require login, wrap the handler with
`OAuthProvider` (`@cloudflare/workers-oauth-provider`) using GitHub/Google, or
put it behind **Cloudflare Access**. See:
<https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/#add-authentication>
