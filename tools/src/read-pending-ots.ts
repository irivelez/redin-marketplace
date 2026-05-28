// read_pending_ots — list OTs currently offerable to a worker, optionally
// filtered and ranked per worker's city + speciality profile.
//
// Only OTs in state "4. Coordinar – Listo para ejecutar" are offerable. Earlier
// states aren't ready for a worker to take; later states are already in motion
// or closed. The literal must match AppSheet exactly (em-dash, "4." prefix).
//
// v1.1 — per-worker filter + rank when tecnico_id provided:
//   Hard filter: include OT iff worker.ciudad matches OR speciality overlaps.
//   Rank: especialidadFit desc → freshness desc → valor desc.
//   Cap: 5 results when tecnico_id provided.
//   Alcance: LEFT JOIN ots_extended (Stream A migration 012). Graceful degrade
//   when table doesn't exist yet or row has alcance_jsonb IS NULL.

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import type {
  PendingOtSummary,
  ReadPendingOtsInput,
  ReadPendingOtsOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";
import { especialidadFit } from "@redin/shared";

// Exported so the dashboard pipeline view (and, eventually, the AppSheet
// sync Selector) can use the same canonical literal — single source of
// truth for "the only assignable OT state".
export const OFFERABLE_ESTADO = "4. Coordinar – Listo para ejecutar";

// Cap on personalized results when tecnico_id is provided.
const PERSONALIZED_LIMIT = 5;

function descripcionFrom(data: Json): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  const candidates = ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"];
  for (const k of candidates) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

// 2026-05-28: source column switched Valor_Estimado → Total_Orden_Calculado
// per HR. Workers see the calculated total (post-cotización), not the initial
// estimate, when Toño offers jobs. Output field name kept as valor_estimado
// to avoid rippling through types, prompts, and the Manos architect tool
// (which still reads Valor_Estimado intentionally — different audience).
function valorEstimadoFrom(data: Json): { num: number | null; label: string | null } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { num: null, label: null };
  const raw = (data as Record<string, unknown>).Total_Orden_Calculado;
  if (typeof raw !== "string") return { num: null, label: null };
  const num = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return { num: null, label: null };
  const label = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(num);
  return { num, label };
}

