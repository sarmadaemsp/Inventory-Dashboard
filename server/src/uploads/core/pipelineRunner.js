import { randomUUID } from 'crypto';
import { parseTxtStream } from './txtStreamParser.js';
import { AppError } from '../../utils/errors.js';

// ============================================================
// Feed-based CRUD upload pipeline.
// ------------------------------------------------------------
// Phases:
//   1. Stream all rows into adds / updates / removes buckets.
//   2. Fetch the existing key set for the affected keys.
//   3. Validate each row against the key set.
//   4. Execute operations.
//      - Adds:    GCS NDJSON staging + BigQuery LOAD JOB        (Phase B)
//                 Falls back to DML chunks if storage isn't wired.
//      - Updates: chunked MERGE (DML).
//      - Removes: chunked DELETE (DML).
//   5. Optionally log the upload row (legacy callers only).
//
// Phase A async lifecycle (2026-05-18): when an `uploadId` is supplied
// by the caller, pipelineRunner uses it as the row identifier and
// SKIPS the final logUpload INSERT — the caller has already created an
// `accepted` row via uploadsRepo.createUploadJob and is responsible for
// finalizing the terminal status afterwards. When no `uploadId` is
// supplied, the runner falls back to the legacy self-insert path.
//
// Phase B GCS+LOAD JOB ingest (2026-05-18): when `storageService` is
// supplied AND `storageService.enabled === true`, the Add path takes
// the LOAD-JOB shortcut:
//   parsed rows → NDJSON → GCS → BigQuery LOAD JOB → done.
// 100k-row latency drops from ~5 min (DML chunks) to ~10-15s.
// 17k rows drops from ~30s to ~3s.
//
// Every phase records its duration. On completion the runner returns
// a `timings` object so the calling route can emit one structured log
// line for end-to-end visibility (the user's explicit ask: "exact
// bottleneck visibility").
// ============================================================

// DML chunk sizes — only used when LOAD JOB isn't available or for
// Update/Remove operations (LOAD JOB can't do partial updates).
const CHUNK_SIZE_ADD    = 500;
const CHUNK_SIZE_UPDATE = 500;
const CHUNK_SIZE_REMOVE = 10000;
const MAX_ERRORS = 200;

