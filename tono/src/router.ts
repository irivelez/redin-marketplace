// Tool router — policy enforcement layer (PRD §19).
//
// This module is the single enforcement point for ALL tool-call rules that cannot
// be trusted to the LLM. Pure functions operating over (TurnSession, toolName,
// toolArgs, toolResult). No I/O, no side effects.
//
// Rule catalogue:
//   Rule 1 — Identify-first + auth gating
//   Rule 2 — Session-bound tecnico_id override (anti-auth-bypass)
//   Rule 3 — Max 5 tool calls per user turn (2026-05-16: bumped from 3.
//            Cap of 3 was being hit during legitimate screening turns where
//            the model wants identify_user → find_by_cedula → register_tecnico
//            or similar chains; the resulting refusal terminated the loop
//            and left the user with an empty reply.)
//   Rule 4 — ≥50-row truncation, ranked, with "y hay más" marker

import type { ToolResult } from "@redin/tools";

// ---------- Session state ----------

// TurnSession is created fresh per handleMessage call and lives only for the
// duration of one user turn. It is NOT persisted — DB session is separate.
export interface TurnSession {
  /** Set after identify_user returns found=true, or after register_tecnico succeeds. */
  tecnico_id: string | null;
  /** Increments each time the router dispatches a tool. Blocked at 5. */
  toolCallCount: number;
  /**
   * Snapshot of `tecnicos_extended.candidate_state` at turn start. Pre-loaded
   * by the agent before any tool fires. Used by Rule 1c to block job-search
   * and apply tools for non-approved workers (Gap A.4). `null` means we
   * haven't loaded it yet — Rule 1c treats null as "not approved" defensively.
   */
  candidate_state: string | null;
  /**
   * The canonical WhatsApp identity phone for this turn (the session's
   * normalized phone / JID-derived phone). Pre-loaded by the agent. Used by
   * Rule 2b (phone override) to force `register_tecnico` and `identify_user`
   * to use the WA jid as the row identity — never the typed contact number
   * the LLM might extract from the chat body.
   *
   * Background: 2026-05-25 Camilo test showed the LLM passing
   * register_tecnico({phone: "3132022942"}) — the user-TYPED Colombian
   * contact phone — instead of the session WA jid +137877543452841. The row
   * was created with the wrong identity, breaking identityGate on every
   * subsequent turn and blocking all auth-gated tools with `not_identified`.
   * `null` means the agent didn't preload it; override falls open.
   */
  session_phone: string | null;
}

export function createTurnSession(): TurnSession {
  return {
    tecnico_id: null,
    toolCallCount: 0,
    candidate_state: null,
    session_phone: null,
  };
}

// ---------- Auth-gated tool set ----------

// These tools require an identified técnico. Everything else is auth-free.
// Single source of truth — not scattered across tool files.
//
// Stream A additions (2026-05-07):
// - submit_candidate_dossier — needs tecnico_id; takes tecnico_id arg
// - mark_candidate_withdrawn — needs tecnico_id; takes tecnico_id arg
// - complete_legacy_profile  — needs tecnico_id; takes tecnico_id arg
// - find_by_cedula           — pure read; auth-free; no tecnico_id arg
const AUTH_GATED_TOOLS = new Set([
  "create_postulacion",
  "upload_documento",
  "read_my_postulaciones",
  "read_my_contratos",
  "submit_candidate_dossier",
  "mark_candidate_withdrawn",
  "complete_legacy_profile",
]);

// Tools whose args may carry a tecnico_id that the LLM supplied and that MUST
// be overridden by session.tecnico_id before dispatch (PRD §19 rule 3 / §20).
const TOOLS_WITH_TECNICO_ID_ARG = new Set([
  "create_postulacion",
  "upload_documento",
  "read_my_postulaciones",
  "read_my_contratos",
  "read_pending_ots", // optional arg, but must still be session-bound when present
  "submit_candidate_dossier",
  "mark_candidate_withdrawn",
  "complete_legacy_profile",
]);

// Tools whose `phone` arg names the worker's WA identity (the row's primary
// phone in tecnicos_extended). These MUST be session-bound to prevent the
// LLM from substituting a different number the user typed in chat. See
// TurnSession.session_phone doc above for the Camilo regression that
// motivated this gate. `escalate_to_hr` is intentionally excluded — HR
// escalation may reference an arbitrary phone in its payload.
const TOOLS_WITH_PHONE_ARG = new Set([
  "identify_user",
  "register_tecnico",
]);

