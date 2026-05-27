"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  computeAgreedWithTono,
  type CandidateState,
  type HrAction,
  type TonoRecommendation,
} from "@redin/shared";
import { enqueueWhatsApp } from "@/lib/notify";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { computeResultingState } from "@/lib/decisions-state";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OFFERABLE_ESTADO } from "@redin/tools/read-pending-ots";
import { hasCedulaUploaded } from "@redin/tools/missing-docs";
import { otDescripcion, otValorEstimado } from "@/lib/ot-display";

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

// Force-expire active WhatsApp sessions for a phone by setting last_active to
// 2 hours ago. SessionStore.getOrCreate uses a 60-minute freshness window
// ([`tono/src/session.ts`](file:///../../tono/src/session.ts) SESSION_TTL_MIN),
// so 2 hours is comfortably outside that window and survives clock skew.
// Best-effort: failures are logged and never block the HR decision flow.
async function expireWhatsAppSessions(
  supa: SupabaseClient,
  phone: string
): Promise<void> {
  try {
    const twoHoursAgoIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { error, count } = await supa
      .from("sessions")
      .update({ last_active: twoHoursAgoIso }, { count: "exact" })
      .eq("phone", phone)
      .eq("channel", "whatsapp")
      .gte("last_active", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if (error) {
      console.warn("expireWhatsAppSessions failed (non-fatal)", {
        phone,
        error: error.message,
      });
      return;
    }
    if ((count ?? 0) > 0) {
      console.info("expireWhatsAppSessions: expired", { phone, count });
    }
  } catch (e) {
    console.warn("expireWhatsAppSessions threw (non-fatal)", {
      phone,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Approval push helpers
// ---------------------------------------------------------------------------

const MAX_OT_LINES = 3;
const MAX_DESC_LEN = 60;

function _truncateDesc(s: string): string {
  if (s.length <= MAX_DESC_LEN) return s;
  return s.slice(0, MAX_DESC_LEN - 1).trimEnd() + "…";
}

function _normalizeStr(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

interface _ApprovalOtLine {
  row_id: string;
  descripcion: string;
  valor_label: string | null;
  ciudad: string | null;
}

// Sends composite numbered WA message on approval. Idempotent (skips on duplicate).
// Failures are caught — must NEVER block the approval state flip.
async function fireApprovalPush(
  supa: SupabaseClient,
  tecnicoId: string,
  phone: string
): Promise<void> {
  try {
    const { data: existing } = await supa
      .from("outbound_messages")
      .select("id")
      .eq("phone", phone)
      .contains("meta", { kind: "approval_push", tecnico_id: tecnicoId })
      .limit(1)
      .maybeSingle();
    if (existing) {
      console.info("fireApprovalPush: duplicate skipped", { tecnicoId });
      return;
    }

    const [tecRes, regRes] = await Promise.all([
      supa
        .from("tecnicos_extended")
        .select("nombre")
        .eq("tecnico_id", tecnicoId)
        .maybeSingle(),
      supa
        .from("eventos")
        .select("meta")
        .eq("type", "tecnico_registered")
        .eq("entity_id", tecnicoId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const nombre = (tecRes.data?.nombre as string | null | undefined) ?? null;
    const firstName = nombre ? (nombre.trim().split(/\s+/)[0] ?? nombre) : null;
    const regMeta = regRes.data?.meta as Record<string, unknown> | null | undefined;
    const ciudad = regMeta && typeof regMeta.ciudad === "string" ? regMeta.ciudad : null;

    let matchingOts: _ApprovalOtLine[] = [];
    if (ciudad) {
      const { data: ots } = await supa
        .from("ots_mirror")
        .select("row_id, ciudad, especialidad, data")
        .eq("estado", OFFERABLE_ESTADO);

      const ciudadNorm = _normalizeStr(ciudad);
      matchingOts = (ots ?? [])
        .filter((o) => o.ciudad && _normalizeStr(o.ciudad).includes(ciudadNorm))
        .slice(0, MAX_OT_LINES)
        .map((o) => {
          const desc = _truncateDesc(otDescripcion(o.data) || "(sin descripción)");
          const valor = otValorEstimado(o.data);
          return {
            row_id: o.row_id,
            descripcion: desc,
            valor_label: valor.label,
            ciudad: o.ciudad,
          };
        });
    }

    const greeting = firstName ? `¡Felicidades, ${firstName}!` : "¡Felicidades!";
    const n = matchingOts.length;
    let body: string;

    if (n === 0) {
      body = `${greeting} Tu perfil quedó aprobado. Apenas haya trabajos que te calcen en tu zona te aviso. También puedes preguntarme '¿hay trabajo?' cuando quieras.`;
    } else {
      const jobWord = n === 1 ? "trabajo" : "trabajos";
      const lines = matchingOts.map((ot, i) => {
        const valorPart = ot.valor_label ? ` — ${ot.valor_label}` : "";
        const ciudadPart = ot.ciudad ? ` · ${ot.ciudad}` : "";
        return `${i + 1}. ${ot.descripcion}${valorPart}${ciudadPart}`;
      });
      body = [
        `${greeting} Tu perfil quedó aprobado.`,
        "",
        `Hay ${n} ${jobWord} para ti:`,
        ...lines,
        "",
        "¿Cuál te interesa? Respóndeme con el número o pídeme más detalles.",
      ].join("\n");
    }

    // ot_row_ids[] makes the push numerically addressable downstream. When the
    // worker replies "2" / "el primero" / "la segunda", tono's
    // approval-push-replies handler resolves the index → row_id → creates the
    // postulación pre-LLM. Without these IDs the worker reply would fall to
    // the LLM with no grounded way to map "2" back to a real OT (see the
    // May25-camilo2 chat regression for the failure mode).
    await enqueueWhatsApp(supa, {
      phone,
      body,
      meta: {
        kind: "approval_push",
        tecnico_id: tecnicoId,
        ot_count: n,
        ciudad,
        ot_row_ids: matchingOts.map((o) => o.row_id),
      },
    });

    await supa.from("eventos").insert({
      type: "approval_push_sent",
      entity_id: tecnicoId,
      actor: "system",
      meta: { ot_count: n, ciudad, phone },
    });
  } catch (e) {
    console.error("fireApprovalPush failed (non-blocking)", {
      tecnicoId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// submitDecision
// ---------------------------------------------------------------------------

const HR_ACTIONS: readonly HrAction[] = [
  "approve",
  "reject",
  "schedule_call",
  "unschedule_call",
  "revoke",
  "reopen",
];

const CANDIDATE_STATES: readonly CandidateState[] = [
  "screening",
  "pending",
  "needs_call",
  "approved",
  "rejected",
  "withdrawn",
  "revoked",
];

export async function submitDecision(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;
  const decidedBy = `hr:${hrEmail}`;

  const tecnicoId = formData.get("tecnico_id");
  const decision = formData.get("decision");
  const priorStateRaw = formData.get("prior_state");
  const dossierIdRaw = formData.get("dossier_id");
  const hrReasoningRaw = formData.get("hr_reasoning");

  if (typeof tecnicoId !== "string" || !tecnicoId.trim()) return;
  if (typeof decision !== "string" || !HR_ACTIONS.includes(decision as HrAction)) return;
  if (typeof priorStateRaw !== "string" || !CANDIDATE_STATES.includes(priorStateRaw as CandidateState)) return;

  const action = decision as HrAction;
  const priorState = priorStateRaw as CandidateState;
  const formDossierId =
    typeof dossierIdRaw === "string" && dossierIdRaw.length > 0 ? dossierIdRaw : null;
  const hrReasoning =
    typeof hrReasoningRaw === "string" && hrReasoningRaw.trim().length > 0
      ? hrReasoningRaw.trim()
      : null;

  const resultingState = computeResultingState(priorState, action);
  if (!resultingState) {
    console.error("submitDecision illegal_transition", { tecnicoId, priorState, action });
    return;
  }

  const supa = serviceClient();

  // Approval gate (per Irina 2026-05-24): block approve when the worker has
  // no cédula photo uploaded UNLESS HR supplies a note explaining how they
  // validated offline. The note doubles as an audit record. Other docs
  // (ARL, EPS) are preferred-only and don't block — Redin can provide ARL,
  // EPS is a soft signal. This is the only mandatory doc.
  if (action === "approve") {
    const cedulaPresent = await hasCedulaUploaded(supa, tecnicoId);
    if (!cedulaPresent && !hrReasoning) {
      console.warn("submitDecision: approve blocked — no cédula photo and no override note", { tecnicoId });
      revalidatePath("/hr/qualification-queue");
      revalidatePath(`/hr/tecnicos/${tecnicoId}`);
      return;
    }
  }

  // CAS UPDATE: only flip if candidate_state still matches prior_state.
  const patch: {
    candidate_state: CandidateState;
    appsheet_sync_pending?: boolean;
    appsheet_delete_pending?: boolean;
    withdrawal_reason?: string | null;
    profile_complete?: boolean;
  } = { candidate_state: resultingState };
  if (action === "approve") patch.appsheet_sync_pending = true;
  if (action === "revoke") patch.appsheet_delete_pending = true;
  if (action === "reopen") patch.withdrawal_reason = null;
  // HR approval IS the signal that the dossier is complete enough to take
  // jobs. Without this, the worker's next session routes to mode="enrichment"
  // and Toño re-asks ciudad/categorías even though they were just submitted
  // (May25-camilo3 regression). Legacy enrichment workers reach approved via
  // complete_legacy_profile, which already flips profile_complete itself, so
  // setting true here is also correct for them — it's an idempotent no-op
  // when they were already complete, and a forward-fix if HR is approving a
  // legacy row that somehow stayed incomplete.
  if (action === "approve") patch.profile_complete = true;

  const { data: casRows, error: casErr } = await supa
    .from("tecnicos_extended")
    .update(patch)
    .eq("tecnico_id", tecnicoId)
    .eq("candidate_state", priorState)
    .select("tecnico_id, phone");
  if (casErr) {
    console.error("submitDecision CAS failed", { tecnicoId, error: casErr.message });
    return;
  }
  if (!casRows || casRows.length === 0) {
    console.warn("submitDecision stale_click", { tecnicoId, priorState, action });
    revalidatePath("/hr/qualification-queue");
    revalidatePath(`/hr/tecnicos/${tecnicoId}`);
    return;
  }
  const phone = casRows[0]!.phone;

  // Dossier sanity check — only when form supplied a dossier_id.
  let tonoRecAtDecision: TonoRecommendation | null = null;
  if (formDossierId) {
    const { data: latest } = await supa
      .from("candidate_dossiers")
      .select("id, tono_recommendation")
      .eq("tecnico_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latest || latest.id !== formDossierId) {
      const rollback: {
        candidate_state: CandidateState;
        appsheet_sync_pending?: boolean;
        appsheet_delete_pending?: boolean;
        withdrawal_reason?: string | null;
        profile_complete?: boolean;
      } = { candidate_state: priorState };
      if (action === "approve") rollback.appsheet_sync_pending = false;
      if (action === "revoke") rollback.appsheet_delete_pending = false;
      if (action === "approve") rollback.profile_complete = false;
      const { error: rbErr } = await supa
        .from("tecnicos_extended")
        .update(rollback)
        .eq("tecnico_id", tecnicoId)
        .eq("candidate_state", resultingState);
      if (rbErr) {
        console.error("submitDecision rollback failed (data inconsistency)", {
          tecnicoId,
          error: rbErr.message,
        });
      }
      console.warn("submitDecision stale_dossier", {
        tecnicoId,
        formDossierId,
        latestDossierId: latest?.id ?? null,
      });
      revalidatePath("/hr/qualification-queue");
      return;
    }
    tonoRecAtDecision = latest.tono_recommendation as TonoRecommendation;
  }

  const agreedWithTono = computeAgreedWithTono(action, tonoRecAtDecision);

  // Eventos before candidate_decisions — reconstructable audit on partial failure.
  const { error: evErr } = await supa.from("eventos").insert({
    type: "hr_decision",
    entity_id: tecnicoId,
    actor: decidedBy,
    meta: {
      decision: action,
      prior_state: priorState,
      resulting_state: resultingState,
      dossier_id: formDossierId,
      tono_recommendation_at_decision_time: tonoRecAtDecision,
      agreed_with_tono: agreedWithTono,
      hr_reasoning: hrReasoning,
    },
  });
  if (evErr) {
    console.error("submitDecision eventos insert failed", { tecnicoId, error: evErr.message });
  }

  const { error: decErr } = await supa.from("candidate_decisions").insert({
    tecnico_id: tecnicoId,
    dossier_id: formDossierId,
    decision: action,
    resulting_state: resultingState,
    prior_state: priorState,
    tono_recommendation_at_decision_time: tonoRecAtDecision,
    agreed_with_tono: agreedWithTono,
    hr_reasoning: hrReasoning,
    decided_by: decidedBy,
  });
  if (decErr) {
    console.error("submitDecision candidate_decisions insert failed", {
      tecnicoId,
      error: decErr.message,
    });
  }

  // Expire any active WhatsApp session for this phone BEFORE side-effect
  // outbounds fire. Two reasons:
  //   1. The post-decision conversation (approval opener, rejection message,
  //      schedule_call notice) belongs in a fresh session — its prompt mode
  //      now reflects the new candidate_state, and re-feeding it the
  //      pre-decision screening history just poisons the model with stale
  //      "asking-for-data" cues. May25-camilo3 hit exactly this: after HR
  //      approved, the worker's next "Hola" rendered enrichment-style
  //      questions because the prior turns biased the LLM despite the
  //      corrected [session_state] block.
  //   2. The system push (approval_push, etc.) persists into `messages`
  //      via outbound.ts. Without expiry the push lands in the old session;
  //      with expiry it creates and lands in a fresh session, which is also
  //      what the worker's next reply will use.
  if (phone && (action === "approve" || action === "reject" || action === "schedule_call")) {
    await expireWhatsAppSessions(supa, phone);
  }

  // Side effects: WhatsApp — no outbound on unschedule_call / revoke / reopen.
  if (phone) {
    if (action === "approve") {
      await fireApprovalPush(supa, tecnicoId, phone);
    } else if (action === "reject") {
      await enqueueWhatsApp(supa, {
        phone,
        body: "Hola, revisamos tu perfil y por ahora no podemos seguir adelante. Si quieres conversarlo, puedes responder y te contactamos.",
        meta: { kind: "hr_decision", tecnico_id: tecnicoId, decision: action, to_state: resultingState },
      });
    } else if (action === "schedule_call") {
      // Idempotency: harmonize with Lane B's enqueuePedirLlamada in
      // tools/src/set-qualification-state.ts. Both writers must skip if a
      // pedir_llamada_notification was already enqueued in the last 24h —
      // otherwise the worker gets duplicates when Toño and HR both fire.
      // We check both meta key shapes (kind=... and notification_type=...)
      // because the two writers historically used different keys.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [byKind, byNotif] = await Promise.all([
        supa
          .from("outbound_messages")
          .select("id")
          .eq("phone", phone)
          .gte("created_at", twentyFourHoursAgo)
          .contains("meta", { kind: "pedir_llamada_notification" })
          .limit(1)
          .maybeSingle(),
        supa
          .from("outbound_messages")
          .select("id")
          .eq("phone", phone)
          .gte("created_at", twentyFourHoursAgo)
          .contains("meta", { notification_type: "pedir_llamada_notification" })
          .limit(1)
          .maybeSingle(),
      ]);
      if (byKind.data || byNotif.data) {
        console.info("submitDecision schedule_call: pedir_llamada already enqueued in last 24h (skipped)", {
          tecnicoId,
        });
      } else {
        await enqueueWhatsApp(supa, {
          phone,
          body: "Queremos hacerte una llamada corta para conocerte mejor antes de avanzar. Pronto te contactamos para coordinar.",
          meta: {
            kind: "pedir_llamada_notification",
            notification_type: "pedir_llamada_notification",
            tecnico_id: tecnicoId,
            decision: action,
            to_state: resultingState,
          },
        });
      }
    }
  }

  revalidatePath("/hr/qualification-queue");
  revalidatePath(`/hr/tecnicos/${tecnicoId}`);
  revalidatePath("/hr/tecnicos");
}

// ---------------------------------------------------------------------------
// requestDocument — Gap A.5
// ---------------------------------------------------------------------------

const REQUESTABLE_TIPOS = new Set([
  "evidencia_arl",
  "evidencia_eps",
  "cedula",
  "cert_estudios",
  "cert_trabajos_previos",
]);

const TIPO_LABELS: Record<string, string> = {
  evidencia_arl: "ARL (carné o constancia)",
  evidencia_eps: "EPS (carné o constancia)",
  cedula: "cédula (foto del documento)",
  cert_estudios: "certificado de estudios",
  cert_trabajos_previos: "certificado de trabajos previos",
};

export async function requestDocument(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const tecnicoId = formData.get("tecnico_id");
  const tipo = formData.get("tipo");
  if (typeof tecnicoId !== "string" || !tecnicoId.trim()) return;
  if (typeof tipo !== "string" || !REQUESTABLE_TIPOS.has(tipo)) {
    console.error("requestDocument: invalid tipo", { tipo });
    return;
  }

  const supa = serviceClient();
  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("phone, contact_phone, nombre")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();
  if (!tec) {
    console.error("requestDocument: worker not found", { tecnicoId });
    return;
  }
  const phone = tec.phone ?? tec.contact_phone;
  if (!phone) {
    console.error("requestDocument: no phone on worker", { tecnicoId });
    return;
  }

  const label = TIPO_LABELS[tipo] ?? tipo;
  const nombre = (tec.nombre ?? "").split(" ")[0] || "compa";
  const body = `Hola ${nombre}, soy del equipo de Redin. Para terminar de validar tu perfil necesitamos tu evidencia de ${label}. ¿Nos la puedes pasar por aquí (foto o PDF) cuando puedas? Gracias.`;

  await enqueueWhatsApp(supa, {
    phone,
    body,
    meta: {
      kind: "hr_doc_request",
      tecnico_id: tecnicoId,
      tipo,
      requested_by: hrEmail,
    },
  });

  await supa.from("eventos").insert({
    type: "hr_doc_request",
    entity_id: tecnicoId,
    actor: `hr:${hrEmail}`,
    meta: { tipo, phone },
  });

  revalidatePath(`/hr/tecnicos/${tecnicoId}`);
}

// ---------------------------------------------------------------------------
// appendHrNote
// ---------------------------------------------------------------------------

export async function appendHrNote(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const tecnicoId = formData.get("tecnico_id");
  const bodyRaw = formData.get("body");
  if (typeof tecnicoId !== "string" || !tecnicoId.trim()) return;
  if (typeof bodyRaw !== "string") return;
  const body = bodyRaw.trim();
  if (body.length === 0 || body.length > 2000) return;

  const supa = serviceClient();

  const { data: latest } = await supa
    .from("candidate_dossiers")
    .select("id")
    .eq("tecnico_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supa.from("hr_notes").insert({
    tecnico_id: tecnicoId,
    dossier_id: latest?.id ?? null,
    body,
    hr_user: `hr:${hrEmail}`,
  });
  if (error) {
    console.error("appendHrNote insert failed", { tecnicoId, error: error.message });
    return;
  }

  revalidatePath("/hr/qualification-queue");
  revalidatePath(`/hr/tecnicos/${tecnicoId}`);
}
