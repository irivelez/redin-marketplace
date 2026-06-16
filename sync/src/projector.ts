// AppSheet TECNICOS reverse-projection — drainer.
//
// Per docs/architecture/onboarding-contracts.md §8:
//   - approved candidates → AppSheet Add (find-by-name first; capture Row ID
//     without Add if a row with the same name already exists; ambiguous-name
//     escalates to Telegram).
//   - revoked candidates → AppSheet Delete by Row ID. Re-deletes (404) treated
//     as success.
//
// Concurrency:
//   - Single-instance projector per contract §14.1.
//   - In-process Set<tecnico_id> guards against re-entrant ticks (e.g., manual
//     SIGUSR1 overlapping the cron).
//   - DB CAS on appsheet_sync_attempts as belt-and-braces against accidental
//     multi-instance (Railway redeploy overlap, dev-against-prod).
//
// Failure handling:
//   - Bumps appsheet_sync_attempts on every failed dispatch (incl. ambiguous_name).
//   - At attempt 3, sends a louder Telegram ping; the dashboard's per-worker
//     warning banner surfaces appsheet_sync_last_error in the operator's UI.

import { createLogger, signOtPublicToken } from "@redin/shared";
import type { ServerClient } from "@redin/shared";
import type { AppSheetReadClient } from "./appsheet";
import type { TelegramSink } from "./telegram";

const log = createLogger("sync:projector");

const ALCANCE_LINK_BASE_URL =
  process.env.DASHBOARD_URL ??
  "https://dashboard-mp-production-1ef3.up.railway.app";

const inFlight = new Set<string>();

export interface ProjectorTickDeps {
  supa: ServerClient;
  appsheet: AppSheetReadClient;
  telegram?: TelegramSink;
  // Optional override for testing — defaults to 3.
  failureEscalationThreshold?: number;
}

export type ProjectorAction =
  | "added"
  | "found_existing"
  | "deleted"
  | "skipped"
  | "skipped_already_gone";

export interface ProjectorTickResult {
  tecnico_id: string;
  action: ProjectorAction;
  appsheet_row_id?: string;
  attempts: number;
  error?: string;
}

interface CandidateRow {
  tecnico_id: string;
  phone: string;
  candidate_state: string;
  appsheet_row_id: string | null;
  appsheet_sync_attempts: number;
  nombre: string | null;
}

const ATTEMPTS_LIMIT = 3;

// ---------------------------------------------------------------------------
// OT alcance outbox drain — ots_extended.appsheet_alcance_pending
// ---------------------------------------------------------------------------

export interface OtAlcanceProjectorResult {
  ot_row_id: string;
  action: "synced" | "skipped" | "column_missing" | "already_gone";
  attempts: number;
  error?: string;
}

const OT_ALCANCE_ATTEMPTS_LIMIT = 5;

/**
 * Drain up to 5 ots_extended rows where appsheet_alcance_pending=true and write
 * the alcance (scope) into the AppSheet `Alcance_OT` column so HR/Jose see it on
 * the OT. No-ops safely if the column doesn't exist yet (Estado_Redin precedent).
 *
 * SAFETY: the ONLY OT field we ever write is `Alcance_OT`. We never write
 * ID_Orden, Numero_Orden (the consecutive), or any other column, and we never
 * Add or Delete OT rows.
 */