export async function runUploadPipeline({
  importer, uploadsRepo, organizationId, userId, stream, filename,
  uploadId: existingUploadId = null,
  storageService = null,
  logger = null,
}) {
  const { schema } = importer;
  const t0 = Date.now();
  const timings = {};

  const adds    = []; // [{ row, lineNum }]
  const updates = [];
  const removes = [];
  const errors  = [];
  let   failed  = 0;

  // ── Phase 1: parse ────────────────────────────────────────────────────────
  const tParseStart = Date.now();
  for await (const event of parseTxtStream(stream)) {
    if (event.type === 'headers') {
      if (schema.required.length) {
        const missing = schema.required.filter(col => !event.headers.includes(col));
        if (missing.length) {
          throw new AppError(400, `TXT missing required columns: ${missing.join(', ')}`);
        }
      }
      continue;
    }

    const { lineNum, raw } = event;
    const result = schema.buildRow(raw, organizationId, lineNum);

    if (result.error) {
      failed++;
      if (errors.length < MAX_ERRORS) errors.push(result.error);
      continue;
    }

    if      (result.action === 'Add')    adds.push({ row: result.row, lineNum });
    else if (result.action === 'Update') updates.push({ row: result.row, lineNum });
    else if (result.action === 'Remove') removes.push({ row: result.row, lineNum });
  }
  timings.parse_ms = Date.now() - tParseStart;

  const totalParsed = adds.length + updates.length + removes.length;
  if (totalParsed === 0 && failed === 0) {
    throw new AppError(400, 'No data rows found in file');
  }

  // ── Phase 2: key-set fetch ───────────────────────────────────────────────
  const tKeyStart = Date.now();
  const addKeys    = adds.map(({ row }) => importer.getKey(row));
  const updateKeys = updates.map(({ row }) => importer.getKey(row));
  const removeKeys = removes.map(({ row }) => importer.getKey(row));
  const allKeys    = [...new Set([...addKeys, ...updateKeys, ...removeKeys])];
  const existingKeys = await importer.fetchKeySet(uploadsRepo, organizationId, allKeys);
  timings.key_fetch_ms = Date.now() - tKeyStart;

  // ── Phase 3: validate ────────────────────────────────────────────────────
  const tValidateStart = Date.now();
  const validAdds    = [];
  const validUpdates = [];
  const validRemoves = [];

  for (const { row, lineNum } of adds) {
    const key = importer.getKey(row);
    if (existingKeys.has(key)) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({ row: lineNum, field: importer.keyField, reason: `${key} already exists — use action Update to modify` });
      }
    } else {
      validAdds.push(row);
    }
  }

  for (const { row, lineNum } of updates) {
    const key = importer.getKey(row);
    if (!existingKeys.has(key)) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({ row: lineNum, field: importer.keyField, reason: `${key} not found — use action Add to create it` });
      }
    } else {
      validUpdates.push({ row, lineNum });
    }
  }

  for (const { row, lineNum } of removes) {
    const key = importer.getKey(row);
    if (!existingKeys.has(key)) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({ row: lineNum, field: importer.keyField, reason: `${key} not found` });
      }
    } else {
      validRemoves.push({ key, lineNum });
    }
  }
  timings.validate_ms = Date.now() - tValidateStart;

  // ── Phase 4: execute ─────────────────────────────────────────────────────
  let added = 0, updated = 0, removed = 0;
  let addPath = 'none'; // 'load_job' | 'dml_fallback' | 'none'

  function _recordFailures(failureList, lineByKey) {
    for (const f of failureList) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({
          row:    lineByKey.get(f.key) ?? null,
          field:  importer.keyField,
          reason: f.reason,
        });
      }
    }
  }

  // Phase B Add path: GCS NDJSON + BigQuery LOAD JOB.
  // Only used when storageService is enabled AND we have rows to add.
  // Any failure falls back to the DML chunked path — same correctness,
  // slower. The fallback is the safety net for: GCS bucket missing,
  // network blip during upload, LOAD JOB rejection on schema mismatch.
  const tAddsStart = Date.now();
  if (validAdds.length > 0 && storageService?.enabled) {
    const uploadIdForKey = existingUploadId || randomUUID();
    const gcsKey = `uploads/${uploadIdForKey}/${importer.type}-adds.ndjson`;
    let sourceUri = null;
    try {
      const tStageStart = Date.now();
      sourceUri = await storageService.uploadNdjson({ key: gcsKey, rows: validAdds });
      timings.gcs_stage_ms = Date.now() - tStageStart;

      const tLoadStart = Date.now();
      const loadResult = await importer.loadFromGcsBatch(uploadsRepo, sourceUri);
      timings.load_job_ms = Date.now() - tLoadStart;
      timings.load_job_bytes = loadResult.bytes;

      // LOAD JOB reports `outputRows` — use it as the source of truth.
      // If for any reason BQ reports zero but we sent rows, trust our
      // sent count rather than under-counting in the report.
      added = loadResult.rows_added > 0 ? loadResult.rows_added : validAdds.length;
      addPath = 'load_job';

      logger?.info?.(
        {
          event: 'upload_load_job_complete',
          type:  importer.type,
          rows:  added,
          bytes: loadResult.bytes,
          gcs_stage_ms: timings.gcs_stage_ms,
          load_job_ms:  timings.load_job_ms,
          upload_id:    uploadIdForKey,
        },
        'LOAD JOB ingest complete',
      );
    } catch (err) {
      logger?.warn?.(
        { event: 'upload_load_job_failed', type: importer.type, err: err?.message, upload_id: uploadIdForKey },
        'LOAD JOB failed — falling back to DML chunked ingest',
      );
      // Fall back to DML chunks. The DML path is unchanged from
      // pre-Phase-B so correctness is preserved; the user just gets
      // the slower experience.
      added = 0;
      for (let i = 0; i < validAdds.length; i += CHUNK_SIZE_ADD) {
        const chunk = validAdds.slice(i, i + CHUNK_SIZE_ADD);
        await importer.addBatch(uploadsRepo, chunk);
        added += chunk.length;
      }
      addPath = 'dml_fallback';
    } finally {
      // Cleanup the staged NDJSON object. Best-effort — bucket
      // lifecycle policy is the real safety net.
      if (sourceUri) {
        storageService.deleteObject({ key: gcsKey }).catch(() => {});
      }
    }
  } else if (validAdds.length > 0) {
    // GCS not configured — pure DML path.
    for (let i = 0; i < validAdds.length; i += CHUNK_SIZE_ADD) {
      const chunk = validAdds.slice(i, i + CHUNK_SIZE_ADD);
      await importer.addBatch(uploadsRepo, chunk);
      added += chunk.length;
    }
    addPath = 'dml_no_gcs';
  }
  timings.adds_ms = Date.now() - tAddsStart;

  // Updates: stay on DML MERGE (LOAD JOB can't do partial updates).
  const tUpdatesStart = Date.now();
  for (let i = 0; i < validUpdates.length; i += CHUNK_SIZE_UPDATE) {
    const chunk = validUpdates.slice(i, i + CHUNK_SIZE_UPDATE);
    const lineByKey = new Map(chunk.map(({ row, lineNum }) => [importer.getKey(row), lineNum]));
    const { failures = [] } = (await importer.updateBatch(uploadsRepo, organizationId, chunk.map(c => c.row))) ?? {};
    updated += chunk.length - failures.length;
    _recordFailures(failures, lineByKey);
  }
  timings.updates_ms = Date.now() - tUpdatesStart;

  // Removes: stay on DML DELETE.
  const tRemovesStart = Date.now();
  for (let i = 0; i < validRemoves.length; i += CHUNK_SIZE_REMOVE) {
    const chunk = validRemoves.slice(i, i + CHUNK_SIZE_REMOVE);
    const lineByKey = new Map(chunk.map(({ key, lineNum }) => [key, lineNum]));
    const { failures = [] } = (await importer.removeBatch(uploadsRepo, organizationId, chunk.map(c => c.key))) ?? {};
    removed += chunk.length - failures.length;
    _recordFailures(failures, lineByKey);
  }
  timings.removes_ms = Date.now() - tRemovesStart;

  if (added + updated + removed === 0 && failed === 0) {
    throw new AppError(400, 'No valid rows to process');
  }

  const successCount = added + updated + removed;
  const status = (successCount === 0 && failed > 0) ? 'failed'
               : (failed > 0)                       ? 'partial'
               :                                      'success';

  const uploadId = existingUploadId || randomUUID();
  const report   = _buildReportText({
    filename, type: importer.type, status,
    added, updated, removed, failed, errors,
    timestamp: new Date(),
  });

  // Legacy path: when no uploadId was supplied, do the final
  // self-insert so direct-script callers still get an audit row.
  if (!existingUploadId) {
    await importer.logUpload(uploadsRepo, {
      uploadId,
      organizationId,
      userId,
      filename: filename || `${importer.type}.txt`,
      rowCount: successCount,
      status,
      report,
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[pipelineRunner] logUpload failed (non-fatal):', err?.message ?? err);
    });
  }

  timings.total_ms = Date.now() - t0;
  timings.add_path = addPath;

  // One structured log line capturing the entire pipeline shape.
  // Lets the operator pin down which phase is the bottleneck.
  logger?.info?.(
    {
      event:       'upload_pipeline_complete',
      type:        importer.type,
      upload_id:   uploadId,
      added, updated, removed, failed,
      ...timings,
    },
    'Upload pipeline complete',
  );

  return { upload_id: uploadId, added, updated, removed, failed, errors, filename, status, report, timings };
}

