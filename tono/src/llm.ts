// Claude Haiku 4.5 wrapper for Toño's tool-calling loop.
//
// Design notes:
// - Tool use via @anthropic-ai/sdk. Tools are converted from the Gemini-flavored
//   TOOL_DECLARATIONS (UPPERCASE JSON-Schema types) to Anthropic input_schema
//   (lowercase) at the boundary, so the shared schemas file stays untouched.
// - Loop: send messages → receive tool_use block(s) → execute via dispatchTool
//   → feed tool_result block(s) back → repeat until the model returns plain text.
// - Hard cap on tool-call iterations to prevent runaway loops.
// - SDK auto-retry disabled (maxRetries:0) — we implement PRD §18 retry semantics
//   ourselves so we can emit `llm_retry` events and escalate on second failure.
// - System prompt comes from prompts/tono-system.ts.

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@redin/shared";
import {
  TOOL_DECLARATIONS,
  dispatchTool,
  logLlmCall,
  logLlmError,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";
import { TONO_SYSTEM_PROMPT } from "./prompts/tono-system";
import { TONO_PROMPT_SHA } from "./prompt-sha";

// ---------------------------------------------------------------------------
// PRD §18 — ModelUnavailableError signals an Anthropic 5xx after one retry.
// The agent layer catches this and calls escalate_to_hr.
// ---------------------------------------------------------------------------

export class ModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ModelUnavailableError";
  }
}

const log = createLogger("tono:llm");

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 45_000; // bumped from 30s — thinking turns can take longer
const MAX_TOOL_ITERATIONS = 6;

// Gap A.3 (2026-05-22): Extended thinking.
//
// When enabled, the model emits a hidden `thinking` content block before the
// final answer (text + tool_use blocks). The deterministic gates (router,
// refusal protocol, schema validation, auth gating) still see only the
// non-thinking outputs — so we get smarter edge-case handling without
// loosening any safety bar. The thinking block:
//   - Never reaches WhatsApp (router/agent filters by content type)
//   - IS billed as output tokens (~+1.5-3K tokens per turn, ~3-5x cost)
//   - Requires temperature unset (Anthropic API constraint with thinking on)
//   - Requires max_tokens > budget_tokens (we set max = budget + 2048 headroom)
//
// Off-switch: TONO_THINKING_ENABLED=0 reverts to single-pass Haiku.
const THINKING_ENABLED = (() => {
  const raw = process.env.TONO_THINKING_ENABLED;
  if (raw === undefined || raw === null || raw === "") return true; // default ON
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
})();

// Budget for the hidden reasoning. Min 1024 (Anthropic API constraint).
// 2000 is the sweet spot for our screening-style decisions per
// docs.anthropic.com/en/docs/build-with-claude/extended-thinking.
const THINKING_BUDGET = (() => {
  const raw = process.env.TONO_THINKING_BUDGET;
  if (!raw) return 2000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1024) return 2000;
  return n;
})();

// 2026-05-16 hardening: raise default from 1024 → 2048. Santiago's chat hit
// truncation mid-JSON when the model was wrongly serializing tool args as
// natural-language text; 1024 cut it off at "fines_de_sem". Higher cap is the
// safety net while the prompt fix forbids the JSON-as-text behavior. Env-
// overridable so we can tune live without redeploy.
//
// Gap A.3: max_tokens must exceed thinking_budget (Anthropic constraint).
// When thinking is on, default to budget + 2048 headroom for text + tool_use.
const MAX_TOKENS = (() => {
  const raw = process.env.TONO_MAX_TOKENS;
  const baseDefault = THINKING_ENABLED ? THINKING_BUDGET + 2048 : 2048;
  if (!raw) return baseDefault;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return baseDefault;
  // Guard against an env override that's too low to coexist with thinking.
  if (THINKING_ENABLED && n <= THINKING_BUDGET) return THINKING_BUDGET + 1024;
  return n;
})();

// 2026-05-16: 0.3 was making Toño stilted/over-deterministic. 0.5 restores
// some warmth without destabilizing tool-call discipline. Env-overridable.
//
// Gap A.3: Anthropic API rejects `temperature` when `thinking` is enabled.
// When thinking is on, we omit the temperature parameter entirely.
const TEMPERATURE = (() => {
  const raw = process.env.TONO_TEMPERATURE;
  if (!raw) return 0.5;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
})();

