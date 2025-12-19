const express = require("express");
const app = express();
app.use(express.json());

const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");


app.get("/db-health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});



app.post("/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
      [email.toLowerCase(), passwordHash]
    );

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    // likely duplicate email
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  try {
    const result = await pool.query("SELECT id, email, password_hash FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: "invalid credentials" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ ok: false, error: "invalid credentials" });

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
 res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});


    function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { sub, email, iat, exp }
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
}

app.get("/me", requireAuth, async (req, res) => {
  const userId = Number(req.user.sub);

  const result = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [userId]
  );

  if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "user not found" });
  res.json({ ok: true, user: result.rows[0] });
});


app.post("/customers", requireAuth, async (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: "name required" });

  try {
    const userId = Number(req.user.sub);

    const result = await pool.query(
      "INSERT INTO customers (name, phone, user_id) VALUES ($1, $2, $3) RETURNING *",
      [name, phone || null, userId]
    );

    res.json({ ok: true, customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/customers", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const result = await pool.query(
      "SELECT * FROM customers WHERE user_id = $1 ORDER BY id DESC LIMIT 50",
      [userId]
    );
    res.json({ ok: true, customers: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});


app.get("/customers/:id", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const customerId = Number(req.params.id);

    const result = await pool.query(
      "SELECT * FROM customers WHERE id = $1 AND user_id = $2",
      [customerId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    res.json({ ok: true, customer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});


app.get("/customers/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM customers WHERE id = $1",
      [Number(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/setup-loyalty", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        subtotal_cents INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS loyalty_ledger (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        order_id INTEGER,
        points_delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ledger_customer_id ON loyalty_ledger(customer_id);`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});



const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on port ${port}');
});