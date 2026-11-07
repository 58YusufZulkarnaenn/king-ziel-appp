CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  headers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_records (
  id BIGSERIAL PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  schema_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  last_import_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_records_exact_unique UNIQUE (dataset_id, schema_hash, row_hash)
);

CREATE INDEX IF NOT EXISTS customer_records_dataset_id_idx
  ON customer_records (dataset_id, id);
CREATE INDEX IF NOT EXISTS customer_records_search_trgm_idx
  ON customer_records USING GIN (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customer_records_data_gin_idx
  ON customer_records USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  headers JSONB NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading',
  match_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview JSONB,
  stats JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS import_batches_created_at_idx
  ON import_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS import_staging_rows (
  import_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  row_data JSONB NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  schema_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  PRIMARY KEY (import_id, row_number)
);

CREATE INDEX IF NOT EXISTS import_staging_hash_idx
  ON import_staging_rows (import_id, schema_hash, row_hash);

CREATE TABLE IF NOT EXISTS import_change_log (
  batch_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  record_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('insert', 'update')),
  old_data JSONB,
  old_search_text TEXT,
  old_schema_hash TEXT,
  old_row_hash TEXT,
  old_last_import_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (batch_id, record_id)
);

