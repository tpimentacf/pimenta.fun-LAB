-- D1 schema for the ai-mcp Worker.
-- Apply locally:  npx wrangler d1 execute pimenta-ai-mcp --local  --file=./schema.sql
-- Apply remote:   npx wrangler d1 execute pimenta-ai-mcp --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes (created_at DESC);

-- Optional: audit log for ask_ai calls so you can show stored history.
CREATE TABLE IF NOT EXISTS ai_calls (
  id         TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  answer     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at ON ai_calls (created_at DESC);
