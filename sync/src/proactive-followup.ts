// Daily proactive follow-up for missing ARL/EPS evidence (Gap A.6).
//
// Policy (Irina 2026-05-22):
//   - Mandatory docs: ARL + EPS evidence (foto/constancia).
//   - Workers in candidate_state in (pending, needs_call) with declared-
//     but-not-uploaded docs get a friendly WA reminder.
//   - Max 2 reminders per worker across the lifetime of their candidacy
//     (event count gate). After the 2nd, the worker either uploaded the
//     doc or the cron stops chasing — RRHH escalates manually.
//   - Minimum 24h between reminders (last-followup spacing gate).
//   - Runs once per day at 10:00 COT (15:00 UTC). Idempotent: re-running
//     the same day is a no-op for workers already followed up that day.
//
// Architecturally similar to the projector tick:
//   - Same re-entrancy guard pattern (boolean flag)
//   - Same outbound_messages queue pattern (dashboard already uses this
//     mechanism via lib/notify.ts; we replicate the insert here directly
//     since sync-mp doesn't import the dashboard helpers)
//   - Same eventos audit pattern (one row per follow-up sent)

import {
  countDocFollowups,
  docLabel,
  findWorkersWithMissingMandatoryDocs,
  lastFollowupAt,
  type WorkerMissingDocs,
  type MandatoryDocType,
} from "@redin/tools/missing-docs";
import { createLogger, normalizePhone, type ServerClient } from "@redin/shared";

const log = createLogger("sync:doc-followup");

const MAX_FOLLOWUPS_PER_WORKER = 2;
const MIN_HOURS_BETWEEN_FOLLOWUPS = 24;

interface FollowupResult {
  tecnico_id: string;
  nombre: string | null;
  sent: boolean;
  reason?: string;
  followup_number?: number;
  tipos_chased?: MandatoryDocType[];
}

/**
 * Find candidates needing a follow-up, send one to each that qualifies.
 * Returns an array of results (sent + skip reasons) for log inspection.
 */
export async function runDocFollowupTick(
  supa: ServerClient
): Promise<FollowupResult[]> {
  const workers = await findWorkersWithMissingMandatoryDocs(supa);
  log.info("doc-followup tick", { candidates: workers.length });
  const out: FollowupResult[] = [];
  for (const w of workers) {
    const result = await processWorker(supa, w);
    out.push(result);
  }
  const sent = out.filter((r) => r.sent).length;
  log.info("doc-followup tick done", {
    candidates: workers.length,
    sent,
    skipped: out.length - sent,
  });
  return out;
}

async function processWorker(
  supa: ServerClient,
  w: WorkerMissingDocs
): Promise<FollowupResult> {
  // Resolve a phone to message. Prefer phone (WA identity), fall back to
  // contact_phone (callable number). The drainer in tono-mp will deliver
  // via Baileys regardless.
  const phoneRaw = w.phone ?? w.contact_phone;
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (!phone) {
    return {
      tecnico_id: w.tecnico_id,
      nombre: w.nombre,
      sent: false,
      reason: "no_phone",
    };
  }

  // Cap at 2 follow-ups total (across both ARL and EPS).
  const followupCount = await countDocFollowups(supa, w.tecnico_id);
  if (followupCount >= MAX_FOLLOWUPS_PER_WORKER) {
    return {
      tecnico_id: w.tecnico_id,
      nombre: w.nombre,
      sent: false,
      reason: "max_followups_reached",
    };
  }

  // Enforce 24h spacing.
  const lastAt = await lastFollowupAt(supa, w.tecnico_id);
  if (lastAt) {
    const hoursSince = (Date.now() - lastAt.getTime()) / (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN_FOLLOWUPS) {
      return {
        tecnico_id: w.tecnico_id,
        nombre: w.nombre,
        sent: false,
        reason: `last_followup_${Math.round(hoursSince)}h_ago`,
      };
    }
  }

  // Compose + enqueue the message. Tone shifts on second follow-up:
  //   - 1st: friendly nudge
  //   - 2nd: last call with explicit consequence ("sin estos docs no
  //     podemos avanzar tu aprobación")
  const tipos = w.missing.map((m) => m.tipo);
  const labels = w.missing.map((m) => m.label).join(" y ");
  const nombre = (w.nombre ?? "").split(" ")[0] || "compa";
  const isLastChance = followupCount === MAX_FOLLOWUPS_PER_WORKER - 1;
  const body = isLastChance
    ? `Hola ${nombre}, te recuerdo por última vez que aún falta tu evidencia de ${labels} para procesar tu aprobación con Redin. Si la tienes, mándala por aquí (foto está bien). Si no podés conseguirla, dime y vemos cómo seguimos.`
    : `Hola ${nombre}, soy del equipo de Redin. Para terminar de validar tu perfil necesitamos tu evidencia de ${labels}. ¿Nos la puedes pasar por aquí cuando puedas? Una foto del carné o constancia sirve.`;

  const { error: enqErr } = await supa.from("outbound_messages").insert({
    phone,
    body,
    channel: "whatsapp",
    kind: "text",
    meta: {
      kind: "tono_doc_followup",
      tecnico_id: w.tecnico_id,
      followup_number: followupCount + 1,
      tipos_chased: tipos,
    },
  });
  if (enqErr) {
    log.error("outbound enqueue failed", {
      tecnico_id: w.tecnico_id,
      error: enqErr.message,
    });
    return {
      tecnico_id: w.tecnico_id,
      nombre: w.nombre,
      sent: false,
      reason: "enqueue_failed",
    };
  }

  // Audit row — counted by countDocFollowups on the next tick.
  await supa.from("eventos").insert({
    type: "tono_doc_followup",
    entity_id: w.tecnico_id,
    actor: "agent",
    meta: {
      followup_number: followupCount + 1,
      max_followups: MAX_FOLLOWUPS_PER_WORKER,
      tipos_chased: tipos,
      phone,
      dossier_id: w.dossier_id,
    },
  });

  log.info("doc-followup sent", {
    tecnico_id: w.tecnico_id,
    nombre: w.nombre,
    followup_number: followupCount + 1,
    tipos: tipos.join("+"),
  });

  return {
    tecnico_id: w.tecnico_id,
    nombre: w.nombre,
    sent: true,
    followup_number: followupCount + 1,
    tipos_chased: tipos,
  };
}
