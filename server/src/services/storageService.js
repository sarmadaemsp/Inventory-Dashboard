// ============================================================
// storageService — GCS wrapper for upload staging (Phase B, 2026-05-18)
// ------------------------------------------------------------
// Phase B replaces the 200-chunk DML INSERT loop for inventory /
// orders Add operations with a single BigQuery LOAD JOB. The data
// path is:
//
//   parsed rows in memory
//     → newline-delimited JSON
//     → uploaded to gs://${UPLOAD_BUCKET}/uploads/${uploadId}/${type}.ndjson
//     → BigQuery LOAD JOB ingests in seconds
//     → object deleted (best-effort cleanup)
//
// Why: 100k Add rows via DML chunks take ~5 minutes (200 × ~1.5s).
// A single LOAD JOB ingests the same volume in ~10-15s including
// staging time. 17k rows drops from minutes to ~3 seconds.
//
// Fail-soft: when UPLOAD_BUCKET isn't configured (operator hasn't
// created the bucket yet, or local dev), `enabled` stays false and
// the upload pipeline falls back to the existing DML chunked path.
// Same correctness, just slower. The system ships and works
// immediately; speed unlocks the moment the operator sets the env.
// ============================================================

export function createStorageService({ bucketName, projectId, logger }) {
  const enabled = !!bucketName;
  let _client = null;
  let _bucket = null;

  async function _getBucket() {
    if (_bucket) return _bucket;
    if (!enabled) throw new Error('UPLOAD_BUCKET not configured');
    const mod = await import('@google-cloud/storage');
    _client = new mod.Storage({ projectId });
    _bucket = _client.bucket(bucketName);
    return _bucket;
  }

  // Upload an array of row objects as newline-delimited JSON.
  // Returns the GCS URI (gs://bucket/key) on success — the BigQuery
  // LOAD JOB consumes this URI directly. Stream-writes the NDJSON
  // instead of buffering into a single string so 100k rows don't
  // double-allocate memory.
  async function uploadNdjson({ key, rows }) {
    if (!enabled) throw new Error('UPLOAD_BUCKET not configured');
    if (!rows?.length) return null;

    const bucket = await _getBucket();
    const file = bucket.file(key);

    // Construct NDJSON in chunks so a 100k-row 30MB payload doesn't
    // sit as one giant string in V8 heap before going to the wire.
    const start = Date.now();
    await new Promise((resolve, reject) => {
      const stream = file.createWriteStream({
        contentType: 'application/x-ndjson',
        resumable: false,           // small payloads — resumable adds latency
        gzip: true,                  // ~10x size reduction for JSON
        metadata: { metadata: { source: 'patman-upload', row_count: String(rows.length) } },
      });
      stream.on('error', reject);
      stream.on('finish', resolve);

      // Batch lines to limit string allocation churn (256 rows ≈ ~50KB).
      const BATCH = 256;
      let i = 0;
      function _writeNext() {
        while (i < rows.length) {
          const end  = Math.min(i + BATCH, rows.length);
          let chunk  = '';
          for (let j = i; j < end; j++) chunk += JSON.stringify(rows[j]) + '\n';
          i = end;
          if (!stream.write(chunk)) {
            stream.once('drain', _writeNext);
            return;
          }
        }
        stream.end();
      }
      _writeNext();
    });
    logger?.info?.(
      { event: 'gcs_ndjson_uploaded', key, rows: rows.length, duration_ms: Date.now() - start },
      'NDJSON staged to GCS',
    );
    return `gs://${bucketName}/${key}`;
  }

  async function deleteObject({ key }) {
    if (!enabled) return;
    try {
      const bucket = await _getBucket();
      await bucket.file(key).delete({ ignoreNotFound: true });
    } catch (err) {
      // Best-effort cleanup. Object lifecycle policy on the bucket
      // should auto-delete `uploads/*` after 24h as a safety net.
      logger?.warn?.(
        { event: 'gcs_delete_failed', key, err: err?.message },
        'GCS object cleanup failed — relies on bucket lifecycle policy',
      );
    }
  }

  return { enabled, uploadNdjson, deleteObject };
}
