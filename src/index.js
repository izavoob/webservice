'use strict';

require('dotenv').config();

const express = require('express');
const checkbox = require('./services/checkbox');
const keycrm = require('./services/keycrm');

// ─── Required env vars ────────────────────────────────────────────────────────

const REQUIRED_VARS = [
  'KEYCRM_API_KEY',
  'KEYCRM_SOURCE_ID',
  'CHECKBOX_CASHIER_LOGIN',
  'CHECKBOX_CASHIER_PASSWORD',
  'CHECKBOX_LICENSE_KEY',
  'SYNC_SECRET',
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`[startup] Missing required environment variables:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Capture raw body for HMAC signature verification in the webhook route
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — used by Render and UptimeRobot
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Product sync endpoint
app.use('/sync-products', require('./routes/sync'));

// Checkbox webhook receiver
app.use('/webhook/checkbox', require('./routes/webhook'));

// ─── Startup sequence ─────────────────────────────────────────────────────────

async function startup() {
  validateEnv();

  // Sign in to Checkbox and cache the JWT
  try {
    await checkbox.login();
  } catch (err) {
    console.error('[startup] Failed to sign in to Checkbox:', err.response?.data || err.message);
    process.exit(1);
  }

  // Verify KeyCRM connectivity and log available sources/statuses for reference
  try {
    const [sources, statuses, paymentMethods] = await Promise.all([
      keycrm.getOrderSources(),
      keycrm.getOrderStatuses(),
      keycrm.getPaymentMethods(),
    ]);

    console.log(
      '[startup] KeyCRM order sources:',
      sources.map((s) => `${s.id}: ${s.name}`).join(', ')
    );
    console.log(
      '[startup] KeyCRM order statuses:',
      statuses.map((s) => `${s.id}: ${s.name}`).join(', ')
    );
    console.log(
      '[startup] KeyCRM payment methods:',
      paymentMethods.map((m) => `${m.id}: ${m.name}`).join(', ')
    );
  } catch (err) {
    console.error('[startup] Failed to fetch KeyCRM reference data:', err.response?.data || err.message);
    // Non-fatal — service can still operate
  }

  // Auto-register Checkbox webhook if RENDER_EXTERNAL_URL is set
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    const expectedUrl = `${renderUrl.replace(/\/$/, '')}/webhook/checkbox`;
    try {
      const current = await checkbox.getWebhook();
      const currentUrl = current?.url;

      if (currentUrl !== expectedUrl) {
        const result = await checkbox.registerWebhook(expectedUrl);
        // Checkbox returns the webhook secret on first registration — log it so you can save it
        if (result && result.secret) {
          console.log(
            `\n⚠️  [startup] Checkbox webhook registered!\n` +
              `   URL: ${expectedUrl}\n` +
              `   SECRET (save this as CHECKBOX_WEBHOOK_SECRET): ${result.secret}\n`
          );
        } else {
          console.log(`[startup] Checkbox webhook updated → ${expectedUrl}`);
        }
      } else {
        console.log(`[startup] Checkbox webhook already set to correct URL.`);
      }
    } catch (err) {
      console.warn('[startup] Could not auto-register Checkbox webhook:', err.response?.data || err.message);
    }
  } else {
    console.warn('[startup] RENDER_EXTERNAL_URL not set — skipping auto webhook registration.');
  }

  // Start HTTP server
  const port = Number(process.env.PORT) || 3000;
  const baseUrl = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
  app.listen(port, () => {
    console.log(`\n✅ keycrm-checkbox-bridge listening on port ${port}`);
    console.log(`   Health:         ${baseUrl}/health`);
    console.log(`   Sync products:  ${baseUrl}/sync-products?secret=<SYNC_SECRET>`);
    console.log(`   Webhook:        POST ${baseUrl}/webhook/checkbox\n`);
  });
}

startup();
