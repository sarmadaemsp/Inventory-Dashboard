import { randomUUID } from 'crypto';
import { safeString, parsePositiveInt, normalizeDate, normalizeShippedSku } from '../core/rowNormalizer.js';

const VALID_ACTIONS = new Set(['Add', 'Update', 'Remove']);

export const ordersSchema = {
  // No columns are universally required across all action types:
  //   Add    → order_date, sku, quantity_sold, platform
  //   Update → order_id (user-provided key)
  //   Remove → order_id
  // Per-row validation in buildRow handles action-specific requirements.
  required: [],

  buildRow(raw, organizationId, lineNum) {
    const action = raw.action?.trim() || 'Add';
    if (!VALID_ACTIONS.has(action)) {
      return { error: { row: lineNum, field: 'action', reason: `action must be Add, Update, or Remove (got "${action}")` } };
    }

    // Accept `shipped_sku` (canonical). Legacy `shipped_from_box` header is
    // still tolerated for backwards-compatible feed files; the new header wins.
    const shippedRaw = (raw.shipped_sku?.trim?.() ? raw.shipped_sku : raw.shipped_from_box) ?? '';

    // `uid` is the INTERNAL row tracker (order_row_id) for Update/Remove.
    // `order_id` is the EXTERNAL marketplace order number (required on Add).
    if (action === 'Remove') {
      const uid = raw.uid?.trim();
      if (!uid) {
        return { error: { row: lineNum, field: 'uid', reason: 'uid is required for Remove' } };
      }
      return { action, row: { organization_id: organizationId, order_row_id: uid } };
    }

    if (action === 'Update') {
      const uid = raw.uid?.trim();
      if (!uid) {
        return { error: { row: lineNum, field: 'uid', reason: 'uid is required for Update' } };
      }

      const row = { organization_id: organizationId, order_row_id: uid };

      if (raw.order_id?.trim()) row.order_id = safeString(raw.order_id);
      if (raw.order_date?.trim()) {
        const orderDate = normalizeDate(raw.order_date);
        if (!orderDate) {
          return { error: { row: lineNum, field: 'order_date', reason: 'order_date could not be parsed — accepted formats: YYYY-MM-DD, M/D/YYYY, MM/DD/YYYY' } };
        }
        row.order_date = orderDate;
      }
      if (raw.sku?.trim())      row.sku      = safeString(raw.sku);
      if (raw.platform?.trim()) row.platform = safeString(raw.platform);
      // Only touch shipped_sku when the user actually filled the cell. Blank
      // cells on Update must NOT wipe an existing override — the TSV parser
      // always sets undefined columns to '' so we must compare to ''.
      if (shippedRaw && shippedRaw.trim()) {
        row.shipped_sku = normalizeShippedSku(shippedRaw);
      }

      if (raw.quantity_sold !== undefined && raw.quantity_sold !== '') {
        const qty = parsePositiveInt(raw.quantity_sold, 'quantity_sold', lineNum);
        if (qty.error) return { error: qty.error };
        row.quantity_sold = qty.value;
      }

      return { action, row };
    }

    // Add: all fields required (original behavior).
    // order_id (marketplace order number) is now required so every order has
    // a human-meaningful identifier in addition to the internal UID.
    if (!raw.order_id?.trim()) {
      return { error: { row: lineNum, field: 'order_id', value: raw.order_id, reason: 'order_id is required (marketplace order number, e.g. Amazon order ID)' } };
    }
    if (!raw.order_date?.trim()) {
      return { error: { row: lineNum, field: 'order_date', value: raw.order_date, reason: 'order_date is required' } };
    }
    const orderDate = normalizeDate(raw.order_date);
    if (!orderDate) {
      return { error: { row: lineNum, field: 'order_date', value: raw.order_date, reason: 'order_date could not be parsed — accepted formats: YYYY-MM-DD, M/D/YYYY, MM/DD/YYYY' } };
    }

    if (!raw.sku?.trim()) {
      return { error: { row: lineNum, field: 'sku', value: raw.sku, reason: 'sku is required' } };
    }

    const qty = parsePositiveInt(raw.quantity_sold, 'quantity_sold', lineNum);
    if (qty.error) return { error: qty.error };

    if (!raw.platform?.trim()) {
      return { error: { row: lineNum, field: 'platform', value: raw.platform, reason: 'platform is required' } };
    }

    return {
      action,
      row: {
        order_row_id:     randomUUID(),
        organization_id:  organizationId,
        order_id:         safeString(raw.order_id),
        order_date:       orderDate,
        sku:              safeString(raw.sku),
        quantity_sold:    qty.value,
        platform:         safeString(raw.platform),
        shipped_sku:      normalizeShippedSku(shippedRaw),
        created_at:       new Date().toISOString(),
      },
    };
  },
};
