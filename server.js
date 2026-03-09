'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Ollama base URL — points to your local hardware by default
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
// Default model served by Ollama (e.g. llama3, mistral, etc.)
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';

// Stripe
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PERSONAL_PRICE_ID = process.env.STRIPE_PERSONAL_PRICE_ID || '';
const STRIPE_TEAM_PRICE_ID = process.env.STRIPE_TEAM_PRICE_ID || '';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Stripe — initialized once when STRIPE_SECRET_KEY is present
const Stripe = STRIPE_SECRET_KEY ? require('stripe') : null;
const stripe = Stripe ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' }) : null;

// Keywords that route a message to Ollama
const OLLAMA_TRIGGER_PATTERN = /(?:^|\s)@(copilot|lucidia|blackboxprogramming)\b/i;

// ── Middleware ────────────────────────────────────────────────────────────────

// Raw body for Stripe webhook signature verification (must come before json)
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Chat → Ollama ─────────────────────────────────────────────────────────────

/**
 * POST /api/chat
 * Body: { message: string, history?: Array<{role, content}> }
 *
 * If the message contains @copilot, @lucidia, or @blackboxprogramming the
 * request is forwarded directly to the local Ollama instance.  No external
 * AI provider is contacted.
 */
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  if (!OLLAMA_TRIGGER_PATTERN.test(message)) {
    return res.status(400).json({
      error: 'No @mention found. Use @copilot, @lucidia, or @blackboxprogramming to chat with Ollama.'
    });
  }

  // Build the conversation for Ollama
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false })
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      return res.status(502).json({ error: `Ollama error: ${text}` });
    }

    const data = await ollamaRes.json();
    const reply = data?.message?.content || '';
    return res.json({ reply, model: OLLAMA_MODEL });
  } catch (err) {
    console.error('Ollama request failed:', err.message);
    return res.status(503).json({
      error: 'Could not reach Ollama. Make sure it is running on your machine.'
    });
  }
});

// ── Stripe ────────────────────────────────────────────────────────────────────

/**
 * GET /api/stripe/checkout?plan=personal|team
 * Creates a Stripe Checkout session and redirects the user to it.
 */
app.get('/api/stripe/checkout', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing).' });
  }

  const plan = req.query.plan === 'team' ? 'team' : 'personal';
  const priceId = plan === 'team' ? STRIPE_TEAM_PRICE_ID : STRIPE_PERSONAL_PRICE_ID;

  if (!priceId) {
    return res.status(503).json({
      error: `Stripe price ID not configured (STRIPE_${plan.toUpperCase()}_PRICE_ID missing).`
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { plan },
      success_url: `${PUBLIC_URL}/?checkout=success`,
      cancel_url: `${PUBLIC_URL}/?checkout=cancelled`
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/stripe/webhook
 * Handles Stripe events (payment succeeded, subscription updated, etc.)
 */
app.post('/api/stripe/webhook', (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      console.log('✅ Checkout completed:', event.data.object.id);
      break;
    case 'invoice.payment_succeeded':
      console.log('💰 Payment succeeded:', event.data.object.id);
      break;
    case 'customer.subscription.deleted':
      console.log('❌ Subscription cancelled:', event.data.object.id);
      break;
    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  return res.json({ received: true });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ollama: OLLAMA_BASE_URL, model: OLLAMA_MODEL });
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Lucidia running on port ${PORT}`);
  console.log(`🤖 Ollama: ${OLLAMA_BASE_URL} (model: ${OLLAMA_MODEL})`);
  console.log(`💳 Stripe: ${STRIPE_SECRET_KEY ? 'configured' : 'NOT configured (set STRIPE_SECRET_KEY)'}`);
});
