import { ordersSchema } from '../schemas/ordersSchema.js';

export const ordersImporter = {
  type:     'orders',
  schema:   ordersSchema,
  // Surface "uid" in validation error messages — that is the column users
  // type into for Update / Remove (the row's internal order_row_id).
  keyField: 'uid',

  getKey(row) {
    return row.order_row_id;
  },

  async fetchKeySet(uploadsRepo, organizationId, keys) {
    return uploadsRepo.getOrderKeySet(organizationId, keys);
  },

  async addBatch(uploadsRepo, rows) {
    await uploadsRepo.insertOrdersBatch(rows);
  },

  async updateBatch(uploadsRepo, organizationId, rows) {
    return uploadsRepo.updateOrdersByOrderId(organizationId, rows);
  },

  async removeBatch(uploadsRepo, organizationId, keys) {
    return uploadsRepo.deleteOrdersByOrderIds(organizationId, keys);
  },

  async logUpload(uploadsRepo, meta) {
    await uploadsRepo.logOrderUpload(meta);
  },

  // Phase B (2026-05-18): BigQuery LOAD JOB ingest from a GCS NDJSON
  // source. Used for the Add path when storageService is enabled.
  async loadFromGcsBatch(uploadsRepo, sourceUri) {
    return uploadsRepo.loadOrdersFromGcs(sourceUri);
  },
};
