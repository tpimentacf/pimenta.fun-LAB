// db.js — SQLite database layer for the Pimenta API.
// Creates the schema on first run and seeds products + an admin user.
// The DB file persists on disk, so data survives restarts and reboots.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "pimenta.db");

// Ensure the directory exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");   // better concurrency + durability
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'customer',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL DEFAULT 0,
    emoji       TEXT NOT NULL DEFAULT '🧃',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS baskets (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS basket_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    basket_id  INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (basket_id)  REFERENCES baskets(id)  ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS feedbacks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    comment    TEXT NOT NULL,
    rating     INTEGER NOT NULL DEFAULT 5,
    user_id    INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    total      REAL NOT NULL,
    items_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ---------------------------------------------------------------------------
// Seed (idempotent)
// ---------------------------------------------------------------------------
function seed() {
  const productCount = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  if (productCount === 0) {
    const insert = db.prepare(
      "INSERT INTO products (name, description, price, emoji) VALUES (?, ?, ?, ?)"
    );
    const items = [
      ["Apple Juice (1L)",       "The original. Cold-pressed daily.", 1.99, "🍎"],
      ["Carrot Juice (1L)",      "Loaded with beta-carotene.",        2.99, "🥕"],
      ["Eggfruit Juice (500ml)", "Exotic and creamy.",                8.99, "🥚"],
      ["Strawberry Smoothie",    "Blended fresh berries.",            4.99, "🍓"],
      ["Lemon Juice (500ml)",    "Sour, refreshing, zingy.",          2.99, "🍋"],
      ["Melon Bike (Limited)",   "Collector's edition merch.",     2999.00, "🍈"],
      ["OWASP Juice Sticker",    "Show your AppSec pride.",           0.99, "👕"],
      ["Banana Juice (1L)",      "Smooth and tropical.",              1.99, "🍌"]
    ];
    const tx = db.transaction(() => items.forEach(i => insert.run(...i)));
    tx();
    console.log(`[seed] inserted ${items.length} products`);
  }

  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (userCount === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || "admin@juice-sh.op";
    const adminPass  = process.env.ADMIN_PASSWORD || "admin123";
    const hash = bcrypt.hashSync(adminPass, 10);
    const info = db.prepare(
      "INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')"
    ).run(adminEmail, hash);
    db.prepare("INSERT INTO baskets (user_id) VALUES (?)").run(info.lastInsertRowid);
    console.log(`[seed] created admin user ${adminEmail} (password: ${adminPass})`);
  }
}

seed();

// Allow `node db.js --seed` to (re)initialise without starting the server.
if (require.main === module && process.argv.includes("--seed")) {
  console.log("[db] schema ready, seed complete at", DB_PATH);
  process.exit(0);
}

module.exports = { db, DB_PATH };
