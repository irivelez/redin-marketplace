// find_legacy_by_name — fuzzy-match a worker's full name against approved
// + incomplete legacy workers (bootstrapped from AppSheet TECNICOS).
//
// Used by Toño when find_by_cedula returns not-found AND the worker has
// already provided their name during cold-path registration. If a legacy
// match surfaces, the agent must escalate via escalate_to_hr with
// reason='possible_legacy_reconciliation' — DO NOT auto-merge.
//
// Pure read. Auth-free. Loads at most ~49 candidate rows in practice.
//
// Returns a next_action so the chain that started in find_by_cedula
// (next_action='check_legacy_name_then_proceed') terminates here:
//   matches.length > 0 with similarity >= 0.80
//     -> next_action='escalate_legacy_reconciliation' (call escalate_to_hr)
//   otherwise
//     -> next_action='proceed_with_screening' (real cold worker; resume CASE B)

import type { ToolContext } from "./context";
import { ok, err, type ToolResult } from "./types";
import { findMatches, type NameMatch } from "./legacy-name-match";

export type FindLegacyByNameNextAction =
  | "escalate_legacy_reconciliation"
  | "proceed_with_screening";

export interface FindLegacyByNameInput {
  name: string;
}

export interface FindLegacyByNameOutput {
  matches: NameMatch[];
  next_action: FindLegacyByNameNextAction;
  suggested_reply: string;
}

const ESCALATION_SIMILARITY_THRESHOLD = 0.8;

export async function findLegacyByName(
  ctx: ToolContext,
  input: FindLegacyByNameInput
): Promise<ToolResult<FindLegacyByNameOutput>> {
  const name = (input.name ?? "").trim();
  if (!name) {
    return err("name required", { code: "invalid_input" });
  }
  if (name.length < 2) {
    // Too short to match meaningfully; signal "no match, proceed".
    return ok({
      matches: [],
      next_action: "proceed_with_screening",
      suggested_reply:
        "Nombre muy corto para verificar legacy. Sigamos con la calificación normal.",
    });
  }

  // Pull tecnico_ids of approved+incomplete legacy workers.
  const { data: rows, error: rowsErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("candidate_state", "approved")
    .eq("profile_complete", false)
    .eq("import_source", "appsheet_legacy_bootstrap");
  if (rowsErr) {
    return err(`db error: ${rowsErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }
  if (!rows || rows.length === 0) {
    return ok({
      matches: [],
      next_action: "proceed_with_screening",
      suggested_reply:
        "No hay técnicos legacy que se parezcan. Sigamos con la calificación normal.",
    });
  }

  // Pull display names from the legacy bootstrap eventos meta.
  const tecnicoIds = rows.map((r) => r.tecnico_id);
  const { data: events, error: evErr } = await ctx.supabase
    .from("eventos")
    .select("entity_id, meta")
    .eq("type", "tecnico_legacy_bootstrap")
    .in("entity_id", tecnicoIds);
  if (evErr) {
    return err(`db error: ${evErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  const candidates: { tecnico_id: string; nombre: string }[] = [];
  for (const ev of events ?? []) {
    if (!ev.entity_id) continue;
    const m = ev.meta as Record<string, unknown> | null;
    const n = m && typeof m === "object" ? m["nombre"] : null;
    if (typeof n === "string" && n.trim().length > 0) {
      candidates.push({ tecnico_id: ev.entity_id, nombre: n.trim() });
    }
  }

  const matches = findMatches(name, candidates);
  const hasStrongHit = matches.some(
    (m) => m.similarity >= ESCALATION_SIMILARITY_THRESHOLD
  );
  if (hasStrongHit) {
    return ok({
      matches,
      next_action: "escalate_legacy_reconciliation",
      suggested_reply:
        "Posible coincidencia con un técnico legacy. Escalando a nuestra área de talento humano para verificar.",
    });
  }
  return ok({
    matches,
    next_action: "proceed_with_screening",
    suggested_reply:
      "No hay técnicos legacy que se parezcan claramente. Sigamos con la calificación normal.",
  });
}
