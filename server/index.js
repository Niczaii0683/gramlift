// server/index.js — GramLift backend
// ═════════════════════════════════════════════════════════════════════════════
// ORDER FLOW
//   1. Customer builds a cart on the site and hits pay
//   2. Browser POSTs the cart to /api/create-checkout
//   3. Server prices it from the PRODUCTS table below and asks Stripe for a
//      checkout page. Prices are NEVER taken from the browser.
//   4. Customer pays on Stripe
//   5. Stripe calls POST /webhook here
//   6. Server sends each line to SocialLegend, then logs to Google Sheets
//
// CHANGING PRICES
//   Edit the tiers in PRODUCTS below, then edit the matching numbers in
//   public/index.html and public/app.html so the customer sees the same thing.
//
// CHANGING A SOCIALLEGEND SERVICE ID
//   Do it in Render → Environment. No code change, no deploy needed.
//     SL_SERVICE_FOLLOWERS   SL_SERVICE_LIKES
//     SL_SERVICE_VIEWS       SL_SERVICE_SHARES
// ═════════════════════════════════════════════════════════════════════════════

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const Stripe  = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app    = express();

// Stripe needs the raw body to verify its signature, so this must come first
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
// extensions:["html"] lets /track serve public/track.html, and /success serve
// public/success.html, without the customer needing to type ".html".
app.use(express.static(path.join(__dirname, "../public"), { extensions: ["html"] }));

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═════════════════════════════════════════════════════════════════════════════
const PRODUCTS = {
  followers: {
    label:     "Instagram Followers",
    serviceId: process.env.SL_SERVICE_FOLLOWERS || "5059",
    linkType:  "profile",          // needs an @username
    min: 100, max: 100000,
    tiers: {
      100:    3,
      250:    7,
      500:    13,
      1000:   25,
      2000:   48,
      5000:   110,
      10000:  210,
      20000:  415,
      50000:  1010,
      100000: 2000,
    },
  },

  likes: {
    label:     "Instagram Likes",
    serviceId: process.env.SL_SERVICE_LIKES || "5177",
    linkType:  "post",             // needs a post or reel URL
    min: 10, max: 1000000,
    tiers: { 100: 2, 250: 5, 500: 10, 1000: 20, 2500: 50, 5000: 100 },
  },

  views: {
    label:     "Instagram Views",
    serviceId: process.env.SL_SERVICE_VIEWS || "4391",
    linkType:  "post",
    min: 50, max: 100000000,
    tiers: { 100: 1, 500: 5, 1000: 10, 5000: 50, 10000: 100, 25000: 250 },
  },

  shares: {
    label:     "Instagram Shares",
    serviceId: process.env.SL_SERVICE_SHARES || "4261",
    linkType:  "post",
    min: 10, max: 10000000,
    tiers: { 100: 1, 250: 2.5, 500: 5, 1000: 10, 2500: 25, 5000: 50 },
  },
};

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@gramlift.com";

// ═════════════════════════════════════════════════════════════════════════════
// DRY RUN
//
// Set  DRY_RUN=true  in Render to rehearse the whole money path without
// spending SocialLegend credit. Stripe still charges, the webhook still fires,
// the order row is still written to the Google Sheet, but the supplier call is
// skipped and the row is marked TEST instead of fulfilled.
//
// Turn it off by deleting the variable, or setting it to anything but "true".
// ═════════════════════════════════════════════════════════════════════════════
const DRY_RUN = String(process.env.DRY_RUN || "").trim().toLowerCase() === "true";

// ═════════════════════════════════════════════════════════════════════════════
// ORDER REFERENCE
//
// One checkout gets ONE reference, shared by every line in the cart. It is
// derived from the Stripe session id, so the success page can work it out on
// its own without waiting for the webhook, and it will always match what the
// webhook writes to the Sheet.
//
// This is the number the customer types into /track.
// ═════════════════════════════════════════════════════════════════════════════
function orderRef(sessionId) {
  return "GL-" + String(sessionId || "").slice(-8).toUpperCase();
}

// Accepts "GL-A1B2C3D4", "gl-a1b2c3d4" or bare "A1B2C3D4".
function normaliseRef(v) {
  const s = String(v || "").trim().toUpperCase().replace(/\s+/g, "");
  return s.startsWith("GL-") ? s : (s ? "GL-" + s : "");
}

