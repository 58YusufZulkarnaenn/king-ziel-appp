import { Pool } from 'pg';
import { getConnectionString } from '@netlify/database';
import {
  getRowHash,
  getSchemaHash,
  makeRecordData,
  makeSearchText,
  safeInteger,
  slugify
} from './lib/import-utils.mjs';

let pool;

function databasePool() {
  if (pool) return pool;
  const connectionString = process.env.NETLIFY_DB_URL || getConnectionString();
  if (!connectionString) throw new Error('Database belum terhubung. Aktifkan Netlify Database di project ini.');
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  return pool;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status < 500 ? (error?.message || 'Request tidak valid.') : 'Server gagal memproses request. Periksa log Netlify Functions.';
  return json({ error: message, code: error?.code || 'INTERNAL_ERROR' }, status);
}

function httpError(message, status = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError('Body request bukan JSON yang valid.');
  }
}

function checkAccess(request) {
  const requiredKey = process.env.APP_ACCESS_KEY;
  if (!requiredKey) return;
  const suppliedKey = request.headers.get('x-app-key') || '';
  if (suppliedKey !== requiredKey) {
    throw httpError('Kunci akses aplikasi belum benar.', 401, 'ACCESS_KEY_REQUIRED');
  }
}

function validateHeaders(headers) {
  if (!Array.isArray(headers) || headers.length < 1 || headers.length > 120) {
    throw httpError('File harus memiliki 1 sampai 120 kolom.');
  }
  const cleaned = headers.map((value, index) => String(value ?? '').replace(/\u00a0/g, ' ').trim() || `Kolom ${index + 1}`);
  const normalized = cleaned.map(value => value.toLocaleLowerCase('id-ID'));
  if (new Set(normalized).size !== normalized.length) {
    throw httpError('Ada nama kolom yang duplikat. Periksa judul kolom Excel terlebih dahulu.');
  }
  return cleaned;
}

function validateMatchColumns(matchColumns, headers) {
  if (!Array.isArray(matchColumns)) throw httpError('Pilihan kolom pencocokan tidak valid.');
  const cleaned = [...new Set(matchColumns.map(value => String(value)))];
  if (cleaned.length > 8) throw httpError('Maksimal 8 kolom dapat digunakan sebagai kunci pencocokan.');
  for (const name of cleaned) {
    if (!headers.includes(name)) throw httpError(`Kolom pencocokan "${name}" tidak ditemukan dalam file.`);
  }
  return cleaned;
}

function keySql(matchColumns, firstParameter = 3, recordAlias = 'r', stagedAlias = 'c') {
  if (!matchColumns.length) return null;
  const params = matchColumns.map((_, index) => `$${firstParameter + index}`);
  const hasKey = params.map(parameter => `NULLIF(BTRIM(COALESCE(${stagedAlias}.row_data ->> ${parameter}, '')), '') IS NOT NULL`).join(' AND ');
  const keyValue = `jsonb_build_array(${params.map(parameter => `COALESCE(${stagedAlias}.row_data ->> ${parameter}, '')`).join(', ')})`;
  const match = params.map(parameter => `COALESCE(${recordAlias}.data ->> ${parameter}, '') = COALESCE(${stagedAlias}.row_data ->> ${parameter}, '')`).join(' AND ');
  return { params, hasKey, keyValue, match };
}

async function getBatch(client, importId, lock = false) {
  const result = await client.query(
    `SELECT b.*, d.name AS dataset_name
       FROM import_batches b
       JOIN datasets d ON d.id = b.dataset_id
      WHERE b.id = $1
      ${lock ? 'FOR UPDATE OF b' : ''}`,
    [importId]
  );
  if (!result.rows[0]) throw httpError('Sesi import tidak ditemukan.', 404, 'IMPORT_NOT_FOUND');
  return result.rows[0];
}

