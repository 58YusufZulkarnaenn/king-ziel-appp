import { createHash } from 'node:crypto';

export function cleanHeader(value, index) {
  const label = String(value ?? '').replace(/\u00a0/g, ' ').trim();
  return label || `Kolom ${index + 1}`;
}

export function makeUniqueHeaders(values) {
  const used = new Set();
  return values.map((value, index) => {
    const base = cleanHeader(value, index);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase('id-ID'))) {
      candidate = `${base} (${suffix++})`;
    }
    used.add(candidate.toLocaleLowerCase('id-ID'));
    return candidate;
  });
}

export function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function getSchemaHash(headers) {
  const canonicalHeaders = headers
    .map(header => String(header).trim().toLocaleLowerCase('id-ID'))
    .sort((a, b) => a.localeCompare(b, 'id'));
  return sha256(JSON.stringify(canonicalHeaders));
}

export function makeRecordData(headers, row) {
  const data = {};
  headers.forEach((header, index) => {
    data[header] = normalizeCell(Array.isArray(row) ? row[index] : '');
  });
  return data;
}

export function getRowHash(headers, data) {
  const canonical = headers
    .map(header => [
      String(header).trim().toLocaleLowerCase('id-ID'),
      normalizeCell(data[header])
    ])
    .sort((a, b) => a[0].localeCompare(b[0], 'id'));
  return sha256(JSON.stringify(canonical));
}

export function makeSearchText(data) {
  return Object.values(data).map(normalizeCell).filter(Boolean).join(' ');
}

export function slugify(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `dataset-${Date.now()}`;
}

export function safeInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