function normaliseEmail(v) {
  return String(v || "").trim().toLowerCase();
}

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═════════════════════════════════════════════════════════════════════════════
const USERNAME_RE = /^[a-zA-Z0-9_.]{1,30}$/;
const POST_RE     = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/i;

function cleanUsername(v) {
  return String(v || "").trim().replace(/^@/, "").toLowerCase();
}

// Turns a cart line from the browser into a priced, validated order line.
// Returns { ok:true, line } or { ok:false, reason }.
function validateLine(item) {
  const product = PRODUCTS[item.type];
  if (!product) return { ok: false, reason: "Unknown product" };

  const qty   = Number(item.qty);
  const price = product.tiers[qty];
  if (!price) return { ok: false, reason: `${product.label}: ${qty} is not a package we sell` };

  let link, shown;

  if (product.linkType === "profile") {
    const user = cleanUsername(item.instagram);
    if (!USERNAME_RE.test(user)) {
      return { ok: false, reason: "Instagram username can only contain letters, numbers, dots and underscores" };
    }
    link  = `https://www.instagram.com/${user}/`;
    shown = `@${user}`;
  } else {
    const url = String(item.postUrl || "").trim();
    if (!POST_RE.test(url)) {
      return { ok: false, reason: "That does not look like an Instagram post or reel link. It should start with instagram.com/p/ or instagram.com/reel/" };
    }
    link  = url.split("?")[0];
    shown = link.replace(/^https?:\/\/(www\.)?instagram\.com\//, "");
  }

  return {
    ok: true,
    line: {
      type:      item.type,
      label:     product.label,
      serviceId: product.serviceId,
      qty, price, link, shown,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SOCIALLEGEND
// ═════════════════════════════════════════════════════════════════════════════
async function callSocialLegend({ serviceId, link, qty }) {
  console.log(`\n[SL] service ${serviceId} · ${qty} · ${link}`);

  const body = new URLSearchParams({
    key:      process.env.SOCIALLEGEND_API_KEY,
    action:   "add",
    service:  String(serviceId),
    link,
    quantity: String(qty),
  });

  const res  = await fetch("https://sociallegend.com.my/api/v2", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  const text = await res.text();
  console.log("[SL] reply:", text);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("SocialLegend returned something unreadable: " + text.slice(0, 200)); }

  if (data.error) throw new Error("SocialLegend: " + data.error);
  if (!data.order) throw new Error("SocialLegend did not return an order id");

  console.log("[SL] placed, id", data.order);
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// GOOGLE SHEETS
//
// Two sheets, two Apps Script web apps, two env vars.
//   GOOGLE_SHEET_WEBHOOK_URL   → one row per order line
//   GOOGLE_CUSTOMERS_SHEET_URL → one row per customer, updated on repeat orders
//
// Both are optional. If an env var is missing that logger is silently skipped,
// so nothing breaks before you have set them up.
// ═════════════════════════════════════════════════════════════════════════════
async function postToSheet(url, payload, tag) {
  if (!url) return;
  try {
    await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    console.log(`[Sheets] ${tag} row written`);
  } catch (err) {
    console.error(`[Sheets] ${tag} failed:`, err.message);
  }
}

// One row per order line. Called once per product in the cart.
function logOrder(record) {
  return postToSheet(process.env.GOOGLE_SHEET_WEBHOOK_URL, {
    timestamp:  record.createdAt,        // column A
    orderId:    record.ref,              // column B  GL-A1B2C3D4, what /track accepts
    email:      record.email || "",      // column C
    product:    record.label,            // column D
    target:     record.shown,            // column E  @handle or p/ABC123
    quantity:   record.qty,              // column F
    amountPaid: record.price,            // column G
    status:     record.status,           // column H  fulfilled | failed
    supplierId: record.supplierOrderId || "",  // column I
    sessionId:  record.sessionId || "",  // column J
    error:      record.error || "",      // column K
  }, "order");
}

// One row per customer. The Apps Script updates the existing row when the
// email is already present, so totals accumulate instead of duplicating.
function logCustomer({ email, amount, orderId, targets }) {
  if (!email) return;
  return postToSheet(process.env.GOOGLE_CUSTOMERS_SHEET_URL, {
    timestamp:   new Date().toISOString(),  // column A  first seen
    email,                                  // column B
    lastOrderId: orderId,                   // column C
    orderTotal:  amount,                    // column D  added to running total
    handles:     targets.join(", "),        // column E  merged with what's there
  }, "customer");
}

// ═════════════════════════════════════════════════════════════════════════════
// FULFILMENT
// ═════════════════════════════════════════════════════════════════════════════
const orders = [];   // in memory only, cleared on restart. Sheets are the record.

async function fulfillLine({ sessionId, email, line, ref }) {
  const record = {
    id:        "GL-" + Date.now() + "-" + Math.floor(Math.random() * 900 + 100),
    ref:       ref || orderRef(sessionId),   // what the customer sees and types into /track
    sessionId, email,
    type:  line.type,
    label: line.label,
    shown: line.shown,
    qty:   line.qty,
    price: line.price,
    status:    "processing",
    createdAt: new Date().toISOString(),
  };
  orders.push(record);

  if (DRY_RUN) {
    // Rehearsal. Nothing is sent to SocialLegend and no credit is spent.
    record.status          = "TEST";
    record.supplierOrderId = "";
    console.log(
      `\n[DRY RUN] would have placed:\n` +
      `          product  ${line.label}\n` +
      `          service  ${line.serviceId}\n` +
      `          quantity ${line.qty}\n` +
      `          link     ${line.link}\n` +
      `          target   ${line.shown}\n` +
      `          price    $${line.price}\n` +
      `          ref      ${record.ref}\n` +
      `          NOT sent. DRY_RUN is true.`
    );
    await logOrder(record);
    return record;
  }

  try {
    const result = await callSocialLegend(line);
    record.status          = "fulfilled";
    record.supplierOrderId = String(result.order);
    console.log(`FULFILLED ${line.label} ${line.qty} → ${line.shown}`);
  } catch (err) {
    record.status = "failed";
    record.error  = err.message;
    console.error(`FAILED ${line.label} ${line.qty} → ${line.shown}: ${err.message}`);
  }

  await logOrder(record);
  return record;
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/create-checkout
// Body: { cart: [ {type, qty, instagram?, postUrl?}, ... ], email? }
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/create-checkout", async (req, res) => {
  try {
    const { cart, email } = req.body;

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Your cart is empty." });
    }
    if (cart.length > 20) {
      return res.status(400).json({ error: "That is more than 20 items. Please split it into separate orders." });
    }

    const lines = [];
    for (const item of cart) {
      const check = validateLine(item);
      if (!check.ok) return res.status(400).json({ error: check.reason });
      lines.push(check.line);
    }

    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3001").replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      allow_promotion_codes: true,          // promo codes are made in the Stripe dashboard

      line_items: lines.map(l => ({
        price_data: {
          currency:     "usd",
          unit_amount:  Math.round(l.price * 100),
          product_data: { name: `${l.label} · ${l.qty.toLocaleString()} → ${l.shown}` },
        },
        quantity: 1,
      })),

      // Stripe caps each metadata VALUE at 500 characters but allows 50 keys.
      // One line per key keeps every cart well inside the limit, where a single
      // combined key would overflow and silently break fulfilment.
      metadata: Object.assign(
        { n: String(lines.length) },
        ...lines.map((l, i) => ({
          ["L" + i]: JSON.stringify({ t: l.type, s: l.serviceId, q: l.qty, l: l.link, n: l.shown, p: l.price }),
        }))
      ),

      success_url: `${frontendUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${frontendUrl}/app.html`,
      billing_address_collection: "auto",
    });

    console.log(`\n[Stripe] checkout for ${lines.length} line(s), $${lines.reduce((s, l) => s + l.price, 0).toFixed(2)}`);
    res.json({ url: session.url });

  } catch (err) {
    console.error("[Stripe]", err.message);
    if (String(err.message).includes("No API key")) {
      return res.status(500).json({ error: "Payments are not configured yet. Set STRIPE_SECRET_KEY." });
    }
    res.status(500).json({ error: "Could not start checkout. Please try again." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /webhook — Stripe calls this once payment clears
// ═════════════════════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  const sig    = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  if (secret && secret.startsWith("whsec_")) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("[Webhook] signature check failed:", err.message);
      console.error("[Webhook] STRIPE_WEBHOOK_SECRET in Render must match the signing secret in Stripe → Webhooks.");
      return res.status(400).send("Signature failed");
    }
  } else {
    console.warn("[Webhook] no STRIPE_WEBHOOK_SECRET set, skipping signature check");
    try { event = JSON.parse(req.body); } catch { event = req.body; }
  }

  // Reply immediately. Stripe retries anything that takes too long.
  res.json({ received: true });

  if (event.type !== "checkout.session.completed") return;

  const session = event.data.object;
  const amount  = session.amount_total / 100;
  const email   = session.customer_details?.email || session.customer_email || "";

  console.log(`\n[Webhook] paid $${amount} ${email ? "· " + email : ""}`);

  const meta  = session.metadata || {};
  const count = Number(meta.n || 0);
  const lines = [];
  for (let i = 0; i < count; i++) {
    try { lines.push(JSON.parse(meta["L" + i])); }
    catch { console.error(`[Webhook] line L${i} unreadable, skipping`); }
  }

  if (lines.length === 0) {
    console.error("[Webhook] no line data on this session, nothing to fulfil");
    return;
  }
  if (lines.length !== count) {
    console.error(`[Webhook] expected ${count} lines, recovered ${lines.length}. Check /api/orders and refund or retry the missing ones.`);
  }

  // One reference for the whole checkout, shared by every line.
  const ref = orderRef(session.id);
  console.log(`[Webhook] order reference ${ref}${DRY_RUN ? "  (DRY RUN, nothing will be sent to SocialLegend)" : ""}`);

  const targets = [];
  for (const l of lines) {
    targets.push(l.n);
    await fulfillLine({
      sessionId: session.id,
      email,
      ref,
      line: { type: l.t, label: PRODUCTS[l.t]?.label || l.t, serviceId: l.s, qty: l.q, link: l.l, shown: l.n, price: l.p },
    });
  }

  await logCustomer({ email, amount, orderId: ref, targets });
});

// ═════════════════════════════════════════════════════════════════════════════
// ORDER TRACKING  ·  POST /api/track   { email, orderId }
//
// WHERE THE DATA COMES FROM, and why it matters:
//
//   orders[] above is in MEMORY. Render's free tier sleeps after 15 minutes of
//   no traffic and wipes it. An order placed on Monday is gone by Tuesday. So
//   memory is only a fast path for orders placed since the last restart.
//
//   The Google Sheet is the permanent record. /track reads from there, which
//   means GOOGLE_SHEET_WEBHOOK_URL must be set AND the Apps Script must have
//   the doGet lookup from sheets_orders.js. Without that, tracking only works
//   for the last few hours and customers will be told their order is not found.
//
// A customer must supply BOTH the reference and the email on the order. That
// pairing is the only thing standing in for a password, so both must match.
// ═════════════════════════════════════════════════════════════════════════════

// Turns a SocialLegend status into the three words the customer sees.
function friendlyStatus(ourStatus, slStatus) {
  if (ourStatus === "TEST")   return { label: "Test order",  note: "Placed with DRY_RUN on. Nothing was sent to the supplier." };
  if (ourStatus === "failed") return { label: "Needs attention", note: "Payment went through but the order did not place. Email us and we will fix it or refund you." };

  const s = String(slStatus || "").trim().toLowerCase();
  if (s === "completed")                    return { label: "Completed",   note: "Delivered in full." };
  if (s === "in progress" || s === "processing") return { label: "In progress", note: "Delivery is under way." };
  if (s === "pending")                      return { label: "Processing",  note: "Queued with our supplier, starting shortly." };
  if (s === "partial")                      return { label: "Partly delivered", note: "Some of the order was delivered. Email us about the rest." };
  if (s === "canceled" || s === "cancelled") return { label: "Cancelled",  note: "This order was cancelled. Email us if you were charged." };

  // No supplier id yet, or the supplier did not answer.
  return { label: "Processing", note: "Your payment is confirmed and the order is being placed." };
}

// Ask SocialLegend where one supplier order has got to.
async function slStatus(supplierOrderId) {
  if (!supplierOrderId) return null;
  try {
    const body = new URLSearchParams({
      key: process.env.SOCIALLEGEND_API_KEY, action: "status", order: String(supplierOrderId),
    });
    const r = await fetch("https://sociallegend.com.my/api/v2", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    const d = await r.json();
    return d && !d.error ? d : null;
  } catch (err) {
    console.error("[SL status]", err.message);
    return null;
  }
}

// Ask the orders Sheet for every row matching this reference and email.
async function lookupInSheet(ref, email) {
  const base = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!base) return { ok: false, reason: "no-sheet" };

  const url = base + (base.includes("?") ? "&" : "?")
            + "action=lookup&ref=" + encodeURIComponent(ref)
            + "&email=" + encodeURIComponent(email);
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow" });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      console.error("[Sheets] lookup did not return JSON. Is the doGet lookup deployed?");
      return { ok: false, reason: "bad-reply" };
    }
    return { ok: true, rows: Array.isArray(data.rows) ? data.rows : [] };
  } catch (err) {
    console.error("[Sheets] lookup failed:", err.message);
    return { ok: false, reason: "unreachable" };
  }
}

