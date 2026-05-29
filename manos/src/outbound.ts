// Drains the outbound_messages queue for messages tagged channel="manos".
// Dashboard's /api/hr/nudge-architect enqueues rows with channel="manos";
// this loop in manos-mp picks them up and sends via Baileys.
//
// Single-instance assumption: only one manos-mp replica runs in production.
//
// LID delivery: on accounts using WhatsApp's LID identifier the real
// remoteJid is "<id>@lid", NOT "<phone>@s.whatsapp.net". Reconstructing the
// jid from the stored phone string (jidFromPhone) produces a dead address on
// LID accounts → Baileys reports "sent" but the message never arrives.
// Fix: capture the real inbound jid on the session's meta JSON in agent.ts;
// the drainer looks it up here via preferredJid().

import { createLogger, jidFromPhone } from "@redin/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppClient } from "./whatsapp";

const log = createLogger("manos:outbound");

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;

/**
 * Pure helper: pick the best jid to send to.
 *   - If `metaJid` is a string containing "@", trust it verbatim (covers
 *     both "<id>@lid" for LID accounts and "<phone>@s.whatsapp.net" for
 *     classic numbers — whatever Baileys observed on the inbound).
 *   - Otherwise fall back to reconstructing from the stored phone via
 *     jidFromPhone(); this only works for classic @s.whatsapp.net numbers
 *     but it's the same behavior we had before the LID fix, so classic
 *     accounts are unaffected.
 *
 * Exported for the unit test in scripts/test-manos-outbound-jid.ts.
 */
export function preferredJid(metaJid: unknown, phone: string): string | null {
  if (typeof metaJid === "string" && metaJid.includes("@")) {
    return metaJid;
  }
  const fallback = jidFromPhone(phone);
  // jidFromPhone returns "" if phone has no digits — treat that as null
  // (drainer expects null/missing-"@" to fail the row).
  if (!fallback || !fallback.includes("@")) return null;
  return fallback;
}

export interface OutboundDrainerOpts {
  supabase: SupabaseClient;
  wa: WhatsAppClient;
  isReady: () => boolean;
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
        .eq("channel", "manos")
        .lt("attempts", MAX_ATTEMPTS)
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (error) {
        log.error("poll failed", { error: error.message });
        return;
      }
      for (const row of data ?? []) {
        // Look up the most-recent manos session for this phone to pull the
        // real inbound jid captured at agent.ts (LID-aware). Falls back to
        // the row's own meta.jid (set by sendAgentReply), then to
        // jidFromPhone(phone) — the legacy reconstruction.
        const { data: sess } = await supabase
          .from("sessions")
          .select("meta")
          .eq("phone", row.phone)
          .eq("channel", "manos")
          .order("last_active", { ascending: false })
          .limit(1)
          .maybeSingle();
        const sessionMetaJid =
          sess && typeof (sess as { meta?: unknown }).meta === "object" &&
          (sess as { meta: Record<string, unknown> | null }).meta !== null
            ? (sess as { meta: Record<string, unknown> }).meta.jid
            : undefined;
        const rowMetaJid =
          row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
            ? (row.meta as Record<string, unknown>).jid
            : undefined;
        const jid = preferredJid(sessionMetaJid ?? rowMetaJid, row.phone);
        if (!jid || !jid.includes("@")) {
          await markFailed(supabase, row.id, "invalid phone");
          continue;
        }
        try {
          if (row.kind === "document" && row.attachment_path) {
            const bucket = row.attachment_bucket ?? "alcance-photos";
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
              caption: row.body,
            });
          } else {
            await wa.sendText(jid, row.body);
          }
          await markSent(supabase, row.id);
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

  setTimeout(() => { void tick(); }, 2_000);
  const handle = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  return () => clearInterval(handle);
}

async function markSent(supa: SupabaseClient, id: string): Promise<void> {
  await supa
    .from("outbound_messages")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id);
}

async function markFailed(supa: SupabaseClient, id: string, error: string): Promise<void> {
  await supa
    .from("outbound_messages")
    .update({ status: "failed", last_error: error })
    .eq("id", id);
}

async function markRetry(supa: SupabaseClient, id: string, attempts: number, error: string): Promise<void> {
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await supa
    .from("outbound_messages")
    .update({ attempts, last_error: error, status })
    .eq("id", id);
}

// Resilient send for Manos's per-turn agent reply. Mirrors the helper in
// tono/src/outbound.ts — same enqueue-first invariant prevents replies from
// being lost when Baileys is mid-reconnect. The channel="manos" tag keeps
// agent-generated rows on Manos's drainer, separate from Toño's queue.
//
// We also stamp `meta.jid = args.jid` so that if the direct send fails and
// the drainer fallback picks the row up later, it has the real inbound jid
// even if the session row's meta hasn't been written yet.
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
  const body = args.body.trim();
  if (!body) return;

  const meta: Record<string, unknown> = { ...(args.meta ?? {}), jid: args.jid };

  let outboundId: string | null = null;
  const { data: outRow, error: insErr } = await supabase
    .from("outbound_messages")
    .insert({
      phone: args.phone,
      body,
      channel: "manos",
      kind: "text",
      status: "pending",
      meta,
    })
    .select("id")
    .single();
  if (insErr) {
    log.warn("outbound enqueue failed; attempting direct send only", {
      phone: args.phone,
      error: insErr.message,
    });
  } else if (outRow && typeof (outRow as { id?: unknown }).id === "string") {
    outboundId = (outRow as { id: string }).id;
  }

  try {
    await wa.sendText(args.jid, body);
    if (outboundId) {
      await markSent(supabase, outboundId);
    }
  } catch (e) {
    log.warn("direct send failed; left in outbound queue for drainer", {
      phone: args.phone,
      id: outboundId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
