// submit_candidate_dossier — Toño's structured handoff.
//
// Atomic operation:
//   1. Validate payload per contract §4.4
//   2. Run cedula merge per §6.3 (collision with existing screening/withdrawn)
//   3. Insert candidate_dossiers row (immutable, append-only)
//   4. Flip candidate_state to 'pending' (state ALWAYS lands in pending; the
//      recommendation triplet is just a hint to HR — graduated autonomy)
//   5. Log eventos{type:'candidate_dossier_submitted'}
//   6. Return typed outcome code per §4.3
//
// The 6 outcome codes (FROM dossier-types.SubmitDossierCode):
//   submitted        clean submission
//   merged           cedula matched another tecnico in screening|withdrawn;
//                    rows merged, dossier landed against canonical id
//   already_decided  cedula matches approved|pending|needs_call — agent must
//                    tell worker "ya estás registrado", no re-screen
//   blocked          cedula matches rejected|revoked — agent must escalate
//   cedula_conflict  format invalid or collision the agent must resolve
//   invalid_payload  schema validation failed — agent retries once

import type { ToolContext } from "./context";
import type { Json } from "@redin/shared";
import { ok, err, type ToolResult } from "./types";
import { recordEvent } from "./events";
import {
  CIUDAD_CANONICAL,
  CATEGORIA_VALUES,
  SUBCATEGORIA_BY_CATEGORIA,
  SUBCATEGORIA_VALUES,
  TONO_RECOMMENDATION_VALUES,
  type CandidateDossier,
  type CandidateState,
  type SubmitCandidateDossierInput,
  type SubmitCandidateDossierOutput,
  type SubmitDossierCode,
  type Categoria,
} from "@redin/shared/dossier-types";

const CIUDAD_SET = new Set<string>(CIUDAD_CANONICAL);
const CATEGORIA_SET = new Set<string>(CATEGORIA_VALUES);
const SUBCAT_SET = new Set<string>(SUBCATEGORIA_VALUES);
const RECOMMENDATION_SET = new Set<string>(TONO_RECOMMENDATION_VALUES);

const DOSSIER_MAX_CHARS = 2000;
const REASONING_MIN = 10;
const REASONING_MAX = 500;
// Colombian plate after uppercase + strip whitespace/hyphens.
// Cars: 3 letras + 3 dígitos (ABC123). Motos: 3 letras + 2 dígitos + 1 letra (ABC12D).
const PLACA_RE = /^[A-Z]{3}[0-9]{2,3}[A-Z]?$/;
const ALREADY_DECIDED_STATES: ReadonlySet<CandidateState> = new Set<CandidateState>([
  "approved",
  "pending",
  "needs_call",
]);
const BLOCKED_STATES: ReadonlySet<CandidateState> = new Set<CandidateState>([
  "rejected",
  "revoked",
]);
const MERGEABLE_STATES: ReadonlySet<CandidateState> = new Set<CandidateState>([
  "screening",
  "withdrawn",
]);

interface ValidatedDossier {
  dossier: CandidateDossier;
  warnings: string[];
}

