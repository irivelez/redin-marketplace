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
import { startOutboundDrainer } from "./outbound";
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
      onMessage: async ({ phone, text, jid, media }) => {
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
            });
            log.info("handled", {
              phone,
              session_id: result.session_id,
              reply_len: result.reply.length,
              tools: result.tool_calls.map((t) => `${t.name}:${t.result_ok ? "ok" : "err"}`).join(","),
            });
            if (result.reply.trim()) {
              await wa.sendText(jid, result.reply);
            }
          })
          .catch((e) => {
            log.error("handler failed", {
              phone,
              error: e instanceof Error ? e.message : String(e),
            });
            // Try to send a soft fallback so the user isn't left hanging.
            wa.sendText(
              jid,
              "Hoy tuve un problema técnico. Inténtame en un rato y te ayudo."
            ).catch(() => {
              /* ignore */
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
