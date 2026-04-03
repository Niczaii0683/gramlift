// server/index.js — GramLift Backend (Stripe, Malaysia)
// ─────────────────────────────────────────────────────────────────────────────
// HOW THIS WORKS:
//  1. Customer picks a package, enters Instagram username, clicks Pay
//  2. Browser calls POST /api/create-checkout  →  server asks Stripe to make a payment page
//  3. Stripe returns a URL  →  browser redirects customer there (real Stripe card form)
//  4. Customer enters Visa/Mastercard/Amex on Stripe's page
//  5. Payment goes through  →  Stripe calls POST /webhook on your server
//  6. Server calls SocialLegend API with username + quantity  →  followers ordered
//  7. Money lands in your Stripe Malaysia account  →  auto-deposited to your bank
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const Stripe  = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app    = express();

// ── Stripe webhooks MUST receive the raw body — this line must come first ─────
app.use("/webhook", express.raw({ type: "application/json" }));

// Everything else uses JSON
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

// Serve your frontend HTML files from the public/ folder
// Visit http://localhost:3001 to see your full website
app.use(express.static(path.join(__dirname, "../public")));

// ─── PACKAGES ─────────────────────────────────────────────────────────────────
// Edit prices here. Must match the PACKAGES array in public/index.html exactly.
const PACKAGES = {
  100:    { price: 1.00, name: "100 Followers" },
  250:    { price: 1.00, name: "250 Followers" },
  500:    { price: 1.00, name: "500 Followers" },
  1000:   { price: 1.00, name: "1,000 Followers" },
  2000:   { price: 1.00, name: "2,000 Followers" },
  5000:   { price: 1.00, name: "5,000 Followers" },
  10000:  { price: 1.00, name: "10,000 Followers" },
  20000:  { price: 1.00, name: "20,000 Followers" },
  50000:  { price: 1.00, name: "50,000 Followers" },
  100000: { price: 1.00, name: "100,000 Followers" },
};

const PLANS = {
  starter: { price: 1.00, name: "Starter Plan", quantity: 500  },
  creator: { price: 1.00, name: "Creator Plan", quantity: 1500 },
  pro:     { price: 1.00, name: "Pro Plan",     quantity: 4000 },
};

// ─── SOCIALLEGEND ─────────────────────────────────────────────────────────────
// SERVICE CODE — change this number if SocialLegend updates their service ID
// Current: 5021 = Instagram Followers [120k/Day - 60 Day Refill - Real Hq account]
const SOCIALLEGEND_SERVICE_ID = process.env.SOCIALLEGEND_SERVICE_ID || "5020";

// username "nicc_yeo"  →  link "https://www.instagram.com/nicc_yeo/"
// quantity is exactly what the customer bought (e.g. 100)
async function callSocialLegend(instagramUsername, quantity) {
  const igUrl = `https://www.instagram.com/${instagramUsername}/`;

  console.log("\n[SocialLegend] Placing order...");
  console.log("  Service  :", SOCIALLEGEND_SERVICE_ID);
  console.log("  URL      :", igUrl);
  console.log("  Quantity :", quantity);

  const body = new URLSearchParams({
    key:      process.env.SOCIALLEGEND_API_KEY,
    action:   "add",
    service:  SOCIALLEGEND_SERVICE_ID,
    link:     igUrl,
    quantity: String(quantity),
  });

  const res  = await fetch("https://sociallegend.com.my/api/v2", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  const text = await res.text();
  console.log("[SocialLegend] Response:", text);

  let data;
  try   { data = JSON.parse(text); }
  catch { throw new Error("SocialLegend unexpected response: " + text); }

  if (data.error) throw new Error("SocialLegend: " + data.error);

  console.log("[SocialLegend] ✅ Order placed! ID:", data.order);
  return data;
}

// In-memory order log (clears on server restart)
const orders = [];

// ─── GOOGLE SHEETS LOGGER ─────────────────────────────────────────────────────
// Setup: see README — takes 10 minutes, gives you permanent order records
// Add GOOGLE_SHEET_WEBHOOK_URL to Render environment variables to enable
async function logToGoogleSheets(record) {
  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp:   record.createdAt,
        orderId:     record.id,
        instagram:   record.instagramUsername,
        package:     record.packageName,
        quantity:    record.quantity,
        amountPaid:  record.amountPaid,
        status:      record.status,
        supplierId:  record.supplierOrderId || "—",
        sessionId:   record.sessionId || "—",
      }),
    });
    console.log("[Sheets] ✅ Logged to Google Sheets");
  } catch (err) {
    console.error("[Sheets] ❌ Log failed:", err.message);
  }
}

