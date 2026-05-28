// Shared logic for two distinct concerns:
//   (A) Proactive follow-up chasing — preferred docs (ARL, EPS) that Toño
//       reminds the worker to upload. Never blocks approval.
//   (B) Approval gate — the cédula photo is the ONLY doc that blocks
//       HR's Aprobar click (per Irina 2026-05-24). HR can still override
//       with a note explaining how cédula was validated offline.
//
// Used by:
//   1. dashboard/src/app/hr/tecnicos/[id]/page.tsx — preferred-docs surface
//      + per-doc "Pedir por WhatsApp" button (Gap A.5).
//   2. sync/src/proactive-followup.ts — daily cron, preferred docs only.
//   3. dashboard/src/lib/decisions.ts — approval gate, cédula only.
//
// Earlier comment (2026-05-22) said ARL+EPS mandatory; superseded by
// 2026-05-24 — Redin provides ARL, EPS is preferred-only.

import type { ServerClient } from "@redin/shared";

// "Preferred" docs the proactive follow-up cron chases. Never blocks approval.
export type MandatoryDocType = "evidencia_arl" | "evidencia_eps";

export interface MissingDoc {
  tipo: MandatoryDocType;
  /** Worker self-declared in their dossier — true if declared, false if not. */
  declared: boolean;
  /** Spanish label for UI/messages. */
  label: string;
}

export interface WorkerMissingDocs {
  tecnico_id: string;
  nombre: string | null;
  phone: string | null;
  contact_phone: string | null;
  candidate_state: string | null;
  dossier_id: string | null;
  dossier_created_at: string | null;
  /**
   * Docs the worker declared (arl_activa / eps_activa) but never uploaded.
   * Empty array = nothing missing in the strict sense.
   */
  missing: MissingDoc[];
}

const DOC_LABELS: Record<MandatoryDocType, string> = {
  evidencia_arl: "ARL (carné o constancia)",
  evidencia_eps: "EPS (carné o constancia)",
};

export function docLabel(tipo: MandatoryDocType): string {
  return DOC_LABELS[tipo];
}

// Compute missing docs for ONE worker. Used by the HR detail page.
// Returns null if no dossier exists (worker hasn't submitted yet — nothing
// to chase).
export async function getMissingDocsForWorker(
  supa: ServerClient,
  tecnicoId: string
): Promise<WorkerMissingDocs | null> {
  // 1. Pull the worker row + latest dossier
  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, phone, contact_phone, candidate_state")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();
  if (!tec) return null;

  const { data: dossier } = await supa
    .from("candidate_dossiers")
    .select("id, payload, created_at")
    .eq("tecnico_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!dossier) return null;

  // 2. Check declared compliance in the dossier payload
  const payload = (dossier.payload ?? {}) as Record<string, unknown>;
  const cumplimiento = (payload.cumplimiento as Record<string, unknown> | undefined) ?? {};
  const arlDeclared = cumplimiento.arl_activa === true;
  const epsDeclared = cumplimiento.eps_activa === true;
  const arlDocInDossier = !!payload.arl_doc_id;
  const epsDocInDossier = !!payload.eps_doc_id;

  // 3. Check if a doc has been uploaded AFTER the dossier (worker might
  // have responded to a follow-up — newer evidence overrides the snapshot).
  const { data: postDossierDocs } = await supa
    .from("documentos")
    .select("tipo, uploaded_at")
    .eq("tecnico_id", tecnicoId)
    .in("tipo", ["evidencia_arl", "evidencia_eps"]);
  const uploadedTipos = new Set(
    (postDossierDocs ?? []).map((d) => d.tipo as string)
  );

  const missing: MissingDoc[] = [];
  if (arlDeclared && !arlDocInDossier && !uploadedTipos.has("evidencia_arl")) {
    missing.push({ tipo: "evidencia_arl", declared: true, label: DOC_LABELS.evidencia_arl });
  }
  if (epsDeclared && !epsDocInDossier && !uploadedTipos.has("evidencia_eps")) {
    missing.push({ tipo: "evidencia_eps", declared: true, label: DOC_LABELS.evidencia_eps });
  }

  return {
    tecnico_id: tec.tecnico_id,
    nombre: tec.nombre,
    phone: tec.phone,
    contact_phone: tec.contact_phone,
    candidate_state: tec.candidate_state,
    dossier_id: dossier.id,
    dossier_created_at: dossier.created_at,
    missing,
  };
}

// Find ALL workers in pending/needs_call with missing mandatory docs.
// Used by the proactive follow-up cron. Returns workers with at least
// one missing doc — empty list means no one to chase right now.
export async function findWorkersWithMissingMandatoryDocs(
  supa: ServerClient
): Promise<WorkerMissingDocs[]> {
  // Stage 1: pull candidates in pending/needs_call. Reasonable cap (1000)
  // since v1 volume is low; revisit when we have >1000 active candidates.
  const { data: candidates } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, phone, contact_phone, candidate_state")
    .in("candidate_state", ["pending", "needs_call"])
    .limit(1000);
  if (!candidates || candidates.length === 0) return [];

  const out: WorkerMissingDocs[] = [];
  for (const tec of candidates) {
    // Use the per-worker function to keep logic consistent.
    const result = await getMissingDocsForWorker(supa, tec.tecnico_id);
    if (result && result.missing.length > 0) out.push(result);
  }
  return out;
}

// Approval gate — is the worker's cédula photo uploaded?
//
// Cédula photo is the ONLY mandatory doc blocking the Aprobar click
// (per Irina 2026-05-24). All other docs are preferred-only. HR can
// still approve without a cédula by supplying a hr_reasoning note in
// the form (override audit). The dashboard server action enforces this;
// don't add client-side bypass.
export async function hasCedulaUploaded(
  supa: ServerClient,
  tecnicoId: string
): Promise<boolean> {
  const { data } = await supa
    .from("documentos")
    .select("id")
    .eq("tecnico_id", tecnicoId)
    .eq("tipo", "cedula")
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Count how many `tono_doc_followup` events have been logged for this
// worker. The proactive cron uses this to cap reminders at 2 total per
// worker (across both ARL and EPS).
export async function countDocFollowups(
  supa: ServerClient,
  tecnicoId: string
): Promise<number> {
  const { count } = await supa
    .from("eventos")
    .select("*", { count: "exact", head: true })
    .eq("type", "tono_doc_followup")
    .eq("entity_id", tecnicoId);
  return count ?? 0;
}

// When was the most recent follow-up message sent to this worker? Used
// to enforce a minimum spacing between reminders (default 24h). Returns
// null if no follow-up has ever been sent.
export async function lastFollowupAt(
  supa: ServerClient,
  tecnicoId: string
): Promise<Date | null> {
  const { data } = await supa
    .from("eventos")
    .select("created_at")
    .eq("type", "tono_doc_followup")
    .eq("entity_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return new Date(data.created_at as string);
}
