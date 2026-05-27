// Drains the outbound_messages queue. dashboard-mp's HR actions enqueue rows;
// this loop in tono-mp picks them up and sends via Baileys (the only process
// that holds the WhatsApp socket).
//
// Single-instance assumption: only one tono-mp replica runs in production.
// If we ever scale tono-mp to >1, we'll need row-level locking (SELECT FOR
// UPDATE SKIP LOCKED) — Supabase REST doesn't expose that, so we'd switch
// to a Postgres function. Not relevant at v1 scale.

import { createLogger, jidFromPhone, type ServerClient } from "@redin/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppClient } from "./whatsapp";
import { SessionStore } from "./session";

const log = createLogger("tono:outbound");

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;

const MIN_INTERVAL_MS = 10_000;
const JITTER_MS = 500;

const lastSentAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WhatsApp's native bold is *single* asterisks. Markdown-style **double**
// renders LITERALLY in WhatsApp (the asterisks stay visible) and breaks the
// blue-collar UX immediately. Toño's prompt instructs single-asterisk usage,
// but this defensive layer downgrades any `**X**` → `*X*` before send so
// LLM drift or dashboard-side messages can't leak Markdown to the wire.
//
// Same logic applies to `__double__` italics — WhatsApp wants single `_X_`.
// We collapse iteratively to handle nested cases like `****X****` (rare).
export function normalizeForWhatsApp(body: string): string {
  if (!body) return body;
  let out = body;
  if (out.includes("**")) {
    let prev: string;
    do {
      prev = out;
      out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
    } while (out !== prev);
  }
  if (out.includes("__")) {
    let prev: string;
    do {
      prev = out;
      out = out.replace(/__([^_\n]+?)__/g, "_$1_");
    } while (out !== prev);
  }
  return out;
}

export interface OutboundDrainerOpts {
  supabase: ServerClient;
  wa: WhatsAppClient;
  isReady: () => boolean;
}