app.post("/api/track", async (req, res) => {
  const ref   = normaliseRef(req.body?.orderId);
  const email = normaliseEmail(req.body?.email);

  if (!ref || ref === "GL-")            return res.status(400).json({ error: "Please enter your order number." });
  if (!email || !email.includes("@"))   return res.status(400).json({ error: "Please enter the email address you paid with." });

  // 1. Memory first. Instant, and covers anything since the last restart.
  let lines = orders
    .filter(o => o.ref === ref && normaliseEmail(o.email) === email)
    .map(o => ({
      createdAt: o.createdAt, label: o.label, qty: o.qty,
      target: o.shown, ourStatus: o.status, supplierOrderId: o.supplierOrderId || "",
    }));

  let source = "memory";

  // 2. Fall back to the Sheet, which is the permanent record.
  if (lines.length === 0) {
    const sheet = await lookupInSheet(ref, email);

    if (!sheet.ok) {
      const why = sheet.reason === "no-sheet"
        ? "Order lookup is not configured yet (GOOGLE_SHEET_WEBHOOK_URL is not set)."
        : "The order records are not reachable right now.";
      console.error("[Track] " + why);
      return res.status(503).json({
        error: `We can't look that up at the moment. Please email ${SUPPORT_EMAIL} with your order number and we'll check it by hand.`,
      });
    }

    lines = sheet.rows.map(r => ({
      createdAt: r.timestamp, label: r.product, qty: Number(r.quantity) || r.quantity,
      target: r.target, ourStatus: r.status, supplierOrderId: r.supplierId || "",
    }));
    source = "sheet";
  }

  if (lines.length === 0) {
    // Deliberately vague. Do not reveal whether the reference or the email was
    // the part that did not match.
    return res.status(404).json({
      error: "We couldn't find an order with that number and email. Check both and try again, or forward your Stripe receipt to " + SUPPORT_EMAIL + ".",
    });
  }

  // 3. Ask SocialLegend for live progress on each line.
  const out = [];
  for (const l of lines) {
    const live  = await slStatus(l.supplierOrderId);
    const fs    = friendlyStatus(l.ourStatus, live?.status);
    out.push({
      date:     l.createdAt,
      product:  l.label,
      quantity: l.qty,
      target:   l.target,
      status:   fs.label,
      note:     fs.note,
      remains:  live?.remains ?? null,
      startCount: live?.start_count ?? null,
    });
  }

  console.log(`[Track] ${ref} · ${out.length} line(s) · from ${source}`);
  res.json({ orderId: ref, lines: out });
});

