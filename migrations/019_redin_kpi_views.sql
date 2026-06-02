-- 019 — Redin financial-reference KPI views.
--
-- Powers /publico/estado/[token] (the private financial reference dashboard).
-- All views read from ots_mirror (jsonb-backed) + costos_ejecucion_mirror.
-- They expose pre-computed, auditable aggregates so the dashboard can render
-- without GROUP-BY at the page layer.
--
-- Date parsing: AppSheet returns "MM/DD/YYYY" or "MM/DD/YYYY HH:MM:SS" (US
-- format with optional time). The helper appsheet_to_date() strips the time
-- portion and returns NULL on any parse error. appsheet_to_numeric() handles
-- empty strings and bad values gracefully.
--
-- Cost methodology — two figures are exposed in every relevant view:
--   * cost_lineitem_aprobado: SUM(Costos_Ejecucion.Valor_Gasto WHERE estado='APROBADO').
--     Conservative — only itemized contractor expenses. Used on the headline
--     Monthly chart's "solid line."
--   * cost_appsheet_rollup: SUM(ots_mirror.data->>'Total_Ejecutado_Real').
--     What Jose's accounting reads. Used on the headline chart's "dashed line"
--     AND for per-client P&L (where line-items are often missing — using
--     line-items there would hide the Aseo y servicio loss).
--
-- Idempotent: every CREATE statement uses OR REPLACE.

-- ============================================================================
-- Helper functions
-- ============================================================================

create or replace function appsheet_to_date(s text) returns date as $$
begin
  if s is null or s = '' then return null; end if;
  begin
    -- Strip time portion (everything after first space) then parse MM/DD/YYYY.
    return to_date(split_part(s, ' ', 1), 'MM/DD/YYYY');
  exception when others then
    return null;
  end;
end;
$$ language plpgsql immutable;

create or replace function appsheet_to_numeric(s text) returns numeric as $$
begin
  if s is null or s = '' then return null; end if;
  begin
    return s::numeric;
  exception when others then
    return null;
  end;
end;
$$ language plpgsql immutable;

comment on function appsheet_to_date(text) is
  'Parse AppSheet date strings (MM/DD/YYYY or MM/DD/YYYY HH:MM:SS). Returns NULL on empty or parse error.';

comment on function appsheet_to_numeric(text) is
  'Parse numeric AppSheet field. Returns NULL on empty or bad value.';

-- ============================================================================
-- 1. redin_kpi_hero — single-row lifetime + MTD aggregate for the Hero P&L card
-- ============================================================================

