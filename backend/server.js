// server.js — Pimenta API (Express + SQLite)
//
// Long-running backend that powers the shop & API console:
//   products, registration, JWT login, cart/basket, checkout, feedback.
// Designed to run under systemd (Restart=always, start on boot).

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { db, DB_PATH } = require("./db");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const JWT_TTL = process.env.JWT_TTL || "2h";
const STARTED_AT = Date.now();

if (JWT_SECRET === "change-me-in-production") {
  console.warn("[warn] JWT_SECRET is using the default — set a strong secret in the env file!");
}

const app = express();
app.use(express.json());

// CORS — restricted to the lab's own domains. Override with CORS_ORIGINS
// (comma-separated) in the env file. Requests with no Origin header
// (curl, server-to-server) are allowed.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  "https://www.pimenta.fun,https://shop.pimenta.fun,https://api.pimenta.fun"
).split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.disable("x-powered-by");

// Tiny request log
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_TTL });
}

// Required auth — 401 if no/invalid token.
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function basketForUser(userId) {
  let b = db.prepare("SELECT * FROM baskets WHERE user_id = ?").get(userId);
  if (!b) {
    const info = db.prepare("INSERT INTO baskets (user_id) VALUES (?)").run(userId);
    b = { id: info.lastInsertRowid, user_id: userId };
  }
  return b;
}

// ---------------------------------------------------------------------------
// Health / status (used by monitoring + systemd checks)
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  const counts = {
    users:    db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    products: db.prepare("SELECT COUNT(*) AS n FROM products").get().n,
    orders:   db.prepare("SELECT COUNT(*) AS n FROM orders").get().n
  };
  res.json({
    status: "ok",
    uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
    db_path: DB_PATH,
    counts
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// Register
app.post("/api/Users", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "email already registered" });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'customer')")
    .run(email, hash);
  basketForUser(info.lastInsertRowid);
  res.status(201).json({ data: { id: info.lastInsertRowid, email, role: "customer" } });
});

// Login — returns a Juice-Shop-shaped payload so the API console auto-captures the token.
app.post("/rest/user/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email || "");
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = signToken(user);
  const bid = basketForUser(user.id).id;
  res.json({ authentication: { token, bid, umail: user.email } });
});

// Who am I
app.get("/rest/user/whoami", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(req.user.id);
  res.json({ user });
});

// User details by id (auth). Intentionally returns any user → IDOR demo target.
app.get("/api/Users/:id", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, role, created_at FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ status: "success", data: user });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
app.get("/api/Products", (_req, res) => {
  const rows = db.prepare("SELECT * FROM products ORDER BY id").all();
  res.json({ status: "success", data: rows });
});

app.get("/api/Products/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Product not found" });
  res.json({ status: "success", data: row });
});

// Update a product (auth). Only provided fields are changed.
app.put("/api/Products/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Product not found" });
  const b = req.body || {};
  const updated = {
    name: b.name != null ? b.name : existing.name,
    description: b.description != null ? b.description : existing.description,
    price: b.price != null ? Number(b.price) : existing.price,
    emoji: b.emoji != null ? b.emoji : existing.emoji
  };
  db.prepare("UPDATE products SET name = ?, description = ?, price = ?, emoji = ? WHERE id = ?")
    .run(updated.name, updated.description, updated.price, updated.emoji, req.params.id);
  res.json({ status: "success", data: { id: Number(req.params.id), ...updated } });
});

// Search (parameterised — safe; swap to string-concat if you want an SQLi target)
app.get("/rest/products/search", (req, res) => {
  const q = "%" + (req.query.q || "") + "%";
  const rows = db.prepare(
    "SELECT * FROM products WHERE name LIKE ? OR description LIKE ? ORDER BY id"
  ).all(q, q);
  res.json({ status: "success", data: rows });
});