// Strip any <thinking>...</thinking> or <reasoning>...</reasoning> blocks
// that leak into visible assistant text. Belt-and-suspenders: the system
// prompt forbids these tags, but if the model emits them anyway we MUST
// not deliver them to WhatsApp (customer-trust destroying — see
// chat_tono_santiago.txt 2026-05-16). Non-greedy, multi-line, case-
// insensitive. Also collapses the leading blank lines left behind.
const VISIBLE_THINKING_RE =
  /<\s*(thinking|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
function stripVisibleThinking(text: string): string {
  if (!text) return text;
  const stripped = text.replace(VISIBLE_THINKING_RE, "");
  // Also handle the rare case of an unclosed <thinking> tag — drop from the
  // tag to end-of-string rather than ship it.
  const openOnly = stripped.replace(
    /<\s*(thinking|reasoning)\b[^>]*>[\s\S]*$/i,
    ""
  );
  // Collapse 3+ blank lines (left behind by the strip) into 2.
  return openOnly.replace(/\n{3,}/g, "\n\n").trim();
}

export interface RunTurnInput {
  // Ordered oldest-first. Each turn is a user/assistant/tool_call/tool_response
  // entry. We translate to Anthropic MessageParam[] at the boundary.
  history: ConversationTurn[];
  userMessage: string;
  toolCtx: ToolContext;
  // Optional router-injected dispatcher. When provided, replaces dispatchTool so
  // the router's pre/post checks apply. agent.ts wires this in.
  dispatcher?: (
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult<unknown>>;
}

export type ConversationTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | {
      role: "tool_call";
      calls: { name: string; args: Record<string, unknown> }[];
    }
  | {
      role: "tool_response";
      // One entry per preceding call — keep order stable.
      responses: { name: string; response: unknown }[];
    };

export interface RunTurnResult {
  reply: string;
  toolCallsMade: {
    name: string;
    args: Record<string, unknown>;
    result: ToolResult<unknown>;
    /** Wall-clock time of the dispatch call. Surfaced into turns.tool_calls[i].latency_ms. */
    latency_ms?: number;
  }[];
  iterations: number;
  /** Sum of input_tokens across all inner-loop iterations. Stream A: written to turns.prompt_tokens. */
  prompt_tokens: number;
  /** Sum of output_tokens across all inner-loop iterations. */
  completion_tokens: number;
  /** sha256 of TONO_SYSTEM_PROMPT at call time. Stream A: written to turns.prompt_sha. */
  prompt_sha: string;
  /** Anthropic model name. */
  model: string;
}

// Convert Gemini-flavored TOOL_DECLARATIONS (UPPERCASE types) to Anthropic
// input_schema (lowercase). Only the value of `type` keys is lowercased — enum
// values, descriptions, and other strings are preserved as-is.
function lowercaseTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lowercaseTypes);
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "type" && typeof v === "string") {
      out[k] = v.toLowerCase();
    } else {
      out[k] = lowercaseTypes(v);
    }
  }
  return out;
}

function toolsForAnthropic(): Anthropic.Tool[] {
  return TOOL_DECLARATIONS.map(
    (d) =>
      ({
        name: d.name,
        description: d.description,
        input_schema: lowercaseTypes(d.parameters) as Anthropic.Tool["input_schema"],
      }) satisfies Anthropic.Tool
  );
}