create or replace view redin_kpi_hero as
with revenue_totals as (
  select
    count(*) as ots_total,
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real'))
      filter (where appsheet_to_date(data->>'Fecha_Facturacion') is not null)
      as revenue_billed_lifetime,
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real'))
      filter (where appsheet_to_date(data->>'Fecha_Pago_Real') is not null)
      as revenue_collected_lifetime,
    sum(appsheet_to_numeric(data->>'Total_Ejecutado_Real'))
      filter (where appsheet_to_date(data->>'Fecha_Facturacion') is not null)
      as cost_appsheet_rollup_lifetime
  from ots_mirror
),
cost_totals as (
  select
    sum(valor_gasto) filter (where estado = 'APROBADO') as cost_lineitem_aprobado_lifetime,
    sum(valor_gasto) filter (where estado = 'PENDIENTE') as cost_lineitem_pendiente_lifetime
  from costos_ejecucion_mirror
),
outstanding as (
  select
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real')) as outstanding_cartera,
    count(*) as outstanding_count
  from ots_mirror
  where estado = 'Facturado'
    and appsheet_to_date(data->>'Fecha_Facturacion') is not null
),
mtd as (
  select
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real'))
      filter (where appsheet_to_date(data->>'Fecha_Facturacion') >= date_trunc('month', current_date)::date)
      as revenue_billed_mtd,
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real'))
      filter (where appsheet_to_date(data->>'Fecha_Pago_Real') >= date_trunc('month', current_date)::date)
      as revenue_collected_mtd,
    count(*) filter (where appsheet_to_date(data->>'Fecha_Creacion') >= date_trunc('month', current_date)::date)
      as ots_created_mtd
  from ots_mirror
)
select
  r.ots_total,
  coalesce(r.revenue_billed_lifetime, 0) as revenue_billed_lifetime,
  coalesce(r.revenue_collected_lifetime, 0) as revenue_collected_lifetime,
  coalesce(c.cost_lineitem_aprobado_lifetime, 0) as cost_lineitem_aprobado_lifetime,
  coalesce(c.cost_lineitem_pendiente_lifetime, 0) as cost_lineitem_pendiente_lifetime,
  coalesce(r.cost_appsheet_rollup_lifetime, 0) as cost_appsheet_rollup_lifetime,
  coalesce(r.revenue_billed_lifetime, 0) - coalesce(c.cost_lineitem_aprobado_lifetime, 0) as profit_conservative_lifetime,
  coalesce(r.revenue_billed_lifetime, 0) - coalesce(r.cost_appsheet_rollup_lifetime, 0) as profit_appsheet_lifetime,
  case
    when coalesce(r.revenue_billed_lifetime, 0) > 0
    then (coalesce(r.revenue_billed_lifetime, 0) - coalesce(c.cost_lineitem_aprobado_lifetime, 0))
         / r.revenue_billed_lifetime * 100
    else null
  end as margin_pct_conservative,
  case
    when coalesce(r.revenue_billed_lifetime, 0) > 0
    then (coalesce(r.revenue_billed_lifetime, 0) - coalesce(r.cost_appsheet_rollup_lifetime, 0))
         / r.revenue_billed_lifetime * 100
    else null
  end as margin_pct_appsheet,
  coalesce(o.outstanding_cartera, 0) as outstanding_cartera,
  coalesce(o.outstanding_count, 0) as outstanding_count,
  coalesce(m.revenue_billed_mtd, 0) as revenue_billed_mtd,
  coalesce(m.revenue_collected_mtd, 0) as revenue_collected_mtd,
  coalesce(m.ots_created_mtd, 0) as ots_created_mtd
from revenue_totals r
cross join cost_totals c
cross join outstanding o
cross join mtd m;

comment on view redin_kpi_hero is
  'Single-row lifetime + MTD aggregate for the Hero P&L card on /publico/estado. Conservative profit uses line-item APROBADO; appsheet profit uses Total_Ejecutado_Real rollup. Both exposed for the dual-line discipline on Panel 4 (margin).';

-- ============================================================================
-- 2. redin_kpi_monthly — one row per month, multi-metric
-- ============================================================================

