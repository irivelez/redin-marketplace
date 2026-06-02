-- 017 — Costos_Ejecucion mirror table.
--
-- Mirrors AppSheet's Costos_Ejecucion table (1,007 rows as of 2026-05-29) into
-- Supabase so the KPI views can join cost line-items to OTs without round-
-- tripping through the AppSheet API on every page load.
--
-- Layout matches ots_mirror (full row in `data jsonb`, hot columns flattened
-- for indexing). Sync layer fills the flat columns via extract function — same
-- pattern as mirrorOts() in marketplace/sync/src/mirror.ts.
--
-- Date parsing note: AppSheet returns Fecha_Gasto in MM/DD/YYYY US format.
-- The flat column is filled by the TypeScript extractor (handles the format),
-- NOT a generated column (PostgreSQL doesn't accept MM/DD/YYYY without an
-- explicit format string).
--
-- Idempotent: all DDL guarded by IF NOT EXISTS.

create table if not exists costos_ejecucion_mirror (
  row_id text primary key,
  ot_id text,
  estado text,           -- APROBADO | PENDIENTE | RECHAZADO
  fecha_gasto date,
  valor_gasto numeric,
  categoria text,
  data jsonb not null,
  synced_at timestamptz default now()
);

create index if not exists idx_costos_mirror_ot
  on costos_ejecucion_mirror(ot_id);

create index if not exists idx_costos_mirror_estado
  on costos_ejecucion_mirror(estado);

create index if not exists idx_costos_mirror_fecha
  on costos_ejecucion_mirror(fecha_gasto);

comment on table costos_ejecucion_mirror is
  'Mirror of AppSheet Costos_Ejecucion table. One row per contractor expense line. Refreshed by sync layer every 15 min + on demand. Used by redin_kpi_* views for cost-side calculations.';

comment on column costos_ejecucion_mirror.estado is
  'AppSheet ESTADO field. APROBADO = ready to pay / paid. PENDIENTE = waiting approval. RECHAZADO = denied. Only APROBADO counts toward Redin cost in the headline P&L (conservative).';

comment on column costos_ejecucion_mirror.ot_id is
  'AppSheet ID_Orden — the natural key linking to ots_mirror.data->>ID_Orden (NOT row_id). Index supports per-OT cost rollups.';
