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
/**
 * Build a lookup Map from a flat groups array.
 * Key: "name_lowercase::parentGroupId" — avoids relying on API response field names.
 * @param {Array} groups
 * @returns {Map<string, {id: string}>}
 */
function buildGroupMap(groups) {
  const map = new Map();
  for (const g of groups) {
    // Checkbox API uses parent_id for group parent (confirmed from real API response)
    const parentId = g.parent_id || '';
    const key = `${g.name.toLowerCase().trim()}::${parentId}`;
    map.set(key, g);
  }
  return map;
}

async function resolveGroupId(categoryId, keycrmCats, groupMap) {
  if (!categoryId) return null;
  const cat = keycrmCats.get(categoryId);
  if (!cat) return null;

  let parentGroupId = '';

  // If this category has a parent → ensure parent group exists first
  if (cat.parent_id) {
    const parentCat = keycrmCats.get(cat.parent_id);
    if (parentCat) {
      const parentKey = `${parentCat.name.toLowerCase().trim()}::`;
      let parentGroup = groupMap.get(parentKey);
      if (!parentGroup) {
        console.log(`[sync] Creating Checkbox group: "${parentCat.name}"`);
        parentGroup = await checkbox.createGroup(parentCat.name, null);
        groupMap.set(parentKey, parentGroup);
        console.log(`[sync] Created group id=${parentGroup.id} "${parentCat.name}"`);
      }
      parentGroupId = parentGroup.id;
    }
  }

  // Ensure the category's own group/subgroup exists
  const key = `${cat.name.toLowerCase().trim()}::${parentGroupId}`;
  let group = groupMap.get(key);
  if (!group) {
    console.log(`[sync] Creating Checkbox ${parentGroupId ? 'sub' : ''}group: "${cat.name}"`);
    group = await checkbox.createGroup(cat.name, parentGroupId || null);
    groupMap.set(key, group);
    console.log(`[sync] Created ${parentGroupId ? 'sub' : ''}group id=${group.id} "${cat.name}"`);
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

  const summary = { created: 0, updated: 0, skipped: 0, errors: [], created_names: [] };
  const startedAt = Date.now();
  console.log('[sync] Starting product sync…');

  try {
    // ── Step 1: fetch categories & Checkbox groups for group resolution ─────
    let keycrmCats = new Map();
    let groupMap = new Map();
    try {
      const [cats, groups] = await Promise.all([
        keycrm.getProductCategories(),
        checkbox.getGroups(),
      ]);
      keycrmCats = cats;
      groupMap = buildGroupMap(groups);
      console.log(`[sync] Loaded ${keycrmCats.size} KeyCRM categories, ${groupMap.size} Checkbox groups.`);
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
        groupId = await resolveGroupId(categoryId, keycrmCats, groupMap);
      } catch (err) {
        console.warn(`[sync] Could not resolve group for category ${categoryId}: ${err.message}`);
      }

      if (!existing) {
        // ── Create ──────────────────────────────────────────────────────
        try {
          const payload = toCheckboxGood(unit, productId, isOffer, groupId);
          await checkbox.createGood(payload);
          summary.created++;
          summary.created_names.push(unit.name);
          console.log(`[sync] Created: ${code} — ${unit.name}${groupId ? ` (group ${groupId})` : ''}`);
        } catch (err) {
          // Checkbox returns 422 when the code already exists (getGoodByCode can return
          // null due to API inconsistency) — treat any 422 on creation as "already exists"
          if (err.response?.status === 422) {
            summary.skipped++;
            console.log(`[sync] Skipped (already exists): ${code} — ${unit.name}`);
          } else {
            const detail = err.response?.data;
            const errMsg = detail?.message || detail?.detail || err.message || '';
            const msg = `Failed to create "${code}": ${errMsg}`;
            console.error(`[sync] ${msg}`, detail ? JSON.stringify(detail) : '');
            summary.errors.push({ code, reason: msg, detail });
          }
        }
      } else if (needsUpdate(existing, unit) || (groupId && existing.group_id !== groupId)) {
        // ── Update (name/price changed, or group assignment changed) ────
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

  // ── Ukrainian human-readable summary ────────────────────────────────────
  const lines = [];
  if (summary.created_names.length) {
    lines.push(`Додано товари:\n${summary.created_names.map((n) => `  • ${n}`).join('\n')}`);
  }
  if (summary.updated > 0) lines.push(`Оновлено: ${summary.updated}`);
  if (summary.skipped > 0) lines.push(`Пропущено (без змін): ${summary.skipped}`);
  if (summary.errors.length) lines.push(`Помилки: ${summary.errors.length}`);
  const summary_ua = lines.length ? lines.join('\n') : 'Нових товарів не знайдено.';

  const { created_names, ...rest } = summary;
  return res.json({ summary_ua, ...rest, elapsed_sec: elapsedSec });
});

module.exports = router;