export async function tickOtAlcanceOutbox(
  deps: ProjectorTickDeps
): Promise<OtAlcanceProjectorResult[]> {
  const { data: pendingRows, error } = await deps.supa
    .from("ots_extended")
    .select("ot_row_id, appsheet_alcance_sync_attempts")
    .eq("appsheet_alcance_pending", true)
    .lt("appsheet_alcance_sync_attempts", OT_ALCANCE_ATTEMPTS_LIMIT)
    .limit(5);

  if (error) {
    log.error("ots_extended pending query failed", { error: error.message });
    return [];
  }

  const results: OtAlcanceProjectorResult[] = [];

  for (const row of pendingRows ?? []) {
    const otRowId = row.ot_row_id as string;
    const currentAttempts = (row.appsheet_alcance_sync_attempts as number) ?? 0;

    // Resolve the AppSheet row key (ID_Orden) BEFORE claiming an attempt.
    // ID_Orden is the table's key; AppSheet assigns it shortly after a row is
    // created. If the mirror doesn't carry it yet, skip WITHOUT burning an
    // attempt so the row simply retries on a later tick (once the next mirror
    // refresh brings ID_Orden) instead of dead-lettering while merely waiting.
    // NEVER fall back to Numero_Orden as the key — doing so produced weeks of
    // AppSheet 400 "Row key field 'ID_Orden' value is missing" dead-letters.
    const { data: otMirrow } = await deps.supa
      .from("ots_mirror")
      .select("data")
      .eq("row_id", otRowId)
      .maybeSingle();
    const otData = otMirrow?.data as Record<string, unknown> | null;
    const rawIdOrden = otData?.["ID_Orden"];
    const idOrden =
      typeof rawIdOrden === "string" && rawIdOrden.trim() ? rawIdOrden.trim() : null;

    if (!idOrden) {
      const errMsg = "waiting_for_appsheet_id_orden";
      await deps.supa
        .from("ots_extended")
        .update({ appsheet_alcance_last_error: errMsg })
        .eq("ot_row_id", otRowId);
      results.push({ ot_row_id: otRowId, action: "skipped", attempts: currentAttempts, error: errMsg });
      continue;
    }

    const { data: claimed } = await deps.supa
      .from("ots_extended")
      .update({ appsheet_alcance_sync_attempts: currentAttempts + 1 })
      .eq("ot_row_id", otRowId)
      .eq("appsheet_alcance_sync_attempts", currentAttempts)
      .select("ot_row_id");

    if (!claimed || claimed.length === 0) {
      results.push({ ot_row_id: otRowId, action: "skipped", attempts: currentAttempts, error: "claim_lost" });
      continue;
    }

    const claimedAttempts = currentAttempts + 1;

    const alcanceUrl = buildAlcanceOtUrl(otRowId);
    if (!alcanceUrl) {
      const errMsg = "missing_supabase_secret_for_alcance_link";
      await deps.supa
        .from("ots_extended")
        .update({ appsheet_alcance_last_error: errMsg })
        .eq("ot_row_id", otRowId);
      results.push({ ot_row_id: otRowId, action: "skipped", attempts: claimedAttempts, error: errMsg });
      continue;
    }

    try {
      const result = await deps.appsheet.editOT(otRowId, idOrden, {
        Alcance_OT: alcanceUrl,
      });

      if (result.alreadyGone) {
        await deps.supa
          .from("ots_extended")
          .update({
            appsheet_alcance_pending: false,
            appsheet_alcance_last_error: null,
          })
          .eq("ot_row_id", otRowId);
        results.push({ ot_row_id: otRowId, action: "already_gone", attempts: claimedAttempts });
        continue;
      }

      if (result.columnMissing) {
        // AppSheet column Alcance_OT doesn't exist yet — no-op per Estado_Redin precedent.
        const errMsg = "appsheet_column_Alcance_OT_not_found";
        await deps.supa
          .from("ots_extended")
          .update({ appsheet_alcance_last_error: errMsg })
          .eq("ot_row_id", otRowId);
        log.info("Alcance_OT column missing in AppSheet — leaving pending", { ot_row_id: otRowId });
        results.push({ ot_row_id: otRowId, action: "column_missing", attempts: claimedAttempts, error: errMsg });
        continue;
      }

      // Success.
      await deps.supa
        .from("ots_extended")
        .update({
          appsheet_alcance_pending: false,
          appsheet_alcance_last_error: null,
        })
        .eq("ot_row_id", otRowId);
      await deps.supa.from("eventos").insert({
        type: "appsheet_alcance_synced",
        entity_id: otRowId,
        actor: "system:projector",
        meta: { ot_row_id: otRowId, attempts: claimedAttempts },
      });
      log.info("AppSheet Alcance_OT synced", { ot_row_id: otRowId });
      results.push({ ot_row_id: otRowId, action: "synced", attempts: claimedAttempts });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await deps.supa
        .from("ots_extended")
        .update({ appsheet_alcance_last_error: errMsg.slice(0, 500) })
        .eq("ot_row_id", otRowId);
      log.error("OT alcance AppSheet sync failed", { ot_row_id: otRowId, error: errMsg });

      // Visibility plumbing — mirrors the tecnicos projector's markFailure
      // pattern (see processAdd/markFailure below). Three rungs:
      //   1) Always emit an `appsheet_alcance_projection_failed` event so
      //      the dashboard/audit trail picks it up.
      //   2) At attempt ≥ 3, ping Telegram so ops sees the repeat failure
      //      before it dies.
      //   3) At attempt == OT_ALCANCE_ATTEMPTS_LIMIT (5), drop the row out
      //      of the polling window by setting pending=false and emit a
      //      dead-letter event + final Telegram. The last_error stays
      //      populated so the dashboard can surface "pending=false AND
      //      last_error IS NOT NULL" as the dead-letter queue.
      // All side-effects are best-effort: Telegram or event-insert failures
      // are swallowed so the projector tick never crashes on a side-channel.
      try {
        await deps.supa.from("eventos").insert({
          type: "appsheet_alcance_projection_failed",
          entity_id: otRowId,
          actor: "system:projector",
          meta: { attempts: claimedAttempts, error: errMsg.slice(0, 500) },
        });
      } catch (logErr) {
        log.warn("could not insert appsheet_alcance_projection_failed event", {
          ot_row_id: otRowId,
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }

      if (claimedAttempts >= 3 && deps.telegram) {
        try {
          await deps.telegram.send(
            `Alcance projector falla repetidamente para OT ${otRowId} — intento ${claimedAttempts}/${OT_ALCANCE_ATTEMPTS_LIMIT}: ${errMsg.slice(0, 300)}`
          );
        } catch (tgErr) {
          log.warn("telegram escalation failed (alcance projector)", {
            ot_row_id: otRowId,
            error: tgErr instanceof Error ? tgErr.message : String(tgErr),
          });
        }
      }

      if (claimedAttempts >= OT_ALCANCE_ATTEMPTS_LIMIT) {
        // Dead-letter: stop polling this row, but leave last_error set so
        // it remains findable. Manual intervention is required to clear it.
        try {
          await deps.supa
            .from("ots_extended")
            .update({ appsheet_alcance_pending: false })
            .eq("ot_row_id", otRowId);
        } catch (dlErr) {
          log.warn("could not mark alcance row dead-letter", {
            ot_row_id: otRowId,
            error: dlErr instanceof Error ? dlErr.message : String(dlErr),
          });
        }
        try {
          await deps.supa.from("eventos").insert({
            type: "appsheet_alcance_dead_letter",
            entity_id: otRowId,
            actor: "system:projector",
            meta: { attempts: claimedAttempts, error: errMsg.slice(0, 500) },
          });
        } catch (dlEvtErr) {
          log.warn("could not insert appsheet_alcance_dead_letter event", {
            ot_row_id: otRowId,
            error: dlEvtErr instanceof Error ? dlEvtErr.message : String(dlEvtErr),
          });
        }
        if (deps.telegram) {
          try {
            await deps.telegram.send(
              `Alcance projector DEAD-LETTER for OT ${otRowId}. Manual intervention needed. Last error: ${errMsg.slice(0, 300)}`
            );
          } catch (tgErr) {
            log.warn("telegram dead-letter notice failed (alcance projector)", {
              ot_row_id: otRowId,
              error: tgErr instanceof Error ? tgErr.message : String(tgErr),
            });
          }
        }
      }

      results.push({ ot_row_id: otRowId, action: "skipped", attempts: claimedAttempts, error: errMsg });
    }
  }

  return results;
}

function buildAlcanceOtUrl(otRowId: string): string | null {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) return null;
  const base = ALCANCE_LINK_BASE_URL.replace(/\/+$/, "");
  return `${base}/api/alcance/${signOtPublicToken(otRowId, secret)}`;
}

// ---------------------------------------------------------------------------
// Main tick — workers + OT alcance outbox
// ---------------------------------------------------------------------------

export async function tickOnce(
  deps: ProjectorTickDeps
): Promise<ProjectorTickResult[]> {
  const threshold = deps.failureEscalationThreshold ?? 3;

  // Pull deletes first (frees names so a re-Add of a different worker with
  // the same name doesn't get blocked by the stale row).
  const [deletesRes, addsRes] = await Promise.all([
    deps.supa
      .from("tecnicos_extended")
      .select(
        "tecnico_id, phone, candidate_state, appsheet_row_id, appsheet_sync_attempts, nombre"
      )
      .eq("appsheet_delete_pending", true)
      .lt("appsheet_sync_attempts", ATTEMPTS_LIMIT)
      .limit(5),
    deps.supa
      .from("tecnicos_extended")
      .select(
        "tecnico_id, phone, candidate_state, appsheet_row_id, appsheet_sync_attempts, nombre"
      )
      .eq("appsheet_sync_pending", true)
      .lt("appsheet_sync_attempts", ATTEMPTS_LIMIT)
      .limit(5),
  ]);

  const deleteIds = new Set(
    (deletesRes.data ?? []).map((r) => r.tecnico_id as string)
  );
  const all: CandidateRow[] = [
    ...(deletesRes.data ?? []),
    ...(addsRes.data ?? []).filter(
      (r) => !deleteIds.has(r.tecnico_id as string)
    ),
  ] as CandidateRow[];

  const results: ProjectorTickResult[] = [];
  for (const row of all) {
    if (inFlight.has(row.tecnico_id)) continue;
    inFlight.add(row.tecnico_id);
    try {
      // Belt-and-braces: claim the work via CAS on appsheet_sync_attempts.
      // If another instance already bumped it, count=0 → skip this row.
      const { data: claimed, error: claimErr } = await deps.supa
        .from("tecnicos_extended")
        .update({ appsheet_sync_attempts: row.appsheet_sync_attempts + 1 })
        .eq("tecnico_id", row.tecnico_id)
        .eq("appsheet_sync_attempts", row.appsheet_sync_attempts)
        .select("tecnico_id");
      if (claimErr) {
        log.warn("CAS claim failed", {
          tecnico_id: row.tecnico_id,
          error: claimErr.message,
        });
        results.push({
          tecnico_id: row.tecnico_id,
          action: "skipped",
          attempts: row.appsheet_sync_attempts,
          error: `claim_failed: ${claimErr.message}`,
        });
        continue;
      }
      if (!claimed || claimed.length === 0) {
        // Another worker grabbed it — leave silently.
        results.push({
          tecnico_id: row.tecnico_id,
          action: "skipped",
          attempts: row.appsheet_sync_attempts,
          error: "claim_lost",
        });
        continue;
      }

      const claimedAttempts = row.appsheet_sync_attempts + 1;
      const isDelete = deleteIds.has(row.tecnico_id);
      const result = isDelete
        ? await processDelete(deps, row, claimedAttempts, threshold)
        : await processAdd(deps, row, claimedAttempts, threshold);
      results.push(result);
    } finally {
      inFlight.delete(row.tecnico_id);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Add path
// ---------------------------------------------------------------------------

// Migration 011: contact_phone intentionally NOT projected to AppSheet.
// AppSheet's TECNICOS schema only carries `Telefono` (the WA-side identity)
// per docs/architecture/onboarding-contracts.md §8.1. Supabase remains the
// source of truth for the callable number; HR reads it from the dashboard,
// not from Jose's AppSheet.

async function processAdd(
  deps: ProjectorTickDeps,
  row: CandidateRow,
  attempts: number,
  threshold: number
): Promise<ProjectorTickResult> {
  // Migration 010: prefer the first-class column. Fall back to the latest
  // tecnico_registered event for legacy rows where the column wasn't backfilled.
  let nombre: string | null = row.nombre?.trim() || null;
  if (!nombre) {
    const { data: regEvent } = await deps.supa
      .from("eventos")
      .select("meta")
      .eq("type", "tecnico_registered")
      .eq("entity_id", row.tecnico_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    nombre = extractString(regEvent?.meta, "nombre");
  }
  if (!nombre) {
    await markFailure(
      deps,
      row.tecnico_id,
      "no_nombre_in_registered_event",
      attempts,
      threshold
    );
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: "no_nombre",
    };
  }

  try {
    const found = await deps.appsheet.findTecnicoByName(nombre);

    if (found.length === 1) {
      const rowId = found[0]!["Row ID"];
      if (!rowId) {
        await markFailure(
          deps,
          row.tecnico_id,
          "find_returned_row_without_row_id",
          attempts,
          threshold
        );
        return {
          tecnico_id: row.tecnico_id,
          action: "skipped",
          attempts,
          error: "missing_row_id",
        };
      }
      await deps.supa
        .from("tecnicos_extended")
        .update({
          appsheet_row_id: rowId,
          appsheet_sync_pending: false,
          appsheet_synced_at: new Date().toISOString(),
          appsheet_sync_last_error: null,
        })
        .eq("tecnico_id", row.tecnico_id);
      await deps.supa.from("eventos").insert({
        type: "appsheet_add_skipped_existing",
        entity_id: row.tecnico_id,
        actor: "system:projector",
        meta: { row_id: rowId, nombre, attempts },
      });
      log.info("found existing AppSheet row", {
        tecnico_id: row.tecnico_id,
        row_id: rowId,
        nombre,
      });
      return {
        tecnico_id: row.tecnico_id,
        action: "found_existing",
        appsheet_row_id: rowId,
        attempts,
      };
    }

    if (found.length > 1) {
      // Ambiguous — escalate, leave pending. The per-worker dashboard page
      // surfaces the warning banner so HR sees this in the dashboard, not
      // only in Telegram.
      await deps.telegram?.send(
        `AppSheet ambiguous-name: "${nombre}" matches ${found.length} rows; tecnico_id=${row.tecnico_id} (intento ${attempts})`
      );
      const errMsg = `ambiguous_name(${found.length})`;
      await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
      return {
        tecnico_id: row.tecnico_id,
        action: "skipped",
        attempts,
        error: errMsg,
      };
    }

    // 0 results → Add.
    const added = await deps.appsheet.addTecnico({
      "Nombre de Tecnico": nombre,
      Telefono: row.phone,
      EMAIL: "",
    });
    const newRowId = added["Row ID"];
    if (!newRowId) {
      throw new Error("AppSheet Add returned without Row ID");
    }
    await deps.supa
      .from("tecnicos_extended")
      .update({
        appsheet_row_id: newRowId,
        appsheet_sync_pending: false,
        appsheet_synced_at: new Date().toISOString(),
        appsheet_sync_last_error: null,
      })
      .eq("tecnico_id", row.tecnico_id);
    await deps.supa.from("eventos").insert({
      type: "appsheet_added",
      entity_id: row.tecnico_id,
      actor: "system:projector",
      meta: { row_id: newRowId, nombre, attempts },
    });
    log.info("AppSheet Add ok", {
      tecnico_id: row.tecnico_id,
      row_id: newRowId,
      nombre,
    });
    return {
      tecnico_id: row.tecnico_id,
      action: "added",
      appsheet_row_id: newRowId,
      attempts,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Delete path
// ---------------------------------------------------------------------------

async function processDelete(
  deps: ProjectorTickDeps,
  row: CandidateRow,
  attempts: number,
  threshold: number
): Promise<ProjectorTickResult> {
  // Policy (2026-05-09): we DO NOT delete TECNICOS rows from AppSheet.
  // Per the user, architects rely on the historical roster — deleting a
  // worker erases context and risks a wrong-row mistake. Instead, the
  // projector's "revoke" path soft-deletes by setting Estado_Redin =
  // "Revocado" on the AppSheet row. The row stays visible to architects
  // with the revoked tag; new work can't be assigned without the architect
  // explicitly accepting the revoked status. The appsheet_delete_pending
  // column name is kept (no schema migration needed) but its semantics
  // are now "AppSheet revoke pending" — comment-only repurposing.
  if (!row.appsheet_row_id) {
    // Nothing to revoke in AppSheet; clear the flag so we don't loop forever.
    await deps.supa
      .from("tecnicos_extended")
      .update({
        appsheet_delete_pending: false,
        appsheet_sync_last_error: null,
      })
      .eq("tecnico_id", row.tecnico_id);
    await deps.supa.from("eventos").insert({
      type: "appsheet_revoked",
      entity_id: row.tecnico_id,
      actor: "system:projector",
      meta: { row_id: null, no_row_id: true, attempts },
    });
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped_already_gone",
      attempts,
    };
  }
  // editTecnico requires the worker's nombre as the integrity belt — it
  // pre-flights a Find by Row ID and refuses to mutate unless the AppSheet
  // row's current Nombre de Tecnico matches. Null nombre (legacy rows
  // pre-migration 010) blocks the revoke; HR must backfill nombre or
  // mark Estado_Redin in AppSheet manually.
  if (!row.nombre) {
    const errMsg =
      "revoke_blocked: tecnicos_extended.nombre is null; cannot verify AppSheet row identity. Backfill the nombre or mark Estado_Redin = Revocado in AppSheet manually.";
    await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: errMsg,
    };
  }
  try {
    const { alreadyGone } = await deps.appsheet.editTecnico(
      row.appsheet_row_id,
      row.nombre,
      { Estado_Redin: "Revocado" }
    );
    await deps.supa
      .from("tecnicos_extended")
      .update({
        appsheet_delete_pending: false,
        appsheet_sync_last_error: null,
        // appsheet_row_id stays for forever-audit per §8.3.
      })
      .eq("tecnico_id", row.tecnico_id);
    await deps.supa.from("eventos").insert({
      type: "appsheet_revoked",
      entity_id: row.tecnico_id,
      actor: "system:projector",
      meta: {
        row_id: row.appsheet_row_id,
        already_gone: alreadyGone,
        attempts,
        appsheet_field: "Estado_Redin",
        appsheet_value: "Revocado",
      },
    });
    log.info("AppSheet Revoke ok", {
      tecnico_id: row.tecnico_id,
      row_id: row.appsheet_row_id,
      already_gone: alreadyGone,
    });
    return {
      tecnico_id: row.tecnico_id,
      action: "deleted", // semantic name kept for ProjectorTickResult union compat
      attempts,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Failure plumbing
// ---------------------------------------------------------------------------

async function markFailure(
  deps: ProjectorTickDeps,
  tecnicoId: string,
  errorMsg: string,
  attempts: number,
  threshold: number
): Promise<void> {
  await deps.supa
    .from("tecnicos_extended")
    .update({ appsheet_sync_last_error: errorMsg.slice(0, 500) })
    .eq("tecnico_id", tecnicoId);
  await deps.supa.from("eventos").insert({
    type: "appsheet_projection_failed",
    entity_id: tecnicoId,
    actor: "system:projector",
    meta: { error: errorMsg.slice(0, 500), attempts },
  });
  if (attempts >= threshold) {
    await deps.telegram?.send(
      `AppSheet projection failed ${attempts}x for ${tecnicoId}: ${errorMsg.slice(0, 300)}`
    );
  }
}

function extractString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
