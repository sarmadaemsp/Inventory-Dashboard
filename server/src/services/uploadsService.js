import { runUploadPipeline }   from '../uploads/core/pipelineRunner.js';
import { inventoryImporter }   from '../uploads/importers/inventoryImporter.js';
import { ordersImporter }      from '../uploads/importers/ordersImporter.js';

// Phase B (2026-05-18): storageService + logger are injected here so
// every pipeline invocation gets GCS staging + per-phase timing logs.
// Both are optional — when unsupplied, the pipeline falls back to
// pure DML (Phase A behavior).
export function createUploadsService({ uploadsRepo, storageService = null, logger = null }) {

  function processInventoryUpload(organizationId, userId, stream, filename, uploadId = null) {
    return runUploadPipeline({
      importer: inventoryImporter,
      uploadsRepo, organizationId, userId, stream, filename, uploadId,
      storageService, logger,
    });
  }

  function processOrdersUpload(organizationId, userId, stream, filename, uploadId = null) {
    return runUploadPipeline({
      importer: ordersImporter,
      uploadsRepo, organizationId, userId, stream, filename, uploadId,
      storageService, logger,
    });
  }

  async function getHistory(organizationId, type) {
    return uploadsRepo.getHistory(organizationId, type);
  }

  async function getReport(organizationId, uploadId) {
    return uploadsRepo.getUploadReport(organizationId, uploadId);
  }

  async function getStatus(organizationId, uploadId) {
    return uploadsRepo.getUploadStatus(organizationId, uploadId);
  }

  return { processInventoryUpload, processOrdersUpload, getHistory, getReport, getStatus };
}
