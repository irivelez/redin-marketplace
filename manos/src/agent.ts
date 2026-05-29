// Manos agent — handles a single turn for an architect message.
//
// Flow:
//   1. Resolve session (per-phone, channel="manos").
//   2. Pre-LLM cédula gate (must pass before LLM sees the message).
//   3. If gate passes, build Claude messages array with conversation history
//      + current user message (text + transcription + image URLs as multimodal
//      blocks injected via message text).
//   4. Run runTurn() loop with Manos tools (arq_row_id injected into ctx.meta).
//   5. Persist turn and message records.

import {
  createLogger,
  normalizePhone,
  type Json,
  type MessageRow,
  type ServerClient,
  type SessionChannel,
} from "@redin/shared";
import {
  makeDefaultToolContext,
  recordEvent,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";
import { runTurn, type ConversationTurn } from "./llm";
import { SessionStore } from "./session";
import { runCedulaGate } from "./cedula-gate";
import type { TelegramEscalationSink } from "./telegram-escalation";

const log = createLogger("manos:agent");

export interface HandleManosMessageInput {
  phone: string;
  text: string;
  channel: SessionChannel;
  toolCtx?: ToolContext;
  jid?: string;
  /** Signed URLs of photos uploaded to alcance-photos/incoming this turn. */
  imageUrls?: string[];
  /** Vision-generated Spanish captions, index-aligned with imageUrls. */
  imageDescriptions?: string[];
}

export interface HandleManosMessageResult {
  reply: string;
  session_id: string;
  tool_calls: { name: string; args: Record<string, unknown>; result_ok: boolean }[];
}

export async function handleManosMessage(
  input: HandleManosMessageInput,
  deps: {
    supabase: ServerClient;
    escalationSink?: TelegramEscalationSink;
  }
): Promise<HandleManosMessageResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error("phone required");
  const text = (input.text ?? "").trim();
  if (!text && (!input.imageUrls || input.imageUrls.length === 0)) {
    throw new Error("text or imageUrls required");
  }

  const baseCtx =
    input.toolCtx ??
    makeDefaultToolContext({
      supabase: deps.supabase,
      defaultActor: `tecnico:${phone}`, // arquitectos use tecnico: actor namespace for now
      escalationSink: deps.escalationSink,
    });

  const sessions = new SessionStore(baseCtx.supabase);
  const session = await sessions.getOrCreate(phone, input.channel ?? "manos");

  // Session meta holds arq_row_id once cédula is verified.
  const sessionMeta: Record<string, unknown> =
    typeof (session as unknown as { meta?: unknown }).meta === "object" &&
    (session as unknown as { meta?: unknown }).meta !== null
      ? ({ ...(session as unknown as { meta: Record<string, unknown> }).meta })
      : {};

  const toolCtx: ToolContext = {
    ...baseCtx,
    session_id: session.id,
  };

  log.info("incoming", {
    phone,
    channel: input.channel,
    session_id: session.id,
    text_len: text.length,
    image_count: input.imageUrls?.length ?? 0,
  });

  // ---- Pre-LLM cédula gate ----
  const gateResult = await runCedulaGate({
    supabase: baseCtx.supabase,
    phone,
    currentText: text,
    sessionId: session.id,
    sessionMeta,
    escalationSink: deps.escalationSink,
  });

  // Persist user message regardless of gate outcome.
  await sessions.recordMessage({
    sessionId: session.id,
    role: "user",
    content: buildUserContent(text, input.imageUrls, input.imageDescriptions),
  });

  if (!gateResult.passed) {
    // Gate is still closed — send onboarding/refusal reply and stop.
    const reply = gateResult.reply ?? "Mándame tu cédula para continuar.";
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: reply,
    });
    await sessions.touch(session.id);
    return { reply, session_id: session.id, tool_calls: [] };
  }

  // Gate passed (or already open) — resolve arq_row_id for tool injection.
  const arqRowId = sessionMeta.arq_row_id as string | undefined;
  const updatedCtx: ToolContext = { ...toolCtx };

  // If the gate just verified (gateResult has a reply), send that reply and
  // then CONTINUE to LLM so the architect's very first substantive message
  // (if sent after cédula in same turn) gets processed. For simplicity in
  // v1 we short-circuit on verification to keep turns atomic.
  if (gateResult.reply) {
    const reply = gateResult.reply;
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: reply,
    });
    await sessions.touch(session.id);
    return { reply, session_id: session.id, tool_calls: [] };
  }

  // ---- LLM turn ----
  const history = await loadHistory(sessions, session.id);

  // Build user message with optional image URL appendix.
  const userMessageForLlm = buildUserContent(text, input.imageUrls, input.imageDescriptions);

  let llmReply: string;
  let toolCallsMade: { name: string; args: Record<string, unknown>; result: ToolResult<unknown> }[] = [];

  // Inject arq_row_id into every manos tool call via a custom dispatcher.
  const { dispatchManosTools } = await import("./manos-tools");
  const arqAwareDispatcher = async (
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<unknown>> => {
    // Always inject the current session's arq_row_id so tools can verify identity.
    const enrichedArgs = arqRowId ? { ...args, arq_row_id: arqRowId } : args;
    return dispatchManosTools(ctx, name, enrichedArgs);
  };

  try {
    const result = await runTurn({
      history,
      userMessage: userMessageForLlm,
      toolCtx: updatedCtx,
      dispatcher: arqAwareDispatcher,
    });
    llmReply = result.reply;
    toolCallsMade = result.toolCallsMade;

    // Persist tool calls and response.
    if (result.toolCallsMade.length > 0) {
      await sessions.recordMessage({
        sessionId: session.id,
        role: "assistant",
        toolCalls: JSON.stringify(
          result.toolCallsMade.map((tc) => ({ name: tc.name, args: tc.args }))
        ) as unknown as Json,
      });
      await sessions.recordMessage({
        sessionId: session.id,
        role: "tool",
        toolCalls: JSON.stringify(
          result.toolCallsMade.map((tc) => ({
            name: tc.name,
            response: tc.result,
          }))
        ) as unknown as Json,
      });
    }
    if (llmReply) {
      await sessions.recordMessage({
        sessionId: session.id,
        role: "assistant",
        content: llmReply,
      });
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    log.error("llm turn failed", { phone, session_id: session.id, error: errMsg });
    llmReply = "Tuve un problema técnico. Inténtalo en un momento.";
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: llmReply,
    });
  }

  await sessions.touch(session.id);

  await recordEvent(updatedCtx, {
    type: "message_received",
    entity_id: session.id,
    meta: {
      phone,
      channel: input.channel,
      text_len: text.length,
      image_count: input.imageUrls?.length ?? 0,
      tool_count: toolCallsMade.length,
    },
  });

  return {
    reply: llmReply,
    session_id: session.id,
    tool_calls: toolCallsMade.map((tc) => ({
      name: tc.name,
      args: tc.args,
      result_ok: tc.result.ok,
    })),
  };
}