async function calculatePreview(client, batch, requestedKeys = null) {
  const headers = Array.isArray(batch.headers) ? batch.headers : [];
  const keys = validateMatchColumns(
    requestedKeys === null ? (Array.isArray(batch.match_columns) ? batch.match_columns : []) : requestedKeys,
    headers
  );
  const totals = await client.query(
    `SELECT COUNT(*)::int AS total_rows,
            COUNT(DISTINCT (schema_hash, row_hash))::int AS unique_rows
       FROM import_staging_rows
      WHERE import_id = $1`,
    [batch.id]
  );
  const totalRows = totals.rows[0]?.total_rows || 0;
  const uniqueRows = totals.rows[0]?.unique_rows || 0;
  const duplicatesInFile = Math.max(0, totalRows - uniqueRows);

  const exactResult = await client.query(
    `WITH distinct_rows AS (
       SELECT DISTINCT ON (schema_hash, row_hash) schema_hash, row_hash
         FROM import_staging_rows
        WHERE import_id = $1
        ORDER BY schema_hash, row_hash, row_number
     )
     SELECT COUNT(*)::int AS count
       FROM distinct_rows s
       JOIN customer_records r
         ON r.dataset_id = $2
        AND r.schema_hash = s.schema_hash
        AND r.row_hash = s.row_hash`,
    [batch.id, batch.dataset_id]
  );
  const exactDuplicatesExisting = exactResult.rows[0]?.count || 0;

  let updateCandidates = 0;
  let newCandidates = Math.max(0, uniqueRows - exactDuplicatesExisting);
  let ambiguousIncoming = 0;
  let ambiguousExisting = 0;

  if (keys.length && uniqueRows > exactDuplicatesExisting) {
    const expressions = keySql(keys, 3, 'r', 'c');
    const query = `
      WITH distinct_rows AS (
        SELECT DISTINCT ON (schema_hash, row_hash)
               row_number, row_data, search_text, schema_hash, row_hash
          FROM import_staging_rows
         WHERE import_id = $1
         ORDER BY schema_hash, row_hash, row_number
      ), candidates AS (
        SELECT c.*,
               (${expressions.hasKey}) AS has_key,
               ${expressions.keyValue} AS key_value
          FROM distinct_rows c
         WHERE NOT EXISTS (
           SELECT 1 FROM customer_records exact_record
            WHERE exact_record.dataset_id = $2
              AND exact_record.schema_hash = c.schema_hash
              AND exact_record.row_hash = c.row_hash
         )
      ), key_counts AS (
        SELECT key_value, COUNT(*)::int AS source_count
          FROM candidates
         WHERE has_key
         GROUP BY key_value
      ), match_counts AS (
        SELECT c.row_hash, c.has_key,
               COALESCE(k.source_count, 1)::int AS source_count,
               COUNT(r.id)::int AS db_count
          FROM candidates c
          LEFT JOIN key_counts k ON c.has_key AND k.key_value = c.key_value
          LEFT JOIN customer_records r
            ON c.has_key
           AND r.dataset_id = $2
           AND ${expressions.match}
         GROUP BY c.row_hash, c.has_key, k.source_count
      )
      SELECT
        COUNT(*) FILTER (WHERE source_count > 1)::int AS ambiguous_incoming,
        COUNT(*) FILTER (WHERE source_count = 1 AND db_count > 1)::int AS ambiguous_existing,
        COUNT(*) FILTER (WHERE source_count = 1 AND db_count = 1)::int AS updates,
        COUNT(*) FILTER (WHERE source_count = 1 AND db_count = 0)::int AS new_rows
      FROM match_counts`;
    const result = await client.query(query, [batch.id, batch.dataset_id, ...keys]);
    const row = result.rows[0] || {};
    ambiguousIncoming = row.ambiguous_incoming || 0;
    ambiguousExisting = row.ambiguous_existing || 0;
    updateCandidates = row.updates || 0;
    newCandidates = row.new_rows || 0;
  }

  const preview = {
    totalRows,
    uniqueRows,
    duplicatesInFile,
    exactDuplicatesExisting,
    updateCandidates,
    newCandidates,
    ambiguousIncoming,
    ambiguousExisting,
    matchColumns: keys,
    canCommit: ambiguousIncoming === 0 && ambiguousExisting === 0
  };
  await client.query(
    `UPDATE import_batches SET match_columns = $2::jsonb, preview = $3::jsonb
      WHERE id = $1`,
    [batch.id, JSON.stringify(keys), JSON.stringify(preview)]
  );
  return preview;
}