// Outbound messages enqueued by tono itself (sendAgentReply) are already
// persisted to the messages table by agent.ts — skip re-persistence here to
// avoid duplicates. Any other source (dashboard HR actions: approval_push,
// hr_decision, pedir_llamada_notification, hr_doc_request, ...) MUST be
// persisted so the LLM sees the full conversation on the next user turn.
// Without this, the LLM is amnesiac about system-initiated messages and
// produces non-sequiturs like "¿Qué significa '2'?" after an approval push.
async function persistSystemPushToMessages(
  supabase: ServerClient,
  phone: string,
  body: string
): Promise<void> {
  try {
    const sessions = new SessionStore(supabase);
    const session = await sessions.getOrCreate(phone, "whatsapp");
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: body,
    });
    await sessions.touch(session.id);
  } catch (e) {
    log.warn("system-push messages persist failed (non-fatal)", {
      phone,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function isSystemPush(meta: unknown): boolean {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return true;
  const source = (meta as Record<string, unknown>).source;
  return source !== "tono_agent";
}

export function startOutboundDrainer(opts: OutboundDrainerOpts): () => void {
  const { supabase, wa, isReady } = opts;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    if (!isReady()) return;
    inFlight = true;
    try {
      const { data, error } = await supabase
        .from("outbound_messages")
        .select(
          "id, phone, body, attempts, kind, attachment_path, attachment_filename, attachment_bucket, meta"
        )
        .eq("status", "pending")
        .lt("attempts", MAX_ATTEMPTS)
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (error) {
        log.error("poll failed", { error: error.message });
        return;
      }
      for (const row of data ?? []) {
        // Prefer the persisted inbound JID over a phone-rebuilt JID. The
        // rebuilt one hardcodes "@s.whatsapp.net" and silently misses
        // LID-mode accounts ("<digits>@lid"). See migration 004.
        const { data: tec } = await supabase
          .from("tecnicos_extended")
          .select("last_jid")
          .eq("phone", row.phone)
          .maybeSingle();
        const jid =
          (tec as { last_jid: string | null } | null)?.last_jid ??
          jidFromPhone(row.phone);
        if (!jid || !jid.includes("@")) {
          await markFailed(supabase, row.id, "invalid phone");
          continue;
        }
        try {
          const now = Date.now();
          const last = lastSentAt.get(row.phone);
          if (last !== undefined) {
            const elapsed = now - last;
            if (elapsed < MIN_INTERVAL_MS) {
              const delay = MIN_INTERVAL_MS - elapsed + Math.random() * JITTER_MS;
              log.info("rate-limiting outbound", { phone: row.phone, delay_ms: Math.round(delay) });
              await sleep(delay);
            }
          }

          const body = normalizeForWhatsApp(row.body);
          if (row.kind === "document" && row.attachment_path) {
            const bucket = row.attachment_bucket ?? "contratos";
            const { data: blob, error: dlErr } = await supabase.storage
              .from(bucket)
              .download(row.attachment_path);
            if (dlErr || !blob) {
              throw new Error(`storage download failed: ${dlErr?.message ?? "no blob"}`);
            }
            const arrBuf = await blob.arrayBuffer();
            const buffer = Buffer.from(arrBuf);
            await wa.sendDocument(jid, buffer, {
              fileName: row.attachment_filename ?? "documento.pdf",
              mimetype: "application/pdf",
              caption: body,
            });
          } else {
            await wa.sendText(jid, body);
          }
          lastSentAt.set(row.phone, Date.now());
          await markSent(supabase, row.id);
          if (body && isSystemPush(row.meta)) {
            await persistSystemPushToMessages(supabase, row.phone, body);
          }
          log.info("sent", { id: row.id, phone: row.phone, jid, kind: row.kind ?? "text" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await markRetry(supabase, row.id, (row.attempts ?? 0) + 1, msg);
          log.error("send failed", { id: row.id, error: msg });
        }
      }
    } finally {
      inFlight = false;
    }
  };

  // First tick after a short delay so Baileys has time to come up after boot.
  setTimeout(() => {
    void tick();
  }, 2_000);
  const handle = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  return () => clearInterval(handle);
}

async function markSent(supa: SupabaseClient, id: string): Promise<void> {
  await supa
    .from("outbound_messages")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id);
}

async function markFailed(
  supa: SupabaseClient,
  id: string,
  error: string
): Promise<void> {
  await supa
    .from("outbound_messages")
    .update({ status: "failed", last_error: error })
    .eq("id", id);
}

async function markRetry(
  supa: SupabaseClient,
  id: string,
  attempts: number,
  error: string
): Promise<void> {
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await supa
    .from("outbound_messages")
    .update({ attempts, last_error: error, status })
    .eq("id", id);
}

// Resilient send path for Toño's per-turn agent reply.
//
// Why this exists: previously the runner called wa.sendText() directly and
// only persisted the turn — when Baileys was mid-reconnect (statusCode=440
// storm), sendText threw, the user never saw the reply, and there was no
// row in outbound_messages for the drainer to retry. The user was left
// staring at a one-sided conversation.
//
// New shape:
//   1. Always insert a `pending` row first → drainer has a recovery path.
//   2. Try a direct send for low latency (PRD §22 p95 ≤ 8s).
//   3. On success: mark `sent` + record lastSentAt so the drainer's 10s
//      rate-limiter knows about it (prevents bursts from HR-triggered
//      notifications racing the agent reply).
//   4. On failure: leave the row `pending`; the drainer picks it up on
//      its next tick (and definitely after Baileys reconnects).
export async function sendAgentReply(
  supabase: SupabaseClient,
  wa: WhatsAppClient,
  args: {
    phone: string;
    jid: string;
    body: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  const body = normalizeForWhatsApp(args.body.trim());
  if (!body) return;

  let outboundId: string | null = null;
  const { data: outRow, error: insErr } = await supabase
    .from("outbound_messages")
    .insert({
      phone: args.phone,
      body,
      channel: "whatsapp",
      kind: "text",
      status: "pending",
      meta: args.meta ?? null,
    })
    .select("id")
    .single();
  if (insErr) {
    // Persistence failed — still attempt direct send so the user isn't left
    // hanging, but log loudly. If direct send also fails, the message is
    // gone (no row for the drainer to retry).
    log.warn("outbound enqueue failed; attempting direct send only", {
      phone: args.phone,
      error: insErr.message,
    });
  } else if (outRow && typeof (outRow as { id?: unknown }).id === "string") {
    outboundId = (outRow as { id: string }).id;
  }

  try {
    await wa.sendText(args.jid, body);
    lastSentAt.set(args.phone, Date.now());
    if (outboundId) {
      await markSent(supabase, outboundId);
    }
  } catch (e) {
    // Direct send failed — leave the row pending so the drainer retries.
    log.warn("direct send failed; left in outbound queue for drainer", {
      phone: args.phone,
      id: outboundId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
