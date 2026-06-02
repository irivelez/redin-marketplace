-- 018 — Daily snapshot of ots_mirror for forward-velocity tracking.
--
-- ots_mirror is upserted by row_id every 15 min — yesterday's state is
-- overwritten. AppSheet's per-row date fields (Fecha_Creacion,
-- Fecha_Facturacion, Fecha_Pago_Real, TS_Cancelacion) DO encode historical
-- events and let the KPI views reconstruct the past WITHOUT this snapshot.
--
-- This table exists for FUTURE velocity metrics — things that depend on
-- watching a field mutate in place (e.g. how long an OT sits in 'En ejecución',
-- which Estado transitions happened today). Today's dashboard does not
-- read from this table, but we start collecting from day 1 so post-Toño
-- behavior is captured. Cheap: ~728 rows/day × small payload.
--
-- Retro-backfill at migration time inserts a single (current_date - 1) snapshot
-- so the Panel 6 monthly-completeness inset line has more than one data point
-- on first render.

create table if not exists ots_daily_snapshot (
  snapshot_date date not null,
  row_id text not null,
  estado text,
  cliente text,
  ciudad text,
  data jsonb not null,
  captured_at timestamptz default now(),
  primary key (snapshot_date, row_id)
);

create index if not exists idx_snapshot_date
  on ots_daily_snapshot(snapshot_date);

create index if not exists idx_snapshot_estado
  on ots_daily_snapshot(estado);

-- One-shot retro-backfill so the snapshot stream has >1 point on first deploy.
-- Idempotent via on conflict — re-running the migration does not duplicate.
insert into ots_daily_snapshot (snapshot_date, row_id, estado, cliente, ciudad, data)
select
  (current_date - interval '1 day')::date,
  row_id,
  estado,
  nullif(data->>'ID_Cliente', ''),
  ciudad,
  data
from ots_mirror
on conflict do nothing;

comment on table ots_daily_snapshot is
  'Daily full snapshot of ots_mirror written by sync cron at 23:59 COT. Used by future post-Tono velocity metrics. Not read by current dashboard panels. Retro-backfill at migration time supplies yesterday for first-deploy continuity.';
