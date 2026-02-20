'use strict';

const { Router } = require('express');
const keycrm = require('../services/keycrm');
const checkbox = require('../services/checkbox');
const { deriveCode, toCheckboxGood, needsUpdate } = require('../utils/mapper');

const router = Router();

/**
 * Resolves (or creates) a Checkbox group UUID for a given KeyCRM category.
 * Supports one level of nesting: if the category has a parent, the parent becomes
 * the Checkbox group and the category itself becomes the subgroup (parent_group_id set).
 *
 * @param {number|null} categoryId   KeyCRM category_id from a product
 * @param {Map}         keycrmCats   Map<id, {id, name, parent_id}> from keycrm.getProductCategories()
 * @param {Array}       checkboxGroups  Already-fetched Checkbox groups array (mutated on create)
 * @returns {Promise<string|null>}   Checkbox group UUID or null
 */
async function resolveGroupId(categoryId, keycrmCats, checkboxGroups) {
  if (!categoryId) return null;
  const cat = keycrmCats.get(categoryId);
  if (!cat) return null;

  let parentGroupId = null;

  // If this category has a parent → ensure parent group exists first
  if (cat.parent_id) {
    const parentCat = keycrmCats.get(cat.parent_id);
    if (parentCat) {
      let parentGroup = checkbox.findGroupByName(parentCat.name, null, checkboxGroups);
      if (!parentGroup) {
        console.log(`[sync] Creating Checkbox group: "${parentCat.name}"`);
        parentGroup = await checkbox.createGroup(parentCat.name, null);
        checkboxGroups.push(parentGroup);
      }
      parentGroupId = parentGroup.id;
    }
  }

  // Ensure the category's own group exists (as subgroup if parent was resolved)
  let group = checkbox.findGroupByName(cat.name, parentGroupId, checkboxGroups);
  if (!group) {
    console.log(`[sync] Creating Checkbox ${parentGroupId ? 'sub' : ''}group: "${cat.name}"`);
    group = await checkbox.createGroup(cat.name, parentGroupId);
    checkboxGroups.push(group);
  }

  return group.id;
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

  try {
    // ── Step 1: fetch categories & Checkbox groups for group resolution ─────
    let keycrmCats = new Map();
    let checkboxGroups = [];
    try {
      [keycrmCats, checkboxGroups] = await Promise.all([
        keycrm.getProductCategories(),
        checkbox.getGroups(),
      ]);
      console.log(`[sync] Loaded ${keycrmCats.size} KeyCRM categories, ${checkboxGroups.length} Checkbox groups.`);
    } catch (err) {
      console.warn('[sync] Could not load categories/groups, skipping group assignment:', err.message);
    }

    // ── Step 2: collect all KeyCRM syncable units ─────────────────────────
    const products = await keycrm.getAllProducts();
    /** @type {Array<{unit: object, productId: number, isOffer: boolean, categoryId: number|null}>} */
    const units = [];

    for (const product of products) {
      const categoryId = product.category_id || product.category?.id || null;
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
          units.push({ unit: offer, productId: product.id, isOffer: true, categoryId });
        }
      } else {
        units.push({ unit: product, productId: product.id, isOffer: false, categoryId });
      }
    }

    console.log(`[sync] Found ${units.length} syncable units in KeyCRM.`);

    // ── Step 3: upsert each unit into Checkbox ─────────────────────────────
    for (const { unit, productId, isOffer, categoryId } of units) {
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

      // Resolve Checkbox group UUID from KeyCRM category (best-effort)
      let groupId = null;
      try {
        groupId = await resolveGroupId(categoryId, keycrmCats, checkboxGroups);
      } catch (err) {
        console.warn(`[sync] Could not resolve group for category ${categoryId}: ${err.message}`);
      }

      if (!existing) {
        // ── Create ──────────────────────────────────────────────────────
        try {
          const payload = toCheckboxGood(unit, productId, isOffer, groupId);
          console.log(`[sync] Creating good:`, JSON.stringify(payload));
          await checkbox.createGood(payload);
          summary.created++;
          console.log(`[sync] Created: ${code} — ${unit.name}${groupId ? ` (group ${groupId})` : ''}`);
        } catch (err) {
          const detail = err.response?.data;
          const msg = `Failed to create "${code}": ${detail?.message || err.message}`;
          console.error(`[sync] ${msg}`, detail ? JSON.stringify(detail) : '');
          summary.errors.push({ code, reason: msg, detail });
        }
      } else if (needsUpdate(existing, unit)) {
        // ── Update ──────────────────────────────────────────────────────
        try {
          const payload = toCheckboxGood(unit, productId, isOffer, groupId);
          await checkbox.updateGood(existing.id, payload);
          summary.updated++;
          console.log(`[sync] Updated: ${code} — ${unit.name}${groupId ? ` (group ${groupId})` : ''}`);
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
