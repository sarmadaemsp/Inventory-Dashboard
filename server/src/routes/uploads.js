import { randomUUID } from 'crypto';
import { Readable }   from 'stream';
import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';

// Accepted upload format is TSV (Tab Separated Values). Excel exports TSV
// cleanly via "Save As → Tab Separated Values (.tsv)" — this avoids the
// ambiguity that occurred when users saved as "Text (Tab delimited) .txt"
// and Excel produced comma-separated content instead.
//
// .txt is still accepted as a backward-compat alias for users who already
// have correctly tab-delimited .txt files from earlier exports.
//
// File MIME types are NOT checked: browsers vary too much in what they send
// for TSV (text/plain, text/tab-separated-values, application/octet-stream,
// even empty). The extension check + downstream TSV parser are the real
// validators — a wrong-format upload fails parsing with a clear error.
function validateUploadFile(part) {
  if (!part) return 'No file uploaded';
  const name = (part.filename ?? '').toLowerCase();
  if (!/\.(tsv|txt)$/.test(name)) {
    return 'Only UTF-8 tab-separated .tsv files are accepted (use Excel → Save As → Tab Separated Values .tsv).';
  }
  return null;
}

// ============================================================
// Phase A async upload lifecycle (2026-05-18)
// ------------------------------------------------------------
// The HTTP request returns 202 + upload_id within seconds, even for
// 100k-row uploads. The actual Phase 2-4 DML work + summary refresh
// happen in a background task scheduled via setImmediate AFTER the
// response is flushed.
//
// Why this matters:
//   The old synchronous flow did Phase 1-4 (~5 min for 100k rows)
//   inside the HTTP request, exceeded Cloud Run's --timeout=60s, and
//   surfaced as a CORS / 504 / "no Access-Control-Allow-Origin" error
//   in the browser (the connection was killed mid-flight by Cloud
//   Run, never finishing the response).
//
// Steps:
//   1. Validate the multipart upload.
//   2. Buffer the whole file into memory (10 MB cap from the multipart
//      plugin — fits in 512 MB Cloud Run RAM with room to spare).
//   3. Generate uploadId, INSERT an `accepted` row in inventory_uploads
//      / order_uploads via uploadsRepo.createUploadJob(). This is a
//      single fast DML statement — completes in <500 ms.
//   4. Schedule the background processor via setImmediate. The Node
//      event loop sends the 202 response, THEN starts the background
//      task — so the HTTP request returns in ~2-5 s for any size.
//   5. The background task:
//        a. Marks status='processing'.
//        b. Runs the existing pipelineRunner on a Readable wrapping
//           the buffered bytes. Phase 2-4 DML executes here.
//        c. Finalizes the job row with the terminal status + report.
//        d. Enqueues a Cloud Task → /tasks/refresh-summaries (or
//           runs the refresh inline if Cloud Tasks isn't configured).
//
// Cloud Run instance lifetime:
//   For the background work to survive after the HTTP response, the
//   Cloud Run instance must stay warm. Set --min-instances=1 in
//   cloudbuild.yaml. Without that flag, scale-down can kill an
//   in-flight background job mid-write.
//
// Recovery:
//   If a job is stuck in 'processing' or 'accepted' for >10 minutes,
//   the operator can call POST /admin/summary-refresh to force a
//   refresh, and the status row can be inspected via GET
//   /uploads/status/:upload_id. A future iteration could auto-recover
//   by sweeping stuck rows; for Phase A we surface them to the UI.
// ============================================================

