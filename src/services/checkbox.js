'use strict';

const axios = require('axios');

const BASE_URL = 'https://api.checkbox.ua/api/v1';

let jwtToken = null;
let cashierId = null;  // UUID of the signed-in cashier, set on login

/**
 * Returns the UUID of the currently signed-in cashier (set after login).
 */
function getCashierId() {
  return cashierId;
}

/**
 * Returns an axios instance with Authorization + X-License-Key headers.
 * Automatically uses the cached JWT.
 */
function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Content-Type': 'application/json',
      ...(jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {}),
      'X-License-Key': process.env.CHECKBOX_LICENSE_KEY,
    },
  });
}

/**
 * Sign in the cashier and cache the JWT.
 * Called on startup and whenever a 401 is received.
 */
async function login() {
  const res = await axios.post(`${BASE_URL}/cashier/signin`, {
    login: process.env.CHECKBOX_CASHIER_LOGIN,
    password: process.env.CHECKBOX_CASHIER_PASSWORD,
  });
  jwtToken = res.data.access_token;
  // The signin response doesn't include cashier UUID — fetch it separately
  try {
    const me = await axios.get(`${BASE_URL}/cashier/me`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'X-License-Key': process.env.CHECKBOX_LICENSE_KEY,
      },
    });
    cashierId = me.data.id || null;
  } catch (_) {
    cashierId = null;
  }
  console.log(`[checkbox] Signed in, JWT cached. Cashier ID: ${cashierId}`);
  return jwtToken;
}

/**
 * Wraps a Checkbox API call with automatic 401 retry (re-login once).
 */
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.response && err.response.status === 401) {
      console.warn('[checkbox] 401 received, re-logging in…');
      await login();
      return await fn(); // retry once with fresh JWT
    }
    throw err;
  }
}

// ─── Goods ───────────────────────────────────────────────────────────────────

/**
 * Fetch a page of goods from the Checkbox catalog.
 * @param {number} page  1-based page number
 * @param {number} limit Items per page (max 100)
 */
async function getGoods(page = 1, limit = 100) {
  return withRetry(async () => {
    const res = await client().get('/goods', { params: { page, limit } });
    return res.data; // { count, results, next, previous }
  });
}

/**
 * Look up a good by its `code` field (maps to KeyCRM SKU).
 * Returns the good object or null if not found.
 */
async function getGoodByCode(code) {
  return withRetry(async () => {
    try {
      const res = await client().get(`/goods/by-code/${encodeURIComponent(code)}`);
      return res.data;
    } catch (err) {
      if (err.response && err.response.status === 404) return null;
      throw err;
    }
  });
}

/**
 * Create a new good in the Checkbox catalog.
 * All prices must be in kopecks (UAH × 100).
 */
async function createGood(payload) {
  return withRetry(async () => {
    const res = await client().post('/goods', payload);
    return res.data;
  });
}

/**
 * Update an existing good by its UUID.
 */
async function updateGood(uuid, payload) {
  return withRetry(async () => {
    const res = await client().put(`/goods/${uuid}`, payload);
    return res.data;
  });
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

/**
 * Get the currently registered webhook URL.
 * Returns null if none is set.
 */
async function getWebhook() {
  return withRetry(async () => {
    try {
      const res = await client().get('/webhook');
      return res.data;
    } catch (err) {
      if (err.response && (err.response.status === 404 || err.response.status === 422)) return null;
      throw err;
    }
  });
}

/**
 * Register a webhook URL with Checkbox.
 * @param {string} url  Public HTTPS URL to receive webhook events
 * Returns the full response including `secret` on first registration.
 */
async function registerWebhook(url) {
  return withRetry(async () => {
    const res = await client().post('/webhook', { url });
    return res.data;
  });
}

/**
 * Delete the currently registered webhook.
 */
async function deleteWebhook() {
  return withRetry(async () => {
    await client().delete('/webhook');
  });
}

// ─── Groups ─────────────────────────────────────────────────────────────────

let groupCache = null; // { "name::parentId" -> uuid }

async function getAllGroups() {
  return withRetry(async () => {
    const res = await client().get('/goods/groups', { params: { limit: 200, offset: 0 } });
    return res.data.results || [];
  });
}

async function createGroup(name, parentId = null) {
  return withRetry(async () => {
    const payload = { name };
    if (parentId) payload.parent_id = parentId;
    const res = await client().post('/goods/groups', payload);
    return res.data;
  });
}

/**
 * Returns a Checkbox group UUID by name (and optional parent UUID).
 * Creates the group if it doesn't exist. Call clearGroupCache() before each sync run.
 */
async function getOrCreateGroup(name, parentId = null) {
  if (!groupCache) {
    const groups = await getAllGroups();
    groupCache = {};
    for (const g of groups) {
      const key = `${g.name}::${g.parent_id || ''}`;
      groupCache[key] = g.id;
    }
  }
  const key = `${name}::${parentId || ''}`;
  if (groupCache[key]) return groupCache[key];

  const newGroup = await createGroup(name, parentId);
  groupCache[key] = newGroup.id;
  return newGroup.id;
}

function clearGroupCache() {
  groupCache = null;
}

module.exports = { login, getCashierId, getGoods, getGoodByCode, createGood, updateGood, getWebhook, registerWebhook, deleteWebhook, getOrCreateGroup, clearGroupCache };