create or replace view redin_kpi_monthly as
with months as (
  select to_char(d, 'YYYY-MM') as month, d::date as month_start
  from generate_series(date '2026-01-01', current_date, '1 month'::interval) d
),
by_creacion as (
  select
    to_char(appsheet_to_date(data->>'Fecha_Creacion'), 'YYYY-MM') as month,
    count(*) as ots_created,
    sum(appsheet_to_numeric(data->>'Valor_Estimado')) as valor_estimado_created,
    count(distinct ciudad) as distinct_cities,
    count(distinct data->>'ID_Cliente') as distinct_clients
  from ots_mirror
  where appsheet_to_date(data->>'Fecha_Creacion') is not null
  group by 1
),
by_facturado as (
  select
    to_char(appsheet_to_date(data->>'Fecha_Facturacion'), 'YYYY-MM') as month,
    count(*) as ots_facturado,
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real')) as revenue_billed,
    sum(appsheet_to_numeric(data->>'Total_Ejecutado_Real')) as cost_appsheet_rollup
  from ots_mirror
  where appsheet_to_date(data->>'Fecha_Facturacion') is not null
  group by 1
),
by_pago as (
  select
    to_char(appsheet_to_date(data->>'Fecha_Pago_Real'), 'YYYY-MM') as month,
    count(*) as ots_pagado,
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real')) as revenue_collected
  from ots_mirror
  where appsheet_to_date(data->>'Fecha_Pago_Real') is not null
  group by 1
),
by_cancelacion as (
  select
    to_char(appsheet_to_date(data->>'TS_Cancelacion'), 'YYYY-MM') as month,
    count(*) as ots_cancelled
  from ots_mirror
  where estado = '99. Perdida / Cancelada'
    and appsheet_to_date(data->>'TS_Cancelacion') is not null
  group by 1
),
by_cost as (
  select
    to_char(fecha_gasto, 'YYYY-MM') as month,
    sum(case when estado = 'APROBADO' then valor_gasto else 0 end) as cost_lineitem_aprobado,
    sum(case when estado = 'PENDIENTE' then valor_gasto else 0 end) as cost_lineitem_pendiente
  from costos_ejecucion_mirror
  where fecha_gasto is not null
  group by 1
)
select
  m.month,
  m.month_start,
  coalesce(c.ots_created, 0) as ots_created,
  coalesce(c.valor_estimado_created, 0) as valor_estimado_created,
  coalesce(c.distinct_cities, 0) as distinct_cities,
  coalesce(c.distinct_clients, 0) as distinct_clients,
  coalesce(f.ots_facturado, 0) as ots_facturado,
  coalesce(f.revenue_billed, 0) as revenue_billed,
  coalesce(f.cost_appsheet_rollup, 0) as cost_appsheet_rollup,
  coalesce(p.ots_pagado, 0) as ots_pagado,
  coalesce(p.revenue_collected, 0) as revenue_collected,
  coalesce(x.ots_cancelled, 0) as ots_cancelled,
  coalesce(cost.cost_lineitem_aprobado, 0) as cost_lineitem_aprobado,
  coalesce(cost.cost_lineitem_pendiente, 0) as cost_lineitem_pendiente,
  coalesce(f.revenue_billed, 0) - coalesce(cost.cost_lineitem_aprobado, 0) as profit_conservative,
  coalesce(f.revenue_billed, 0) - coalesce(f.cost_appsheet_rollup, 0) as profit_appsheet,
  case when coalesce(f.revenue_billed, 0) > 0
       then (coalesce(f.revenue_billed, 0) - coalesce(cost.cost_lineitem_aprobado, 0))
            / f.revenue_billed * 100
       else null end as margin_pct_conservative,
  case when coalesce(f.revenue_billed, 0) > 0
       then (coalesce(f.revenue_billed, 0) - coalesce(f.cost_appsheet_rollup, 0))
            / f.revenue_billed * 100
       else null end as margin_pct_appsheet
from months m
left join by_creacion c on c.month = m.month
left join by_facturado f on f.month = m.month
left join by_pago p on p.month = m.month
left join by_cancelacion x on x.month = m.month
left join by_cost cost on cost.month = m.month
order by m.month;

comment on view redin_kpi_monthly is
  'Per-month aggregates by event-date for Panel 2 (Monthly trend) and Panel 5 (Volume). Months from 2026-01 to current_date generated via series so missing months show as zeros not gaps.';

-- ============================================================================
-- 3. redin_kpi_client_pnl — per-client lifetime P&L for Panel 3
-- ============================================================================

create or replace view redin_kpi_client_pnl as
with client_agg as (
  select
    coalesce(nullif(data->>'ID_Cliente', ''), 'Sin cliente') as cliente,
    count(*) as ot_count,
    sum(appsheet_to_numeric(data->>'Valor_Facturado_Real')) as revenue_billed,
    sum(appsheet_to_numeric(data->>'Total_Ejecutado_Real')) as cost_appsheet
  from ots_mirror
  group by 1
),
total_rev as (
  select sum(revenue_billed) as total from client_agg
)
select
  a.cliente,
  a.ot_count,
  coalesce(a.revenue_billed, 0) as revenue_billed,
  coalesce(a.cost_appsheet, 0) as cost,
  coalesce(a.revenue_billed, 0) - coalesce(a.cost_appsheet, 0) as profit,
  case when coalesce(a.revenue_billed, 0) > 0
       then (coalesce(a.revenue_billed, 0) - coalesce(a.cost_appsheet, 0))
            / a.revenue_billed * 100
       else null end as margin_pct,
  case when t.total > 0
       then coalesce(a.revenue_billed, 0) / t.total * 100
       else 0 end as pct_of_total_revenue
