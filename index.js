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

const crypto = require("crypto");

function safeEqual(a, b) {
  const aa = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function requireWebhookSecret(req, res, next) {
  const provided = req.get("X-Webhook-Secret");
  const expected = process.env.WEBHOOK_SECRET;

  if (!expected) return res.status(500).json({ ok: false, error: "WEBHOOK_SECRET not configured" });
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
  }
  next();
}


const webhookHits = new Map();

function rateLimitWebhook(req, res, next) {
  const limit = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN || 120);
  const now = Date.now();
  const windowMs = 60_000;

  const key = req.ip || "unknown";
  const entry = webhookHits.get(key) || { count: 0, start: now };

  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }

  entry.count += 1;
  webhookHits.set(key, entry);

  if (entry.count > limit) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }
  next();
}


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




app.get("/customers/:id/points", requireAuth, async (req, res) => {
  const userId = Number(req.user.sub);
  const customerId = Number(req.params.id);

  try {
    // verify ownership
    const c = await pool.query(
      "SELECT id FROM customers WHERE id = $1 AND user_id = $2",
      [customerId, userId]
    );
    if (c.rows.length === 0) return res.status(404).json({ ok: false, error: "Customer not found" });

    const sum = await pool.query(
      "SELECT COALESCE(SUM(points_delta), 0) AS points FROM loyalty_ledger WHERE customer_id = $1 AND user_id = $2",
      [customerId, userId]
    );

    res.json({ ok: true, customer_id: customerId, points: Number(sum.rows[0].points) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/customers/:id/redeem", requireAuth, async (req, res) => {
  const userId = Number(req.user.sub);
  const customerId = Number(req.params.id);

  const pointsToRedeem = Number(req.body?.points);
  const reason = req.body?.reason ? String(req.body.reason) : "redeem";

  const idemKey =
    (req.get("Idempotency-Key") ? String(req.get("Idempotency-Key")) : null) ||
    (req.body?.idempotency_key ? String(req.body.idempotency_key) : null);

  if (!pointsToRedeem || pointsToRedeem <= 0) {
    return res.status(400).json({ ok: false, error: "points must be a positive number" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock per (user, customer) to prevent redeem/earn races
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [userId, customerId]);

    // Verify customer ownership
    const c = await client.query(
      "SELECT id FROM customers WHERE id = $1 AND user_id = $2",
      [customerId, userId]
    );
    if (c.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    // Idempotency replay check (if key provided)
    if (idemKey) {
      const existing = await client.query(
        "SELECT * FROM loyalty_ledger WHERE user_id=$1 AND customer_id=$2 AND idempotency_key=$3 LIMIT 1",
        [userId, customerId, idemKey]
      );

      if (existing.rows.length > 0) {
        // Compute current balance (includes that redemption)
        const sum = await client.query(
          "SELECT COALESCE(SUM(points_delta), 0) AS points FROM loyalty_ledger WHERE user_id=$1 AND customer_id=$2",
          [userId, customerId]
        );

        await client.query("COMMIT");
        return res.json({
          ok: true,
          idempotent_replay: true,
          redeemed: Math.abs(Number(existing.rows[0].points_delta)),
          balance: Number(sum.rows[0].points),
          ledger_entry: existing.rows[0],
        });
      }
    }

    // Current balance (after lock)
    const sum = await client.query(
      "SELECT COALESCE(SUM(points_delta), 0) AS points FROM loyalty_ledger WHERE user_id=$1 AND customer_id=$2",
      [userId, customerId]
    );
    const balance = Number(sum.rows[0].points);

    if (balance < pointsToRedeem) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: `Insufficient points. Balance=${balance}` });
    }

    // Insert redemption (negative delta) with idempotency key
    const entry = await client.query(
      `INSERT INTO loyalty_ledger (user_id, customer_id, order_id, points_delta, reason, idempotency_key)
       VALUES ($1, $2, NULL, $3, $4, $5)
       RETURNING *`,
      [userId, customerId, -pointsToRedeem, reason, idemKey || null]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      idempotent_replay: false,
      redeemed: pointsToRedeem,
      balance: balance - pointsToRedeem,
      ledger_entry: entry.rows[0],
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}

    // If unique constraint fires (retry/race), fetch existing and return replay
    if (idemKey && String(err.message || err).toLowerCase().includes("duplicate")) {
      try {
        const existing = await pool.query(
          "SELECT * FROM loyalty_ledger WHERE user_id=$1 AND customer_id=$2 AND idempotency_key=$3 LIMIT 1",
          [userId, customerId, idemKey]
        );

        if (existing.rows.length > 0) {
          const sum = await pool.query(
            "SELECT COALESCE(SUM(points_delta), 0) AS points FROM loyalty_ledger WHERE user_id=$1 AND customer_id=$2",
            [userId, customerId]
          );

          return res.json({
            ok: true,
            idempotent_replay: true,
            redeemed: Math.abs(Number(existing.rows[0].points_delta)),
            balance: Number(sum.rows[0].points),
            ledger_entry: existing.rows[0],
          });
        }
      } catch {}
    }

    res.status(500).json({ ok: false, error: String(err.message || err) });
  } finally {
    client.release();
  }
});


app.get("/customers/:id/ledger", requireAuth, async (req, res) => {
  const userId = Number(req.user.sub);
  const customerId = Number(req.params.id);

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const beforeId = req.query.before_id ? Number(req.query.before_id) : null;

  try {
    // Verify customer ownership
    const c = await pool.query(
      "SELECT id FROM customers WHERE id = $1 AND user_id = $2",
      [customerId, userId]
    );
    if (c.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    // Fetch ledger entries
    const params = [userId, customerId];
    let sql = `
      SELECT id, customer_id, order_id, points_delta, reason, created_at
      FROM loyalty_ledger
      WHERE user_id = $1 AND customer_id = $2
    `;

    if (beforeId) {
      params.push(beforeId);
      sql += ` AND id < $3 `;
    }

    params.push(limit);
    sql += ` ORDER BY id DESC LIMIT $${params.length}; `;

    const result = await pool.query(sql, params);

    const next_before_id =
      result.rows.length > 0 ? result.rows[result.rows.length - 1].id : null;

    res.json({
      ok: true,
      customer_id: customerId,
      ledger: result.rows,
      next_before_id,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});


app.post("/webhooks/orders", requireAuth, async (req, res) => {
  const userId = Number(req.user.sub);

  const customerId = Number(req.body?.customer_id);
  const subtotalCents = Number(req.body?.subtotal_cents);

  // Read idempotency key from header OR body
  const idemKey =
    (req.get("Idempotency-Key") ? String(req.get("Idempotency-Key")) : null) ||
    (req.body?.idempotency_key ? String(req.body.idempotency_key) : null);

  if (!customerId || !subtotalCents || subtotalCents <= 0) {
    return res.status(400).json({
      ok: false,
      error: "customer_id and subtotal_cents (> 0) required",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Earn/redeem safety lock per customer
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [userId, customerId]);

    // Idempotency replay check
    if (idemKey) {
      const existing = await client.query(
        "SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
        [userId, idemKey]
      );

      if (existing.rows.length > 0) {
        const earned = await client.query(
          "SELECT COALESCE(SUM(points_delta), 0) AS points FROM loyalty_ledger WHERE user_id=$1 AND order_id=$2",
          [userId, existing.rows[0].id]
        );

        await client.query("COMMIT");
        return res.json({
          ok: true,
          idempotent_replay: true,
          order: existing.rows[0],
          points_earned: Number(earned.rows[0].points),
          

        });
      }
    }

    // Verify customer ownership
    const c = await client.query(
      "SELECT id FROM customers WHERE id = $1 AND user_id = $2",
      [customerId, userId]
    );
    if (c.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    // Create order (store idempotency key)
    const orderResult = await client.query(
      "INSERT INTO orders (user_id, customer_id, subtotal_cents, idempotency_key) VALUES ($1, $2, $3, $4) RETURNING *",
      [userId, customerId, subtotalCents, idemKey || null]
    );

    const points = Math.floor(subtotalCents / 100);

    // Earn ledger entry
    await client.query(
      "INSERT INTO loyalty_ledger (user_id, customer_id, order_id, points_delta, reason) VALUES ($1, $2, $3, $4, $5)",
      [userId, customerId, orderResult.rows[0].id, points, "earn_from_order"]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      idempotent_replay: false,
      order: orderResult.rows[0],
      points_earned: points,
      
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}

    // If unique constraint triggers, return the existing order (race-safe)
    if (idemKey && String(err.message || err).toLowerCase().includes("duplicate")) {
      try {
        const existing = await pool.query(
          "SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1",
          [userId, idemKey]
        );
        if (existing.rows.length > 0) {
          const earned = await pool.query(
            "SELECT COALESCE(SUM(points_delta), 0) AS points FROM loyalty_ledger WHERE user_id=$1 AND order_id=$2",
            [userId, existing.rows[0].id]
          );
          return res.json({
            ok: true,
            idempotent_replay: true,
            order: existing.rows[0],
            points_earned: Number(earned.rows[0].points),
          });
        }
      } catch {}
    }

    res.status(500).json({ ok: false, error: String(err.message || err) });
  } finally {
    client.release();
  }
});




app.get("/orders/:id", requireAuth, async (req, res) => {
  const userId = Number(req.user.sub);
  const orderId = Number(req.params.id);

  try {
    const result = await pool.query(
      `
      SELECT
        o.id,
        o.customer_id,
        o.subtotal_cents,
        o.created_at,
        o.idempotency_key,
        c.name AS customer_name,
        c.phone AS customer_phone,
        COALESCE(SUM(l.points_delta), 0) AS points_delta
      FROM orders o
      JOIN customers c
        ON c.id = o.customer_id
       AND c.user_id = o.user_id
      LEFT JOIN loyalty_ledger l
        ON l.order_id = o.id
       AND l.user_id = o.user_id
      WHERE o.id = $1 AND o.user_id = $2
      GROUP BY o.id, o.idempotency_key, c.name, c.phone
      `,
      [orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    const row = result.rows[0];

    res.json({
      ok: true,
      order: {
        id: row.id,
        idempotency_key: row.idempotency_key,
        customer_id: row.customer_id,
        subtotal_cents: row.subtotal_cents,
        created_at: row.created_at,
        points_delta: Number(row.points_delta), // earned points for this order (usually positive)
      },
      customer: {
        id: row.customer_id,
        name: row.customer_name,
        phone: row.customer_phone,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/webhooks/orders", requireWebhookSecret, async (req, res) => {
  const {
    
    pos_order_id,
    pos_customer_id,
    customer_name,
    customer_phone,
    subtotal_cents
  } = req.body || {};

const posOrderId = String(pos_order_id || "").trim();
const posCustomerId = String(pos_customer_id || "").trim();

if (posOrderId.length < 3 || posOrderId.length > 200) {
  return res.status(400).json({ ok: false, error: "pos_order_id invalid" });
}
if (posCustomerId.length < 3 || posCustomerId.length > 200) {
  return res.status(400).json({ ok: false, error: "pos_customer_id invalid" });
}
if (!Number.isInteger(subtotalCents) || subtotalCents <= 0 || subtotalCents > 10_000_000) {
  return res.status(400).json({ ok: false, error: "subtotal_cents invalid" });
}


  const userId = Number(process.env.WEBHOOK_USER_ID);
if (!userId) {
  return res.status(500).json({ ok: false, error: "WEBHOOK_USER_ID not configured" });
}

  const subtotalCents = Number(subtotal_cents);

  if (!pos_order_id || !pos_customer_id || !subtotalCents) {
  return res.status(400).json({
    ok: false,
    error: "pos_order_id, pos_customer_id, subtotal_cents required"
  });
}


  const idemKey = String(pos_order_id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Find or create customer by (user_id, pos_customer_id)
    let cust = await client.query(
      "SELECT * FROM customers WHERE user_id=$1 AND pos_customer_id=$2 LIMIT 1",
      [userId, String(pos_customer_id)]
    );

    if (cust.rows.length === 0) {
      const created = await client.query(
        `INSERT INTO customers (user_id, pos_customer_id, name, phone)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, String(pos_customer_id), String(customer_name || "POS Customer"), customer_phone || null]
      );
      cust = created;
    }

    const customerId = cust.rows[0].id;

    // Lock per customer for earn/redeem safety
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [userId, customerId]);

    // Idempotency: if this pos_order_id already created, return ok (replay)
    const existing = await client.query(
      "SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1",
      [userId, idemKey]
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return res.json({ ok: true, replay: true, order_id: existing.rows[0].id });
    }

    // Create order with idempotency_key = pos_order_id
    const orderResult = await client.query(
      "INSERT INTO orders (user_id, customer_id, subtotal_cents, idempotency_key) VALUES ($1, $2, $3, $4) RETURNING *",
      [userId, customerId, subtotalCents, idemKey]
    );

    const points = Math.floor(subtotalCents / 100);

    await client.query(
      "INSERT INTO loyalty_ledger (user_id, customer_id, order_id, points_delta, reason) VALUES ($1, $2, $3, $4, $5)",
      [userId, customerId, orderResult.rows[0].id, points, "earn_from_webhook_order"]
    );

    await client.query("COMMIT");
    res.json({ ok: true, replay: false, order_id: orderResult.rows[0].id, points_earned: points });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}

    // If unique constraint hit due to race, treat as replay
    if (String(err.message || err).toLowerCase().includes("duplicate")) {
      try {
        const existing = await pool.query(
          "SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1",
          [Number(req.body?.user_id), String(req.body?.pos_order_id)]
        );
        if (existing.rows.length > 0) {
          return res.json({ ok: true, replay: true, order_id: existing.rows[0].id });
        }
      } catch {}
    }

    res.status(500).json({ ok: false, error: String(err.message || err) });
  } finally {
    client.release();
  }
});




const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on port ${port}');
});