// identify_user — look up a técnico by phone. First step of every session.

import { normalizePhone } from "@redin/shared";
import type { ToolContext } from "./context";
import type {
  DossierSummary,
  IdentifyUserInput,
  IdentifyUserOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

// Candidate states for which we should attempt to attach dossier_summary.
// Skip for 'screening' (no dossier yet) and terminal states where re-asking
// is already gated elsewhere.
const STATES_WITH_DOSSIER = new Set([
  "pending",
  "needs_call",
  "approved",
  "rejected",
  "revoked",
]);

export async function identifyUser(
  ctx: ToolContext,
  input: IdentifyUserInput
): Promise<ToolResult<IdentifyUserOutput>> {
  const phone = normalizePhone(input.phone);
  if (!phone) return err("phone is required", { code: "invalid_input" });

  const { data, error } = await ctx.supabase
    .from("tecnicos_extended")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    ctx.logger.error("identify_user failed", { phone, error: error.message });
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }

  if (!data) return ok({ found: false, phone });

  // Enrich profile so the agent has nombre/ciudad/especialidades/modalidad to
  // greet, filter jobs, and avoid hallucinating "no tengo tus datos". Two sources:
  //   1) `tecnico_registered` event meta — when the worker registered through
  //      Toño (source="dashboard" / "whatsapp"); has the full profile.
  //   2) `tecnicos_mirror.data` — when the row came from the AppSheet sync;
  //      currently only nombre is reliably exposed.
  let nombre: string | null = null;
  let ciudad: string | null = null;
  let especialidades: string[] | null = null;
  let modalidad: string | null = null;

  const { data: regEvent } = await ctx.supabase
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", data.tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (regEvent?.meta && typeof regEvent.meta === "object" && !Array.isArray(regEvent.meta)) {
    const m = regEvent.meta as Record<string, unknown>;
    if (typeof m.nombre === "string" && m.nombre.trim().length > 0) nombre = m.nombre.trim();
    if (typeof m.ciudad === "string" && m.ciudad.trim().length > 0) ciudad = m.ciudad.trim();
    if (Array.isArray(m.especialidades)) {
      const esp = m.especialidades.filter(
        (e): e is string => typeof e === "string" && e.trim().length > 0
      );
      if (esp.length > 0) especialidades = esp;
    }
    if (typeof m.modalidad === "string" && m.modalidad.trim().length > 0) {
      modalidad = m.modalidad.trim();
    }
  }

  if (!nombre) {
    const { data: mirror } = await ctx.supabase
      .from("tecnicos_mirror")
      .select("data")
      .eq("row_id", data.tecnico_id)
      .maybeSingle();
    if (mirror?.data && typeof mirror.data === "object" && !Array.isArray(mirror.data)) {
      const m = mirror.data as Record<string, unknown>;
      const n = m["Nombre"] ?? m["nombre"] ?? m["NOMBRE"];
      if (typeof n === "string" && n.trim().length > 0) nombre = n.trim();
    }
  }

  // Gap A.2: attach a compact summary of the latest dossier so the agent
  // can avoid re-asking fields the worker already provided. Only for states
  // where a dossier should exist; skip for 'screening' and 'withdrawn'.
  let dossierSummary: DossierSummary | undefined;
  if (STATES_WITH_DOSSIER.has(data.candidate_state ?? "")) {
    dossierSummary = (await loadDossierSummary(ctx, data.tecnico_id)) ?? undefined;
  }

  return ok({
    found: true,
    tecnico: { ...data, nombre, ciudad, especialidades, modalidad },
    ...(dossierSummary ? { dossier_summary: dossierSummary } : {}),
  });
}

// Compact projection of candidate_dossiers.payload. We don't return the full
// payload (it contains the free-text dossier blurb and PII like cédula
// number); we return only the structured fields the agent needs to know
// "what's already on file" so it doesn't re-ask.
async function loadDossierSummary(
  ctx: ToolContext,
  tecnicoId: string
): Promise<DossierSummary | null> {
  const { data } = await ctx.supabase
    .from("candidate_dossiers")
    .select(
      "created_at, payload, tono_recommendation, tono_confidence, cedula"
    )
    .eq("tecnico_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  const p = (data.payload ?? {}) as Record<string, unknown>;
  const herramientas = (p.herramientas as Record<string, unknown> | undefined) ?? {};
  const cumplimiento = (p.cumplimiento as Record<string, unknown> | undefined) ?? {};
  const certificaciones = (p.certificaciones as Record<string, unknown> | undefined) ?? {};
  const referencias = p.referencias_externas;

  const referenciasArr = Array.isArray(referencias) ? referencias : [];

  return {
    submitted_at: data.created_at as string,
    cedula_present: !!data.cedula,
    modalidad: typeof p.modalidad === "string" ? p.modalidad : null,
    ciudad_base: typeof p.ciudad_base === "string" ? p.ciudad_base : null,
    ciudades_cobertura: Array.isArray(p.ciudades_cobertura)
      ? (p.ciudades_cobertura.filter((c) => typeof c === "string") as string[])
      : null,
    categorias_principales: Array.isArray(p.categorias_principales)
      ? (p.categorias_principales.filter((c) => typeof c === "string") as string[])
      : null,
    subcategorias: Array.isArray(p.subcategorias)
      ? (p.subcategorias.filter((c) => typeof c === "string") as string[])
      : null,
    anos_experiencia: typeof p.anos_experiencia === "number" ? p.anos_experiencia : null,
    arl_activa:
      typeof cumplimiento.arl_activa === "boolean" ? cumplimiento.arl_activa : null,
    eps_activa:
      typeof cumplimiento.eps_activa === "boolean" ? cumplimiento.eps_activa : null,
    antecedentes_limpios:
      typeof cumplimiento.antecedentes_limpios === "boolean"
        ? cumplimiento.antecedentes_limpios
        : null,
    vehiculo_propio:
      typeof herramientas.vehiculo_propio === "boolean"
        ? herramientas.vehiculo_propio
        : typeof p.tiene_vehiculo === "boolean"
          ? p.tiene_vehiculo
          : null,
    tipo_vehiculo: typeof p.tipo_vehiculo === "string" ? p.tipo_vehiculo : null,
    placa_vehiculo: typeof p.placa_vehiculo === "string" ? p.placa_vehiculo : null,
    herramientas_basicas:
      typeof herramientas.basicas === "boolean" ? herramientas.basicas : null,
    cert_altura:
      typeof certificaciones.altura === "boolean" ? certificaciones.altura : null,
    cert_retie:
      typeof certificaciones.retie === "boolean" ? certificaciones.retie : null,
    cert_andamios:
      typeof certificaciones.andamios === "boolean" ? certificaciones.andamios : null,
    has_arl_doc: !!p.arl_doc_id,
    has_eps_doc: !!p.eps_doc_id,
    has_cert_estudios_doc: !!p.cert_estudios_doc_id,
    has_cert_trabajos_doc: !!p.cert_trabajos_previos_doc_id,
    has_referencias: referenciasArr.length > 0,
    referencias_count: referenciasArr.length,
    tono_recommendation: data.tono_recommendation as
      | "recommend_approve"
      | "recommend_reject"
      | "recommend_call",
    tono_confidence: Number(data.tono_confidence ?? 0),
  };
}
