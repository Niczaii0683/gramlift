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
  100:    { price: 0.01, name: "100 Followers" },
  250:    { price: 0.01, name: "250 Followers" },
  500:    { price: 0.01, name: "500 Followers" },
  1000:   { price: 0.01, name: "1,000 Followers" },
  2000:   { price: 0.01, name: "2,000 Followers" },
  5000:   { price: 0.01, name: "5,000 Followers" },
  10000:  { price: 0.01, name: "10,000 Followers" },
  20000:  { price: 0.01, name: "20,000 Followers" },
  50000:  { price: 0.01, name: "50,000 Followers" },
  100000: { price: 0.01, name: "100,000 Followers" },
};

const PLANS = {
  starter: { price: 19, name: "Starter Plan", quantity: 500  },
  creator: { price: 49, name: "Creator Plan", quantity: 1500 },
  pro:     { price: 99, name: "Pro Plan",     quantity: 4000 },
};

// ─── SOCIALLEGEND ─────────────────────────────────────────────────────────────
// Called automatically after payment is confirmed.
// username "nicc_yeo"  →  link "https://www.instagram.com/nicc_yeo/"
// quantity is exactly what the customer bought (e.g. 5000)
async function callSocialLegend(instagramUsername, quantity) {
  const igUrl = `https://www.instagram.com/${instagramUsername}/`;

  console.log("\n[SocialLegend] Placing order...");
  console.log("  URL      :", igUrl);
  console.log("  Quantity :", quantity);

  const body = new URLSearchParams({
    key:      process.env.SOCIALLEGEND_API_KEY,
    action:   "add",
    service:  "4997",
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

// Simple order log — replace with Supabase when you're ready
const orders = [];

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
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: POST /api/create-checkout
//
// Frontend calls this → server creates a Stripe Checkout Session → returns URL
// Browser redirects to that URL → customer sees real Stripe card payment page
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/create-checkout", async (req, res) => {
  try {
    const { type, quantity, planId, instagramUsername, email } = req.body;

    // Clean & validate the Instagram username
    const igUser = (instagramUsername || "").trim().replace(/^@/, "").toLowerCase();
    if (!igUser || !/^[a-zA-Z0-9_.]{1,30}$/.test(igUser)) {
      return res.status(400).json({ error: "Invalid Instagram username. Use letters, numbers, underscores or dots only." });
    }

    let priceInCents, productName, qty;

    if (type === "boost") {
      const pkg = PACKAGES[Number(quantity)];
      if (!pkg) return res.status(400).json({ error: "Invalid package quantity" });
      priceInCents = Math.round(pkg.price * 100);
      productName  = `GramLift — ${pkg.name}`;
      qty          = Number(quantity);
    } else if (type === "plan") {
      const plan = PLANS[planId];
      if (!plan) return res.status(400).json({ error: "Invalid plan ID" });
      priceInCents = Math.round(plan.price * 100);
      productName  = `GramLift — ${plan.name}`;
      qty          = plan.quantity;
    } else {
      return res.status(400).json({ error: "type must be 'boost' or 'plan'" });
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";

    // Create the Stripe Checkout Session
    // This generates the real Stripe-hosted payment page with card form
    const session = await stripe.checkout.sessions.create({
      mode:                 "payment",
      payment_method_types: ["card"],    // Visa, Mastercard, Amex all work automatically

      // Pre-fill email if customer provided it
      customer_email: email || undefined,

      line_items: [{
        price_data: {
          currency:     "usd",
          unit_amount:  priceInCents,
          product_data: {
            name:        productName,
            description: `${qty.toLocaleString()} real followers delivered to @${igUser}`,
            images:      [],
          },
        },
        quantity: 1,
      }],

      // Metadata travels with the payment — this is how we know who bought what
      // when the webhook fires. Do NOT put sensitive data here.
      metadata: {
        instagramUsername: igUser,
        quantity:          String(qty),
        packageName:       productName,
        type,
      },

      // Where to send the customer after payment
      success_url: `${frontendUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${frontendUrl}/cancel.html`,

      // Allow guest checkout (customer doesn't need a Stripe account)
      billing_address_collection: "auto",
    });

    console.log(`\n[Stripe] Session created for @${igUser} — ${productName} — $${(priceInCents/100).toFixed(2)}`);

    // Return the Stripe checkout URL to the browser
    res.json({ url: session.url });

  } catch (err) {
    console.error("[Stripe] Error:", err.message);

    // Give a helpful error message if keys aren't set up
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

    const ig       = meta.instagramUsername;
    const quantity = Number(meta.quantity);
    const amount   = session.amount_total / 100;

    console.log(`\n[Webhook] ✅ Payment confirmed!`);
    console.log(`  Instagram : @${ig}`);
    console.log(`  Package   : ${meta.packageName}`);
    console.log(`  Quantity  : ${quantity}`);
    console.log(`  Amount    : $${amount} USD`);
    console.log(`  Session   : ${session.id}`);

    // Fulfill in background so webhook responds quickly
    fulfillOrder({
      sessionId:         session.id,
      instagramUsername: ig,
      quantity,
      amountPaid:        amount,
      packageName:       meta.packageName,
    });
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
app.get("/api/orders", (req, res) => res.json(orders));

// Quick test — checks your SocialLegend account balance
app.get("/api/test-sl", async (req, res) => {
  try {
    const body = new URLSearchParams({ key: process.env.SOCIALLEGEND_API_KEY, action: "balance" });
    const r    = await fetch("https://sociallegend.com.my/api/v2", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    const data = await r.json();
    res.json({ connected: true, data });
  } catch (err) {
    res.json({ connected: false, error: err.message });
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
