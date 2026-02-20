'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const keycrm = require('../services/keycrm');
const checkbox = require('../services/checkbox');
const { toKeycrmProduct } = require('../utils/mapper');

const router = Router();

// ─── In-memory log of last 20 webhook calls (for /webhook/checkbox/log) ──────
const recentWebhooks = [];
function logWebhook(entry) {
  recentWebhooks.unshift({ ts: new Date().toISOString(), ...entry });
  if (recentWebhooks.length > 20) recentWebhooks.pop();
}

// ─── GET /webhook/checkbox/log — inspect recent payloads ─────────────────────
router.get('/log', (req, res) => {
  if (req.query.secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.json({ count: recentWebhooks.length, events: recentWebhooks });
});

// ─── HMAC signature verification ──────────────────────────────────────────────
function verifySignature(rawBody, signature) {
  if (!process.env.CHECKBOX_WEBHOOK_SECRET) return true; // skip if not configured
  const secret = process.env.CHECKBOX_WEBHOOK_SECRET;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// ─── POST /webhook/checkbox ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const signature = req.headers['x-request-signature'];

  // ── Log every incoming call in full ─────────────────────────────────────
  console.log('[webhook] ⬇ Incoming POST headers:', JSON.stringify(req.headers));
  console.log('[webhook] ⬇ Incoming POST body:', JSON.stringify(req.body));
  logWebhook({ headers: req.headers, body: req.body });

  // ── Verify HMAC if secret is configured ─────────────────────────────────
  if (signature && !verifySignature(req.rawBody, signature)) {
    console.warn('[webhook] Invalid signature — rejected');
    return res.status(400).json({ ok: false, error: 'Invalid signature' });
  }

  const body = req.body;

  // ── Detect receipt from multiple possible Checkbox payload shapes ────────
  // Checkbox may send: { callback, receipt } or { notification_type, receipt }
  // or just the receipt object directly. Handle all cases.
  const callbackType = body.callback || body.notification_type || body.type || '';
  const receipt =
    body.receipt ||
    (callbackType.toLowerCase().includes('receipt') ? body.data || body : null);

  if (!receipt || typeof receipt !== 'object') {
    console.log(`[webhook] Ignored — no receipt found. callback="${callbackType}"`);
    return res.json({ ok: true, ignored: true, reason: 'no receipt object found' });
  }

  // Accept both 'SELL' and 'sell', also treat fiscal receipts as sales
  const receiptType = (receipt.type || '').toUpperCase();
  if (receiptType && receiptType !== 'SELL') {
    console.log(`[webhook] Ignored receipt type: ${receipt.type}`);
    return res.json({ ok: true, ignored: true, reason: `receipt.type=${receipt.type}` });
  }

  // ── Skip receipts that were created by KeyCRM fiscalization ─────────────
  // Guard 1: receipts created by KeyCRM fiscalization carry order_id != null
  if (receipt.order_id != null) {
    console.log(`[webhook] Ignored — receipt.order_id=${receipt.order_id} (KeyCRM fiscalization)`);
    return res.json({ ok: true, ignored: true, reason: `fiscalization receipt for order ${receipt.order_id}` });
  }

  // Guard 2: fiscalization receipts have goods with good_id=null (not from catalog)
  // Real POS sales always have good_id set because goods are scanned from catalog.
  const allGoodsHaveNullId = (receipt.goods || []).length > 0 &&
    (receipt.goods || []).every(g => g.good_id == null);
  if (allGoodsHaveNullId) {
    console.log(`[webhook] Ignored — all good_id are null (KeyCRM fiscalization, goods not from catalog)`);
    return res.json({ ok: true, ignored: true, reason: 'all good_id null — fiscalization receipt' });
  }

  // Guard 3: cashier UUID mismatch — fiscalization uses a different Checkbox API user
  const ourCashierId = checkbox.getCashierId();
  const receiptCashierId = receipt.shift?.cashier?.id;
  if (ourCashierId && receiptCashierId && receiptCashierId !== ourCashierId) {
    console.log(`[webhook] Ignored — cashier mismatch: receipt cashier=${receiptCashierId}, ours=${ourCashierId} (likely KeyCRM auto-fiscalization)`);
    return res.json({ ok: true, ignored: true, reason: `cashier mismatch: ${receiptCashierId}` });
  }

  console.log(`[webhook] ✅ Processing SELL receipt id=${receipt.id} fiscal=${receipt.fiscal_code}`);

  // ── Respond 200 immediately (Checkbox requires it within a few seconds) ──
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
  const buyerId = Number(process.env.KEYCRM_BUYER_ID || 4);
  const buyerEmail = process.env.KEYCRM_BUYER_EMAIL || 'klumba.zakarpattia@gmail.com';

  const orderPayload = {
    source_id: Number(process.env.KEYCRM_SOURCE_ID),
    source_uuid: receipt.id, // idempotency key — prevents duplicate orders
    buyer: { email: buyerEmail },
    products,
    ...(payments.length ? { payments } : {}),
  };

  // Attach ordered_at from receipt creation time
  if (receipt.created_at) {
    orderPayload.ordered_at = receipt.created_at.replace('T', ' ').split('.')[0].split('+')[0].split('Z')[0];
  }

  // ── Create order in KeyCRM ────────────────────────────────────────────────
  try {
    const order = await keycrm.createOrder(orderPayload);
    console.log(
      `[webhook] ✅ Created KeyCRM order #${order.id} from Checkbox receipt ${receipt.id}`
    );
    // PUT після 5 сек: встановлюємо статус і прив'язуємо покупця
    if (order.id) {
      await new Promise(r => setTimeout(r, 5000));
      await keycrm.updateOrder(order.id, { status_id: statusId, client_id: buyerId });
      console.log(`[webhook] ✅ Updated order #${order.id} → status=${statusId}, client_id=${buyerId}`);
    }
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