async function startImport(client, payload) {
  let headers = validateHeaders(payload.headers);
  const originalHeaders = [...headers];
  const totalRows = safeInteger(payload.totalRows, 0, 0, 2_000_000);
  const fileName = String(payload.fileName || 'master-data.xlsx').slice(0, 240);
  const datasetName = String(payload.datasetName || '').trim().slice(0, 100);
  if (!fileName) throw httpError('Nama file tidak ditemukan.');

  let dataset;
  if (payload.datasetId) {
    const found = await client.query('SELECT * FROM datasets WHERE id = $1', [payload.datasetId]);
    if (!found.rows[0]) throw httpError('Dataset yang dipilih tidak ditemukan.', 404, 'DATASET_NOT_FOUND');
    dataset = found.rows[0];
    const existingHeaders = Array.isArray(dataset.headers) ? dataset.headers : [];
    const canonical = new Map(existingHeaders.map(header => [String(header).toLocaleLowerCase('id-ID'), String(header)]));
    headers = validateHeaders(headers.map(header => canonical.get(header.toLocaleLowerCase('id-ID')) || header));
  } else {
    if (!datasetName) throw httpError('Nama dataset baru wajib diisi.');
    const slug = slugify(datasetName);
    const slugExists = await client.query('SELECT name FROM datasets WHERE slug = $1', [slug]);
    if (slugExists.rows[0]) {
      throw httpError(`Database "${slugExists.rows[0].name}" sudah ada. Pilih database tersebut dari daftar tujuan, atau gunakan nama kategori lain.`, 409, 'DATASET_ALREADY_EXISTS');
    }
    const created = await client.query(
      `INSERT INTO datasets (name, slug, headers)
       VALUES ($1, $2, '[]'::jsonb)
       RETURNING *`,
      [datasetName, slug]
    );
    dataset = created.rows[0];
  }

  const batch = await client.query(
    `INSERT INTO import_batches (dataset_id, file_name, headers, total_rows, status)
     VALUES ($1, $2, $3::jsonb, $4, 'uploading')
     RETURNING id, dataset_id, total_rows, status`,
    [dataset.id, fileName, JSON.stringify(headers), totalRows]
  );
  const headerMap = Object.fromEntries(originalHeaders.map((header, index) => [header, headers[index]]));
  return { ...batch.rows[0], datasetName: dataset.name, headers, headerMap };
}

async function addChunk(client, importId, payload) {
  const batch = await getBatch(client, importId);
  if (batch.status !== 'uploading') throw httpError('Sesi import ini tidak sedang menerima data.', 409, 'IMPORT_NOT_OPEN');
  if (!Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > 350) {
    throw httpError('Setiap potongan import harus berisi 1 sampai 350 baris.');
  }
  const rowStart = safeInteger(payload.rowStart, 1, 1, 2_000_000);
  const headers = Array.isArray(batch.headers) ? batch.headers : [];
  const schemaHash = getSchemaHash(headers);
  const values = [];
  const groups = [];
  let parameterIndex = 1;

  payload.rows.forEach((row, index) => {
    const data = makeRecordData(headers, row);
    if (!Object.values(data).some(value => value !== '')) return;
    const rowHash = getRowHash(headers, data);
    const searchText = makeSearchText(data);
    const rowNumber = rowStart + index;
    groups.push(`($${parameterIndex++}, $${parameterIndex++}, $${parameterIndex++}::jsonb, $${parameterIndex++}, $${parameterIndex++}, $${parameterIndex++})`);
    values.push(importId, rowNumber, JSON.stringify(data), searchText, schemaHash, rowHash);
  });

  if (!groups.length) return { inserted: 0, stagedRows: batch.staged_rows };
  const inserted = await client.query(
    `INSERT INTO import_staging_rows
       (import_id, row_number, row_data, search_text, schema_hash, row_hash)
     VALUES ${groups.join(', ')}
     ON CONFLICT (import_id, row_number) DO NOTHING`,
    values
  );
  if (inserted.rowCount) {
    await client.query(
      'UPDATE import_batches SET staged_rows = staged_rows + $2 WHERE id = $1',
      [importId, inserted.rowCount]
    );
  }
  return { inserted: inserted.rowCount || 0 };
}