// ---------- Approval-gated tools (Gap A.4 fix) ----------
//
// These tools surface or commit JOB-RELATED actions. They are only valid for
// workers in candidate_state='approved'. For any other state (pending,
// needs_call, screening, rejected, withdrawn, revoked) calling these tools
// is a UX violation — it tells the worker they have a job to apply to
// before HR has approved them, which contradicts pending_review's stop.
//
// Background: 2026-05-22 22:13 UTC live test showed the LLM calling
// read_pending_ots in pending_review mode after Alberto pushed back with
// frustration ("Ya te he dicho que estoy en popayan"). The model's
// thinking-budget concluded "I should help him by showing what's there"
// and produced a real OT in chat ("Plan de mantenimiento RACOL Popayán
// — $1,259,100"), then contradicted itself the next turn ("no, aún no
// estás autorizado"). Prompt rule was insufficient — needs router gate.
const APPROVAL_GATED_TOOLS = new Set([
  "read_pending_ots",   // showing jobs to non-approved = false expectation
  "create_postulacion", // already gated tool-side, but block here too for clarity
]);

// ---------- Tools always allowed before identification ----------
// identify_user is the obvious one. find_by_cedula is also pre-identify because
// it's the lookup that bridges cedula → tecnico_id. log_event for *refusals*
// is allowed because the refusal protocol fires before any other tool.
// Everything ELSE the model might want to call (read_pending_ots,
// register_tecnico, escalate_to_hr, log_event for non-refused events, etc)
// must wait until identify_user runs. This catches the model hallucinating
// log_event(type='session_start') as a polite first move — see Gap A.1.
const PRE_IDENTIFY_TOOLS = new Set([
  "identify_user",
  "find_by_cedula",
]);

// ---------- Rule 1: identify-first + auth gating ----------

export interface RouterRefusal {
  kind: "refusal";
  result: ToolResult<never>;
}

export interface RouterTerminal {
  kind: "terminal"; // agent loop should stop after this
  result: ToolResult<never>;
}

export interface RouterAllow {
  kind: "allow";
  /** Possibly-mutated args (Rule 2 applied). */
  args: Record<string, unknown>;
}

export type PreDispatchDecision = RouterRefusal | RouterTerminal | RouterAllow;

/**
 * Check whether a tool call should be dispatched, applying rules 1–3 in order.
 * Mutates `session.toolCallCount` on allow.
 */
export function preDispatch(
  session: TurnSession,
  toolName: string,
  rawArgs: Record<string, unknown>
): PreDispatchDecision {
  // Rule 3 — max 5 tool calls per user turn. Check FIRST so the counter stays
  // accurate even if rule 1 or 2 fires later.
  if (session.toolCallCount >= 5) {
    return {
      kind: "terminal",
      result: {
        ok: false,
        error:
          "Ya miré varias cosas — déjame responder con lo que tengo.",
        code: "max_tools_reached",
      },
    };
  }

  // Rule 1 — auth-gated tools require an identified técnico.
  if (AUTH_GATED_TOOLS.has(toolName) && session.tecnico_id === null) {
    return {
      kind: "refusal",
      result: {
        ok: false,
        error:
          "Antes de esto necesito saber quién eres — dame tu cédula o el número de teléfono que usas aquí.",
        code: "not_identified",
      },
    };
  }

  // Rule 1c — approval-gated tools (Gap A.4).
  //
  // Job-search and apply tools only fire when the worker is candidate_state=
  // 'approved'. Anything else (pending, needs_call, screening, rejected,
  // withdrawn, revoked, or null) blocks. Prevents Toño from showing real OTs
  // to non-approved workers — which produced the 2026-05-22 22:13 UTC test's
  // contradiction (showed RACOL OT to Alberto in 'pending' state, then
  // immediately said "no estás autorizado").
  //
  // The block returns a `next_action="explain_pending"` so the LLM tells
  // the worker queue-status instead of trying again.
  if (
    APPROVAL_GATED_TOOLS.has(toolName) &&
    session.candidate_state !== "approved"
  ) {
    return {
      kind: "refusal",
      result: {
        ok: false,
        error:
          "El técnico no está aprobado — no le muestres trabajos ni lo postules. Dile que su perfil sigue en revisión.",
        code: "not_approved_yet",
        next_action: "explain_pending",
        user_message_hint:
          session.candidate_state === "pending" || session.candidate_state === "needs_call"
            ? "Tu perfil está en revisión con el equipo. Apenas decidan, te aviso por aquí y te muestro los trabajos que hay para ti."
            : "Tu perfil todavía no está autorizado para postularte. Si quieres avanzar, escríbenos y validamos.",
      },
    };
  }

  // Rule 1b — identify-first enforcement.
  //
  // Even though most tools are auth-free (log_event, read_pending_ots,
  // escalate_to_hr, etc), the system contract requires `identify_user` to be
  // the FIRST tool of a session so we know whether to route screening /
  // pending_review / enrichment / returning before doing anything else.
  // Without this guard the LLM can (and has) called log_event(session_start)
  // as a "polite" first move, hallucinating both the type and the need —
  // then return empty text and trigger the agent.ts empty-reply fallback.
  // This was the root cause of the "Perfecto, anotado" non-sequitur opener.
  //
  // We bypass the rule for `find_by_cedula` because it's the cedula lookup
  // that BRIDGES into identification (the LLM may legitimately call it
  // before identify_user if the worker volunteers a cedula upfront).
  if (
    session.tecnico_id === null &&
    session.toolCallCount === 0 && // counter is bumped at the bottom of preDispatch
    !PRE_IDENTIFY_TOOLS.has(toolName)
  ) {
    return {
      kind: "refusal",
      result: {
        ok: false,
        error:
          "Llama identify_user primero. No registres eventos ni leas datos antes de saber con quién hablas.",
        code: "must_identify_first",
      },
    };
  }

  // Rule 2 — session-bound tecnico_id override.
  // PRD §19 — session-bound, LLM args discarded.
  let args = rawArgs;
  if (
    TOOLS_WITH_TECNICO_ID_ARG.has(toolName) &&
    session.tecnico_id !== null &&
    "tecnico_id" in rawArgs
  ) {
    args = { ...rawArgs, tecnico_id: session.tecnico_id };
  }

  // Rule 2b — session-bound phone override. Same pattern as Rule 2 for
  // tecnico_id. Forces identify_user / register_tecnico to use the WA jid
  // the agent already resolved, not whatever the LLM scraped from the chat
  // body. See TurnSession.session_phone for the Camilo regression context.
  if (
    TOOLS_WITH_PHONE_ARG.has(toolName) &&
    session.session_phone !== null
  ) {
    args = { ...args, phone: session.session_phone };
  }

  // All checks passed — increment counter and allow.
  session.toolCallCount += 1;
  return { kind: "allow", args };
}