function normalizeCedula(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

// Conditional vehicle check. Mirrors register_tecnico.validateIdentity's
// envelope so the agent's REGLA ABSOLUTA handles re-prompting uniformly.
//   tiene_vehiculo === undefined: never asked. ok, no plate.
//   tiene_vehiculo === false:     must NOT have tipo or placa. else INVALID_VEHICLE.
//   tiene_vehiculo === true:      must have tipo + plate matching PLACA_RE.
function validateVehicle(raw: CandidateDossier):
  | { ok: true; placa?: string }
  | {
      ok: false;
      error: "INVALID_VEHICLE";
      next_action: "ask_placa" | "ask_tipo_vehiculo" | "ask_vehicle_consistency";
      missing: ("placa" | "tipo_vehiculo" | "vehicle_consistency")[];
      user_message_hint: string;
    } {
  const tiene = raw.tiene_vehiculo;
  const tipoRaw = (raw.tipo_vehiculo ?? "").trim();
  const placaRaw = (raw.placa_vehiculo ?? "").trim();

  if (tiene === undefined || tiene === null) {
    // Never asked. Worker skipped the question — valid.
    return { ok: true };
  }

  if (tiene === false) {
    // Worker said no — there must be no plate or type leaked through.
    if (tipoRaw.length > 0 || placaRaw.length > 0) {
      return {
        ok: false,
        error: "INVALID_VEHICLE",
        next_action: "ask_vehicle_consistency",
        missing: ["vehicle_consistency"],
        user_message_hint:
          "Dijiste que no tienes vehículo pero me pasaste placa o tipo; aclárame: ¿tienes vehículo o no?",
      };
    }
    return { ok: true };
  }

  // tiene === true — require tipo and placa.
  if (tipoRaw.length === 0) {
    return {
      ok: false,
      error: "INVALID_VEHICLE",
      next_action: "ask_tipo_vehiculo",
      missing: ["tipo_vehiculo"],
      user_message_hint: "¿Qué tipo de vehículo es — moto, carro, camioneta?",
    };
  }

  const placaNorm = placaRaw.toUpperCase().replace(/[\s-]/g, "");
  if (!PLACA_RE.test(placaNorm)) {
    return {
      ok: false,
      error: "INVALID_VEHICLE",
      next_action: "ask_placa",
      missing: ["placa"],
      user_message_hint:
        "Necesito la placa del vehículo, por ejemplo ABC123 (carro) o ABC12D (moto).",
    };
  }

  return { ok: true, placa: placaNorm };
}

// validatePayload return shape.
//   ok=true: normalized dossier ready to persist
//   ok=false: error message + optional next_action envelope.
//     The next_action arm mirrors register_tecnico's INCOMPLETE_IDENTITY rejection
//     so the agent can re-prompt the worker without changing flow.
interface ValidatePayloadFail {
  ok: false;
  error: string;
  code?: string;
  next_action?: string;
  missing?: string[];
  user_message_hint?: string;
}

function validatePayload(
  raw: CandidateDossier
): { ok: true; result: ValidatedDossier } | ValidatePayloadFail {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "dossier must be an object" };
  }
  const warnings: string[] = [];

  // Cedula
  if (!raw.cedula || typeof raw.cedula !== "object") {
    return { ok: false, error: "cedula required" };
  }
  if (!["CC", "CE", "PEP"].includes(raw.cedula.tipo)) {
    return { ok: false, error: `cedula.tipo invalid: ${raw.cedula.tipo}` };
  }
  const numero = normalizeCedula(raw.cedula.numero ?? "");
  if (numero.length < 5 || numero.length > 11) {
    return { ok: false, error: "cedula.numero must be 5-11 digits" };
  }

  // Modalidad
  if (!["individual", "cuadrilla", "lider"].includes(raw.modalidad)) {
    return { ok: false, error: `modalidad invalid: ${raw.modalidad}` };
  }

  // Categorias principales
  if (!Array.isArray(raw.categorias_principales) || raw.categorias_principales.length === 0) {
    return { ok: false, error: "categorias_principales must be a non-empty array" };
  }
  for (const c of raw.categorias_principales) {
    if (!CATEGORIA_SET.has(c)) {
      return { ok: false, error: `unknown categoria: ${c}` };
    }
  }
  if (raw.categorias_principales.length > 4) {
    warnings.push(
      `categorias_principales has ${raw.categorias_principales.length} entries (>4). Accepted but flagged.`
    );
  }

  // Subcategorias
  if (!Array.isArray(raw.subcategorias) || raw.subcategorias.length === 0) {
    return { ok: false, error: "subcategorias must be a non-empty array" };
  }
  for (const s of raw.subcategorias) {
    if (!SUBCAT_SET.has(s)) {
      return { ok: false, error: `unknown subcategoria: ${s}` };
    }
  }
  // Soft check: each subcategoria belongs to a categoria in categorias_principales.
  const allowedSubs = new Set<string>();
  for (const c of raw.categorias_principales) {
    for (const sub of SUBCATEGORIA_BY_CATEGORIA[c as Categoria] ?? []) {
      allowedSubs.add(sub);
    }
  }
  const orphans = raw.subcategorias.filter((s) => !allowedSubs.has(s));
  if (orphans.length > 0) {
    warnings.push(
      `subcategorias not under declared categorias_principales: ${orphans.join(", ")}`
    );
  }

  // Ciudad
  let ciudadBase = raw.ciudad_base as string;
  if (!CIUDAD_SET.has(ciudadBase)) {
    warnings.push(`ciudad_base "${ciudadBase}" not canonical; HR will reconcile`);
    // Coerce keeps the agent's value but flags it. HR sees the gap.
  }

  // Anos experiencia
  if (
    typeof raw.anos_experiencia !== "number" ||
    !Number.isFinite(raw.anos_experiencia) ||
    raw.anos_experiencia < 0 ||
    raw.anos_experiencia > 60
  ) {
    return { ok: false, error: "anos_experiencia must be a number in [0, 60]" };
  }

  // Recommendation triplet
  if (!RECOMMENDATION_SET.has(raw.tono_recommendation)) {
    return { ok: false, error: `tono_recommendation invalid: ${raw.tono_recommendation}` };
  }
  if (
    typeof raw.tono_confidence !== "number" ||
    !Number.isFinite(raw.tono_confidence) ||
    raw.tono_confidence < 0 ||
    raw.tono_confidence > 1
  ) {
    return { ok: false, error: "tono_confidence must be a number in [0, 1]" };
  }
  const reasoning = (raw.tono_reasoning ?? "").trim();
  if (reasoning.length < REASONING_MIN || reasoning.length > REASONING_MAX) {
    return {
      ok: false,
      error: `tono_reasoning must be ${REASONING_MIN}-${REASONING_MAX} chars`,
    };
  }

  // Dossier free-text
  let dossierText = raw.dossier ?? "";
  if (typeof dossierText !== "string") {
    return { ok: false, error: "dossier must be a string" };
  }
  if (dossierText.length > DOSSIER_MAX_CHARS) {
    warnings.push(`dossier truncated from ${dossierText.length} to ${DOSSIER_MAX_CHARS} chars`);
    dossierText = dossierText.slice(0, DOSSIER_MAX_CHARS);
  }

  // gaps
  const gaps = Array.isArray(raw.gaps) ? raw.gaps.filter((g) => typeof g === "string") : [];

  // Vehicle gate. Mirrors register_tecnico.validateIdentity. If tiene_vehiculo
  // is true the agent must supply tipo + valid Colombian plate; on rejection we
  // surface the rich envelope so the agent re-prompts via REGLA ABSOLUTA.
  const vehCheck = validateVehicle(raw);
  if (!vehCheck.ok) {
    return {
      ok: false,
      error: vehCheck.error,
      code: "INVALID_VEHICLE",
      next_action: vehCheck.next_action,
      missing: vehCheck.missing,
      user_message_hint: vehCheck.user_message_hint,
    };
  }
  const placaNormalized = vehCheck.placa;

  // Compute missing_optional: which optional doc fields were NOT provided.
  // NOTE: "missing" here means "no document uploaded" — independent of whether
  // the worker self-declared having the doc in `cumplimiento` (arl_activa/eps_activa).
  // HR badges should reflect that distinction (see QueueListClient labels).
  const missingOptional: string[] = [];
  if (!raw.cert_estudios_doc_id) missingOptional.push("cert_estudios");
  if (!raw.cert_trabajos_previos_doc_id) missingOptional.push("cert_trabajos_previos");
  if (raw.tiene_vehiculo === undefined || raw.tiene_vehiculo === null) {
    missingOptional.push("vehiculo");
  }
  if (!raw.arl_doc_id) missingOptional.push("ARL");
  if (!raw.eps_doc_id) missingOptional.push("EPS");

  // 2026-05-25 locked decision #3 — EPS NEVER blocks. Preferred-only signal.
  // Same for ARL (locked 2026-05-23): tie-breaker, not blocker. Redin can
  // provide both to the worker. Previously this handler auto-downgraded
  // recommend_approve → recommend_call when EPS was missing, with misleading
  // wording ("estado EPS desconocido") that didn't reflect what the worker
  // actually said. That logic was removed; both ARL and EPS now produce
  // descriptive gap entries only, and the recommendation passes through
  // exactly as Toño produced it.
  const finalRecommendation = raw.tono_recommendation;
  const finalConfidence = raw.tono_confidence;
  const finalReasoning = reasoning;
  const cumplimiento = raw.cumplimiento ?? { arl_activa: false, eps_activa: false, antecedentes_limpios: null };

  if (cumplimiento.arl_activa === true && !raw.arl_doc_id) {
    gaps.push("ARL declarada sin documento — Redin puede pedir el carné en validación");
  } else if (cumplimiento.arl_activa === false) {
    gaps.push("Sin ARL declarada — Redin puede proveerla");
  }

  if (cumplimiento.eps_activa === true && !raw.eps_doc_id) {
    gaps.push("EPS declarada sin documento — Redin puede pedir el carné en validación");
  } else if (cumplimiento.eps_activa === false) {
    gaps.push("Sin EPS declarada — Redin puede orientar al técnico");
  } else if (cumplimiento.eps_activa == null) {
    gaps.push("EPS no abordada en el screening");
  }

  const normalized: CandidateDossier = {
    schema_version: 1,
    cedula: { tipo: raw.cedula.tipo, numero },
    modalidad: raw.modalidad,
    categorias_principales: raw.categorias_principales,
    subcategorias: raw.subcategorias,
    anos_experiencia: raw.anos_experiencia,
    anos_por_categoria: raw.anos_por_categoria,
    ciudad_base: raw.ciudad_base,
    ciudades_cobertura: raw.ciudades_cobertura,
    certificaciones: raw.certificaciones ?? {
      altura: false,
      altura_avanzado: false,
      retie: false,
      andamios: false,
      soldadura: false,
      conte: false,
    },
    herramientas: raw.herramientas ?? {
      basicas: false,
      electrica_obra: false,
      electrica_medicion: false,
      altura_personal: false,
      andamio_propio: false,
      vehiculo_propio: false,
    },
    disponibilidad: raw.disponibilidad ?? {
      inicio_inmediato: false,
      fines_de_semana: false,
      nocturno: false,
      viaja_otra_ciudad: false,
    },
    cumplimiento,
    referencias_externas: raw.referencias_externas,
    dossier: dossierText,
    // Optional doc fields — undefined if not provided
    cert_estudios_doc_id: raw.cert_estudios_doc_id ?? undefined,
    cert_trabajos_previos_doc_id: raw.cert_trabajos_previos_doc_id ?? undefined,
    tiene_vehiculo: raw.tiene_vehiculo ?? undefined,
    tipo_vehiculo: raw.tipo_vehiculo ?? undefined,
    placa_vehiculo: placaNormalized ?? undefined,
    arl_doc_id: raw.arl_doc_id ?? undefined,
    eps_doc_id: raw.eps_doc_id ?? undefined,
    missing_optional: missingOptional,
    tono_recommendation: finalRecommendation,
    tono_confidence: finalConfidence,
    tono_reasoning: finalReasoning,
    gaps,
  };

  return { ok: true, result: { dossier: normalized, warnings } };
}

