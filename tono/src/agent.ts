// The Toño agent — channel-agnostic. It takes an incoming message from some
// channel (WhatsApp or dashboard chat), loads session history, calls Anthropic,
// executes tool calls, persists everything, and returns the reply.
//
// Channel wrappers (Baileys in this repo, Next.js route handler in dashboard)
// adapt the transport but call the same function.
//
// Stream A additions (2026-05-07):
//  - candidate_state replaces qualification_state (migration 007)
//  - three-case routing at conversation start (CASE A enrichment / CASE B
//    screening / CASE C returning), surfaced to the LLM as
//    [session_state: candidate_state=…, profile_complete=…, mode=…]
//  - per-turn write to the turns table for live debugging + cost rollup
//  - cost kill switch on NEW conversations only (in-flight conversations
//    always continue, per contract §9.3)
//  - new tools: submit_candidate_dossier, find_by_cedula,
//    mark_candidate_withdrawn, complete_legacy_profile

import {
  createLogger,
  normalizePhone,
  type CandidateState,
  type Json,
  type MessageRow,
  type ServerClient,
  type SessionChannel,
} from "@redin/shared";
import {
  dispatchTool,
  makeDefaultToolContext,
  recordEvent,
  type Actor,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";
import { runTurn, ModelUnavailableError, type ConversationTurn } from "./llm";
import { SessionStore } from "./session";
import { wrapData } from "./prompts/data-wrap";
import {
  createTurnSession,
  preDispatch,
  postDispatch,
  applyToolResultToSession,
  type TurnSession,
} from "./router";
import { tryHandleCustomerRatingReply } from "./customer-ratings";
import { tryMatchOfferReply } from "./offer-replies";

const log = createLogger("tono:agent");

const DEFAULT_DAILY_LLM_COST_USD = 10;

export interface HandleMessageInput {
  phone: string;
  text: string;
  channel: SessionChannel;
  toolCtx?: ToolContext;
  jid?: string;
}

export interface HandleMessageResult {
  reply: string;
  session_id: string;
  tool_calls: { name: string; args: Record<string, unknown>; result_ok: boolean }[];
  tool_calls_full: { name: string; args: Record<string, unknown>; result: ToolResult<unknown> }[];
}

type RoutingMode =
  | "enrichment"      // approved + profile_complete=false → collect missing fields
  | "screening"       // no row OR candidate_state in (screening, rejected → reopen) → run dossier
  | "returning"       // approved + profile_complete=true → offer jobs / handle requests
  | "pending_review"; // candidate_state in (pending, needs_call) → wait for HR, do NOT re-screen

type TurnError = {
  stage: "llm" | "router" | "tool" | "cost";
  code: string;
  message?: string;
};

function toTurns(rows: MessageRow[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const r of rows) {
    if (r.role === "user" && r.content) {
      out.push({ role: "user", text: wrapData(r.content, "tecnico") });
    } else if (r.role === "assistant") {
      if (r.tool_calls) {
        const calls = normalizeToolCalls(r.tool_calls);
        if (calls.length > 0) out.push({ role: "tool_call", calls });
      }
      if (r.content) out.push({ role: "assistant", text: r.content });
    } else if (r.role === "tool" && r.tool_calls) {
      const responses = normalizeToolResponses(r.tool_calls);
      if (responses.length > 0) out.push({ role: "tool_response", responses });
    }
  }
  return out;
}

function normalizeToolCalls(
  raw: Json
): { name: string; args: Record<string, unknown> }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      const args =
        obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
          ? (obj.args as Record<string, unknown>)
          : {};
      if (name) out.push({ name, args });
    }
  }
  return out;
}

function normalizeToolResponses(
  raw: Json
): { name: string; response: unknown }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; response: unknown }[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      const raw_response = obj.response;
      const response =
        typeof raw_response === "string"
          ? wrapData(raw_response, "tool")
          : typeof raw_response === "object" && raw_response !== null
            ? wrapData(JSON.stringify(raw_response), "tool")
            : raw_response;
      if (name) out.push({ name, response });
    }
  }
  return out;
}