from client_agg a
cross join total_rev t
where a.revenue_billed is not null and a.revenue_billed > 0
order by a.revenue_billed desc;

comment on view redin_kpi_client_pnl is
  'Per-client lifetime revenue/cost/profit/margin. Uses AppSheet rollup (Total_Ejecutado_Real) because per-client line-item completeness is uneven — switching to line-items hides the Aseo y servicio loss (which has rollup cost but no line-items). Panel 3 must show that loss; that is the highest-leverage operational insight in the data.';

-- ============================================================================
-- 4. redin_kpi_perdida — every Perdida OT classified
-- ============================================================================

create or replace view redin_kpi_perdida as
select
  o.row_id,
  o.data->>'Numero_Orden' as numero_orden,
  appsheet_to_date(o.data->>'Fecha_Creacion') as fecha_creacion,
  appsheet_to_date(o.data->>'TS_Cancelacion') as fecha_cancelacion,
  o.ciudad,
  nullif(o.data->>'ID_Cliente', '') as cliente,
  o.data->>'Nombre_Arquitecto_Real' as arquitecto,
  o.data->>'Descripcion' as descripcion,
  appsheet_to_numeric(o.data->>'Valor_Estimado') as valor_estimado,
  appsheet_to_numeric(o.data->>'Valor_Facturado_Real') as valor_facturado_real,
  case
    when coalesce(appsheet_to_numeric(o.data->>'Valor_Facturado_Real'), 0) > 0 then 'admin_close'
    else 'real_lost'
  end as category,
  case
    when o.data->>'Descripcion' ilike '%PASA A LA ORDEN%' or o.data->>'Descripcion' ilike '%pasa a la orden%' then 'duplicate_renumbered'
    when o.data->>'Descripcion' ilike '%duplicad%' then 'duplicate'
    when o.data->>'Descripcion' ilike '%cancel%' then 'client_cancelled'
    when o.data->>'Descripcion' ilike '%rechaz%' then 'client_rejected'
    when o.data->>'Descripcion' ilike '%no aprob%' or o.data->>'Descripcion' ilike '%sin aprob%' then 'client_never_approved'
    when o.data->>'Descripcion' ilike '%garant%' then 'warranty_followup'
    when o.data->>'Descripcion' ilike '%sin t%cnico%' or o.data->>'Descripcion' ilike '%sin contrat%' or o.data->>'Descripcion' ilike '%no cobertur%' then 'no_contractor'
    when coalesce(nullif(o.data->>'Descripcion', ''), '') = '' then 'no_description'
    else 'other'
  end as reason_guess
from ots_mirror o
where o.estado = '99. Perdida / Cancelada';

comment on view redin_kpi_perdida is
  'Per-OT Perdida classification for Panel 7. Category split: real_lost (Valor_Facturado_Real=0) vs admin_close (billed then cancelled, usually duplicates renumbered). Reason inferred from Descripcion keywords — labeled "reason_guess" because there is no structured reason field in AppSheet today.';

-- ============================================================================
-- 5. redin_kpi_perdida_summary — pre-aggregated for Panel 7 (saves dashboard group-by)
-- ============================================================================

create or replace view redin_kpi_perdida_summary as
select
  count(*) as total,
  count(*) filter (where category = 'real_lost') as real_lost_count,
  count(*) filter (where category = 'admin_close') as admin_close_count,
  coalesce(sum(valor_estimado) filter (where category = 'real_lost'), 0) as real_lost_value_estimated,
  coalesce(sum(valor_facturado_real) filter (where category = 'admin_close'), 0) as admin_close_value_billed
from redin_kpi_perdida;

comment on view redin_kpi_perdida_summary is
  'Single-row Perdida summary for Panel 7 big-numbers strip.';

-- ============================================================================
-- 6. redin_kpi_cartera_aging — outstanding invoices bucketed
-- ============================================================================