// ---- Helpers ----

/**
 * Build the user message string for the LLM. Each photo contributes two lines:
 * its storage URL (so the LLM can pass it to attach_photos) and its
 * vision-generated description (so the scope reflects what the photo shows —
 * Claude cannot open the URL itself). Descriptions are index-aligned with URLs.
 */
function buildUserContent(
  text: string,
  imageUrls?: string[],
  imageDescriptions?: string[]
): string {
  if (!imageUrls || imageUrls.length === 0) return text || "";
  const imageSection = imageUrls
    .map((url, i) => {
      const desc = imageDescriptions?.[i];
      return desc
        ? `[Foto ${i + 1}: ${url}]\n  Análisis visual: ${desc}`
        : `[Foto ${i + 1}: ${url}]`;
    })
    .join("\n");
  return text ? `${text}\n\n${imageSection}` : imageSection;
}

function toConversationTurns(rows: MessageRow[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const r of rows) {
    if (r.role === "user" && r.content) {
      out.push({ role: "user", text: r.content });
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
      if (name) out.push({ name, response: obj.response });
    }
  }
  return out;
}

async function loadHistory(
  sessions: SessionStore,
  sessionId: string
): Promise<ConversationTurn[]> {
  const rows = await sessions.recentMessages(sessionId, 24);
  return toConversationTurns(rows);
}