function fechaProgramadaFrom(data: Json): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as Record<string, unknown>).Fecha_Programada;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function normalizeStr(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** True if worker city case-insensitively equals OT city. */
function ciudadMatch(workerCiudad: string | null, otCiudad: string | null): boolean {
  if (!workerCiudad || !otCiudad) return false;
  return normalizeStr(workerCiudad) === normalizeStr(otCiudad);
}

/** True if worker speciality set intersects OT speciality/subcategoria at all. */
function especialidadOverlap(
  workerEspecialidades: string[] | null,
  otEspecialidad: string | null,
  otSubcategoria: string | null,
  alcance: { especialidad?: string | null; subcategoria?: string | null } | null
): boolean {
  return especialidadFit(workerEspecialidades, otEspecialidad, otSubcategoria, alcance) > 0;
}

interface OtExtendedRow {
  ot_row_id: string;
  alcance_jsonb: Json | null;
  alcance_pdf_path: string | null;
}

/**
 * Attempt to fetch ots_extended rows for the given OT ids.
 * Gracefully returns an empty Map when the table doesn't exist yet (PGRST116 /
 * table-not-found) — Stream A's migration 012 may not be applied yet in dev.
 */
async function fetchOtsExtended(
  ctx: ToolContext,
  otIds: string[]
): Promise<Map<string, OtExtendedRow>> {
  if (otIds.length === 0) return new Map();
  try {
    const { data, error } = await ctx.supabase
      .from("ots_extended" as never)
      .select("ot_row_id, alcance_jsonb, alcance_pdf_path")
      .in("ot_row_id", otIds);
    if (error) {
      // Table may not exist yet — degrade silently.
      return new Map();
    }
    const map = new Map<string, OtExtendedRow>();
    for (const row of (data ?? []) as OtExtendedRow[]) {
      map.set(row.ot_row_id, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Extract a short alcance summary from the alcance_jsonb blob, if present. */
function alcanceSummaryFrom(alcance_jsonb: Json | null): string | null {
  if (!alcance_jsonb || typeof alcance_jsonb !== "object" || Array.isArray(alcance_jsonb))
    return null;
  const a = alcance_jsonb as Record<string, unknown>;
  if (typeof a.summary === "string" && a.summary.trim()) return a.summary.trim();
  return null;
}

/** Extract especialidad/subcategoria from alcance_jsonb blob. */
function alcanceEspecFromJsonb(
  alcance_jsonb: Json | null
): { especialidad?: string | null; subcategoria?: string | null } | null {
  if (!alcance_jsonb || typeof alcance_jsonb !== "object" || Array.isArray(alcance_jsonb))
    return null;
  const a = alcance_jsonb as Record<string, unknown>;
  return {
    especialidad: typeof a.especialidad === "string" ? a.especialidad : null,
    subcategoria: typeof a.subcategoria === "string" ? a.subcategoria : null,
  };
}

export async function readPendingOts(
  ctx: ToolContext,
  input: ReadPendingOtsInput
): Promise<ToolResult<ReadPendingOtsOutput>> {
  // When tecnico_id is provided we do per-worker filtering; cap at PERSONALIZED_LIMIT.
  // When not provided, honour the caller-supplied limit (legacy path, no cap change).
  const isPersonalized = !!input.tecnico_id;
  const fetchLimit = isPersonalized ? 100 : Math.min(Math.max(input.limit ?? 100, 1), 100);

  // Hydrate worker profile when tecnico_id is given.
  let workerCiudad: string | null = null;
  let workerEspecialidades: string[] | null = null;
  let matchedByProfile = false;

  if (isPersonalized) {
    // Pull from tecnicos_extended for the qualification gate / id check.
    const { data: tec, error: tecErr } = await ctx.supabase
      .from("tecnicos_extended")
      .select("tecnico_id")
      .eq("tecnico_id", input.tecnico_id!)
      .maybeSingle();
    if (tecErr) {
      return err(`db error: ${tecErr.message}`, { code: "db_error", retryable: true });
    }
    if (!tec) {
      return err("tecnico_id not found", { code: "not_found" });
    }

    // Worker city lives in eventos.meta.ciudad (tecnico_registered) — latest event wins.
    const { data: evts } = await ctx.supabase
      .from("eventos")
      .select("meta")
      .eq("type", "tecnico_registered")
      .eq("entity_id", input.tecnico_id!)
      .order("created_at", { ascending: false })
      .limit(1);
    const evtMeta = (evts?.[0]?.meta ?? null) as Record<string, unknown> | null;
    if (evtMeta && typeof evtMeta.ciudad === "string") {
      workerCiudad = evtMeta.ciudad;
    }
    if (evtMeta && Array.isArray(evtMeta.especialidades)) {
      workerEspecialidades = (evtMeta.especialidades as unknown[]).filter(
        (e): e is string => typeof e === "string"
      );
    }
    matchedByProfile = true;
  } else {
    matchedByProfile = false;
  }

  // Legacy ciudad/especialidad string filters (non-personalized path).
  const ciudadFilter = !isPersonalized ? input.ciudad?.trim() : undefined;
  const especialidadFilter = !isPersonalized ? input.especialidad?.trim() : undefined;

  const { data: rawOts, error } = await ctx.supabase
    .from("ots_mirror")
    .select("*")
    .eq("estado", OFFERABLE_ESTADO)
    .order("synced_at", { ascending: false })
    .limit(fetchLimit);

  if (error) {
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }

  const allOts = rawOts ?? [];

  // Fetch alcance data (LEFT JOIN equivalent — graceful degrade when table missing).
  const allOtIds = allOts.map((o) => o.row_id);
  const extendedMap = await fetchOtsExtended(ctx, allOtIds);

  // Application-side filters.
  const normalize = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const ciudadNorm = ciudadFilter ? normalize(ciudadFilter) : null;
  const especNorm = especialidadFilter ? normalize(especialidadFilter) : null;

  const ots = allOts.filter((o) => {
    if (isPersonalized) {
      // Per-worker filter: ciudad match OR speciality overlap.
      const ext = extendedMap.get(o.row_id) ?? null;
      const alcance = ext ? alcanceEspecFromJsonb(ext.alcance_jsonb) : null;
      const cityMatch = ciudadMatch(workerCiudad, o.ciudad);
      const specMatch = especialidadOverlap(
        workerEspecialidades,
        o.especialidad,
        null, // ots_mirror doesn't have subcategoria column — only in alcance
        alcance
      );
      return cityMatch || specMatch;
    }
    // Legacy path: exact substring on normalized strings.
    if (ciudadNorm && !normalize(o.ciudad ?? "").includes(ciudadNorm)) return false;
    if (especNorm && !normalize(o.especialidad ?? "").includes(especNorm)) return false;
    return true;
  });

  if (ots.length === 0) {
    return ok({ ots: [], matched_by_profile: matchedByProfile });
  }

  // Pull postulacion counts in a single query.
  const otIds = ots.map((o) => o.row_id);
  const { data: counts, error: countErr } = await ctx.supabase
    .from("postulaciones")
    .select("ot_id,state")
    .in("ot_id", otIds);
  if (countErr) {
    return err(`db error: ${countErr.message}`, { code: "db_error", retryable: true });
  }
  const totalByOt = new Map<string, number>();
  const shortlistByOt = new Map<string, number>();
  for (const row of counts ?? []) {
    totalByOt.set(row.ot_id, (totalByOt.get(row.ot_id) ?? 0) + 1);
    if (row.state === "preseleccionado" || row.state === "asignado") {
      shortlistByOt.set(row.ot_id, (shortlistByOt.get(row.ot_id) ?? 0) + 1);
    }
  }

  // Build output objects.
  interface ScoredOt {
    summary: PendingOtSummary;
    fitScore: number;
    createdMs: number;
    valorNum: number;
  }

  const scored: ScoredOt[] = ots.map((o) => {
    const data = o.data as Json;
    let createdAt: string | null = null;
    let createdMs = 0;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      const fc = d["Fecha_Creacion"];
      if (typeof fc === "string") {
        createdAt = fc;
        const ts = new Date(fc).getTime();
        if (!Number.isNaN(ts)) createdMs = ts;
      }
    }
    const valor = valorEstimadoFrom(data);
    const ext = extendedMap.get(o.row_id) ?? null;
    const alcance = ext ? alcanceEspecFromJsonb(ext.alcance_jsonb) : null;

    // FitScore for ranking within the personalized result set.
    const fitScore = especialidadFit(
      workerEspecialidades,
      o.especialidad,
      null,
      alcance
    );

    // Alcance-enriched descripcion: prefer alcance.summary, else ots_mirror.data.Descripcion.
    const alcanceSummary = ext ? alcanceSummaryFrom(ext.alcance_jsonb) : null;
    const descripcion = alcanceSummary ?? descripcionFrom(data);

    return {
      fitScore,
      createdMs,
      valorNum: valor.num ?? 0,
      summary: {
        ot_id: o.row_id,
        ciudad: o.ciudad,
        especialidad: o.especialidad,
        estado: o.estado,
        descripcion,
        postulacion_count: totalByOt.get(o.row_id) ?? 0,
        shortlist_count: shortlistByOt.get(o.row_id) ?? 0,
        created_at: createdAt,
        valor_estimado: valor.num,
        valor_estimado_label: valor.label,
        fecha_programada: fechaProgramadaFrom(data),
        // Alcance fields for worker display.
        has_alcance: ext ? ext.alcance_jsonb !== null : false,
        alcance_pdf_url: ext?.alcance_pdf_path ?? null,
      } as PendingOtSummary,
    };
  });

  if (isPersonalized) {
    // Rank: especialidadFit desc → createdAt desc (freshness) → valor desc.
    scored.sort((a, b) => {
      if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
      if (b.createdMs !== a.createdMs) return b.createdMs - a.createdMs;
      return b.valorNum - a.valorNum;
    });
    // Cap at 5.
    scored.splice(PERSONALIZED_LIMIT);
  }

  return ok({ ots: scored.map((s) => s.summary), matched_by_profile: matchedByProfile });
}
