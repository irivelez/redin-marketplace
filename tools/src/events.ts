// Single helper every tool uses to write to `eventos`.
// If this fails, the tool must fail visibly — HITL measurement depends on this log.
//
// logLlmCall / logLlmError are fire-and-forget wrappers for llm.ts observability.
// They must NEVER throw — a failed DB write cannot crash the conversation.

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import type { Actor } from "./types";

export interface RecordEventInput {
  type: string;
  entity_id?: string | null;
  actor?: Actor;
  meta?: Record<string, unknown>;
}

export async function recordEvent(
  ctx: ToolContext,
  input: RecordEventInput
): Promise<{ id: string }> {
  const actor = input.actor ?? ctx.defaultActor;
  const { data, error } = await ctx.supabase
    .from("eventos")
    .insert({
      type: input.type,
      entity_id: input.entity_id ?? null,
      actor,
      meta: (input.meta ?? {}) as Json,
    })
    .select("id")
    .single();
  if (error) {
    ctx.logger.error("eventos insert failed", {
      type: input.type,
      entity_id: input.entity_id,
      error: error.message,
    });
    throw new Error(`eventos insert failed: ${error.message}`);
  }
  return { id: data.id };
}

export interface LlmCallMeta {
  model: string;
  prompt_sha: string;
  prompt_tokens: number | undefined;
  completion_tokens: number | undefined;
  latency_ms: number;
  tool_calls: { name: string; args_keys: string[] }[];
  grounded: boolean;
  // Optional/additive so existing callers (manos/src/llm.ts) keep compiling.
  /** 0-based runTurn iteration: 0 = decision-making, >= 1 = reply composition. */
  iter_index?: number;
  /** Whether extended thinking ran on this iteration's messages.create. */
  thinking_enabled?: boolean;
}

export interface LlmErrorMeta {
  model: string;
  error_message: string;
  latency_ms: number;
}

export async function logLlmCall(ctx: ToolContext, meta: LlmCallMeta): Promise<void> {
  try {
    await ctx.supabase.from("eventos").insert({
      type: "llm_call",
      entity_id: ctx.session_id ?? null,
      actor: "agent" as Actor,
      meta: meta as unknown as Json,
    });
  } catch (e) {
    ctx.logger.warn("logLlmCall: eventos insert failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function logLlmError(ctx: ToolContext, meta: LlmErrorMeta): Promise<void> {
  try {
    await ctx.supabase.from("eventos").insert({
      type: "llm_error",
      entity_id: ctx.session_id ?? null,
      actor: "agent" as Actor,
      meta: meta as unknown as Json,
    });
  } catch (e) {
    ctx.logger.warn("logLlmError: eventos insert failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
