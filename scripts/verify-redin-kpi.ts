import { requireEnv, createLogger } from "@redin/shared";

const log = createLogger("verify-kpi");

const QUERIES = [
  {
    name: "redin_kpi_hero",
    sql: "select revenue_billed_lifetime, revenue_collected_lifetime, cost_lineitem_aprobado_lifetime, profit_conservative_lifetime, margin_pct_conservative, outstanding_cartera, outstanding_count, ots_total from redin_kpi_hero",
  },
  {
    name: "redin_kpi_monthly",
    sql: "select month, ots_created, ots_facturado, revenue_billed, cost_lineitem_aprobado, profit_conservative, margin_pct_conservative, distinct_cities from redin_kpi_monthly order by month",
  },
  {
    name: "redin_kpi_client_pnl",
    sql: "select cliente, ot_count, revenue_billed, cost, profit, margin_pct, pct_of_total_revenue from redin_kpi_client_pnl",
  },
  {
    name: "redin_kpi_perdida_summary",
    sql: "select total, real_lost_count, admin_close_count, real_lost_value_estimated, admin_close_value_billed from redin_kpi_perdida_summary",
  },
  {
    name: "redin_kpi_integrity_lifetime",
    sql: "select ots_total, ots_reconciled, ots_discrepant, completeness_pct, net_appsheet_bias from redin_kpi_integrity_lifetime",
  },
  {
    name: "costos_ejecucion_mirror_count",
    sql: "select count(*) as count, count(*) filter (where estado='APROBADO') as aprobado, count(*) filter (where estado='PENDIENTE') as pendiente, count(*) filter (where estado='RECHAZADO') as rechazado from costos_ejecucion_mirror",
  },
  {
    name: "ots_daily_snapshot_count",
    sql: "select snapshot_date, count(*) as count from ots_daily_snapshot group by snapshot_date order by snapshot_date",
  },
];

async function runOne(name: string, sql: string, ref: string, token: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    log.error(`${name} FAILED`, { status: res.status, body: body.slice(0, 400) });
    return;
  }
  console.log(`\n=== ${name} ===`);
  try {
    const parsed = JSON.parse(body);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(body.slice(0, 800));
  }
}

async function main() {
  const ref = requireEnv("SUPABASE_PROJECT_REF");
  const token = requireEnv("SUPABASE_MANAGEMENT_TOKEN");
  for (const q of QUERIES) await runOne(q.name, q.sql, ref, token);
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