// Pull display name with priority order: tecnico_legacy_bootstrap event ->
// tecnico_registered event -> tecnicos_mirror.data fallback. Legacy first
// because CASE A enrichment workers only have the bootstrap event;
// tecnico_registered is what cold workers leave.
async function loadDisplayName(
  sb: ServerClient,
  tecnico_id: string
): Promise<string | null> {
  const fromMeta = (m: unknown): string | null => {
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const obj = m as Record<string, unknown>;
      if (typeof obj.nombre === "string" && obj.nombre.trim().length > 0) {
        return obj.nombre.trim();
      }
    }
    return null;
  };

  const { data: legacy } = await sb
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_legacy_bootstrap")
    .eq("entity_id", tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromLegacy = fromMeta(legacy?.meta);
  if (fromLegacy) return fromLegacy;

  const { data: reg } = await sb
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromReg = fromMeta(reg?.meta);
  if (fromReg) return fromReg;

  const { data: mirror } = await sb
    .from("tecnicos_mirror")
    .select("data")
    .eq("row_id", tecnico_id)
    .maybeSingle();
  if (mirror?.data && typeof mirror.data === "object" && !Array.isArray(mirror.data)) {
    const m = mirror.data as Record<string, unknown>;
    const cand =
      m["Nombre de Tecnico"] ?? m["Nombre"] ?? m["nombre"] ?? m["NOMBRE"];
    if (typeof cand === "string" && cand.trim().length > 0) return cand.trim();
  }
  return null;
}

// Pull the worker's ciudad with priority order: (1) tecnicos_extended.enrichment_data.ciudad_base
// (CASO A graduates), (2) latest candidate_dossiers.payload.ciudad_base (CASO B graduates),
// (3) tecnico_registered event meta.ciudad (cold workers), (4) null.
// Only called for routingMode="returning" — used by CASO C's proactive opener to
// pre-load read_pending_ots without an extra Toño tool call.
async function loadCiudad(
  sb: ServerClient,
  tecnico_id: string
): Promise<string | null> {
  const pick = (m: unknown, key: string): string | null => {
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const obj = m as Record<string, unknown>;
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    return null;
  };

  const { data: tec } = await sb
    .from("tecnicos_extended")
    .select("enrichment_data")
    .eq("tecnico_id", tecnico_id)
    .maybeSingle();
  const fromEnrichment = pick(tec?.enrichment_data, "ciudad_base");
  if (fromEnrichment) return fromEnrichment;

  const { data: dossier } = await sb
    .from("candidate_dossiers")
    .select("payload")
    .eq("tecnico_id", tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromDossier = pick(dossier?.payload, "ciudad_base");
  if (fromDossier) return fromDossier;

  const { data: reg } = await sb
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return pick(reg?.meta, "ciudad");
}

// Classify whether this is a NEW conversation (cost kill switch applies) or
// an in-flight one (always proceed). Per contract §9.3:
//   in-flight = phone has tecnicos_extended row in screening | pending |
//               needs_call, OR session has at least one prior turn.
// Anything else = new conversation.
async function isNewConversation(
  sb: ServerClient,
  sessionId: string,
  candidateState: CandidateState | null
): Promise<boolean> {
  const inFlightStates: CandidateState[] = ["screening", "pending", "needs_call"];
  if (candidateState !== null && inFlightStates.includes(candidateState)) {
    return false;
  }
  const { count } = await sb
    .from("turns")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  if (typeof count === "number" && count > 0) return false;
  return true;
}

async function nextTurnNumber(sb: ServerClient, sessionId: string): Promise<number> {
  const { data } = await sb
    .from("turns")
    .select("turn_number")
    .eq("session_id", sessionId)
    .order("turn_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.turn_number as number | undefined) ?? 0) + 1;
}

// Read today's UTC LLM cost from the daily_llm_cost view.
async function readTodayCost(sb: ServerClient): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("daily_llm_cost")
    .select("cost_usd")
    .eq("utc_date", today)
    .maybeSingle();
  if (error) {
    log.warn("daily_llm_cost read failed", { error: error.message });
    return 0;
  }
  if (!data) return 0;
  const v = (data as { cost_usd: number | string }).cost_usd;
  return typeof v === "number" ? v : parseFloat(v as string) || 0;
}

async function hasCostOverrideToday(sb: ServerClient): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb
    .from("cost_kill_switch_overrides")
    .select("id")
    .eq("override_date", today)
    .maybeSingle();
  return !!data;
}

