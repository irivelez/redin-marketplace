// Long-running sync service:
//   - Mirror refresh every 15 minutes (node-cron) — pulls AppSheet → Supabase.
//   - Projector tick every 60 seconds (setInterval) — pushes Supabase →
//     AppSheet for approved/revoked candidates.
// SIGUSR1 triggers an on-demand mirror refresh (dev convenience).
//
// node-cron 6-field syntax was considered for the projector cron but the
// installed version's behavior with seconds is inconsistent across docs.
// setInterval(60_000) is the unambiguous, verified path; we use it instead.

import cron from "node-cron";
import { createLogger, createServerClient, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "./appsheet";
import { SyncWorker } from "./mirror";
import { tickOnce, tickOtAlcanceOutbox } from "./projector";
import { TelegramBotSink } from "./telegram";
import { runDocFollowupTick } from "./proactive-followup";

const log = createLogger("sync:runner");

async function main() {
  const appsheet = new AppSheetReadClient({
    appId: requireEnv("APPSHEET_APP_ID"),
    accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
  });
  const worker = new SyncWorker({ appsheet });
  const supa = createServerClient();
  const telegram = TelegramBotSink.fromEnv();

  log.info("starting sync runner", {
    mirror_cron: "*/15 * * * *",
    projector_interval_ms: 60_000,
    timezone: "America/Bogota",
  });

  // Initial mirror refresh so the system doesn't wait 15 min on cold boot.
  worker.refreshAll().catch((e) =>
    log.error("initial refresh failed", { error: String(e) })
  );

  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        const r = await worker.refreshAll();
        log.info("cron refresh ok", { ok: r.ok, total_ms: r.total_ms });
      } catch (e) {
        log.error("cron refresh failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    { timezone: "America/Bogota" }
  );

  // Initial projector tick on cold boot. If approve happened during downtime,
  // don't wait 60s.
  void tickOnce({ supa, appsheet, telegram }).catch((e) =>
    log.error("initial projector tick failed", { error: String(e) })
  );
  void tickOtAlcanceOutbox({ supa, appsheet, telegram }).catch((e) =>
    log.error("initial OT alcance tick failed", { error: String(e) })
  );

  // Re-entrancy guard so a slow tick doesn't queue up an overlap.
  let projectorRunning = false;
  setInterval(async () => {
    if (projectorRunning) {
      log.warn("projector tick still running; skipping interval");
      return;
    }
    projectorRunning = true;
    try {
      const [results, alcanceResults] = await Promise.all([
        tickOnce({ supa, appsheet, telegram }),
        tickOtAlcanceOutbox({ supa, appsheet, telegram }),
      ]);
      if (results.length > 0) {
        log.info("projector tick", { count: results.length, results });
      }
      if (alcanceResults.length > 0) {
        log.info("OT alcance tick", { count: alcanceResults.length, results: alcanceResults });
      }
    } catch (e) {
      log.error("projector tick failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      projectorRunning = false;
    }
  }, 60_000);

  // Gap A.6 — Proactive ARL/EPS doc follow-up at 10:00 COT (15:00 UTC) daily.
  // Sends max 2 reminders per worker; 24h minimum spacing enforced inside the tick.
  cron.schedule(
    "0 10 * * *",
    async () => {
      try {
        const results = await runDocFollowupTick(supa);
        const sent = results.filter((r) => r.sent).length;
        log.info("doc-followup cron ok", {
          candidates: results.length,
          sent,
        });
      } catch (e) {
        log.error("doc-followup cron failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    { timezone: "America/Bogota" }
  );

  process.on("SIGUSR1", () => {
    log.info("on-demand refresh signaled");
    worker.refreshAll().catch((e) =>
      log.error("on-demand refresh failed", { error: String(e) })
    );
  });

  // SIGUSR2 → on-demand doc-followup tick (dev convenience for ops testing).
  process.on("SIGUSR2", () => {
    log.info("on-demand doc-followup signaled");
    runDocFollowupTick(supa).catch((e) =>
      log.error("on-demand doc-followup failed", { error: String(e) })
    );
  });
}

main().catch((e) => {
  log.error("runner fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
