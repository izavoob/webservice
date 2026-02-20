'use strict';

const { Router } = require('express');
const keycrm = require('../services/keycrm');
const checkbox = require('../services/checkbox');
const { deriveCode, toCheckboxGood, needsUpdate } = require('../utils/mapper');

const router = Router();

/**
 * Resolve a KeyCRM category to a Checkbox group UUID.
 * Creates the group (and its parent group) in Checkbox if they don't exist.
 * Returns null if category is falsy or on any error.
 */
async function resolveGroupId(category) {
  if (!category || !category.name) return null;
  try {
    let parentId = null;
    if (category.parent && category.parent.name) {
      parentId = await checkbox.getOrCreateGroup(category.parent.name);
    }
    return await checkbox.getOrCreateGroup(category.name, parentId);
  } catch (err) {
    console.warn(`[sync] Could not resolve Checkbox group for "${category.name}": ${err.message}`);
    return null;
  }
}

/**
 * GET /sync-products?secret=<SYNC_SECRET>
 *
 * Pulls all products/offers from KeyCRM and upserts them into the
 * Checkbox goods catalog. Products are deduplicated by `code`
 * (KeyCRM SKU → barcode → slugified name fallback).
 *
 * Returns: { created, updated, skipped, errors }
 */
router.get('/', async (req, res) => {
  // ── Auth guard ──────────────────────────────────────────────────────────
  if (req.query.secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: invalid secret' });
  }

  const summary = { created: 0, updated: 0, skipped: 0, errors: [] };
  const startedAt = Date.now();
  console.log('[sync] Starting product sync…');

  // Reset group cache so stale data from previous runs doesn’t persist
  checkbox.clearGroupCache();

  try {
    // ── Step 1: collect all KeyCRM syncable units ─────────────────────────
    const products = await keycrm.getAllProducts();
    /** @type {Array<{unit: object, productId: number, isOffer: boolean}>} */
    const units = [];

    for (const product of products) {
      if (product.has_offers) {
        // Fetch individual offer variants
        const offers = await keycrm.getOffersByProduct(product.id);
        for (const offer of offers) {
          // Merge product name into offer for nicer display in Checkbox
          if (!offer.name) offer.name = product.name;
          // Add variant property suffix to name if available
          if (offer.properties && offer.properties.length) {
            const suffix = offer.properties.map((p) => `${p.value}`).join(', ');
            offer.name = `${product.name} — ${suffix}`;
          }
          // Carry parent product’s category down to each offer
          units.push({ unit: offer, productId: product.id, isOffer: true, category: product.category || null });
        }
      } else {
        units.push({ unit: product, productId: product.id, isOffer: false, category: product.category || null });
      }
    }

    console.log(`[sync] Found ${units.length} syncable units in KeyCRM.`);

    // ── Step 2: upsert each unit into Checkbox ────────────────────────────
    for (const { unit, productId, isOffer, category } of units) {
      if (!unit.name) {
        summary.errors.push({ id: unit.id, reason: 'Missing name, skipped' });
        continue;
      }

      const code = deriveCode(unit);

      // Skip products with no identifiable code
      if (!code || !code.trim()) {
        summary.errors.push({ id: unit.id, reason: 'Empty code (no SKU/barcode/name), skipped' });
        summary.skipped++;
        continue;
      }

      let existing = null;

      try {
        existing = await checkbox.getGoodByCode(code);
      } catch (err) {
        const msg = `Error checking code "${code}": ${err.message}`;
        console.error(`[sync] ${msg}`);
        summary.errors.push({ code, reason: msg });
        continue;
      }

      // Resolve Checkbox group from KeyCRM category
      const groupId = await resolveGroupId(category);

      if (!existing) {
        // ── Create ──────────────────────────────────────────────────────
        try {
          const payload = toCheckboxGood(unit, productId, isOffer, groupId);
          console.log(`[sync] Creating good:`, JSON.stringify(payload));
          await checkbox.createGood(payload);
          summary.created++;
          console.log(`[sync] Created: ${code} — ${unit.name}${groupId ? ` (group: ${category?.name})` : ''}`);
        } catch (err) {
          const detail = err.response?.data;
          const msg = `Failed to create "${code}": ${detail?.message || err.message}`;
          console.error(`[sync] ${msg}`, detail ? JSON.stringify(detail) : '');
          summary.errors.push({ code, reason: msg, detail });
        }
      } else if (needsUpdate(existing, unit, groupId)) {
        // ── Update ──────────────────────────────────────────────────────
        try {
          const payload = toCheckboxGood(unit, productId, isOffer, groupId);
          await checkbox.updateGood(existing.id, payload);
          summary.updated++;
          console.log(`[sync] Updated: ${code} — ${unit.name}${groupId ? ` (group: ${category?.name})` : ''}`);
        } catch (err) {
          const msg = `Failed to update "${code}": ${err.response?.data?.message || err.message}`;
          console.error(`[sync] ${msg}`);
          summary.errors.push({ code, reason: msg });
        }
      } else {
        // ── Skip (no changes) ────────────────────────────────────────────
        summary.skipped++;
      }
    }
  } catch (err) {
    console.error('[sync] Fatal error during sync:', err.message);
    return res.status(500).json({ error: err.message, ...summary });
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[sync] Done in ${elapsedSec}s — created: ${summary.created}, updated: ${summary.updated}, skipped: ${summary.skipped}, errors: ${summary.errors.length}`
  );

  return res.json({ ...summary, elapsed_sec: elapsedSec });
});

module.exports = router;
