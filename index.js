const express = require("express");
const app = express();

const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

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

app.post("/setup", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.use(express.json());

app.post("/customers", async (req, res) => {
  const { name, phone } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING *",
      [name, phone || null]
    );
    res.json(result.rows[0]);
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on port ${port}');
});