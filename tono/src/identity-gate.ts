// Pre-LLM phone-based identity gate for Toño.
//
// Pattern mirrors manos/src/cedula-gate.ts but uses PHONE (not cédula) to
// resolve identity — because Toño receives the phone number before any
// conversation starts (WhatsApp transport gives us the sender's JID).
//
// Flow per inbound message:
//   1. Look up `tecnicos_extended` by phone (exact match via unique index).
//   2. Found  → return IdentityContext (pre-populated for [session_identity] injection).
//   3. Not found → return null (Toño routes as new caller via existing screening mode).
//   4. DB error → log + return null (fail open — never block a conversation for infra reasons).
//
// The identity context is injected into the LLM user-message context block so
// the model NEVER re-asks cédula/ciudad/nombre for a known worker regardless of
// which session this is (cross-session amnesia fix — Bug 4).

import { createLogger } from "@redin/shared";
import type { ServerClient } from "@redin/shared";

const log = createLogger("tono:identity-gate");

export interface IdentityContext {
  tecnico_id: string;
  candidate_state: string;
  /** Digits-only cédula. May be null for legacy workers not yet enriched. */
  cedula: string | null;
  nombre: string | null;
  /** Enrichment-data ciudad_base OR null. */
  ciudad_base: string | null;
  /** Top-level categorias from enrichment_data, if any. */
  categorias: string[];
  /** True if the worker was synced to AppSheet (i.e. came via legacy import). */
  appsheet_synced: boolean;
  /**
   * True when the worker is approved but has profile_complete=false.
   * Agent routing MUST land mode="enrichment" in this case.
   */
  is_legacy_incomplete: boolean;
}

type TecnicoExtendedGateRow = {
  tecnico_id: string;
  candidate_state: string;
  cedula: string | null;
  nombre: string | null;
  profile_complete: boolean;
  enrichment_data: Record<string, unknown> | null;
  appsheet_synced_at: string | null;
};

export async function runIdentityGate(
  supabase: ServerClient,
  phone: string
): Promise<IdentityContext | null> {
  let row: TecnicoExtendedGateRow | null = null;
  let dbError: string | null = null;

  try {
    const { data, error } = await supabase
      .from("tecnicos_extended")
      .select(
        "tecnico_id, candidate_state, cedula, nombre, profile_complete, enrichment_data, appsheet_synced_at"
      )
      .eq("phone", phone)
      .maybeSingle();
    if (error) {
      dbError = error.message;
    } else {
      row = data as TecnicoExtendedGateRow | null;
    }
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  if (dbError) {
    log.error("identity gate lookup failed (fail open)", { phone, error: dbError });
    return null;
  }

  if (!row?.tecnico_id) {
    return null;
  }

  const enrichment = row.enrichment_data;
  const enrichmentObj =
    enrichment && typeof enrichment === "object" && !Array.isArray(enrichment)
      ? (enrichment as Record<string, unknown>)
      : null;

  const ciudad_base = enrichmentObj ? pickString(enrichmentObj, "ciudad_base") : null;

  const categorias: string[] = [];
  if (enrichmentObj) {
    const cats = enrichmentObj["categorias_principales"];
    if (Array.isArray(cats)) {
      for (const c of cats) {
        if (typeof c === "string" && c.trim()) categorias.push(c.trim());
      }
    }
  }

  const is_legacy_incomplete =
    row.candidate_state === "approved" && !row.profile_complete;

  const ctx: IdentityContext = {
    tecnico_id: row.tecnico_id,
    candidate_state: row.candidate_state,
    cedula: row.cedula ?? null,
    nombre: row.nombre ?? null,
    ciudad_base,
    categorias,
    appsheet_synced: !!row.appsheet_synced_at,
    is_legacy_incomplete,
  };

  log.info("identity gate: resolved", {
    phone,
    tecnico_id: row.tecnico_id,
    candidate_state: row.candidate_state,
    is_legacy_incomplete,
  });

  return ctx;
}

/**
 * Serialize IdentityContext as a [session_identity] block for LLM injection.
 * Keeps the format consistent with the existing [session_state] / [session_phone] blocks.
 */
export function formatIdentityBlock(ctx: IdentityContext): string {
  const parts: string[] = [
    `tecnico_id=${ctx.tecnico_id}`,
    `candidate_state=${ctx.candidate_state}`,
    `nombre=${ctx.nombre ?? "desconocido"}`,
    `cedula=${ctx.cedula ?? "pendiente"}`,
    `ciudad_base=${ctx.ciudad_base ?? "desconocida"}`,
    `categorias=${ctx.categorias.length > 0 ? ctx.categorias.join(", ") : "ninguna"}`,
    `appsheet_synced=${ctx.appsheet_synced}`,
    `is_legacy_incomplete=${ctx.is_legacy_incomplete}`,
  ];
  return `[session_identity: ${parts.join(", ")}]`;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}
