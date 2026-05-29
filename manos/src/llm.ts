// Claude Haiku 4.5 wrapper for Manos's tool-calling loop.
//
// VERBATIM COPY of tono/src/llm.ts with the following mechanical substitutions:
//   - Import/logger prefix: "tono:" → "manos:"
//   - System prompt: TONO_SYSTEM_PROMPT → MANOS_SYSTEM_PROMPT
//   - Prompt SHA: TONO_PROMPT_SHA → MANOS_PROMPT_SHA
//   - TOOL_DECLARATIONS: tono's full set → manos's tool set (imported from tools/manos)
//
// DO NOT refactor into a shared package — duplicate intentionally to avoid
// Toño regression risk (per sprint constraint #4).
//
// Design notes:
// - Tool use via @anthropic-ai/sdk. Tools are converted from Gemini-flavored
//   TOOL_DECLARATIONS (UPPERCASE JSON-Schema types) to Anthropic input_schema
//   (lowercase) at the boundary.
// - Loop: send messages → receive tool_use block(s) → execute via dispatchManosTools
//   → feed tool_result block(s) back → repeat until the model returns plain text.
// - Hard cap on tool-call iterations to prevent runaway loops.
// - SDK auto-retry disabled (maxRetries:0) — we implement retry semantics
//   ourselves so we can emit `llm_retry` events and escalate on second failure.

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@redin/shared";
import {
  logLlmCall,
  logLlmError,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";
import { MANOS_TOOL_DECLARATIONS, dispatchManosTools } from "./manos-tools";
import { MANOS_SYSTEM_PROMPT } from "./prompts/manos-system";
import { MANOS_PROMPT_SHA } from "./prompt-sha";

// ---------------------------------------------------------------------------
// ModelUnavailableError signals an Anthropic 5xx after one retry.
// The agent layer catches this and logs an escalation event.
// ---------------------------------------------------------------------------

export class ModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ModelUnavailableError";
  }
}

const log = createLogger("manos:llm");

// 2026-05-29: Default flipped Haiku 4.5 → Sonnet 4.5 for native vision on
// the arrival turn (see RunTurnInput.userImages). Env-overridable; setting
// MANOS_MODEL=claude-haiku-4-5 restores the prior behaviour.
const MODEL = process.env.MANOS_MODEL?.trim() || "claude-sonnet-4-5";
const TIMEOUT_MS = 45_000;
const MAX_TOOL_ITERATIONS = 6;

// 2026-05-29: Extended thinking ON by default (mirrors tono/src/llm.ts).
// Scope-building is open-ended judgment — deciding what's missing, what to ask
// next, reconciling ambiguous Spanish + photo evidence — which is exactly where
// thinking helps. Env off-switch MANOS_THINKING_ENABLED=0 reverts to single-pass.
const THINKING_ENABLED = (() => {
  const raw = process.env.MANOS_THINKING_ENABLED;
  if (raw === undefined || raw === null || raw === "") return true;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
})();

// Hidden-reasoning budget. Anthropic floor is 1024.
const THINKING_BUDGET = (() => {
  const raw = process.env.MANOS_THINKING_BUDGET;
  if (!raw) return 1024;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1024 ? n : 1024;
})();

// Anthropic constraint: max_tokens must exceed thinking budget. With thinking
// on we add 2048 headroom for the visible reply + tool_use blocks; non-thinking
// fallback is 2048 (mirrors tono/src/llm.ts — 1024 truncated mid-JSON during
// Santiago's incident). Env-overridable via MANOS_MAX_TOKENS.
const MAX_TOKENS = (() => {
  const raw = process.env.MANOS_MAX_TOKENS;
  const baseDefault = THINKING_ENABLED ? THINKING_BUDGET + 2048 : 2048;
  if (!raw) return baseDefault;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return baseDefault;
  if (THINKING_ENABLED && n <= THINKING_BUDGET) return THINKING_BUDGET + 1024;
  return n;
})();

