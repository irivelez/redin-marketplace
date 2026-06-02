-- 020 — Daily KPI snapshot via Supabase pg_cron.
--
-- Schedules an in-database cron job that captures the redin_kpi_hero values
-- once per day at 23:59 Colombia time (04:59 UTC, since Colombia is UTC-5).
-- The result lands in redin_kpi_hero_daily — one immutable row per snapshot
-- date — so the dashboard can plot day-by-day evolution starting from today.
--
-- Runs entirely inside Supabase, no Railway dependency. If the sync service
-- is down at midnight, the KPI snapshot still fires (the underlying ots_mirror
-- gets refreshed every 15 min when sync IS up, so the values stay current).
--
-- Idempotent:
--   * `create extension if not exists` + `if not exists` table guards
--   * `cron.schedule(jobname, ...)` is upsert-by-name
--   * `on conflict do update` on the table — re-running the function on the
--     same day overwrites that day's row with the latest figures (useful for
--     manual catch-up after AppSheet backfills).

create extension if not exists pg_cron;

create table if not exists redin_kpi_hero_daily (
  snapshot_date date primary key,
  ots_total integer,
  revenue_billed_lifetime numeric,
  revenue_collected_lifetime numeric,
  cost_lineitem_aprobado_lifetime numeric,
  cost_lineitem_pendiente_lifetime numeric,
  cost_appsheet_rollup_lifetime numeric,
  profit_conservative_lifetime numeric,
  profit_appsheet_lifetime numeric,
  margin_pct_conservative numeric,
  margin_pct_appsheet numeric,
  outstanding_cartera numeric,
  outstanding_count integer,
  captured_at timestamptz default now()
);

comment on table redin_kpi_hero_daily is
  'Daily snapshot of redin_kpi_hero values, written by pg_cron at 23:59 COT each day. One row per snapshot_date (Colombia local). Powers the day-by-day evolution chart on /publico/estado.';

create or replace function snapshot_redin_kpi_hero() returns void as $$
  insert into redin_kpi_hero_daily (
    snapshot_date,
    ots_total,
    revenue_billed_lifetime,
    revenue_collected_lifetime,
    cost_lineitem_aprobado_lifetime,
    cost_lineitem_pendiente_lifetime,
    cost_appsheet_rollup_lifetime,
    profit_conservative_lifetime,
    profit_appsheet_lifetime,
    margin_pct_conservative,
    margin_pct_appsheet,
    outstanding_cartera,
    outstanding_count
  )
  select
    (current_timestamp at time zone 'America/Bogota')::date as snapshot_date,
    ots_total,
    revenue_billed_lifetime,
    revenue_collected_lifetime,
    cost_lineitem_aprobado_lifetime,
    cost_lineitem_pendiente_lifetime,
    cost_appsheet_rollup_lifetime,
    profit_conservative_lifetime,
    profit_appsheet_lifetime,
    margin_pct_conservative,
    margin_pct_appsheet,
    outstanding_cartera,
    outstanding_count
  from redin_kpi_hero
  on conflict (snapshot_date) do update set
    ots_total = excluded.ots_total,
    revenue_billed_lifetime = excluded.revenue_billed_lifetime,
    revenue_collected_lifetime = excluded.revenue_collected_lifetime,
    cost_lineitem_aprobado_lifetime = excluded.cost_lineitem_aprobado_lifetime,
    cost_lineitem_pendiente_lifetime = excluded.cost_lineitem_pendiente_lifetime,
    cost_appsheet_rollup_lifetime = excluded.cost_appsheet_rollup_lifetime,
    profit_conservative_lifetime = excluded.profit_conservative_lifetime,
    profit_appsheet_lifetime = excluded.profit_appsheet_lifetime,
    margin_pct_conservative = excluded.margin_pct_conservative,
    margin_pct_appsheet = excluded.margin_pct_appsheet,
    outstanding_cartera = excluded.outstanding_cartera,
    outstanding_count = excluded.outstanding_count,
    captured_at = now();
$$ language sql;

comment on function snapshot_redin_kpi_hero() is
  'Writes the current redin_kpi_hero values to redin_kpi_hero_daily under todays Colombia-local date. Idempotent within the day (on-conflict updates).';

-- Schedule: 04:59 UTC = 23:59 Colombia time (UTC-5, no DST in Colombia).
-- Upsert-by-name: re-running the migration replaces the schedule instead of
-- creating duplicates.
select cron.schedule(
  'redin-kpi-hero-daily',
  '59 4 * * *',
  $$ select snapshot_redin_kpi_hero(); $$
);

-- Immediate backfill so the table has at least one row right after deploy.
select snapshot_redin_kpi_hero();