export async function uploadsRoutes(fastify, {
  uploadsService, dashboardService, summaryRefreshService,
  uploadsRepo, cloudTasksService,
}) {

  // Schedule the background processor. Captured logger ref so we
  // don't depend on the Fastify request/reply lifecycle after the
  // response has been sent.
  function _scheduleBackgroundProcessing({
    type, uploadId, organizationId, userId, buffer, filename,
  }) {
    const log = fastify.log.child({
      event: 'background_upload',
      upload_id: uploadId,
      organization_id: organizationId,
      type,
    });

    setImmediate(async () => {
      const startedAt = Date.now();
      try {
        await uploadsRepo.setUploadProcessing({ type, uploadId, organizationId });

        const stream = Readable.from(buffer);
        const processFn = type === 'inventory'
          ? uploadsService.processInventoryUpload
          : uploadsService.processOrdersUpload;
        const result = await processFn(organizationId, userId, stream, filename, uploadId);

        await uploadsRepo.finalizeUploadJob({
          type, uploadId, organizationId,
          status:    result.status,
          rowCount:  (result.added ?? 0) + (result.updated ?? 0) + (result.removed ?? 0),
          report:    result.report,
          lastError: null,
        });

        // Refresh the KPI cache for this org so the dashboard's next
        // hit doesn't serve a stale cached row.
        dashboardService?.invalidateKPICache?.(organizationId);

        // Enqueue the summary refresh. If Cloud Tasks is configured,
        // it's queued as a separate HTTP request to /tasks/refresh-summaries.
        // Otherwise the inline fallback runs it in this same task.
        const refreshOutcome = await cloudTasksService.enqueueRefresh({
          organizationId, uploadId, type,
        });

        log.info(
          {
            duration_ms: Date.now() - startedAt,
            status:      result.status,
            added:       result.added,
            updated:     result.updated,
            removed:     result.removed,
            failed:      result.failed,
            refresh_mode: refreshOutcome.mode,
          },
          'Background upload processing complete',
        );
      } catch (err) {
        log.error(
          { err: err?.message, duration_ms: Date.now() - startedAt },
          'Background upload processing failed',
        );
        try {
          await uploadsRepo.finalizeUploadJob({
            type, uploadId, organizationId,
            status:    'failed',
            rowCount:  0,
            report:    null,
            lastError: err?.message ?? String(err),
          });
        } catch (e2) {
          log.error({ err: e2?.message }, 'Failed to mark job failed');
        }
      }
    });
  }

  // Shared multipart→buffer + accepted-row insert + 202. The type-specific
  // handlers (POST /inventory, POST /orders) differ only in the importer
  // selection happening inside _scheduleBackgroundProcessing.
  async function _acceptUpload({ type, request, reply }) {
    let part;
    try {
      part = await request.file();
    } catch {
      return reply.code(400).send({ success: false, error: 'Multipart upload required' });
    }

    const fileErr = validateUploadFile(part);
    if (fileErr) return reply.code(400).send({ success: false, error: fileErr });

    // Buffer the whole file into memory. The multipart plugin enforces
    // the 10 MB cap; anything larger fails before we get here.
    let buffer;
    try {
      buffer = await part.toBuffer();
    } catch (err) {
      request.log.warn({ err: err?.message }, 'Failed to buffer multipart upload');
      return reply.code(400).send({ success: false, error: 'Failed to read upload file' });
    }

    const { organization_id, user_id } = request.user;
    const uploadId = randomUUID();
    const filename = part.filename || `${type}.tsv`;

    // Pre-insert the audit row so /uploads/status/:upload_id has
    // something to return immediately. ~250-500 ms DML insert.
    try {
      await uploadsRepo.createUploadJob({
        type, uploadId, organizationId: organization_id, userId: user_id, filename,
      });
    } catch (err) {
      request.log.error({ err: err?.message }, 'Failed to create upload job row');
      return reply.code(500).send({ success: false, error: 'Failed to register upload' });
    }

    _scheduleBackgroundProcessing({
      type, uploadId, organizationId: organization_id, userId: user_id, buffer, filename,
    });

    return reply.code(202).send({
      success: true,
      data: {
        upload_id: uploadId,
        status:    'accepted',
        filename,
        message:   'Upload accepted — processing in background',
      },
    });
  }

  fastify.post(
    '/inventory',
    { preHandler: [authenticate, requireRole('manager')] },
    (request, reply) => _acceptUpload({ type: 'inventory', request, reply }),
  );

  fastify.post(
    '/orders',
    { preHandler: [authenticate, requireRole('manager')] },
    (request, reply) => _acceptUpload({ type: 'orders', request, reply }),
  );

  // Status polling endpoint. Frontend hits this every ~2s while the
  // upload is in `accepted` or `processing` state. Returns the
  // canonical job row + a derived `phase` field the UI can switch on
  // ('accepted' | 'processing' | 'writing' | 'refreshing' | 'complete' | 'failed').
  fastify.get(
    '/status/:upload_id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const uploadId = String(request.params.upload_id || '').trim();
      if (!uploadId) {
        return reply.code(400).send({ success: false, error: 'Missing upload_id' });
      }

      try {
        const job = await uploadsService.getStatus(request.user.organization_id, uploadId);
        if (!job) {
          return reply.code(404).send({ success: false, error: 'Upload not found' });
        }

        // Derive phase for the UI. The terminal status fields
        // (success/partial/failed) are taken at face value; the
        // intermediate states get further-decomposed using
        // refreshed_at so the UI can distinguish "writes finished,
        // analytics refreshing" from "still writing."
        let phase;
        switch (job.status) {
          case 'accepted':   phase = 'accepted';   break;
          case 'processing': phase = 'processing'; break;
          case 'success':
          case 'partial':
            phase = job.refreshed_at ? 'complete' : 'refreshing';
            break;
          case 'failed':     phase = 'failed';     break;
          default:           phase = job.status;
        }

        return reply.send({
          success: true,
          data: { ...job, phase },
        });
      } catch (err) {
        request.log.error({ err }, 'Upload status lookup failed');
        return reply.code(500).send({ success: false, error: 'Failed to read upload status' });
      }
    },
  );

  fastify.get(
    '/history',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const type = ['inventory', 'orders', ''].includes(request.query.type ?? '')
        ? (request.query.type ?? '')
        : '';
      try {
        const data = await uploadsService.getHistory(request.user.organization_id, type);
        return reply.send({ success: true, data });
      } catch (err) {
        request.log.error({ err }, 'Upload history error');
        return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
      }
    }
  );

  // Download the per-upload plain-text summary report. Returned as
  // attachment so the browser triggers a save dialog. Org-scoped: a user
  // can only download reports for uploads in their current organization.
  fastify.get(
    '/report/:upload_id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const uploadId = request.params.upload_id;
      try {
        const row = await uploadsService.getReport(request.user.organization_id, uploadId);
        if (!row) {
          return reply.code(404).send({ success: false, error: 'Upload not found in your organization' });
        }
        const text = row.report || `No report available for this upload.\n`;
        const safeName = (row.filename || `upload_${uploadId}`)
          .replace(/\.(tsv|txt|csv)$/i, '')
          .replace(/[^a-zA-Z0-9._-]+/g, '_');
        const reportName = `${safeName}_report.txt`;

        reply.header('Content-Type', 'text/plain; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${reportName}"`);
        return reply.send(text);
      } catch (err) {
        request.log.error({ err }, 'Upload report error');
        return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
      }
    }
  );

  // Template downloads — tab-delimited .txt files matching the upload format.
  fastify.get(
    '/template/:type',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { type } = request.params;

      const templates = {
        // uid is the canonical row tracker. For Add: leave blank — system
        // assigns one. For Update / Remove: paste the existing row's uid
        // (copy from the Inventory table or a previous export).
        inventory: [
          'action,uid,sku,upc,quantity,part_number,box_number,date_added,notes',
          'Add,,SKU-001,012345678901,25,PT-123,BX-001,2026-05-11,Sample item',
          'Add,,SKU-002,098765432109,10,,,2026-05-11,',
          'Update,UID-FROM-EXPORT,,,30,,,,',
          'Remove,UID-FROM-EXPORT,,,,,,, ',
        ].join('\r\n'),
        // Orders template — 8 columns:
        //   action, uid, order_id, order_date, sku, quantity_sold, platform, shipped_sku
        //
        //   uid          — INTERNAL row tracker. Leave blank on Add (auto-assigned);
        //                  paste from a previous export for Update / Remove.
        //   order_id     — EXTERNAL marketplace order number (Amazon order ID,
        //                  eBay sale ID, etc.). Required on Add.
        //   shipped_sku  — Fulfillment override. Accepts three forms:
        //                  "20" or "ARA20"  → same-part box override
        //                  "ARA20-4060915-037256018282"
        //                                  → full alternate SKU (wrong-part allowed)
        //                  blank           → no override
        //                  Legacy header `shipped_from_box` is still accepted.
        orders: [
          'action,uid,order_id,order_date,sku,quantity_sold,platform,shipped_sku',
          'Add,,111-2222222-3333333,2026-05-11,SKU-001,2,Amazon,BX-001',
          'Add,,EBAY-9876543210,2026-05-11,SKU-002,1,eBay,',
          'Update,UID-FROM-EXPORT,,,,3,,',
          'Remove,UID-FROM-EXPORT,,,,,,',
        ].join('\r\n'),
      };

      if (!templates[type]) {
        return reply.code(404).send({ success: false, error: 'Unknown template type' });
      }

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${type}_template.csv"`)
        .send('﻿' + templates[type]);
    }
  );
}