// Anthropic rejects `temperature` when `thinking` is enabled, so it is ONLY
// applied on the no-thinking path (see runTurn param build).
const TEMPERATURE = 0.3;

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

export const __configForTests = {
  MODEL,
  TEMPERATURE,
  MAX_TOKENS,
  MAX_TOOL_ITERATIONS,
  THINKING_ENABLED,
  THINKING_BUDGET,
} as const;

export interface RunTurnInput {
  // Ordered oldest-first. Each turn is a user/assistant/tool_call/tool_response
  // entry. We translate to Anthropic MessageParam[] at the boundary.
  history: ConversationTurn[];
  userMessage: string;
  toolCtx: ToolContext;
  // Optional router-injected dispatcher. When provided, replaces dispatchManosTools so
  // the router's pre/post checks apply. agent.ts wires this in.
  dispatcher?: (
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult<unknown>>;
  // Hybrid-vision arrival turn: when set, each {url} becomes a native
  // Anthropic image content block attached to the CURRENT user message only.
  // History user turns stay plain strings — Spanish captions persisted via
  // buildUserContent in agent.ts keep cross-turn memory; this carries pixels.
  userImages?: { url: string }[];
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
  /** Sum of input_tokens across all inner-loop iterations. Written to turns.prompt_tokens. */
  prompt_tokens: number;
  /** Sum of output_tokens across all inner-loop iterations. */
  completion_tokens: number;
  /** sha256 of MANOS_SYSTEM_PROMPT at call time. Written to turns.prompt_sha. */
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
  const tools: Anthropic.Tool[] = MANOS_TOOL_DECLARATIONS.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: lowercaseTypes(d.parameters) as Anthropic.Tool["input_schema"],
  }));
  if (tools.length > 0) {
    tools[tools.length - 1]!.cache_control = { type: "ephemeral" };
  }
  return tools;
}

function systemForAnthropic(): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: MANOS_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
}

// Convert ConversationTurn[] (our persisted shape) to Anthropic MessageParam[].
// Pair tool_call <-> tool_response by index within consecutive history entries;
// assign synthetic toolu_h<i>_<j> IDs that only need to be consistent within
// this single API call.
//
// When `currentUserImages` is non-empty the FINAL user message becomes a
// content-array with one text block + one image block per URL. History user
// messages are always plain strings — by design, since the persisted Spanish
// captions (woven in via buildUserContent in agent.ts) are what carries cross-
// turn visual memory. See RunTurnInput.userImages.
export function toAnthropicMessages(
  history: ConversationTurn[],
  currentUserMessage: string,
  currentUserImages?: { url: string }[]
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingCallIds: string[] | null = null;
  let turnIdx = 0;

  // Anthropic's API enforces a strict pairing: every tool_use block in an
  // assistant message must be answered by a tool_result block in the next
  // user message, with matching tool_use_id and the same count. Any
  // violation returns 400 and the entire turn crashes. Sanitize:
  //
  //   - Orphan tool_response (no pendingCallIds) → SKIP entirely.
  //   - Tool_call followed by anything other than a matching tool_response
  //     → before emitting the next non-response block, flush the dangling
  //     tool_use as a synthetic error result so the assistant message
  //     stays paired.
  //   - Count mismatch between pendingCallIds and t.responses → SKIP the
  //     tool_response and synthesize errors for the dangling calls.
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
        // Orphan tool_response — drop.
        continue;
      }
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
  if (currentUserImages && currentUserImages.length > 0) {
    const blocks: Anthropic.ContentBlockParam[] = [
      { type: "text", text: currentUserMessage },
      ...currentUserImages.map(
        (img): Anthropic.ImageBlockParam => ({
          type: "image",
          source: { type: "url", url: img.url },
        })
      ),
    ];
    out.push({ role: "user", content: blocks });
  } else {
    out.push({ role: "user", content: currentUserMessage });
  }
  return out;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
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