// Convert ConversationTurn[] (our persisted shape) to Anthropic MessageParam[].
// Pair tool_call <-> tool_response by index within consecutive history entries;
// assign synthetic toolu_h<i>_<j> IDs that only need to be consistent within
// this single API call.
function toAnthropicMessages(
  history: ConversationTurn[],
  currentUserMessage: string
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingCallIds: string[] | null = null;
  let turnIdx = 0;

  // Anthropic's API enforces a strict pairing: every tool_use block in an
  // assistant message must be answered by a tool_result block in the next
  // user message, with matching tool_use_id and the same count. Any
  // violation (orphan tool_result with no preceding tool_use, or a
  // tool_use that's never answered) returns 400 and the entire turn
  // crashes. The previous code synthesized `toolu_orphan_*` placeholders
  // as a defensive fallback, but the API rejects them at the pairing
  // check before content matters. So we sanitize:
  //
  //   - Orphan tool_response (no pendingCallIds) → SKIP entirely.
  //   - Tool_call followed by anything other than a matching tool_response
  //     → before emitting the next non-response block, flush the dangling
  //     tool_use as a synthetic error result so the assistant message
  //     stays paired.
  //   - Count mismatch between pendingCallIds and t.responses → SKIP the
  //     tool_response and synthesize errors for the dangling calls.
  //
  // Net effect: the model loses some tool-result context on corrupted
  // history but the conversation continues instead of every turn 400'ing.
  const flushDanglingToolUse = (): void => {
    if (!pendingCallIds || pendingCallIds.length === 0) return;
    out.push({
      role: "user",
      content: pendingCallIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content:
          "[[tool call not completed in this session — proceed without this result]]",
        is_error: true,
      })),
    });
    pendingCallIds = null;
  };

  for (const t of history) {
    if (t.role === "user") {
      flushDanglingToolUse();
      out.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      flushDanglingToolUse();
      out.push({ role: "assistant", content: t.text });
    } else if (t.role === "tool_call") {
      flushDanglingToolUse();
      const ids = t.calls.map((_c, i) => `toolu_h${turnIdx}_${i}`);
      pendingCallIds = ids;
      out.push({
        role: "assistant",
        content: t.calls.map((c, i) => ({
          type: "tool_use" as const,
          id: ids[i] as string,
          name: c.name,
          input: c.args,
        })),
      });
      turnIdx++;
    } else if (t.role === "tool_response") {
      if (!pendingCallIds || pendingCallIds.length === 0) {
        // Orphan tool_response — drop. Logging here would require a
        // structured logger import; keep silent and let smoke tests catch
        // any pattern of recurring drops.
        continue;
      }
      // If the count mismatches, prefer pairing what we can and synthesize
      // errors for any leftover. This is rare but defensive.
      const pairCount = Math.min(pendingCallIds.length, t.responses.length);
      const ids = pendingCallIds;
      out.push({
        role: "user",
        content: t.responses.slice(0, pairCount).map((r, i) => ({
          type: "tool_result" as const,
          tool_use_id: ids[i] as string,
          content:
            typeof r.response === "string"
              ? r.response
              : JSON.stringify(r.response),
        })),
      });
      // If there were more pending tool_use ids than responses, synthesize
      // error results for the leftover so the assistant message stays
      // fully paired.
      if (pendingCallIds.length > t.responses.length) {
        const leftover = pendingCallIds.slice(t.responses.length);
        out.push({
          role: "user",
          content: leftover.map((id) => ({
            type: "tool_result" as const,
            tool_use_id: id,
            content:
              "[[tool call response missing in session — proceed without this result]]",
            is_error: true,
          })),
        });
      }
      pendingCallIds = null;
    }
  }
  flushDanglingToolUse();
  out.push({ role: "user", content: currentUserMessage });
  return out;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  // Disable SDK auto-retry — we implement PRD §18 retry semantics ourselves
  // (one retry on 5xx, then ModelUnavailableError) so we can emit llm_retry
  // events and let the agent layer escalate to HR.
  client = new Anthropic({ apiKey, maxRetries: 0 });
  return client;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// PRD §18: detect retryable Anthropic errors (500, 502, 503, 504, 529 overloaded).
// Timeout errors (our own withTimeout) are NOT retried — they propagate.
function isRetryableAnthropicError(e: unknown): boolean {
  if (e instanceof Error && e.message.includes("timeout after")) return false;
  if (e instanceof Anthropic.InternalServerError) return true;
  if (e instanceof Anthropic.APIError) {
    const s = e.status;
    return s === 502 || s === 503 || s === 504 || s === 529;
  }
  return false;
}

// Fire-and-forget: log an llm_retry event so it's visible in eventos.
async function logLlmRetry(ctx: ToolContext, model: string, attempt: number): Promise<void> {
  try {
    await ctx.supabase.from("eventos").insert({
      type: "llm_retry",
      entity_id: ctx.session_id ?? null,
      actor: "agent" as const,
      meta: { model, attempt },
    });
  } catch {
    // Non-fatal — retry logging must never crash the conversation.
  }
}