// ---------- Rule 4: ≥50-row truncation ----------

// Ranking fields per PRD §9.4 / §19 rule 5: disponibilidad → calidad → costo.
// These fields may or may not be present on any given row; we rank defensively.
// If they're absent, the tool already returned rows in a sensible order, so we
// delegate ranking to the tool and just cap at 20. (Ranking comment: "delegated to
// tool" — the HR dashboard UI handles visible ranking per PRD §11.)
function rankRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  // Sort descending: higher disponibilidad first, then calidad, then lower costo.
  return [...rows].sort((a, b) => {
    const disp =
      numericField(b, "disponibilidad") - numericField(a, "disponibilidad");
    if (disp !== 0) return disp;
    const cal = numericField(b, "calidad") - numericField(a, "calidad");
    if (cal !== 0) return cal;
    // costo: lower is better, so sort ascending (a - b in original = b[costo] - a[costo] descending)
    return numericField(a, "costo") - numericField(b, "costo");
  });
}

function numericField(row: Record<string, unknown>, field: string): number {
  const v = row[field];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

const TRUNCATION_THRESHOLD = 50;
const TRUNCATION_LIMIT = 20;

/**
 * If the tool result contains an array of ≥50 rows, truncate to top 20 ranked by
 * disponibilidad → calidad → costo. Appends `truncated: true, total: N` to the
 * result data so the agent can emit "y hay más" to the LLM context.
 *
 * Works on any `ToolResult<T>` where T has a top-level array property.
 * If the result is an error, passes through unchanged.
 */
export function postDispatch(result: ToolResult<unknown>): ToolResult<unknown> {
  if (!result.ok) return result;

  const data = result.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    // Flat array at top level — rare, but handle it.
    if (Array.isArray(data) && data.length >= TRUNCATION_THRESHOLD) {
      const typed = data as Record<string, unknown>[];
      const ranked = rankRows(typed).slice(0, TRUNCATION_LIMIT);
      return {
        ok: true,
        data: {
          rows: ranked,
          truncated: true,
          total: data.length,
          note: "y hay más",
        },
      };
    }
    return result;
  }

  // Look for the first array-valued property in the result object.
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length >= TRUNCATION_THRESHOLD) {
      const typed = val as Record<string, unknown>[];
      const ranked = rankRows(typed).slice(0, TRUNCATION_LIMIT);
      return {
        ok: true,
        data: {
          ...obj,
          [key]: ranked,
          truncated: true,
          total: val.length,
          note: "y hay más",
        },
      };
    }
  }

  return result;
}

// ---------- Session update from tool results ----------

/**
 * After identify_user or register_tecnico succeeds, extract the tecnico_id and
 * store it on the TurnSession so subsequent auth-gated tools are unlocked.
 */
export function applyToolResultToSession(
  session: TurnSession,
  toolName: string,
  result: ToolResult<unknown>
): void {
  if (!result.ok) return;

  if (toolName === "identify_user") {
    const data = result.data as Record<string, unknown> | null;
    if (
      data !== null &&
      typeof data === "object" &&
      data["found"] === true
    ) {
      const tecnico = data["tecnico"] as Record<string, unknown> | undefined;
      if (tecnico && typeof tecnico["tecnico_id"] === "string") {
        session.tecnico_id = tecnico["tecnico_id"];
      }
    }
  }

  if (toolName === "register_tecnico") {
    const data = result.data as Record<string, unknown> | null;
    if (data !== null && typeof data === "object") {
      const id = data["tecnico_id"];
      if (typeof id === "string") {
        session.tecnico_id = id;
      }
    }
  }
}