function isRetryableAnthropicError(e: unknown): boolean {
  if (e instanceof Error && e.message.includes("timeout after")) return false;
  if (e instanceof Anthropic.InternalServerError) return true;
  if (e instanceof Anthropic.APIError) {
    const s = e.status;
    return s === 502 || s === 503 || s === 504 || s === 529;
  }
  return false;
}

async function logLlmRetry(ctx: ToolContext, model: string, attempt: number): Promise<void> {
  try {
    await ctx.supabase.from("eventos").insert({
      type: "llm_retry",
      entity_id: ctx.session_id ?? null,
      actor: "agent" as const,
      meta: { model, attempt },
    });
  } catch {
    // Non-fatal.
  }
}

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
  const messages = toAnthropicMessages(input.history, input.userMessage, input.userImages);
  const tools = toolsForAnthropic();

  const toolCallsMade: RunTurnResult["toolCallsMade"] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const t0 = Date.now();
    let response: Anthropic.Message;
    try {
      const params: Anthropic.MessageCreateParamsNonStreaming = THINKING_ENABLED
        ? {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: systemForAnthropic(),
            tools,
            messages,
            thinking: { type: "enabled", budget_tokens: THINKING_BUDGET },
          }
        : {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            system: systemForAnthropic(),
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

    const toolCallsMeta = toolUseBlocks.map((b) => ({
      name: b.name,
      args_keys: Object.keys((b.input ?? {}) as Record<string, unknown>),
    }));

    const rawResponseText = textBlocks
      .map((b) => b.text)
      .join("\n")
      .trim();
    const responseText = stripVisibleThinking(rawResponseText);

    const grounded = toolCallsMeta.length === 0 || responseText.length <= 400;

    await logLlmCall(input.toolCtx, {
      model: MODEL,
      prompt_sha: MANOS_PROMPT_SHA,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      latency_ms,
      tool_calls: toolCallsMeta,
      grounded,
    });

    if (toolUseBlocks.length === 0) {
      if (!responseText) log.warn("anthropic returned empty text", { iter });
      return {
        reply: responseText,
        toolCallsMade,
        iterations: iter,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        prompt_sha: MANOS_PROMPT_SHA,
        model: MODEL,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const name = tu.name;
      const args = (tu.input ?? {}) as Record<string, unknown>;
      log.info("tool call", { name, args_keys: Object.keys(args) });
      let result: ToolResult<unknown>;
      const dispatchT0 = Date.now();
      try {
        const dispatch = input.dispatcher ?? dispatchManosTools;
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
      if (!result.ok && result.code === "max_tools_reached") {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          is_error: true,
        });
        messages.push({ role: "user", content: toolResultBlocks });
        return {
          reply: "",
          toolCallsMade,
          iterations: iter,
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
          prompt_sha: MANOS_PROMPT_SHA,
          model: MODEL,
        };
      }
      // Primary path verified against claude-sonnet-4-5 on 2026-05-29 via
      // scripts/probe-anthropic-tool-result-image.ts: an `image` block inside
      // tool_result.content is accepted and the model successfully describes
      // the pixels in its next turn. Gated strictly to view_photo; every
      // other tool keeps the historical JSON.stringify path so behaviour for
      // list_my_pending_ots / attach_photos / set_alcance_ot / finalize_alcance
      // is byte-for-byte unchanged.
      if (
        name === "view_photo" &&
        result.ok &&
        (result.data as { image_url?: string } | null)?.image_url
      ) {
        const data = result.data as { image_url: string; n: number };
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [
            { type: "image", source: { type: "url", url: data.image_url } },
            { type: "text", text: `(foto #${data.n} re-adjuntada)` },
          ],
        });
      } else {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        });
      }
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
    prompt_sha: MANOS_PROMPT_SHA,
    model: MODEL,
  };
}
