import "server-only";
import { serviceClient } from "./supabase-server";

export interface HeroPnl {
  ots_total: number;
  revenue_billed_lifetime: number;
  revenue_collected_lifetime: number;
  cost_lineitem_aprobado_lifetime: number;
  cost_lineitem_pendiente_lifetime: number;
  cost_appsheet_rollup_lifetime: number;
  profit_conservative_lifetime: number;
  profit_appsheet_lifetime: number;
  margin_pct_conservative: number | null;
  margin_pct_appsheet: number | null;
  outstanding_cartera: number;
  outstanding_count: number;
  revenue_billed_mtd: number;
  revenue_collected_mtd: number;
  ots_created_mtd: number;
}

export interface MonthlyKpi {
  month: string;
  month_start: string;
  ots_created: number;
  valor_estimado_created: number;
  distinct_cities: number;
  distinct_clients: number;
  ots_facturado: number;
  revenue_billed: number;
  cost_appsheet_rollup: number;
  ots_pagado: number;
  revenue_collected: number;
  ots_cancelled: number;
  cost_lineitem_aprobado: number;
  cost_lineitem_pendiente: number;
  profit_conservative: number;
  profit_appsheet: number;
  margin_pct_conservative: number | null;
  margin_pct_appsheet: number | null;
}

export interface ClientPnl {
  cliente: string;
  ot_count: number;
  revenue_billed: number;
  cost: number;
  profit: number;
  margin_pct: number | null;
  pct_of_total_revenue: number;
}

export interface PerdidaRow {
  row_id: string;
  numero_orden: string | null;
  fecha_creacion: string | null;
  fecha_cancelacion: string | null;
  ciudad: string | null;
  cliente: string | null;
  arquitecto: string | null;
  descripcion: string | null;
  valor_estimado: number | null;
  valor_facturado_real: number | null;
  category: "real_lost" | "admin_close";
  reason_guess: string;
}

export interface PerdidaSummary {
  total: number;
  real_lost_count: number;
  admin_close_count: number;
  real_lost_value_estimated: number;
  admin_close_value_billed: number;
}

export interface CarteraRow {
  row_id: string;
  numero_orden: string | null;
  cliente: string;
  ciudad: string | null;
  fecha_facturacion: string;
  valor_facturado_real: number;
  days_outstanding: number;
  aging_bucket: "0-30" | "30-60" | "60-90" | "90+";
}

export interface IntegrityMonthly {
  month: string;
  ots_total: number;
  ots_reconciled: number;
  ots_discrepant: number;
  completeness_pct: number | null;
  net_appsheet_bias: number;
}

export interface IntegrityLifetime {
  ots_total: number;
  ots_reconciled: number;
  ots_discrepant: number;
  completeness_pct: number | null;
  net_appsheet_bias: number;
}

export interface DataAsOf {
  ts: string;
  n: number;
}

async function fetchOne<T>(view: string): Promise<T> {
  const supa = serviceClient();
  const { data, error } = await supa
    // @ts-expect-error — redin_kpi_* views introduced in migration 019; gen-types regen pending
    .from(view)
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`${view} query failed: ${error.message}`);
  if (!data) throw new Error(`${view} returned no rows`);
  return data as T;
}

async function fetchMany<T>(view: string, orderBy?: string): Promise<T[]> {
  const supa = serviceClient();
  const q = supa
    // @ts-expect-error — redin_kpi_* views introduced in migration 019; gen-types regen pending
    .from(view)
    .select("*");
  const { data, error } = orderBy ? await q.order(orderBy) : await q;
  if (error) throw new Error(`${view} query failed: ${error.message}`);
  return (data ?? []) as T[];
}

export function getHeroPnl(): Promise<HeroPnl> {
  return fetchOne<HeroPnl>("redin_kpi_hero");
}

export function getMonthly(): Promise<MonthlyKpi[]> {
  return fetchMany<MonthlyKpi>("redin_kpi_monthly", "month");
}

export function getClientPnl(): Promise<ClientPnl[]> {
  return fetchMany<ClientPnl>("redin_kpi_client_pnl");
}

export function getPerdida(): Promise<PerdidaRow[]> {
  return fetchMany<PerdidaRow>("redin_kpi_perdida");
}

export function getPerdidaSummary(): Promise<PerdidaSummary> {
  return fetchOne<PerdidaSummary>("redin_kpi_perdida_summary");
}

export function getCarteraAging(): Promise<CarteraRow[]> {
  return fetchMany<CarteraRow>("redin_kpi_cartera_aging");
}

export function getIntegrityMonthly(): Promise<IntegrityMonthly[]> {
  return fetchMany<IntegrityMonthly>("redin_kpi_integrity", "month");
}

export function getIntegrityLifetime(): Promise<IntegrityLifetime> {
  return fetchOne<IntegrityLifetime>("redin_kpi_integrity_lifetime");
}

export async function getDataAsOf(): Promise<DataAsOf> {
  const supa = serviceClient();
  const { data, error } = await supa
    .from("ots_mirror")
    .select("synced_at", { count: "exact" })
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getDataAsOf failed: ${error.message}`);
  const { count } = await supa.from("ots_mirror").select("*", { count: "exact", head: true });
  return {
    ts: data?.synced_at ?? new Date().toISOString(),
    n: count ?? 0,
  };
}
