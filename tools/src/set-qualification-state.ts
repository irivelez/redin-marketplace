// set_qualification_state — DEPRECATED COMPATIBILITY SHIM.
//
// This tool is removed from the LLM-visible declarations in schemas.ts (the
// agent can no longer call it). The dispatch entry remains so HR-side server
// actions / dashboard API routes that still reference the old name keep
// working until Stream B retires them.
//
// Translation table (legacy state -> new data model):
//   needs_review  -> log eventos{type:'deprecated_tool_called'}; NO state flip
//                    (canonical replacement is submit_candidate_dossier).
//   qualified     -> candidate_decisions{decision:'approve', resulting_state:'approved'}
//                    + candidate_state='approved' + appsheet_sync_pending=true.
//   rejected      -> candidate_decisions{decision:'reject', resulting_state:'rejected'}
//                    + candidate_state='rejected'.
//   needs_call    -> candidate_decisions{decision:'schedule_call', resulting_state:'needs_call'}
//                    + candidate_state='needs_call'. Valid from pending only.
//   pending       -> candidate_decisions{decision:'unschedule_call', resulting_state:'pending'}
//                    + candidate_state='pending'. Valid from needs_call only.
//
// Every shim call writes eventos{type:'deprecated_tool_called', meta:{...}} so
// removal-readiness is queryable via:
//   SELECT date_trunc('day', created_at), count(*)
//   FROM eventos WHERE type='deprecated_tool_called' GROUP BY 1 ORDER BY 1;
//
// Delete this file only after the deprecation count has been zero for >= 7
// days AND Stream B's HR dashboard no longer imports/uses the old name.

import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  SetQualificationStateInput,
  SetQualificationStateOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";
import type { CandidateState, HrAction } from "@redin/shared/dossier-types";
import { normalizePhone } from "@redin/shared";

interface ShimInput {
  tecnico_id: string;
  state: string; // accepts wider range than the original type
  summary?: string;
  actor?: string;
}

const LEGACY_STATE_TO_DECISION: Record<
  string,
  { decision: HrAction; resulting_state: CandidateState }
> = {
  qualified: { decision: "approve", resulting_state: "approved" },
  rejected: { decision: "reject", resulting_state: "rejected" },
  needs_call: { decision: "schedule_call", resulting_state: "needs_call" },
  pending: { decision: "unschedule_call", resulting_state: "pending" },
};