// Human-readable plain-text summary stored with each upload and downloadable
// from the Upload History UI. Truncates the errors list to MAX_ERRORS.
function _buildReportText({ filename, type, status, added, updated, removed, failed, errors, timestamp }) {
  const total = added + updated + removed + failed;
  const lines = [
    'PATMAN UPLOAD SUMMARY',
    '='.repeat(60),
    '',
    `File:       ${filename || `${type}.txt`}`,
    `Type:       ${type}`,
    `Date (UTC): ${timestamp.toISOString().replace('T', ' ').slice(0, 19)}`,
    `Status:     ${status.toUpperCase()}`,
    '',
    'RESULT',
    '-'.repeat(60),
    `  Added:    ${added.toLocaleString().padStart(8)}`,
    `  Updated:  ${updated.toLocaleString().padStart(8)}`,
    `  Removed:  ${removed.toLocaleString().padStart(8)}`,
    `  Failed:   ${failed.toLocaleString().padStart(8)}`,
    `  ----------------`,
    `  Total:    ${total.toLocaleString().padStart(8)}`,
    '',
  ];

  if (errors.length) {
    lines.push('ERRORS');
    lines.push('-'.repeat(60));
    for (const e of errors) {
      const field = e.field ? `[${e.field}]` : '';
      const val   = e.value !== undefined && e.value !== '' ? ` (value: "${e.value}")` : '';
      lines.push(`  Row ${String(e.row ?? '?').padStart(5)}  ${field.padEnd(18)} ${e.reason}${val}`);
    }
    if (failed > errors.length) {
      lines.push(`  ...and ${(failed - errors.length).toLocaleString()} more errors not shown (limit ${MAX_ERRORS}).`);
    }
    lines.push('');
  }

  lines.push('-'.repeat(60));
  lines.push('Generated by Patman Inventory.');
  return lines.join('\n');
}
