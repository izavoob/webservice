'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const keycrm = require('../services/keycrm');
const { toKeycrmProduct } = require('../utils/mapper');

const router = Router();

// ─── HMAC signature verification ──────────────────────────────────────────────

/**
 * Verifies the Checkbox HMAC-SHA256 webhook signature.
 * Checkbox computes: HMAC-SHA256(rawBody + webhookSecret)
 *
 * @param {Buffer} rawBody    Raw request body bytes
 * @param {string} signature  Value of x-request-signature header
 */
function verifySignature(rawBody, signature) {
  if (!process.env.CHECKBOX_WEBHOOK_SECRET) return true; // skip if not configured
  const secret = process.env.CHECKBOX_WEBHOOK_SECRET;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /webhook/checkbox
 *
 * Receives Checkbox webhook events. On a `receipt_notification` for a SELL
 * receipt, creates a corresponding order in KeyCRM with:
 *   - status_id = KEYCRM_ORDER_STATUS_ID (default 12 = "Виконано")
 *   - source_uuid = receipt.id (idempotency key)
 *   - all sold products mapped back to KeyCRM offers by SKU/barcode
 *   - payment method = KEYCRM_PAYMENT_METHOD_ID (default 2 = "Банківська картка")
 */
router.post('/', async (req, res) => {
  // ── 1. Verify HMAC signature ─────────────────────────────────────────────
  const signature = req.headers['x-request-signature'];
  if (signature && !verifySignature(req.rawBody, signature)) {
    console.warn('[webhook] Invalid signature — rejected');
    return res.status(400).json({ ok: false, error: 'Invalid signature' });
  }

  const body = req.body;

  // ── 2. Filter to SELL receipt_notification events ────────────────────────
  if (body.callback !== 'receipt_notification') {
    // Ignore shift/service/order notifications
    return res.json({ ok: true, ignored: true });
  }

  const receipt = body.receipt;
  if (!receipt) {
    return res.status(400).json({ ok: false, error: 'Missing receipt in payload' });
  }

  if (receipt.type !== 'SELL') {
    // Ignore RETURN receipts and others
    return res.json({ ok: true, ignored: true, reason: `receipt.type=${receipt.type}` });
  }

  console.log(`[webhook] Received SELL receipt ${receipt.id} (fiscal: ${receipt.fiscal_code})`);

  // ── 3. Respond 200 immediately (Checkbox requires it within a few seconds) ─
  // We process asynchronously after responding.
  res.json({ ok: true });

  // ── 4. Process asynchronously ─────────────────────────────────────────────
  try {
    await processReceipt(receipt);
  } catch (err) {
    // Log but don't bubble — response is already sent
    console.error(`[webhook] Error processing receipt ${receipt.id}:`, err.message);
  }
});

// ─── processReceipt ───────────────────────────────────────────────────────────

async function processReceipt(receipt) {
  // ── Build product lines ──────────────────────────────────────────────────
  const products = [];

  for (const goodItem of receipt.goods || []) {
    const good = goodItem.good || {};
    let offer = null;

    // a) Look up by SKU (code field = KeyCRM SKU)
    if (good.code) {
      offer = await keycrm.getOfferBySku(good.code);
    }

    // b) Fallback: look up by barcode
    if (!offer && good.barcode) {
      offer = await keycrm.getOfferByBarcode(good.barcode);
    }

    // c) Fallback: look up product by name — use it without SKU resolution
    if (!offer && good.name) {
      const product = await keycrm.getProductByName(good.name);
      if (product) {
        offer = { sku: product.sku, product };
      }
    }

    if (!offer && !good.code && !good.name) {
      console.warn(`[webhook] Cannot identify product: code=${good.code}, barcode=${good.barcode}, name=${good.name}`);
      continue;
    }

    products.push(toKeycrmProduct(goodItem, offer));
  }

  if (products.length === 0) {
    console.warn(`[webhook] No products resolved for receipt ${receipt.id}, skipping order creation.`);
    return;
  }

  // ── Build payment ─────────────────────────────────────────────────────────
  // All Checkbox sales are mapped to a single KeyCRM payment method (Банківська картка, ID 2).
  const paymentMethodId = Number(process.env.KEYCRM_PAYMENT_METHOD_ID || 2);
  const totalAmount = (receipt.total_sum || 0) / 100; // kopecks → UAH

  const payments = totalAmount > 0
    ? [{ payment_method_id: paymentMethodId, amount: totalAmount, status: 'paid' }]
    : [];

  // ── Build KeyCRM order payload ────────────────────────────────────────────
  const statusId = Number(process.env.KEYCRM_ORDER_STATUS_ID || 12); // 12 = Виконано

  const orderPayload = {
    source_id: Number(process.env.KEYCRM_SOURCE_ID),
    source_uuid: receipt.id, // idempotency key — prevents duplicate orders
    status_id: statusId,
    buyer: {
      full_name: receipt.cashier_name || 'Checkbox POS',
    },
    products,
    ...(payments.length ? { payments } : {}),
  };

  // Attach ordered_at from receipt creation time
  if (receipt.created_at) {
    orderPayload.ordered_at = receipt.created_at.replace('T', ' ').split('+')[0].split('Z')[0];
  }

  // ── Create order in KeyCRM ────────────────────────────────────────────────
  try {
    const order = await keycrm.createOrder(orderPayload);
    console.log(
      `[webhook] ✅ Created KeyCRM order #${order.id} from Checkbox receipt ${receipt.id}`
    );
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;

    // 422 with "duplicate source_uuid" = already processed, safe to ignore
    if (status === 422 && msg && msg.toLowerCase().includes('source_uuid')) {
      console.log(`[webhook] Duplicate receipt ${receipt.id} — order already exists, ignored.`);
      return;
    }

    console.error(`[webhook] Failed to create order for receipt ${receipt.id}: [${status}] ${msg}`);
    throw err;
  }
}

module.exports = router;
