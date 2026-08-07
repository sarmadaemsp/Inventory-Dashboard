import { createInterface } from 'readline';
import { AppError } from '../../utils/errors.js';

const DEFAULT_MAX_ROWS = 100_000;

/**
 * Parses a UTF-8 tab-delimited TXT stream.
 * Yields { type:'headers', headers } then { type:'row', lineNum, raw } for each data row.
 * Throws AppError(400) if the row limit is exceeded.
 */
export async function* parseTxtStream(stream, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers  = null;
  let lineNum  = 0;
  let dataRows = 0;

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;

    const cells = line.split('\t').map(c => c.trim());

    if (!headers) {
      headers = cells.map(h => h.toLowerCase().replace(/\s+/g, '_'));
      yield { type: 'headers', headers, lineNum };
      continue;
    }

    dataRows++;
    if (dataRows > maxRows) {
      throw new AppError(400, `File exceeds ${maxRows.toLocaleString()} row limit`);
    }

    const raw = {};
    headers.forEach((h, i) => { raw[h] = cells[i] ?? ''; });

    yield { type: 'row', lineNum, raw };
  }
}
