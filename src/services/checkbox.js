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

// ─── Goods Groups ────────────────────────────────────────────────────────────

/**
 * Fetch all goods groups from Checkbox (supports pagination).
 * Returns flat array of all group objects.
 */
async function getGroups() {
  return withRetry(async () => {
    const results = [];
    let page = 1;
    const limit = 100;
    while (true) {
      const res = await client().get('/goods/groups', { params: { limit, offset: (page - 1) * limit } });
      const data = res.data;
      const items = data.results || data || [];
      results.push(...items);
      if (!data.next || items.length < limit) break;
      page++;
    }
    return results;
  });
}

/**
 * Find a group by name (case-insensitive) within a given parent_group_id (or null for top-level).
 * @param {string} name
 * @param {string|null} parentGroupId
 * @param {Array} cachedGroups  Already-fetched groups array (avoids extra API call)
 */
function findGroupByName(name, parentGroupId, cachedGroups) {
  const needle = name.toLowerCase().trim();
  return cachedGroups.find(
    g =>
      g.name.toLowerCase().trim() === needle &&
      (g.parent_group_id || null) === (parentGroupId || null)
  ) || null;
}

/**
 * Create a new goods group.
 * @param {string} name
 * @param {string|null} parentGroupId  UUID of parent group for a subgroup
 */
async function createGroup(name, parentGroupId = null) {
  return withRetry(async () => {
    const res = await client().post('/goods/groups', {
      name,
      ...(parentGroupId ? { parent_group_id: parentGroupId } : {}),
    });
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

module.exports = { login, getCashierId, getGoods, getGoodByCode, createGood, updateGood, getGroups, findGroupByName, createGroup, getWebhook, registerWebhook, deleteWebhook };