// ---------------------------------------------------------------------------
// Basket / cart
// ---------------------------------------------------------------------------
app.post("/api/BasketItems", requireAuth, (req, res) => {
  const { ProductId, quantity } = req.body || {};
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(ProductId);
  if (!product) return res.status(404).json({ error: "Product not found" });
  const qty = Math.max(1, parseInt(quantity || 1, 10));
  const basket = basketForUser(req.user.id);

  const existing = db.prepare(
    "SELECT * FROM basket_items WHERE basket_id = ? AND product_id = ?"
  ).get(basket.id, ProductId);

  if (existing) {
    db.prepare("UPDATE basket_items SET quantity = quantity + ? WHERE id = ?").run(qty, existing.id);
  } else {
    db.prepare("INSERT INTO basket_items (basket_id, product_id, quantity) VALUES (?, ?, ?)")
      .run(basket.id, ProductId, qty);
  }
  res.status(201).json({ status: "success", data: { BasketId: basket.id, ProductId, quantity: qty } });
});

app.get("/rest/basket/:id", requireAuth, (req, res) => {
  const basket = basketForUser(req.user.id);
  const items = db.prepare(`
    SELECT bi.id, bi.quantity, p.id AS product_id, p.name, p.price, p.emoji
    FROM basket_items bi JOIN products p ON p.id = bi.product_id
    WHERE bi.basket_id = ?
  `).all(basket.id);
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  res.json({ status: "success", data: { id: basket.id, items, total: Number(total.toFixed(2)) } });
});

app.post("/rest/basket/:id/checkout", requireAuth, (req, res) => {
  const basket = basketForUser(req.user.id);
  const items = db.prepare(`
    SELECT bi.quantity, p.id AS product_id, p.name, p.price
    FROM basket_items bi JOIN products p ON p.id = bi.product_id
    WHERE bi.basket_id = ?
  `).all(basket.id);
  if (items.length === 0) return res.status(400).json({ error: "Basket is empty" });

  const total = Number(items.reduce((s, i) => s + i.price * i.quantity, 0).toFixed(2));
  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO orders (user_id, total, items_json) VALUES (?, ?, ?)")
      .run(req.user.id, total, JSON.stringify(items));
    db.prepare("DELETE FROM basket_items WHERE basket_id = ?").run(basket.id);
    return info.lastInsertRowid;
  });
  const orderId = tx();
  res.json({ status: "success", data: { orderId: "PIM-" + orderId, total } });
});

// ---------------------------------------------------------------------------
// Orders (current user's order history)
// ---------------------------------------------------------------------------
app.get("/api/Orders", requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT id, total, items_json, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100"
  ).all(req.user.id);
  const orders = rows.map(o => {
    let items = [];
    try { items = JSON.parse(o.items_json); } catch (e) {}
    return { orderId: "PIM-" + o.id, total: o.total, created_at: o.created_at, items };
  });
  res.json({ status: "success", data: orders });
});

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
app.get("/api/Feedbacks", (_req, res) => {
  const rows = db.prepare("SELECT id, comment, rating, created_at FROM feedbacks ORDER BY id DESC LIMIT 100").all();
  res.json({ status: "success", data: rows });
});

app.post("/api/Feedbacks", (req, res) => {
  const { comment, rating } = req.body || {};
  if (!comment) return res.status(400).json({ error: "comment required" });
  const r = Math.min(5, Math.max(1, parseInt(rating || 5, 10)));
  // Optional auth: attribute to a user if a valid token is present.
  let userId = null;
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Bearer ")) {
    try { userId = jwt.verify(hdr.slice(7), JWT_SECRET).id; } catch (e) {}
  }
  const info = db.prepare("INSERT INTO feedbacks (comment, rating, user_id) VALUES (?, ?, ?)")
    .run(comment, r, userId);
  res.status(201).json({ status: "success", data: { id: info.lastInsertRowid, comment, rating: r } });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
app.get("/rest/admin/application-version", (_req, res) => {
  res.json({ status: "success", version: "1.0.0", name: "pimenta-api" });
});

// ---------------------------------------------------------------------------
// Fallback + error handling
// ---------------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));
app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Pimenta API listening on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
});

// Graceful shutdown so systemd restarts are clean.
function shutdown(sig) {
  console.log(`\n[${sig}] shutting down…`);
  server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