export async function handleMessage(
  input: HandleMessageInput
): Promise<HandleMessageResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error("phone required");
  const text = (input.text ?? "").trim();
  if (!text) throw new Error("text required");

  const startedAt = Date.now();
  const actor: Actor = `tecnico:${phone}`;
  const baseCtx = input.toolCtx ?? makeDefaultToolContext({ defaultActor: actor });

  // Pre-LLM short-circuit: if the inbound is a customer rating reply, handle
  // it without touching Toño at all.
  const ratingResult = await tryHandleCustomerRatingReply(
    baseCtx.supabase,
    phone,
    text
  );
  if (ratingResult.handled) {
    log.info("customer rating: handled pre-LLM", { phone });
    return {
      reply: ratingResult.reply ?? "",
      session_id: "",
      tool_calls: [],
      tool_calls_full: [],
    };
  }

  // Pre-LLM short-circuit #2: HR-triggered offers create ot_offers rows;
  // workers reply "acepto"/"paso" on WhatsApp. Match the inbound to the
  // latest open offer before invoking the LLM. Zero LLM budget burned.
  const escalationSinkMaybe = baseCtx.escalationSink as unknown as
    | { send?: (text: string) => Promise<void> }
    | undefined;
  const tgSink =
    escalationSinkMaybe && typeof escalationSinkMaybe.send === "function"
      ? { send: (text: string) => escalationSinkMaybe.send!(text) }
      : null;
  const offerReply = await tryMatchOfferReply({
    phone,
    text,
    supabase: baseCtx.supabase,
    telegram: tgSink,
    log: (lvl, m, meta) =>
      log[lvl](m, meta as Record<string, unknown> | undefined),
  });
  if (offerReply.handled) {
    log.info("offer-reply: handled pre-LLM", { phone });
    return {
      reply: offerReply.reply,
      session_id: "",
      tool_calls: [],
      tool_calls_full: [],
    };
  }

  const sessions = new SessionStore(baseCtx.supabase);
  const session = await sessions.getOrCreate(phone, input.channel);
  const toolCtx: ToolContext = { ...baseCtx, session_id: session.id };

  log.info("incoming", {
    phone,
    channel: input.channel,
    session_id: session.id,
    text_len: text.length,
  });

  // Three-case routing — read the worker's row and decide which mode applies.
  // CASE A (enrichment): approved + profile_complete=false -> Toño collects
  //                      missing fields via complete_legacy_profile.
  // CASE B (screening):  no row, or row in any non-approved state -> standard
  //                      contract flow.
  // CASE C (returning):  approved + profile_complete=true -> minimal greeting,
  //                      future job-application flows live here.
  const turnSession: TurnSession = createTurnSession();
  let routingMode: RoutingMode = "screening";
  let currentCandidateState: CandidateState | null = null;
  let profileComplete = false;
  let nombreFromRow: string | null = null;
  let ciudadFromRow: string | null = null;
  {
    const { data: existing } = await baseCtx.supabase
      .from("tecnicos_extended")
      .select("tecnico_id, candidate_state, profile_complete")
      .eq("phone", phone)
      .maybeSingle();
    if (existing?.tecnico_id) {
      turnSession.tecnico_id = existing.tecnico_id;
      currentCandidateState = existing.candidate_state as CandidateState;
      profileComplete = !!existing.profile_complete;
      if (currentCandidateState === "approved" && !profileComplete) {
        routingMode = "enrichment";
      } else if (currentCandidateState === "approved" && profileComplete) {
        routingMode = "returning";
      } else if (
        currentCandidateState === "pending" ||
        currentCandidateState === "needs_call"
      ) {
        // Worker already submitted a dossier and is waiting for HR. Do NOT
        // re-run screening — that's why they were getting re-asked cédula,
        // herramientas, vehicle, etc. on the second visit. The prompt's
        // pending_review block tells the LLM to acknowledge queue position
        // without re-screening; the LLM still has read_my_postulaciones,
        // read_my_contratos, escalate_to_hr if the worker asks something
        // substantive.
        routingMode = "pending_review";
      } else {
        routingMode = "screening";
      }
      nombreFromRow = await loadDisplayName(baseCtx.supabase, existing.tecnico_id);
      // Pre-load ciudad only for CASO C — keeps the lookup cost-aware and lets
      // the proactive opener call read_pending_ots without a round-trip.
      if (routingMode === "returning") {
        ciudadFromRow = await loadCiudad(baseCtx.supabase, existing.tecnico_id);
      }
    }
  }

  // Persist inbound BEFORE the cost check so the user message is never lost.
  await sessions.recordMessage({
    sessionId: session.id,
    role: "user",
    content: text,
  });

  // ---------- Cost kill switch (NEW conversations only) ----------
  // Per contract §9.3: in-flight conversations always continue. We classify
  // BEFORE reading cost so the read is skipped for in-flight calls.
  const newConversation = await isNewConversation(
    baseCtx.supabase,
    session.id,
    currentCandidateState
  );
  if (newConversation) {
    const cap =
      parseFloat(process.env.TONO_DAILY_COST_USD_LIMIT ?? `${DEFAULT_DAILY_LLM_COST_USD}`) ||
      DEFAULT_DAILY_LLM_COST_USD;
    const [todayCost, hasOverride] = await Promise.all([
      readTodayCost(baseCtx.supabase),
      hasCostOverrideToday(baseCtx.supabase),
    ]);
    if (todayCost >= cap && !hasOverride) {
      log.warn("cost kill switch triggered", {
        phone,
        today_cost_usd: todayCost,
        cap_usd: cap,
      });
      await recordEvent(toolCtx, {
        type: "cost_kill_switch_triggered",
        entity_id: session.id,
        actor: "agent",
        meta: {
          today_cost_usd: todayCost,
          cap_usd: cap,
          phone,
        },
      }).catch((e) => {
        log.warn("kill-switch event log failed (non-fatal)", {
          error: e instanceof Error ? e.message : String(e),
        });
      });

      const holdingReply =
        "Hoy estamos al tope del cupo de IA por el día. Mañana retomamos.";

      await sessions.recordMessage({
        sessionId: session.id,
        role: "assistant",
        content: holdingReply,
      });

      const turnNumber = await nextTurnNumber(baseCtx.supabase, session.id);
      await baseCtx.supabase.from("turns").insert({
        session_id: session.id,
        turn_number: turnNumber,
        phone,
        channel: input.channel,
        tecnico_id: turnSession.tecnico_id,
        candidate_state_at_turn: currentCandidateState,
        inbound_text: text,
        outbound_text: holdingReply,
        tool_calls: null,
        model: null,
        prompt_sha: null,
        prompt_tokens: 0,
        completion_tokens: 0,
        llm_iterations: 0,
        latency_ms: Date.now() - startedAt,
        errors: [
          {
            stage: "cost" as const,
            code: "kill_switch",
            message: `today=${todayCost} cap=${cap}`,
          },
        ],
        escalated: false,
        refused: false,
        cost_killed: true,
        finished_at: new Date().toISOString(),
      });

      return {
        reply: holdingReply,
        session_id: session.id,
        tool_calls: [],
        tool_calls_full: [],
      };
    }
  }

  // ---------- LLM turn ----------
  const recent = await sessions.recentMessages(session.id);
  const allButCurrent = recent.slice(0, -1);
  const history = toTurns(allButCurrent);

  const routedDispatch = async (
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<unknown>> => {
    const decision = preDispatch(turnSession, name, args);
    if (decision.kind === "refusal" || decision.kind === "terminal") {
      log.warn("router blocked tool call", {
        name,
        code: decision.result.ok ? "" : decision.result.code,
        kind: decision.kind,
      });
      return decision.result;
    }
    let result: ToolResult<unknown>;
    try {
      result = await dispatchTool(ctx, name, decision.args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = { ok: false, error: msg, code: "tool_threw" };
    }
    applyToolResultToSession(turnSession, name, result);
    return postDispatch(result);
  };

  // Inject session context. mode + name guide Toño's three-case routing.
  // 2026-05-16: surface tecnico_id explicitly. Santiago's chat showed the
  // model looping for ~6 turns asking itself "where is the tecnico_id?"
  // because it was never visible in context. The router rewrites the arg
  // server-side anyway (router.ts Rule 2), but the LLM needs to *see* the
  // id to stop second-guessing.
  const contextLines = [`[session_phone: ${phone}]`];
  const tecnicoIdForContext = turnSession.tecnico_id ?? "unknown";
  if (currentCandidateState) {
    contextLines.push(
      `[session_state: candidate_state=${currentCandidateState}, profile_complete=${profileComplete}, mode=${routingMode}, tecnico_id=${tecnicoIdForContext}]`
    );
  } else {
    contextLines.push(
      `[session_state: candidate_state=null, mode=${routingMode}, tecnico_id=${tecnicoIdForContext}]`
    );
  }
  if (nombreFromRow) contextLines.push(`[session_name: ${nombreFromRow}]`);
  if (ciudadFromRow) contextLines.push(`[session_ciudad: ${ciudadFromRow}]`);
  const userMessage = `${contextLines.join("\n")}\n${wrapData(text, "tecnico")}`;

  const errorsCollected: TurnError[] = [];
  let turn: Awaited<ReturnType<typeof runTurn>> | null = null;
  let modelUnavailable = false;
  try {
    turn = await runTurn({
      history,
      userMessage,
      toolCtx,
      dispatcher: routedDispatch,
    });
  } catch (e) {
    if (e instanceof ModelUnavailableError) {
      modelUnavailable = true;
      log.error("model unavailable after retry — escalating to HR", { phone });
      errorsCollected.push({
        stage: "llm",
        code: "model_unavailable",
        message: e.message,
      });
      try {
        await dispatchTool(toolCtx, "escalate_to_hr", {
          phone,
          reason: "model_unavailable",
          context: `Toño no pudo procesar el mensaje de ${phone} por falla del modelo (5xx tras retry).`,
        });
      } catch (escErr) {
        log.error("escalate_to_hr also failed", {
          error: escErr instanceof Error ? escErr.message : String(escErr),
        });
        errorsCollected.push({
          stage: "tool",
          code: "escalate_failed",
          message: escErr instanceof Error ? escErr.message : String(escErr),
        });
      }
    } else {
      throw e;
    }
  }

  const holdingReply = "Estoy con problemas técnicos, ya HR te escribe.";
  let reply = modelUnavailable ? holdingReply : turn?.reply ?? "";

  // Empty-text safety net. If the model went silent after a tool call (e.g.
  // it consumed the tool result and emitted no text on the follow-up
  // iteration), substitute a deterministic fallback so an empty WhatsApp
  // bubble never reaches the user.
  //
  // Gap A.1 fix (2026-05-22): the previous "anytool-succeeded → 'Perfecto,
  // anotado…'" branch was producing the BUG that opens conversations with
  // "Perfecto, anotado. ¿Algo más que quieras contarme?" — because the LLM
  // sometimes calls log_event(session_start) (a model-hallucinated pattern,
  // not in the prompt or codebase) as its first tool and then returns
  // empty text. The fallback was designed for register_tecnico /
  // complete_legacy_profile cases where "anotado" is genuinely appropriate.
  // Now we branch on whether a STATE-CHANGING tool actually succeeded.
  const STATE_CHANGING_TOOLS = new Set([
    "register_tecnico",
    "complete_legacy_profile",
    "submit_candidate_dossier",
    "mark_candidate_withdrawn",
    "upload_documento",
    "create_postulacion",
  ]);
  if (!modelUnavailable && reply.trim() === "" && turn) {
    const stateChangingOk = turn.toolCallsMade.some(
      (tc) => tc.result.ok && STATE_CHANGING_TOOLS.has(tc.name)
    );
    const anyOk = turn.toolCallsMade.some((tc) => tc.result.ok);
    if (stateChangingOk) {
      // Real state change happened — "anotado" is genuine
      reply = "Perfecto, anotado. ¿Algo más que quieras contarme?";
      log.warn("substituted empty-text reply (state-changing tool ok)", {
        phone,
        session_id: session.id,
        tools: turn.toolCallsMade.map((tc) => tc.name),
      });
    } else if (anyOk) {
      // Only no-op tools (identify_user, find_by_cedula, read_*, log_event,
      // escalate_to_hr). No state changed, so "anotado" is misleading. Use a
      // neutral greeting-style filler that matches Toño's voice.
      reply = "Un momento, déjame ver. ¿Qué necesitas?";
      log.warn("substituted empty-text reply (no-op tool only)", {
        phone,
        session_id: session.id,
        tools: turn.toolCallsMade.map((tc) => tc.name),
      });
    } else {
      reply = "Un momento, déjame revisar eso con el equipo y te respondo.";
      log.warn("substituted empty-text reply (no successful tool)", {
        phone,
        session_id: session.id,
      });
    }
    errorsCollected.push({
      stage: "llm",
      code: "empty_reply_substituted",
    });
  }

  // Persist tool calls + responses + final reply BEFORE writing the turn row,
  // so messages.tool_calls is the source of truth and turns.tool_calls is the
  // lean operations projection.
  if (turn && turn.toolCallsMade.length > 0) {
    const callsJson: Json = turn.toolCallsMade.map((t) => ({
      name: t.name,
      args: t.args as Json,
    })) as Json;
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: null,
      toolCalls: callsJson,
    });
    const responsesJson: Json = turn.toolCallsMade.map((t) => ({
      name: t.name,
      response: t.result as unknown as Json,
    })) as Json;
    await sessions.recordMessage({
      sessionId: session.id,
      role: "tool",
      content: null,
      toolCalls: responsesJson,
    });

    // Surface tool failures into errorsCollected so they land on the turn row.
    for (const tc of turn.toolCallsMade) {
      if (!tc.result.ok) {
        errorsCollected.push({
          stage: "tool",
          code: tc.result.code ?? "unknown",
          message: tc.result.error,
        });
      }
    }
  }

  if (reply) {
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: reply,
    });
  }
  await sessions.touch(session.id);

  // Persist inbound JID so outbound drainer can deliver to LID-mode accounts.
  if (input.jid) {
    const { error: jidErr } = await baseCtx.supabase
      .from("tecnicos_extended")
      .update({ last_jid: input.jid })
      .eq("phone", phone);
    if (jidErr) {
      log.warn("last_jid update failed (non-fatal)", {
        phone,
        error: jidErr.message,
      });
    }
  }

  // Per-turn write to turns. UNIQUE (session_id, turn_number) makes this safe
  // under retries; we use ON CONFLICT DO NOTHING via supabase upsert semantics
  // by checking nextTurnNumber AFTER all message writes. If a concurrent retry
  // increments the counter, the duplicate insert throws — caller sees the
  // user reply either way.
  const escalated = !!turn?.toolCallsMade.some(
    (tc) => tc.name === "escalate_to_hr" && tc.result.ok
  );
  const refused = !!turn?.toolCallsMade.some(
    (tc) =>
      tc.name === "log_event" &&
      ((tc.args as Record<string, unknown>)?.type as string | undefined) === "refused"
  );

  try {
    const turnNumber = await nextTurnNumber(baseCtx.supabase, session.id);
    const { error: turnErr } = await baseCtx.supabase.from("turns").insert({
      session_id: session.id,
      turn_number: turnNumber,
      phone,
      channel: input.channel,
      tecnico_id: turnSession.tecnico_id,
      candidate_state_at_turn: currentCandidateState,
      inbound_text: text,
      outbound_text: reply || null,
      tool_calls:
        turn && turn.toolCallsMade.length > 0
          ? turn.toolCallsMade.map((tc) => ({
              name: tc.name,
              args: tc.args,
              result_ok: tc.result.ok,
              code: tc.result.ok ? undefined : tc.result.code,
              latency_ms: tc.latency_ms,
            }))
          : null,
      model: turn?.model ?? null,
      prompt_sha: turn?.prompt_sha ?? null,
      prompt_tokens: turn?.prompt_tokens ?? null,
      completion_tokens: turn?.completion_tokens ?? null,
      llm_iterations: turn?.iterations ?? null,
      latency_ms: Date.now() - startedAt,
      errors: errorsCollected.length > 0 ? errorsCollected : null,
      escalated,
      refused,
      cost_killed: false,
      finished_at: new Date().toISOString(),
    });
    if (turnErr) {
      log.warn("turns insert failed (non-fatal)", {
        session_id: session.id,
        error: turnErr.message,
      });
    }
  } catch (e) {
    log.warn("turns insert threw (non-fatal)", {
      session_id: session.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    reply,
    session_id: session.id,
    tool_calls: (turn?.toolCallsMade ?? []).map((t) => ({
      name: t.name,
      args: t.args,
      result_ok: t.result.ok,
    })),
    tool_calls_full: turn?.toolCallsMade ?? [],
  };
}

// ---------------------------------------------------------------------------
// EVAL-ONLY — thin re-export alias.
// ---------------------------------------------------------------------------
export { handleMessage as handleMessageForEval };
