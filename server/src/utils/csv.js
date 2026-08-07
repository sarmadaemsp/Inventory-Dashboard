// Lightweight RFC 4180 CSV parser — no dependencies.
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = splitRow(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitRow(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx]?.trim() ?? ''; });
    rows.push(row);
  }

  return { headers, rows };
}

function splitRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
