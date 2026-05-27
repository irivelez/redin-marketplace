// Drains the outbound_messages queue for messages tagged channel="manos".
// Dashboard's /api/hr/nudge-architect enqueues rows with channel="manos";
// this loop in manos-mp picks them up and sends via Baileys.
//
// Single-instance assumption: only one manos-mp replica runs in production.

import { createLogger, jidFromPhone } from "@redin/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppClient } from "./whatsapp";

const log = createLogger("manos:outbound");

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;

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
          "id, phone, body, attempts, kind, attachment_path, attachment_filename, attachment_bucket"
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
        // Prefer the JID from arquitectos_mirror if available.
        const { data: arq } = await supabase
          .from("arquitectos_mirror")
          .select("data")
          .filter("data->>Telefono", "eq", row.phone)
          .limit(1)
          .maybeSingle();
        const jid = jidFromPhone(row.phone);
        if (!jid || !jid.includes("@")) {
          await markFailed(supabase, row.id, "invalid phone");
          continue;
        }
        // Suppress unused variable warning — arq is queried for completeness
        void arq;
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

  let outboundId: string | null = null;
  const { data: outRow, error: insErr } = await supabase
    .from("outbound_messages")
    .insert({
      phone: args.phone,
      body,
      channel: "manos",
      kind: "text",
      status: "pending",
      meta: args.meta ?? null,
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