// ═════════════════════════════════════════════════════════════════════════════
// UTILITY ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// What the site shows customers. The frontend reads this so prices only ever
// live in one place.
app.get("/api/products", (req, res) => {
  const out = {};
  for (const [key, p] of Object.entries(PRODUCTS)) {
    out[key] = { label: p.label, linkType: p.linkType, min: p.min, max: p.max, tiers: p.tiers };
  }
  res.json({ products: out, supportEmail: SUPPORT_EMAIL });
});

app.get("/api/health", (req, res) => {
  const live = String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live");
  res.json({
    status: "ok",
    mode:   live ? "LIVE" : "TEST",
    dryRun: DRY_RUN,
    warning: (DRY_RUN && live)
      ? "DANGER: DRY_RUN is ON with a LIVE Stripe key. Real cards are being charged and NOTHING is being delivered. Turn DRY_RUN off."
      : undefined,
    tracking: process.env.GOOGLE_SHEET_WEBHOOK_URL
      ? "orders sheet set (confirm the doGet lookup is deployed)"
      : "NOT WORKING — /track needs GOOGLE_SHEET_WEBHOOK_URL",
    stripe:        process.env.STRIPE_SECRET_KEY ? "configured" : "MISSING",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ? "configured" : "MISSING",
    socialLegend:  process.env.SOCIALLEGEND_API_KEY ? "configured" : "MISSING",
    ordersSheet:    process.env.GOOGLE_SHEET_WEBHOOK_URL    ? "configured" : "not set",
    customersSheet: process.env.GOOGLE_CUSTOMERS_SHEET_URL  ? "configured" : "not set",
    services: Object.fromEntries(Object.entries(PRODUCTS).map(([k, p]) => [k, p.serviceId])),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/orders", (req, res) => {
  res.json({
    count: orders.length,
    note:  "In-memory only. Restarts clear this. Google Sheets holds the permanent record.",
    orders,
  });
});

// SocialLegend balance
app.get("/api/test-sl", async (req, res) => {
  try {
    const body = new URLSearchParams({ key: process.env.SOCIALLEGEND_API_KEY, action: "balance" });
    const r    = await fetch("https://sociallegend.com.my/api/v2", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    res.json({ connected: true, balance: await r.json(), services: Object.fromEntries(Object.entries(PRODUCTS).map(([k, p]) => [k, p.serviceId])) });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Place a real order by hand. Spends real SocialLegend credit.
// POST { type:"likes", qty:100, instagram:"handle" }  or  { ..., postUrl:"https://..." }
app.post("/api/test-sl-order", async (req, res) => {
  const check = validateLine(req.body);
  if (!check.ok) return res.status(400).json({ error: check.reason });
  try {
    const result = await callSocialLegend(check.line);
    res.json({ success: true, supplierOrderId: result.order, sent: check.line });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Retry a line that failed. Same shape as above.
app.post("/api/retry-order", async (req, res) => {
  const check = validateLine(req.body);
  if (!check.ok) return res.status(400).json({ error: check.reason });
  try {
    const record = await fulfillLine({ sessionId: req.body.sessionId || "manual-retry", email: req.body.email || "", line: check.line });
    res.json({ success: record.status === "fulfilled", record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/sl-status/:orderId", async (req, res) => {
  try {
    const body = new URLSearchParams({
      key: process.env.SOCIALLEGEND_API_KEY, action: "status", order: req.params.orderId,
    });
    const r = await fetch("https://sociallegend.com.my/api/v2", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    res.json({ orderId: req.params.orderId, ...(await r.json()) });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const live = String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live");
  console.log(`\nGramLift running on http://localhost:${PORT}`);
  console.log(`Stripe mode: ${live ? "LIVE, real money" : "TEST"}`);

  if (DRY_RUN) {
    console.log("\n" + "=".repeat(70));
    console.log("  DRY_RUN IS ON");
    console.log("  Orders will NOT be sent to SocialLegend. Sheet rows say TEST.");
    if (live) {
      console.log("");
      console.log("  *** WARNING: your Stripe key is LIVE. ***");
      console.log("  *** Real customers will be charged and get NOTHING. ***");
      console.log("  *** Turn DRY_RUN off before taking real orders.    ***");
    }
    console.log("=".repeat(70));
  }

  if (!process.env.GOOGLE_SHEET_WEBHOOK_URL) {
    console.warn("\n[Track] GOOGLE_SHEET_WEBHOOK_URL is not set.");
    console.warn("[Track] /track will only find orders placed since this restart.");
  }
  console.log("Services:", Object.entries(PRODUCTS).map(([k, p]) => `${k}=${p.serviceId}`).join("  "));
  console.log(`\n  health   http://localhost:${PORT}/api/health`);
  console.log(`  products http://localhost:${PORT}/api/products`);
  console.log(`  orders   http://localhost:${PORT}/api/orders`);
});
