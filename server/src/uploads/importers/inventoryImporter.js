import { inventorySchema } from '../schemas/inventorySchema.js';

export const inventoryImporter = {
  type:     'inventory',
  schema:   inventorySchema,
  // Surface "uid" in validation error messages — that is the column users
  // type into for Update / Remove (the row's internal row_uid).
  keyField: 'uid',

  getKey(row) {
    return row.row_uid;
  },

  async fetchKeySet(uploadsRepo, organizationId, keys) {
    return uploadsRepo.getInventoryKeySet(organizationId, keys);
  },

  async addBatch(uploadsRepo, rows) {
    await uploadsRepo.insertInventoryBatch(rows);
  },

  async updateBatch(uploadsRepo, organizationId, rows) {
    return uploadsRepo.updateInventoryByRowUid(organizationId, rows);
  },

  async removeBatch(uploadsRepo, organizationId, keys) {
    return uploadsRepo.deleteInventoryByRowUids(organizationId, keys);
  },

  async logUpload(uploadsRepo, meta) {
    await uploadsRepo.logInventoryUpload(meta);
  },

  // Phase B (2026-05-18): BigQuery LOAD JOB ingest from a GCS NDJSON
  // source. Used for the Add path when storageService is enabled —
  // drops 100k-row latency from ~5 min (DML chunks) to ~10-15s.
  async loadFromGcsBatch(uploadsRepo, sourceUri) {
    return uploadsRepo.loadInventoryFromGcs(sourceUri);
  },
};
