// Manos runner — starts Baileys + wires each inbound WhatsApp message into the
// Manos agent. Per-phone serialization via KeyedMutex. Telegram escalation wired.
// Separate service from tono-mp — different WA number, different Baileys volume.

import {
  createLogger,
  createServerClient,
  requireEnv,
} from "@redin/shared";
import { makeDefaultToolContext } from "@redin/tools";
import { handleManosMessage } from "./agent";
import { KeyedMutex } from "./mutex";
import { sendAgentReply, startOutboundDrainer } from "./outbound";
import { TelegramEscalationSink } from "./telegram-escalation";
import { WhatsAppClient, defaultAuthDir } from "./whatsapp";

const log = createLogger("manos:runner");

async function main() {
  // Fail-fast env validation — don't pair, take a user message, then crash.
  requireEnv("SUPABASE_URL");
  requireEnv("SUPABASE_SECRET_KEY");
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("GROQ_API_KEY");

  const supabase = createServerClient();
  const escalationSink = TelegramEscalationSink.fromEnv();
  const mutex = new KeyedMutex();

  let waReady = false;

  const wa = new WhatsAppClient({
    authDir: defaultAuthDir(),
    supabase,
    printQr: true,
    handlers: {
      onReady: () => {
        waReady = true;
        log.info("Manos is online", {
          number_env: process.env.MANOS_WA_NUMBER ?? "(unset)",
        });
      },
      onMessage: async ({ phone, text, jid, imageUrls }) => {
        mutex
          .run(phone, async () => {
            const toolCtx = makeDefaultToolContext({
              supabase,
              defaultActor: `tecnico:${phone}`, // arquitectos use tecnico: actor namespace for now
              escalationSink,
            });
            const result = await handleManosMessage(
              {
                phone,
                text,
                channel: "manos" as const,
                toolCtx,
                jid,
                imageUrls,
              },
              { supabase, escalationSink }
            );
            log.info("handled", {
              phone,
              session_id: result.session_id,
              reply_len: result.reply.length,
              tools: result.tool_calls
                .map((t) => `${t.name}:${t.result_ok ? "ok" : "err"}`)
                .join(","),
            });
            if (result.reply.trim()) {
              await sendAgentReply(supabase, wa, {
                phone,
                jid,
                body: result.reply,
                meta: { source: "manos_agent", session_id: result.session_id },
              });
            }
          })
          .catch((e) => {
            log.error("handler failed", {
              phone,
              error: e instanceof Error ? e.message : String(e),
            });
            sendAgentReply(supabase, wa, {
              phone,
              jid,
              body: "Hoy tuve un problema técnico. Inténtame en un rato y te ayudo.",
              meta: { source: "manos_fallback" },
            }).catch(() => {
              /* last resort — already logged inside the helper */
            });
          });
      },
    },
  });

  await wa.start();
  log.info("Manos runner started", {
    concurrent_limit: "per-phone serialized, phones parallel",
    mutex_size_live: mutex.size(),
  });

  // Drain HR-triggered architect nudges enqueued by dashboard-mp.
  startOutboundDrainer({ supabase, wa, isReady: () => waReady });

  // Keep the process alive.
  setInterval(() => {
    /* heartbeat */
  }, 60_000);
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
