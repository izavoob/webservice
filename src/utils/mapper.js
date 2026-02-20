'use strict';

/**
 * Derives the Checkbox `code` field from a KeyCRM product/offer unit.
 * Strategy: SKU → barcode → slugified name.
 *
 * @param {object} unit  KeyCRM product or offer object
 * @returns {string}     Value to use as `code` in Checkbox
 */
function deriveCode(unit) {
  if (unit.sku && unit.sku.trim()) return unit.sku.trim();
  if (unit.barcode && unit.barcode.trim()) return unit.barcode.trim();
  // Last resort: slugify the name, truncate to 150 chars (Checkbox code max)
  return slugify(unit.name || `product-${unit.id}`).slice(0, 150);
}

/**
 * Simple slug: lowercase, replace spaces/special chars with hyphens.
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert a KeyCRM product/offer unit into a Checkbox `POST /goods` payload.
 *
 * @param {object} unit       KeyCRM product (has_offers=false) or offer object
 * @param {number} productId  Parent product ID (for external_id)
 * @param {boolean} isOffer   True if the unit is an offer (variant); false if bare product
 * @returns {object}          Checkbox good payload
 */
function toCheckboxGood(unit, productId, isOffer = false) {
  const code = deriveCode(unit);
  const name = unit.name || `Product ${unit.id}`;
  // Checkbox expects price in kopecks (integer), KeyCRM uses decimal UAH
  const price = Math.round((unit.price || 0) * 100);
  const externalId = isOffer
    ? `keycrm_offer:${unit.id}`
    : `keycrm_product:${productId}`;

  // tax_codes: required by Ukrainian fiscal law.
  // Set CHECKBOX_TAX_CODES=A in .env for 20% VAT (most common).
  // Use empty array [] for no taxes (e.g. exempt goods).
  const rawTaxCodes = process.env.CHECKBOX_TAX_CODES || '';
  const taxCodes = rawTaxCodes
    ? rawTaxCodes.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const payload = {
    name,
    code,
    price,
    type: 'PRODUCT',
    is_weight: false,
    tax_codes: taxCodes,
    external_id: externalId,
  };

  // Attach barcode if available (and not already used as code)
  if (unit.barcode && unit.barcode.trim()) {
    payload.barcode = unit.barcode.trim();
  }

  return payload;
}

/**
 * Determine whether a Checkbox good needs to be updated compared to a KeyCRM unit.
 * Returns true if name or price differ.
 *
 * @param {object} checkboxGood  Existing good from Checkbox GET response
 * @param {object} keycrmUnit    KeyCRM product or offer unit
 */
function needsUpdate(checkboxGood, keycrmUnit) {
  const expectedPrice = Math.round((keycrmUnit.price || 0) * 100);
  const expectedName = keycrmUnit.name || `Product ${keycrmUnit.id}`;
  return checkboxGood.price !== expectedPrice || checkboxGood.name !== expectedName;
}

/**
 * Convert a Checkbox receipt payment into a KeyCRM payment object.
 *
 * @param {object} checkboxPayment  Payment object from Checkbox receipt
 * @returns {object|null}           KeyCRM payment object, or null if type unknown
 */
function toKeycrmPayment(checkboxPayment) {
  const typeMap = {
    CASH: process.env.CHECKBOX_CASH_PAYMENT_METHOD_ID,
    CASHLESS: process.env.CHECKBOX_CASHLESS_PAYMENT_METHOD_ID,
  };
  const methodId = typeMap[checkboxPayment.type];
  if (!methodId) return null;

  // Checkbox stores amounts in kopecks; convert to decimal UAH
  const amount = (checkboxPayment.value || 0) / 100;

  return {
    payment_method_id: Number(methodId),
    amount,
    status: 'paid',
  };
}

/**
 * Convert a Checkbox receipt good item into a KeyCRM order product line.
 *
 * @param {object} goodItem   Item from receipt.goods[i]
 * @param {object} offer      Matching KeyCRM offer or null
 * @returns {object}          KeyCRM product line object
 */
function toKeycrmProduct(goodItem, offer) {
  const good = goodItem.good || {};
  // Checkbox quantity is in units × 1000 (1 item = 1000)
  const quantity = (goodItem.quantity || 1000) / 1000;
  // Checkbox price is in kopecks
  const price = (good.price || goodItem.total_sum || 0) / 100;

  return {
    sku: offer ? offer.sku || good.code : good.code,
    name: good.name || (offer && offer.product ? offer.product.name : 'Unknown'),
    price,
    quantity,
  };
}

module.exports = { deriveCode, toCheckboxGood, needsUpdate, toKeycrmPayment, toKeycrmProduct };