// PRD §18: one retry after 500ms on 5xx; throw ModelUnavailableError on second failure.
async function createMessageWithRetry(
  c: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  ctx: ToolContext,
  timeoutMs: number
): Promise<Anthropic.Message> {
  try {
    return await withTimeout(c.messages.create(params), timeoutMs, "anthropic messages.create");
  } catch (firstErr) {
    if (!isRetryableAnthropicError(firstErr)) throw firstErr;
    await logLlmRetry(ctx, MODEL, 1);
    await new Promise((res) => setTimeout(res, 500));
    try {
      return await withTimeout(
        c.messages.create(params),
        timeoutMs,
        "anthropic messages.create retry"
      );
    } catch (secondErr) {
      throw new ModelUnavailableError(secondErr);
    }
  }
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const c = getClient();
  const messages = toAnthropicMessages(input.history, input.userMessage);
  const tools = toolsForAnthropic();

  const toolCallsMade: RunTurnResult["toolCallsMade"] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const t0 = Date.now();
    let response: Anthropic.Message;
    try {
      // Gap A.3: build params conditionally. With thinking enabled,
      // temperature must be omitted (API rejects the combination).
      const params: Anthropic.MessageCreateParamsNonStreaming = THINKING_ENABLED
        ? {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: TONO_SYSTEM_PROMPT,
            tools,
            messages,
            thinking: {
              type: "enabled",
              budget_tokens: THINKING_BUDGET,
            },
          }
        : {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            system: TONO_SYSTEM_PROMPT,
            tools,
            messages,
          };
      response = await createMessageWithRetry(c, params, input.toolCtx, TIMEOUT_MS);
    } catch (e) {
      const latency_ms = Date.now() - t0;
      const error_message = e instanceof Error ? e.message : String(e);
      await logLlmError(input.toolCtx, { model: MODEL, error_message, latency_ms });
      throw e;
    }
    const latency_ms = Date.now() - t0;

    const usage = response.usage;
    totalPromptTokens += usage.input_tokens;
    totalCompletionTokens += usage.output_tokens;
    log.debug("llm usage", {
      in: usage.input_tokens,
      out: usage.output_tokens,
      iter,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );

    // Serialize tool calls as name + arg keys only — no values (PII risk).
    const toolCallsMeta = toolUseBlocks.map((b) => ({
      name: b.name,
      args_keys: Object.keys((b.input ?? {}) as Record<string, unknown>),
    }));

    const rawResponseText = textBlocks
      .map((b) => b.text)
      .join("\n")
      .trim();
    // ALWAYS strip <thinking>/<reasoning> before anything else looks at the
    // text. The prompt forbids these tags but if the model ever emits them
    // the user must never see them.
    const responseText = stripVisibleThinking(rawResponseText);

    // PRD §22 — v1 grounding heuristic. Tighten post-pilot.
    const grounded = toolCallsMeta.length === 0 || responseText.length <= 400;

    await logLlmCall(input.toolCtx, {
      model: MODEL,
      prompt_sha: TONO_PROMPT_SHA,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      latency_ms,
      tool_calls: toolCallsMeta,
      grounded,
    });

    if (toolUseBlocks.length === 0) {
      // No more tool calls — return model text.
      if (!responseText) log.warn("anthropic returned empty text", { iter });
      return {
        reply: responseText,
        toolCallsMade,
        iterations: iter,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        prompt_sha: TONO_PROMPT_SHA,
        model: MODEL,
      };
    }

    // Append the assistant turn (full content blocks: text + tool_use).
    messages.push({ role: "assistant", content: response.content });

    // Execute every tool call; build matching tool_result blocks.
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const name = tu.name;
      const args = (tu.input ?? {}) as Record<string, unknown>;
      log.info("tool call", { name, args_keys: Object.keys(args) });
      let result: ToolResult<unknown>;
      const dispatchT0 = Date.now();
      try {
        const dispatch = input.dispatcher ?? dispatchTool;
        result = await dispatch(input.toolCtx, name, args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("tool threw", { name, error: msg });
        result = { ok: false, error: msg, code: "tool_threw" };
      }
      toolCallsMade.push({
        name,
        args,
        result,
        latency_ms: Date.now() - dispatchT0,
      });
      // Router signal: max_tools_reached. 2026-05-16 fix — do NOT force-
      // terminate. Push the tool_result back like any other and let the
      // model run ONE more iteration so it composes a real user-facing
      // reply ("ya miré varias cosas, esto es lo que tengo: …") instead
      // of returning empty text that the agent then has to paper over
      // with the deterministic substitute. The router-imposed cap still
      // prevents further tool calls (subsequent dispatches will be
      // blocked at preDispatch), so this is bounded.
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  log.warn("max tool iterations reached", { iterations: MAX_TOOL_ITERATIONS });
  return {
    reply: "Un momento, déjame revisar eso con el equipo y te respondo.",
    toolCallsMade,
    iterations: MAX_TOOL_ITERATIONS,
    prompt_tokens: totalPromptTokens,
    completion_tokens: totalCompletionTokens,
    prompt_sha: TONO_PROMPT_SHA,
    model: MODEL,
  };
}
