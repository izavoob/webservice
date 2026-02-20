'use strict';

const axios = require('axios');

const BASE_URL = 'https://openapi.keycrm.app/v1';
const RATE_LIMIT_DELAY_MS = 1100; // ~54 req/min safety margin

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.KEYCRM_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Products ─────────────────────────────────────────────────────────────────

/**
 * Fetch all products from KeyCRM, paginating automatically.
 * Returns an array of raw product objects.
 * Products with has_offers=true will have their offers fetched separately.
 */
async function getAllProducts() {
  const products = [];
  let page = 1;
  const limit = 50;

  while (true) {
    const res = await client().get('/products', { params: { limit, page } });
    const data = res.data;
    products.push(...data.data);

    if (products.length >= data.total || data.data.length < limit) break;
    page++;
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return products;
}

/**
 * Fetch all offers for a specific product ID.
 */
async function getOffersByProduct(productId) {
  const offers = [];
  let page = 1;
  const limit = 50;

  while (true) {
    const res = await client().get('/offers', {
      params: { 'filter[product_id]': productId, limit, page },
    });
    const data = res.data;
    offers.push(...data.data);

    if (offers.length >= data.total || data.data.length < limit) break;
    page++;
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return offers;
}

/**
 * Look up an offer by SKU.
 * Returns the first matching offer or null.
 */
async function getOfferBySku(sku) {
  try {
    const res = await client().get('/offers', {
      params: { 'filter[sku]': sku, include: 'product', limit: 1 },
    });
    return res.data.data[0] || null;
  } catch {
    return null;
  }
}

/**
 * Look up an offer by barcode (scans all pages until found).
 * Returns the first matching offer or null.
 */
async function getOfferByBarcode(barcode) {
  let page = 1;
  const limit = 50;

  while (true) {
    const res = await client().get('/offers', {
      params: { include: 'product', limit, page },
    });
    const { data, total } = res.data;

    const match = data.find((o) => o.barcode === barcode);
    if (match) return match;

    if (data.length < limit || page * limit >= total) return null;
    page++;
    await sleep(RATE_LIMIT_DELAY_MS);
  }
}

/**
 * Look up a product by name (exact, case-insensitive).
 * Returns the first matching product or null.
 */
async function getProductByName(name) {
  let page = 1;
  const limit = 50;
  const needle = name.toLowerCase().trim();

  while (true) {
    const res = await client().get('/products', { params: { limit, page } });
    const { data, total } = res.data;

    const match = data.find((p) => p.name.toLowerCase().trim() === needle);
    if (match) return match;

    if (data.length < limit || page * limit >= total) return null;
    page++;
    await sleep(RATE_LIMIT_DELAY_MS);
  }
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Create a new order in KeyCRM.
 * @param {object} payload  Full order payload (source_id, buyer, products, payments, etc.)
 * @returns {object} Created order
 */
async function createOrder(payload) {
  const res = await client().post('/order', payload);
  return res.data;
}

/**
 * Update an existing order (PATCH).
 * @param {number|string} orderId
 * @param {object} payload  Partial payload (e.g. { status_id: 12 })
 */
async function updateOrder(orderId, payload) {
  const res = await client().put(`/order/${orderId}`, payload);
  return res.data;
}

// ─── Reference Data ───────────────────────────────────────────────────────────

/**
 * Fetch all payment methods.
 */
async function getPaymentMethods() {
  const res = await client().get('/order/payment-method', { params: { limit: 50, page: 1 } });
  return res.data.data;
}

/**
 * Fetch all order statuses.
 */
async function getOrderStatuses() {
  const res = await client().get('/order/status', { params: { limit: 50, page: 1 } });
  return res.data.data;
}

/**
 * Fetch all order sources.
 */
async function getOrderSources() {
  const res = await client().get('/order/source', { params: { limit: 50, page: 1 } });
  return res.data.data;
}

module.exports = {
  getAllProducts,
  getOffersByProduct,
  getOfferBySku,
  getOfferByBarcode,
  getProductByName,
  createOrder,
  updateOrder,
  getPaymentMethods,
  getOrderStatuses,
  getOrderSources,
};
