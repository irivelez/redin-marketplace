// Toño runner — starts Baileys + wires each inbound WhatsApp message into the
// agent. Per-phone serialization via KeyedMutex. Telegram escalation sink wired.

import {
  createLogger,
  createServerClient,
  jidFromPhone,
  requireEnv,
} from "@redin/shared";
import { makeDefaultToolContext } from "@redin/tools";
import { handleMessage } from "./agent";
import { KeyedMutex } from "./mutex";
import { sendAgentReply, startOutboundDrainer } from "./outbound";
import { TelegramEscalationSink } from "./telegram-escalation";
import { WhatsAppClient, defaultAuthDir } from "./whatsapp";

const log = createLogger("tono:runner");

async function main() {
  // Fail-fast env validation so we don't pair, take a user message, then crash.
  requireEnv("SUPABASE_URL");
  requireEnv("SUPABASE_SECRET_KEY");
  requireEnv("ANTHROPIC_API_KEY");

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
        log.info("Toño is online", {
          number_env: process.env.WA_NUMBER ?? "(unset)",
        });
      },
      onMessage: async ({ phone, text, jid, media, media_failures }) => {
        mutex
          .run(phone, async () => {
            const toolCtx = makeDefaultToolContext({
              supabase,
              defaultActor: `tecnico:${phone}`,
              escalationSink,
            });
            const result = await handleMessage({
              phone,
              text,
              channel: "whatsapp",
              toolCtx,
              jid,
              media,
              media_failures,
            });
            log.info("handled", {
              phone,
              session_id: result.session_id,
              reply_len: result.reply.length,
              tools: result.tool_calls.map((t) => `${t.name}:${t.result_ok ? "ok" : "err"}`).join(","),
            });
            if (result.reply.trim()) {
              // sendAgentReply persists to outbound_messages FIRST, then
              // attempts a direct send. If Baileys is mid-reconnect the row
              // stays pending and the drainer retries — no more silently
              // lost replies during 440 storms.
              await sendAgentReply(supabase, wa, {
                phone,
                jid,
                body: result.reply,
                meta: { source: "tono_agent", session_id: result.session_id },
              });
            }
          })
          .catch((e) => {
            log.error("handler failed", {
              phone,
              error: e instanceof Error ? e.message : String(e),
            });
            // Resilient fallback so the user isn't left hanging even if
            // Baileys is down right now — the drainer will retry on reconnect.
            sendAgentReply(supabase, wa, {
              phone,
              jid,
              body: "Hoy tuve un problema técnico. Inténtame en un rato y te ayudo.",
              meta: { source: "tono_fallback" },
            }).catch(() => {
              /* last resort — already logged inside the helper */
            });
          });
      },
    },
  });

  await wa.start();
  log.info("Toño runner started", {
    concurrent_limit: "per-phone serialized, phones parallel",
    mutex_size_live: mutex.size(),
  });

  // Drain HR-triggered worker notifications enqueued by dashboard-mp.
  startOutboundDrainer({ supabase, wa, isReady: () => waReady });

  // Keep the process alive:
  setInterval(() => {
    /* heartbeat */
  }, 60_000);

  // Avoid unused-import warning for jidFromPhone — we expose it for future outbound use.
  void jidFromPhone;
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