interface CedulaMatchRow {
  tecnico_id: string;
  candidate_state: CandidateState;
  phone: string;
  last_jid: string | null;
  onboarded_at: string;
}

async function findCedulaCollision(
  ctx: ToolContext,
  cedula: string,
  excludeTecnicoId: string
): Promise<CedulaMatchRow | null> {
  const { data, error } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id, candidate_state, phone, last_jid, onboarded_at")
    .eq("cedula", cedula)
    .neq("tecnico_id", excludeTecnicoId)
    .maybeSingle();
  if (error) throw new Error(`cedula collision lookup failed: ${error.message}`);
  return (data as CedulaMatchRow | null) ?? null;
}

// §6.3 cedula merge: pick older tecnico as canonical, repoint references,
// drop the newer row, log eventos. Returns the canonical tecnico_id and the
// canonical state AFTER any 'withdrawn -> screening' resume.
async function performCedulaMerge(
  ctx: ToolContext,
  agentTecnicoId: string,
  agentRow: CedulaMatchRow,
  collidingRow: CedulaMatchRow
): Promise<{ effective_tecnico_id: string; resumed_from_withdrawn: boolean }> {
  // Older onboarded_at wins as canonical.
  const agentOlder =
    new Date(agentRow.onboarded_at).getTime() <
    new Date(collidingRow.onboarded_at).getTime();
  const canonical = agentOlder ? agentRow : collidingRow;
  const dropped = agentOlder ? collidingRow : agentRow;

  // Tables that hold a real tecnico_id reference column. Sessions and
  // messages are phone-keyed and migrate implicitly with the phone update
  // on the canonical row, so they're not in this list.
  const referenceTables = [
    "postulaciones",
    "eventos",
    "qualification_calls",
    "tecnico_evaluations",
    "candidate_dossiers",
    "candidate_decisions",
    "hr_notes",
    "contratos",
    "documentos",
  ] as const;

  for (const t of referenceTables) {
    const column = t === "eventos" ? "entity_id" : "tecnico_id";
    const { error } = await ctx.supabase
      .from(t as any)
      .update({ [column]: canonical.tecnico_id })
      .eq(column, dropped.tecnico_id);
    if (error) {
      // Defensive: log but continue. The CASCADE on FK ensures the
      // subsequent DELETE of the dropped row won't hit a violation.
      ctx.logger.warn("merge: reference update soft-failed", {
        table: t,
        error: error.message,
      });
    }
  }

  // The canonical row's phone needs to land on the new (live) phone the worker
  // is messaging from, but tecnicos_extended.phone is UNIQUE — both rows
  // currently hold phones, so we must DELETE the duplicate before UPDATING
  // canonical's phone, otherwise the UNIQUE constraint trips. Order:
  //   1. References moved (above)
  //   2. DELETE dropped row (frees its phone for canonical to take)
  //   3. UPDATE canonical with new phone + state-flip patch
  const newPhone = (agentOlder ? collidingRow : agentRow).phone;
  const newJid = (agentOlder ? collidingRow : agentRow).last_jid;
  const canonicalPatch: Partial<{
    phone: string;
    last_jid: string;
    candidate_state: CandidateState;
    withdrawal_reason: string | null;
  }> = {
    phone: newPhone,
  };
  if (newJid) canonicalPatch.last_jid = newJid;

  // Resume from withdrawn -> screening per §6.3 step 6.
  let resumedFromWithdrawn = false;
  if (canonical.candidate_state === "withdrawn") {
    canonicalPatch.candidate_state = "screening";
    canonicalPatch.withdrawal_reason = null;
    resumedFromWithdrawn = true;
  }

  // Drop dropped row first to release its phone from the UNIQUE index.
  const { error: delErr } = await ctx.supabase
    .from("tecnicos_extended")
    .delete()
    .eq("tecnico_id", dropped.tecnico_id);
  if (delErr) throw new Error(`drop merged row failed: ${delErr.message}`);

  const { error: updErr } = await ctx.supabase
    .from("tecnicos_extended")
    .update(canonicalPatch)
    .eq("tecnico_id", canonical.tecnico_id);
  if (updErr) throw new Error(`canonical update failed: ${updErr.message}`);

  await recordEvent(ctx, {
    type: "cedula_merged",
    entity_id: canonical.tecnico_id,
    actor: ctx.defaultActor,
    meta: {
      kept_id: canonical.tecnico_id,
      dropped_id: dropped.tecnico_id,
      prior_phone: canonical.phone,
      new_phone: newPhone,
      resumed_from_withdrawn: resumedFromWithdrawn,
    },
  });

  return {
    effective_tecnico_id: canonical.tecnico_id,
    resumed_from_withdrawn: resumedFromWithdrawn,
  };
}