async function commitImport(poolInstance, importId) {
  const client = await poolInstance.connect();
  try {
    await client.query('BEGIN');
    const batch = await getBatch(client, importId, true);
    await client.query('SELECT id FROM datasets WHERE id = $1 FOR UPDATE', [batch.dataset_id]);
    if (batch.status !== 'uploading' && batch.status !== 'previewed') {
      throw httpError('Import ini tidak dalam status yang bisa diproses.', 409, 'IMPORT_NOT_READY');
    }
    const stagedCount = await client.query(
      'SELECT COUNT(*)::int AS count FROM import_staging_rows WHERE import_id = $1',
      [importId]
    );
    if (!stagedCount.rows[0].count) throw httpError('Tidak ada baris data yang berhasil diterima.');
    const preview = await calculatePreview(client, batch);
    if (!preview.canCommit) {
      await client.query('ROLLBACK');
      return { blocked: true, preview };
    }

    const keys = preview.matchColumns;
    let updatedRows = 0;
    if (keys.length) {
      const expressions = keySql(keys, 3, 'r', 'c');
      const updateResult = await client.query(
        `WITH distinct_rows AS (
           SELECT DISTINCT ON (schema_hash, row_hash)
                  row_data, search_text, schema_hash, row_hash, row_number
             FROM import_staging_rows
            WHERE import_id = $1
            ORDER BY schema_hash, row_hash, row_number
         ), candidates AS (
           SELECT c.* FROM distinct_rows c
            WHERE NOT EXISTS (
              SELECT 1 FROM customer_records e
               WHERE e.dataset_id = $2
                 AND e.schema_hash = c.schema_hash
                 AND e.row_hash = c.row_hash
            )
         ), targets AS (
           SELECT r.id, r.data AS old_data, r.search_text AS old_search_text,
                  r.schema_hash AS old_schema_hash, r.row_hash AS old_row_hash,
                  r.last_import_id AS old_last_import_id,
                  c.row_data AS next_data,
                  c.schema_hash AS next_schema_hash, c.row_hash AS next_row_hash
             FROM customer_records r
             JOIN candidates c ON ${expressions.match}
            WHERE r.dataset_id = $2
              AND (${expressions.hasKey})
         ), logged AS (
           INSERT INTO import_change_log
             (batch_id, record_id, action, old_data, old_search_text,
              old_schema_hash, old_row_hash, old_last_import_id)
           SELECT $1, id, 'update', old_data, old_search_text,
                  old_schema_hash, old_row_hash, old_last_import_id
             FROM targets
           RETURNING record_id
         ), updated AS (
           UPDATE customer_records r
              SET data = r.data || t.next_data,
                  search_text = (
                    SELECT COALESCE(string_agg(kv.value, ' '), '')
                      FROM jsonb_each_text(r.data || t.next_data) AS kv(key, value)
                  ),
                  schema_hash = t.next_schema_hash,
                  row_hash = t.next_row_hash,
                  last_import_id = $1,
                  updated_at = NOW()
             FROM targets t
             JOIN logged l ON l.record_id = t.id
            WHERE r.id = t.id
           RETURNING r.id
         )
         SELECT COUNT(*)::int AS count FROM updated`,
        [importId, batch.dataset_id, ...keys]
      );
      updatedRows = updateResult.rows[0]?.count || 0;
    }

    const keyExpressions = keys.length ? keySql(keys, 3, 'r', 'c') : null;
    const insertParams = [importId, batch.dataset_id, ...keys];
    const noMatchCondition = keyExpressions
      ? `NOT EXISTS (
           SELECT 1 FROM customer_records r
            WHERE r.dataset_id = $2
              AND (${keyExpressions.hasKey})
              AND ${keyExpressions.match}
         )`
      : 'TRUE';
    await client.query(
      `WITH distinct_rows AS (
         SELECT DISTINCT ON (schema_hash, row_hash)
                row_data, search_text, schema_hash, row_hash, row_number
           FROM import_staging_rows
          WHERE import_id = $1
          ORDER BY schema_hash, row_hash, row_number
       ), candidates AS (
         SELECT c.* FROM distinct_rows c
          WHERE NOT EXISTS (
            SELECT 1 FROM customer_records e
             WHERE e.dataset_id = $2
               AND e.schema_hash = c.schema_hash
               AND e.row_hash = c.row_hash
          )
       ), insertable AS (
         SELECT c.* FROM candidates c
          WHERE ${noMatchCondition}
       ), inserted AS (
         INSERT INTO customer_records
           (dataset_id, data, search_text, schema_hash, row_hash, last_import_id)
         SELECT $2, row_data, search_text, schema_hash, row_hash, $1
           FROM insertable
         ON CONFLICT (dataset_id, schema_hash, row_hash) DO NOTHING
         RETURNING id
       )
       INSERT INTO import_change_log (batch_id, record_id, action)
       SELECT $1, id, 'insert' FROM inserted`,
      insertParams
    );

    const insertedResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM import_change_log
        WHERE batch_id = $1 AND action = 'insert'`,
      [importId]
    );
    const insertedRows = insertedResult.rows[0]?.count || 0;
    const priorDataset = await client.query('SELECT headers FROM datasets WHERE id = $1', [batch.dataset_id]);
    const existingHeaders = Array.isArray(priorDataset.rows[0]?.headers) ? priorDataset.rows[0].headers : [];
    const incomingHeaders = Array.isArray(batch.headers) ? batch.headers : [];
    const headerKeys = new Set(existingHeaders.map(value => String(value).toLocaleLowerCase('id-ID')));
    const combinedHeaders = [...existingHeaders, ...incomingHeaders.filter(value => {
      const key = String(value).toLocaleLowerCase('id-ID');
      if (headerKeys.has(key)) return false;
      headerKeys.add(key);
      return true;
    })];

    await client.query(
      `UPDATE datasets SET headers = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [batch.dataset_id, JSON.stringify(combinedHeaders)]
    );

    const stats = {
      ...preview,
      insertedRows,
      updatedRows,
      duplicateRows: preview.duplicatesInFile + preview.exactDuplicatesExisting,
      completedAt: new Date().toISOString()
    };
    await client.query(
      `UPDATE import_batches
          SET status = 'completed', stats = $2::jsonb,
              completed_at = NOW()
        WHERE id = $1`,
      [importId, JSON.stringify(stats)]
    );
    await client.query('DELETE FROM import_staging_rows WHERE import_id = $1', [importId]);
    await client.query('COMMIT');
    return { blocked: false, stats };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackImport(poolInstance, importId) {
  const client = await poolInstance.connect();
  try {
    await client.query('BEGIN');
    const batch = await getBatch(client, importId, true);
    await client.query('SELECT id FROM datasets WHERE id = $1 FOR UPDATE', [batch.dataset_id]);
    if (batch.status !== 'completed') throw httpError('Hanya import yang sudah selesai yang bisa dibatalkan.', 409, 'ROLLBACK_NOT_ALLOWED');

    const conflicts = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM import_change_log l
         LEFT JOIN customer_records r ON r.id = l.record_id
        WHERE l.batch_id = $1
          AND (
            (l.action = 'update' AND (r.id IS NULL OR r.last_import_id IS DISTINCT FROM $1))
            OR
            (l.action = 'insert' AND r.id IS NOT NULL AND r.last_import_id IS DISTINCT FROM $1)
          )`,
      [importId]
    );
    if ((conflicts.rows[0]?.count || 0) > 0) {
      throw httpError('Rollback dihentikan karena sebagian data dari import ini sudah diubah oleh import berikutnya. Tidak ada perubahan yang dibatalkan.', 409, 'ROLLBACK_CONFLICT');
    }

    await client.query(
      `UPDATE customer_records r
          SET data = l.old_data,
              search_text = l.old_search_text,
              schema_hash = l.old_schema_hash,
              row_hash = l.old_row_hash,
              last_import_id = l.old_last_import_id,
              updated_at = NOW()
         FROM import_change_log l
        WHERE l.batch_id = $1
          AND l.action = 'update'
          AND r.id = l.record_id`,
      [importId]
    );
    await client.query(
      `DELETE FROM customer_records r
        USING import_change_log l
        WHERE l.batch_id = $1
          AND l.action = 'insert'
          AND r.id = l.record_id`,
      [importId]
    );
    await client.query(
      `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW()
        WHERE id = $1`,
      [importId]
    );
    await client.query('COMMIT');
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/api/config' && request.method === 'GET') {
    return json({ authRequired: Boolean(process.env.APP_ACCESS_KEY) });
  }
  checkAccess(request);
  const poolInstance = databasePool();

  if (path === '/api/health' && request.method === 'GET') {
    const result = await poolInstance.query('SELECT 1 AS ok');
    return json({ ok: result.rows[0]?.ok === 1, authRequired: Boolean(process.env.APP_ACCESS_KEY) });
  }

  if (path === '/api/datasets' && request.method === 'GET') {
    const result = await poolInstance.query(
      `SELECT d.id, d.name, d.slug, d.headers, d.updated_at,
              COUNT(r.id)::int AS record_count
         FROM datasets d
         LEFT JOIN customer_records r ON r.dataset_id = d.id
        GROUP BY d.id
        ORDER BY d.updated_at DESC, d.name ASC`
    );
    return json({ datasets: result.rows });
  }

  if (path === '/api/records' && request.method === 'GET') {
    const datasetId = url.searchParams.get('datasetId');
    if (!datasetId) throw httpError('Pilih dataset terlebih dahulu.');
    const datasetResult = await poolInstance.query('SELECT id, name, headers FROM datasets WHERE id = $1', [datasetId]);
    if (!datasetResult.rows[0]) throw httpError('Dataset tidak ditemukan.', 404, 'DATASET_NOT_FOUND');
    const dataset = datasetResult.rows[0];
    const page = safeInteger(url.searchParams.get('page'), 1, 1, 1_000_000);
    const pageSize = safeInteger(url.searchParams.get('pageSize'), 50, 10, 250);
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 160);
    const sort = String(url.searchParams.get('sort') || '');
    const direction = url.searchParams.get('direction') === 'desc' ? 'DESC' : 'ASC';
    let filters = {};
    try { filters = JSON.parse(url.searchParams.get('filters') || '{}'); }
    catch { throw httpError('Filter pencarian tidak valid.'); }
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) filters = {};

    const params = [datasetId];
    const conditions = ['r.dataset_id = $1'];
    if (query) {
      params.push(`%${query}%`);
      conditions.push(`r.search_text ILIKE $${params.length}`);
    }
    const allowedHeaders = new Set(Array.isArray(dataset.headers) ? dataset.headers : []);
    for (const [header, value] of Object.entries(filters).slice(0, 120)) {
      if (!allowedHeaders.has(header) || !String(value || '').trim()) continue;
      params.push(header);
      const headerParam = `$${params.length}`;
      params.push(`%${String(value).trim().slice(0, 100)}%`);
      conditions.push(`COALESCE(r.data ->> ${headerParam}, '') ILIKE $${params.length}`);
    }
    const where = conditions.join(' AND ');
    const countResult = await poolInstance.query(
      `SELECT COUNT(*)::int AS total FROM customer_records r WHERE ${where}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;
    const datasetCountResult = await poolInstance.query(
      'SELECT COUNT(*)::int AS total FROM customer_records WHERE dataset_id = $1',
      [datasetId]
    );
    const datasetTotal = datasetCountResult.rows[0]?.total || 0;

    const sortHeader = allowedHeaders.has(sort) ? sort : '';
    let orderBy = 'r.id ASC';
    const dataParams = [...params];
    if (sortHeader) {
      dataParams.push(sortHeader);
      orderBy = `LOWER(COALESCE(r.data ->> $${dataParams.length}, '')) ${direction}, r.id ASC`;
    }
    dataParams.push(pageSize);
    const limitParam = `$${dataParams.length}`;
    dataParams.push((page - 1) * pageSize);
    const offsetParam = `$${dataParams.length}`;
    const rowsResult = await poolInstance.query(
      `SELECT r.id, r.data
         FROM customer_records r
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      dataParams
    );
    return json({
      dataset: { id: dataset.id, name: dataset.name, headers: dataset.headers },
      rows: rowsResult.rows.map(row => ({ id: row.id, data: row.data })),
      total,
      datasetTotal,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize)
    });
  }

  if (path === '/api/history' && request.method === 'GET') {
    const result = await poolInstance.query(
      `SELECT b.id, b.file_name, b.status, b.total_rows, b.staged_rows,
              b.stats, b.created_at, b.completed_at, b.rolled_back_at,
              d.name AS dataset_name
         FROM import_batches b
         JOIN datasets d ON d.id = b.dataset_id
        ORDER BY b.created_at DESC
        LIMIT 40`
    );
    return json({ history: result.rows });
  }

  if (path === '/api/imports/start' && request.method === 'POST') {
    const payload = await readJson(request);
    const client = await poolInstance.connect();
    try {
      await client.query('BEGIN');
      const result = await startImport(client, payload);
      await client.query('COMMIT');
      return json(result, 201);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const chunksMatch = path.match(/^\/api\/imports\/([0-9a-f-]+)\/chunks$/i);
  if (chunksMatch && request.method === 'POST') {
    const payload = await readJson(request);
    const result = await addChunk(poolInstance, chunksMatch[1], payload);
    return json(result);
  }

  const previewMatch = path.match(/^\/api\/imports\/([0-9a-f-]+)\/preview$/i);
  if (previewMatch && request.method === 'POST') {
    const payload = await readJson(request);
    const client = await poolInstance.connect();
    try {
      const batch = await getBatch(client, previewMatch[1]);
      if (batch.status !== 'uploading' && batch.status !== 'previewed') {
        throw httpError('Import ini sudah diproses atau dibatalkan.', 409, 'IMPORT_NOT_OPEN');
      }
      const preview = await calculatePreview(client, batch, payload.matchColumns || []);
      await client.query("UPDATE import_batches SET status = 'previewed' WHERE id = $1", [batch.id]);
      return json({ preview });
    } finally {
      client.release();
    }
  }

  const commitMatch = path.match(/^\/api\/imports\/([0-9a-f-]+)\/commit$/i);
  if (commitMatch && request.method === 'POST') {
    const result = await commitImport(poolInstance, commitMatch[1]);
    if (result.blocked) return json({ error: 'Import dihentikan karena ada kunci pencocokan yang ambigu.', code: 'AMBIGUOUS_MATCH', preview: result.preview }, 409);
    return json(result);
  }

  const rollbackMatch = path.match(/^\/api\/imports\/([0-9a-f-]+)\/rollback$/i);
  if (rollbackMatch && request.method === 'POST') {
    const result = await rollbackImport(poolInstance, rollbackMatch[1]);
    return json(result);
  }

  const deleteMatch = path.match(/^\/api\/imports\/([0-9a-f-]+)$/i);
  if (deleteMatch && request.method === 'DELETE') {
    const importId = deleteMatch[1];
    const client = await poolInstance.connect();
    try {
      await client.query('BEGIN');
      const batch = await getBatch(client, importId, true);
      if (batch.status !== 'uploading' && batch.status !== 'previewed') {
        throw httpError('Import yang sudah selesai tidak bisa dihapus dari riwayat.', 409, 'IMPORT_ALREADY_FINISHED');
      }
      await client.query('DELETE FROM import_batches WHERE id = $1', [importId]);
      await client.query(
        `DELETE FROM datasets d
          WHERE d.id = $1
            AND NOT EXISTS (SELECT 1 FROM customer_records r WHERE r.dataset_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.dataset_id = d.id)`,
        [batch.dataset_id]
      );
      await client.query('COMMIT');
      return json({ success: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return json({ error: 'Endpoint tidak ditemukan.' }, 404);
}

export default async (request) => {
  try {
    return await handle(request);
  } catch (error) {
    console.error('[king-ziel-api]', error);
    return errorResponse(error);
  }
};

export const config = { path: '/api/*' };