create or replace view redin_kpi_cartera_aging as
with outstanding as (
  select
    o.row_id,
    o.data->>'Numero_Orden' as numero_orden,
    coalesce(nullif(o.data->>'ID_Cliente', ''), 'Sin cliente') as cliente,
    o.ciudad,
    appsheet_to_date(o.data->>'Fecha_Facturacion') as fecha_facturacion,
    appsheet_to_numeric(o.data->>'Valor_Facturado_Real') as valor_facturado_real,
    (current_date - appsheet_to_date(o.data->>'Fecha_Facturacion'))::integer as days_outstanding
  from ots_mirror o
  where o.estado = 'Facturado'
    and appsheet_to_date(o.data->>'Fecha_Facturacion') is not null
)
select
  row_id,
  numero_orden,
  cliente,
  ciudad,
  fecha_facturacion,
  valor_facturado_real,
  days_outstanding,
  case
    when days_outstanding <= 30 then '0-30'
    when days_outstanding <= 60 then '30-60'
    when days_outstanding <= 90 then '60-90'
    else '90+'
  end as aging_bucket
from outstanding;

comment on view redin_kpi_cartera_aging is
  'Outstanding (billed-but-not-paid) OTs with aging bucket and per-OT detail. Panel 4 stacks by cliente.';

-- ============================================================================
-- 7. redin_kpi_integrity — per-month + lifetime cost-completeness
-- ============================================================================

create or replace view redin_kpi_integrity as
with per_ot as (
  select
    o.row_id,
    o.data->>'ID_Orden' as id_orden,
    appsheet_to_date(o.data->>'Fecha_Facturacion') as fecha_facturacion,
    coalesce(appsheet_to_numeric(o.data->>'Total_Ejecutado_Real'), 0) as appsheet_cost,
    coalesce((
      select sum(c.valor_gasto)
      from costos_ejecucion_mirror c
      where c.ot_id = o.data->>'ID_Orden' and c.estado = 'APROBADO'
    ), 0) as lineitem_cost
  from ots_mirror o
)
select
  to_char(fecha_facturacion, 'YYYY-MM') as month,
  count(*) as ots_total,
  count(*) filter (where abs(appsheet_cost - lineitem_cost) <= 100) as ots_reconciled,
  count(*) filter (where abs(appsheet_cost - lineitem_cost) > 100) as ots_discrepant,
  case when count(*) > 0
       then count(*) filter (where abs(appsheet_cost - lineitem_cost) <= 100)::numeric
            / count(*)::numeric * 100
       else null end as completeness_pct,
  sum(appsheet_cost - lineitem_cost) as net_appsheet_bias
from per_ot
where fecha_facturacion is not null
group by 1
order by 1;

comment on view redin_kpi_integrity is
  'Per-month cost-data integrity. completeness_pct = share of OTs whose AppSheet Total_Ejecutado_Real matches sum of Costos_Ejecucion APROBADO line-items within $100 COP. The gap is contractor cost that has been approved but not yet line-itemized — directly trackable as a Toño hygiene metric.';

-- ============================================================================
-- 8. redin_kpi_integrity_lifetime — single-row aggregate
-- ============================================================================

create or replace view redin_kpi_integrity_lifetime as
with per_ot as (
  select
    o.row_id,
    coalesce(appsheet_to_numeric(o.data->>'Total_Ejecutado_Real'), 0) as appsheet_cost,
    coalesce((
      select sum(c.valor_gasto)
      from costos_ejecucion_mirror c
      where c.ot_id = o.data->>'ID_Orden' and c.estado = 'APROBADO'
    ), 0) as lineitem_cost
  from ots_mirror o
)
select
  count(*) as ots_total,
  count(*) filter (where abs(appsheet_cost - lineitem_cost) <= 100) as ots_reconciled,
  count(*) filter (where abs(appsheet_cost - lineitem_cost) > 100) as ots_discrepant,
  case when count(*) > 0
       then count(*) filter (where abs(appsheet_cost - lineitem_cost) <= 100)::numeric
            / count(*)::numeric * 100
       else null end as completeness_pct,
  sum(appsheet_cost - lineitem_cost) as net_appsheet_bias
from per_ot;

comment on view redin_kpi_integrity_lifetime is
  'Single-row lifetime cost-integrity aggregate for Panel 6 big number.';