export async function submitCandidateDossier(
  ctx: ToolContext,
  input: SubmitCandidateDossierInput
): Promise<ToolResult<SubmitCandidateDossierOutput>> {
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }

  const validation = validatePayload(input.dossier);
  if (!validation.ok) {
    // Rich envelope (next_action present) = the agent must re-prompt the
    // worker per REGLA ABSOLUTA. Plain validation error = retry-or-escalate
    // path via the `invalid_payload` outcome code.
    if (validation.next_action) {
      return err(validation.error, {
        code: validation.code,
        next_action: validation.next_action,
        missing: validation.missing,
        user_message_hint: validation.user_message_hint,
      });
    }
    const out: SubmitCandidateDossierOutput = {
      code: "invalid_payload",
      effective_tecnico_id: input.tecnico_id,
      error: validation.error,
    };
    return ok(out);
  }
  const { dossier, warnings } = validation.result;
  const cedula = dossier.cedula.numero;

  // Lookup the agent's row.
  const { data: agentRowData, error: agentErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id, candidate_state, phone, last_jid, onboarded_at, cedula")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (agentErr) {
    return err(`db error: ${agentErr.message}`, { code: "db_error", retryable: true });
  }
  if (!agentRowData) return err("tecnico_id not found", { code: "not_found" });
  const agentRow: CedulaMatchRow = agentRowData as CedulaMatchRow;

  // If the agent's row already has a different cedula bound, this is a conflict.
  const existingAgentCedula = (agentRowData as { cedula: string | null }).cedula;
  if (existingAgentCedula && existingAgentCedula !== cedula) {
    const out: SubmitCandidateDossierOutput = {
      code: "cedula_conflict",
      effective_tecnico_id: input.tecnico_id,
      error: "cedula on this row already differs from submitted",
    };
    return ok(out);
  }

  // Cedula collision detection.
  let effectiveTecnicoId = input.tecnico_id;
  let resumedFromWithdrawn = false;
  let mergeOccurred = false;

  const collision = await findCedulaCollision(ctx, cedula, input.tecnico_id);
  if (collision) {
    if (ALREADY_DECIDED_STATES.has(collision.candidate_state)) {
      const out: SubmitCandidateDossierOutput = {
        code: "already_decided",
        effective_tecnico_id: collision.tecnico_id,
        existing_state: collision.candidate_state,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
      return ok(out);
    }
    if (BLOCKED_STATES.has(collision.candidate_state)) {
      const out: SubmitCandidateDossierOutput = {
        code: "blocked",
        effective_tecnico_id: collision.tecnico_id,
        existing_state: collision.candidate_state,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
      return ok(out);
    }
    if (MERGEABLE_STATES.has(collision.candidate_state)) {
      try {
        const merge = await performCedulaMerge(ctx, input.tecnico_id, agentRow, collision);
        effectiveTecnicoId = merge.effective_tecnico_id;
        resumedFromWithdrawn = merge.resumed_from_withdrawn;
        mergeOccurred = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`cedula merge failed: ${msg}`, { code: "merge_failed", retryable: true });
      }
    } else {
      // Defensive: any other state is unexpected.
      const out: SubmitCandidateDossierOutput = {
        code: "cedula_conflict",
        effective_tecnico_id: collision.tecnico_id,
        existing_state: collision.candidate_state,
        error: `unexpected colliding state: ${collision.candidate_state}`,
      };
      return ok(out);
    }
  }

  // Write the cedula on the effective row if not already set.
  {
    const { error: cedUpdErr } = await ctx.supabase
      .from("tecnicos_extended")
      .update({ cedula })
      .eq("tecnico_id", effectiveTecnicoId)
      .is("cedula", null);
    if (cedUpdErr) {
      // 23505 = unique violation. Already-bound cedula on a different row beat us.
      if (cedUpdErr.code === "23505") {
        return err(
          "cedula uniqueness violated mid-flight; retry would land on the canonical row",
          { code: "cedula_conflict", retryable: true }
        );
      }
      ctx.logger.warn("cedula update soft-failed", { error: cedUpdErr.message });
    }
  }

  // Insert the dossier.
  const { data: dossierRow, error: dossierErr } = await ctx.supabase
    .from("candidate_dossiers")
    .insert({
      tecnico_id: effectiveTecnicoId,
      session_id: ctx.session_id ?? null,
      submitted_by: "agent",
      payload: dossier as unknown as Json,
      cedula,
      tono_recommendation: dossier.tono_recommendation,
      tono_confidence: dossier.tono_confidence,
      tono_reasoning: dossier.tono_reasoning,
    })
    .select("id")
    .single();
  if (dossierErr) {
    return err(`dossier insert failed: ${dossierErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  // Flip candidate_state to 'pending'. State always lands in pending; HR
  // makes the final decision (graduated autonomy — Toño only recommends).
  const { error: stateErr } = await ctx.supabase
    .from("tecnicos_extended")
    .update({ candidate_state: "pending" })
    .eq("tecnico_id", effectiveTecnicoId);
  if (stateErr) {
    return err(`state flip failed: ${stateErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "candidate_dossier_submitted",
    entity_id: effectiveTecnicoId,
    actor: ctx.defaultActor,
    meta: {
      dossier_id: dossierRow.id,
      tono_recommendation: dossier.tono_recommendation,
      tono_confidence: dossier.tono_confidence,
      merge_occurred: mergeOccurred,
      resumed_from_withdrawn: resumedFromWithdrawn,
    },
  });

  const out: SubmitCandidateDossierOutput = {
    code: mergeOccurred ? ("merged" as SubmitDossierCode) : "submitted",
    dossier_id: dossierRow.id,
    effective_tecnico_id: effectiveTecnicoId,
    resulting_state: "pending",
    warnings: warnings.length > 0 ? warnings : undefined,
  };
  return ok(out);
}