async function fulfillOrder({ sessionId, instagramUsername, quantity, amountPaid, packageName }) {
  const record = {
    id: "GL-" + Date.now(),
    sessionId,
    instagramUsername,
    quantity,
    amountPaid,
    packageName,
    status: "processing",
    createdAt: new Date().toISOString(),
  };
  orders.push(record);
  console.log("\n[Order] Created:", record.id, "—", packageName, "for @" + instagramUsername);

  try {
    const result = await callSocialLegend(instagramUsername, quantity);
    record.status          = "fulfilled";
    record.supplierOrderId = String(result.order);
    console.log("✅ FULFILLED —", packageName, "for @" + instagramUsername, "| Supplier:", record.supplierOrderId);
  } catch (err) {
    record.status = "failed";
    record.error  = err.message;
    console.error("❌ FAILED —", err.message);
  }

  // Always log to Google Sheets (captures both success and failure)
  await logToGoogleSheets(record);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: POST /api/create-checkout
//
// Frontend calls this → server creates a Stripe Checkout Session → returns URL
// Browser redirects to that URL → customer sees real Stripe card payment page
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/create-checkout", async (req, res) => {
  try {
    const { type, cart, quantity, planId, instagramUsername, email } = req.body;
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
    let lineItems = [];
    let metaItems = [];

    if (type === "cart" && Array.isArray(cart)) {
      // CART MODE — multiple items
      for (const item of cart) {
        if (item.type === "boost") {
          const pkg = PACKAGES[Number(item.qty)];
          if (!pkg) continue;
          const igUser = (item.instagram || "").trim().replace(/^@/, "").toLowerCase();
          if (!igUser || !/^[a-zA-Z0-9_.]{1,30}$/.test(igUser)) continue;
          lineItems.push({
            price_data: {
              currency: "usd",
              unit_amount: Math.round(pkg.price * 100),
              product_data: { name: `GramLift — ${pkg.name} → @${igUser}` },
            },
            quantity: 1,
          });
          metaItems.push({ type: "boost", qty: item.qty, instagram: igUser, price: pkg.price });
        } else if (item.type === "plan") {
          const plan = PLANS[item.planId];
          if (!plan) continue;
          lineItems.push({
            price_data: {
              currency: "usd",
              unit_amount: Math.round(plan.price * 100),
              product_data: { name: `GramLift — ${plan.name}` },
            },
            quantity: 1,
          });
          metaItems.push({ type: "plan", planId: item.planId, price: plan.price });
        }
      }
      if (lineItems.length === 0) return res.status(400).json({ error: "No valid items in cart" });
    } else if (type === "plan") {
      // SINGLE PLAN MODE
      const plan = PLANS[planId];
      if (!plan) return res.status(400).json({ error: "Invalid plan" });
      const igUser = (instagramUsername || "").trim().replace(/^@/, "").toLowerCase();
      lineItems.push({
        price_data: {
          currency: "usd",
          unit_amount: Math.round(plan.price * 100),
          product_data: { name: `GramLift — ${plan.name}` },
        },
        quantity: 1,
      });
      metaItems.push({ type: "plan", planId, instagram: igUser, price: plan.price });
    } else {
      return res.status(400).json({ error: "Invalid request type" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: lineItems,
      metadata: { items: JSON.stringify(metaItems) },
      success_url: `${frontendUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${frontendUrl}/cancel.html`,
      billing_address_collection: "auto",
    });

    console.log(`\n[Stripe] Cart session created — ${lineItems.length} item(s)`);
    res.json({ url: session.url });

  } catch (err) {
    console.error("[Stripe] Error:", err.message);
    if (err.message.includes("No API key")) {
      return res.status(500).json({ error: "Stripe not configured — add STRIPE_SECRET_KEY to your .env file" });
    }
    res.status(500).json({ error: "Could not create checkout: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: POST /webhook
//
// Stripe calls this URL automatically after payment is confirmed.
// We verify the signature (proves it's really Stripe, not a fake request)
// Then we fulfill the order by calling SocialLegend.
//
// FOR LOCAL TESTING, run this in a second terminal window:
//   stripe listen --forward-to localhost:3001/webhook
// It will print a webhook secret — add it to .env as STRIPE_WEBHOOK_SECRET
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const sig    = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[Webhook] ⚠️  STRIPE_WEBHOOK_SECRET missing from .env — run: stripe listen --forward-to localhost:3001/webhook");
    return res.status(400).send("Webhook secret not configured");
  }

  let event;
  try {
    // Verify the signature — this prevents fake payment notifications
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[Webhook] ❌ Invalid signature:", err.message);
    return res.status(400).send("Signature failed: " + err.message);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta    = session.metadata;

    const amount = session.amount_total / 100;
    console.log(`\n[Webhook] ✅ Payment confirmed! $${amount}`);

    // Parse cart items from metadata
    let items = [];
    try { items = JSON.parse(meta.items || "[]"); } catch {}

    for (const item of items) {
      if (item.type === "boost" && item.instagram && item.qty) {
        fulfillOrder({
          sessionId: session.id,
          instagramUsername: item.instagram,
          quantity: item.qty,
          amountPaid: item.price,
          packageName: item.qty + " Followers",
        });
      }
    }
    if (items.length === 0) {
      // Fallback for old single-item format
      const ig = meta.instagramUsername;
      const quantity = Number(meta.quantity);
      if (ig && quantity) {
        fulfillOrder({ sessionId: session.id, instagramUsername: ig, quantity, amountPaid: amount, packageName: meta.packageName });
      }
    }
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  const isLive = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live");
  res.json({
    status:    "ok",
    mode:      isLive ? "LIVE 💰" : "TEST 🧪",
    stripe:    process.env.STRIPE_SECRET_KEY ? "configured" : "MISSING — add to .env",
    socialleg: process.env.SOCIALLEGEND_API_KEY ? "configured" : "MISSING",
    timestamp: new Date().toISOString(),
  });
});

// View all orders (for you to debug — protect with a password before launch)
app.get("/api/orders", (req, res) => {
  res.json({
    count: orders.length,
    note: orders.length === 0
      ? "No orders in memory. Server restarts clear this list. Check Google Sheets for permanent records."
      : "Live orders from this server session",
    stripe_dashboard: "https://dashboard.stripe.com/payments",
    orders,
  });
});

// Check SocialLegend account balance
app.get("/api/test-sl", async (req, res) => {
  try {
    const body = new URLSearchParams({ key: process.env.SOCIALLEGEND_API_KEY, action: "balance" });
    const r    = await fetch("https://sociallegend.com.my/api/v2", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    const data = await r.json();
    res.json({ connected: true, serviceId: SOCIALLEGEND_SERVICE_ID, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ── TEST: Place a REAL order to SocialLegend (use carefully — charges your SL balance)
// Call: POST /api/test-sl-order  with body: { instagram: "username", quantity: 100 }
app.post("/api/test-sl-order", async (req, res) => {
  const { instagram, quantity } = req.body;
  if (!instagram || !quantity) {
    return res.status(400).json({ error: "Need instagram and quantity in request body" });
  }
  const cleanIg = instagram.trim().replace(/^@/, "");
  if (!/^[a-zA-Z0-9_.]{1,30}$/.test(cleanIg)) {
    return res.status(400).json({ error: "Invalid Instagram username" });
  }
  try {
    console.log(`\n[TEST ORDER] Placing test order: @${cleanIg} x${quantity}`);
    const result = await callSocialLegend(cleanIg, Number(quantity));
    res.json({
      success: true,
      message: "Order placed successfully on SocialLegend",
      supplierOrderId: result.order,
      instagram: cleanIg,
      quantity: Number(quantity),
      igUrl: `https://www.instagram.com/${cleanIg}/`,
      serviceId: SOCIALLEGEND_SERVICE_ID,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CHECK status of a SocialLegend order
// Call: GET /api/sl-status/:orderId
app.get("/api/sl-status/:orderId", async (req, res) => {
  try {
    const body = new URLSearchParams({
      key:    process.env.SOCIALLEGEND_API_KEY,
      action: "status",
      order:  req.params.orderId,
    });
    const r = await fetch("https://sociallegend.com.my/api/v2", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    const data = await r.json();
    res.json({ orderId: req.params.orderId, ...data });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const isLive = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live");
  console.log(`\n🚀 GramLift running at http://localhost:${PORT}`);
  console.log(`   Mode: ${isLive ? "LIVE 💰" : "TEST 🧪 (safe to experiment)"}`);
  console.log(`\n   ➡  Open in browser: http://localhost:${PORT}`);
  console.log(`   ➡  Health check:   http://localhost:${PORT}/api/health`);
  console.log(`   ➡  View orders:    http://localhost:${PORT}/api/orders`);
  console.log(`   ➡  Test SL:        http://localhost:${PORT}/api/test-sl`);
  if (!isLive) {
    console.log(`\n   ⚡ Run this in a 2nd terminal to receive payment webhooks:`);
    console.log(`      stripe listen --forward-to localhost:${PORT}/webhook`);
  }
});