export async function setQualificationState(
  ctx: ToolContext,
  rawInput: SetQualificationStateInput | ShimInput
): Promise<ToolResult<SetQualificationStateOutput>> {
  const input = rawInput as ShimInput;
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }
  const legacyState = (input.state ?? "").trim();
  const summary = (input.summary ?? "").trim();
  const actor = (input.actor as
    | "agent"
    | `tecnico:${string}`
    | `hr:${string}`
    | "system"
    | undefined) ?? ctx.defaultActor;

  // Always log the deprecation, regardless of branch.
  await recordEvent(ctx, {
    type: "deprecated_tool_called",
    entity_id: input.tecnico_id,
    actor,
    meta: {
      tool: "set_qualification_state",
      legacy_state: legacyState,
      summary: summary.length > 0 ? summary : null,
    },
  }).catch((e) => {
    ctx.logger.warn("deprecation event log failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  // needs_review is the agent's old "I'm done qualifying" call. Canonical
  // replacement is submit_candidate_dossier. Soft no-op so any leftover caller
  // does not crash, but no state flip happens (would be wrong without a dossier).
  if (legacyState === "needs_review") {
    ctx.logger.warn(
      "set_qualification_state(needs_review) called — use submit_candidate_dossier instead",
      { tecnico_id: input.tecnico_id }
    );
    return ok({
      tecnico_id: input.tecnico_id,
      state: "needs_review" as SetQualificationStateOutput["state"],
    });
  }

  // HR-driven legacy paths.
  const map = LEGACY_STATE_TO_DECISION[legacyState];
  if (!map) {
    return err(
      `set_qualification_state is deprecated; state '${legacyState}' is not a recognized legacy value`,
      { code: "deprecated_state" }
    );
  }

  // Read the current row to capture prior_state for the decision audit.
  const { data: tec, error: lookupErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id, candidate_state")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (lookupErr) {
    return err(`db error: ${lookupErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });

  const priorState = tec.candidate_state as CandidateState;

  // Idempotent: already in target state -> no-op.
  if (priorState === map.resulting_state) {
    return ok({
      tecnico_id: tec.tecnico_id,
      state: "already_decided",
      prior_state: priorState,
    });
  }

  // Insert the audit row.
  const { error: decErr } = await ctx.supabase
    .from("candidate_decisions")
    .insert({
      tecnico_id: tec.tecnico_id,
      dossier_id: null,
      decision: map.decision,
      resulting_state: map.resulting_state,
      prior_state: priorState,
      tono_recommendation_at_decision_time: null,
      agreed_with_tono: null,
      hr_reasoning: summary.length > 0 ? summary : null,
      decided_by:
        typeof actor === "string" && actor.startsWith("hr:")
          ? actor
          : "system:deprecated_shim",
    });
  if (decErr) {
    return err(`candidate_decisions insert failed: ${decErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  // Flip candidate_state. For 'qualified' -> 'approved', also set the AppSheet
  // sync flag so the projector picks it up.
  const patch: Partial<{
    candidate_state: CandidateState;
    appsheet_sync_pending: boolean;
  }> = {
    candidate_state: map.resulting_state,
  };
  if (map.resulting_state === "approved") {
    patch.appsheet_sync_pending = true;
  }
  if (map.resulting_state === "rejected") {
    // keep AppSheet untouched; only revoke triggers Delete.
  }

  const { error: updErr } = await ctx.supabase
    .from("tecnicos_extended")
    .update(patch)
    .eq("tecnico_id", tec.tecnico_id);
  if (updErr) {
    return err(`state flip failed: ${updErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  // B5: Pedir llamada → WA notification.
  // When the shim flips to needs_call, enqueue a WhatsApp message to the
  // worker so they know the team will call them. Idempotent: skip if a
  // pedir_llamada_notification was already enqueued within the last 24 hours.
  if (map.resulting_state === "needs_call") {
    await enqueuePedirLlamada(ctx, tec.tecnico_id, actor);
  }

  return ok({
    tecnico_id: tec.tecnico_id,
    state: legacyState as SetQualificationStateOutput["state"],
    prior_state: priorState,
  });
}

async function enqueuePedirLlamada(
  ctx: ToolContext,
  tecnicoId: string,
  actor: string
): Promise<void> {
  const { data: tecRow, error: tecErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("phone")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();

  if (tecErr || !tecRow) {
    ctx.logger.warn("pedir_llamada_notification: could not look up worker phone (skipped)", {
      tecnico_id: tecnicoId,
      error: tecErr?.message ?? "not found",
    });
    return;
  }

  const rawPhone = (tecRow as { phone: string | null }).phone ?? "";
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    ctx.logger.warn("pedir_llamada_notification: worker has no phone (skipped)", {
      tecnico_id: tecnicoId,
    });
    return;
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // Idempotency: check meta->>'notification_type' via a Postgres filter.
  // outbound_messages.kind is "text"|"document" (the WA send mode, not notification type).
  // notification_type is stored in meta so we can discriminate without a new column.
  const { data: existing } = await ctx.supabase
    .from("outbound_messages")
    .select("id")
    .eq("phone", phone)
    .gte("created_at", twentyFourHoursAgo)
    .contains("meta", { notification_type: "pedir_llamada_notification" })
    .maybeSingle();

  if (existing) {
    ctx.logger.warn("pedir_llamada_notification: already sent within 24h (skipped)", {
      tecnico_id: tecnicoId,
    });
    return;
  }

  const body =
    "Hola, soy Toño de Redin. El equipo va a llamarte pronto para conocerte mejor antes de avanzar con tu perfil. Mantente atento a tu celular.";

  const { error: insertErr } = await ctx.supabase.from("outbound_messages").insert({
    phone,
    body,
    channel: "whatsapp",
    kind: "text",
    meta: {
      notification_type: "pedir_llamada_notification",
      tecnico_id: tecnicoId,
      scheduled_by: actor,
    },
  });

  if (insertErr) {
    ctx.logger.warn("pedir_llamada_notification: outbound_messages insert failed", {
      tecnico_id: tecnicoId,
      error: insertErr.message,
    });
  } else {
    await recordEvent(ctx, {
      type: "pedir_llamada_notification_enqueued",
      entity_id: tecnicoId,
      actor: ctx.defaultActor,
      meta: { phone, scheduled_by: actor },
    }).catch((e) => {
      ctx.logger.warn("pedir_llamada_notification: evento insert failed (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }
}
