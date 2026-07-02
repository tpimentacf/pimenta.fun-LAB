/**
 * ai-mcp — Pimenta Lab
 *
 * A remote MCP (Model Context Protocol) server on Cloudflare Workers, wired to a
 * real backend: D1 (SQL) for notes, KV for key/value, and Workers AI via
 * AI Gateway for inference. Stateless — uses createMcpHandler (no Durable
 * Objects). Serves Streamable HTTP transport at /mcp.
 *
 * Tools exposed:
 *   D1:        create_note, list_notes, get_note, delete_note
 *   KV:        kv_put, kv_get
 *   Workers AI: ask_ai  (runs an LLM through AI Gateway, logs the call to D1)
 *
 * Docs:
 *   MCP on Workers  https://developers.cloudflare.com/agents/model-context-protocol/
 *   createMcpHandler https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
 *   Workers AI + AIG https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/
 *
 * SECURITY NOTE: this template is unauthenticated (anyone who knows the URL can
 * call the tools). For production, front it with the OAuthProvider / Cloudflare
 * Access — see the guide.
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  AI: Ai;                 // Workers AI binding
  DB: D1Database;         // D1 database binding
  KV: KVNamespace;        // Workers KV binding
  AI_GATEWAY_ID?: string; // AI Gateway id (defaults to "default")
  AI_MODEL?: string;      // override the default model
}

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/**
 * Build a fresh McpServer per request. MCP SDK >= 1.26.0 forbids reusing a
 * server instance across requests, so never hoist this to global scope.
 */
function createServer(env: Env) {
  const server = new McpServer({
    name: "pimenta-ai-mcp",
    version: "1.0.0",
  });

  // ── D1: notes CRUD ────────────────────────────────────────────────
  server.tool(
    "create_note",
    "Create a note in the D1 database. Returns the new note id.",
    { title: z.string().min(1), body: z.string().default("") },
    async ({ title, body }) => {
      const id = crypto.randomUUID();
      const created_at = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO notes (id, title, body, created_at) VALUES (?, ?, ?, ?)"
      ).bind(id, title, body, created_at).run();
      return text(`Created note ${id} — "${title}"`);
    }
  );

  server.tool(
    "list_notes",
    "List notes from D1, newest first.",
    { limit: z.number().int().min(1).max(100).default(20) },
    async ({ limit }) => {
      const { results } = await env.DB.prepare(
        "SELECT id, title, body, created_at FROM notes ORDER BY created_at DESC LIMIT ?"
      ).bind(limit).all();
      if (!results || results.length === 0) return text("No notes yet.");
      return text(JSON.stringify(results, null, 2));
    }
  );

  server.tool(
    "get_note",
    "Fetch a single note from D1 by id.",
    { id: z.string().min(1) },
    async ({ id }) => {
      const row = await env.DB.prepare(
        "SELECT id, title, body, created_at FROM notes WHERE id = ?"
      ).bind(id).first();
      return row ? text(JSON.stringify(row, null, 2)) : text(`No note with id ${id}`);
    }
  );

  server.tool(
    "delete_note",
    "Delete a note from D1 by id.",
    { id: z.string().min(1) },
    async ({ id }) => {
      const res = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
      const changes = (res.meta && res.meta.changes) || 0;
      return text(changes ? `Deleted note ${id}` : `No note with id ${id}`);
    }
  );

  // ── KV: key/value ─────────────────────────────────────────────────
  server.tool(
    "kv_put",
    "Store a value in Workers KV, with an optional TTL in seconds (min 60).",
    { key: z.string().min(1), value: z.string(), ttl_seconds: z.number().int().min(60).optional() },
    async ({ key, value, ttl_seconds }) => {
      await env.KV.put(key, value, ttl_seconds ? { expirationTtl: ttl_seconds } : undefined);
      return text(`Stored KV key "${key}"${ttl_seconds ? ` (ttl ${ttl_seconds}s)` : ""}.`);
    }
  );

  server.tool(
    "kv_get",
    "Read a value from Workers KV by key.",
    { key: z.string().min(1) },
    async ({ key }) => {
      const v = await env.KV.get(key);
      return v === null ? text(`Key "${key}" not found.`) : text(v);
    }
  );

  // ── Workers AI via AI Gateway ─────────────────────────────────────
  server.tool(
    "ask_ai",
    "Ask an LLM a question. Runs Workers AI through AI Gateway and logs the call to D1.",
    { prompt: z.string().min(1), system: z.string().optional() },
    async ({ prompt, system }) => {
      const model = env.AI_MODEL || DEFAULT_MODEL;
      const messages = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ];
      const result: any = await env.AI.run(
        model,
        { messages },
        { gateway: { id: env.AI_GATEWAY_ID || "default" } }
      );
      const answer = (result && (result.response ?? result.result)) || JSON.stringify(result);

      // Best-effort log to D1 so you can show stored history in the demo.
      try {
        await env.DB.prepare(
          "INSERT INTO ai_calls (id, model, prompt, answer, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), model, prompt, String(answer), new Date().toISOString()).run();
      } catch (_) { /* table optional */ }

      return text(String(answer));
    }
  );

  return server;
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    // Create a new server instance per request (SDK 1.26.0 requirement) and
    // close over env so tools can reach D1 / KV / AI.
    const server = createServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
