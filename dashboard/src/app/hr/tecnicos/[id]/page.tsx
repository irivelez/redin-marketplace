// Per-worker detail page — full state-history timeline + decision actions.
// Per docs/architecture/onboarding-contracts.md §11.3:
//   - Profile + AppSheet projection warning banner (when stuck)
//   - Decision-gated buttons: Revocar (approved → revoked), Reabrir (rejected/withdrawn → screening)
//   - Timeline merging dossiers + candidate_decisions + hr_notes + state events
//   - Add-note form for the hr_notes thread

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { submitDecision, appendHrNote, requestDocument } from "@/lib/decisions";
import { otTitle } from "@/lib/ot-display";
import type { CandidateState, TonoRecommendation, HrAction } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";
import { phoneDisplay } from "@/lib/phone-display";
import { getMissingDocsForWorker } from "@redin/tools/missing-docs";

export const dynamic = "force-dynamic";

const STATE_CLASS: Record<CandidateState, string> = {
  screening: "bg-slate-100 text-slate-700",
  pending: "bg-amber-100 text-amber-800",
  needs_call: "bg-violet-100 text-violet-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  withdrawn: "bg-slate-100 text-slate-500",
  revoked: "bg-rose-200 text-rose-900",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO");
}

interface RegisteredMeta {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
}
function parseRegistered(meta: unknown): RegisteredMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  return {
    nombre: typeof m.nombre === "string" ? m.nombre : undefined,
    ciudad: typeof m.ciudad === "string" ? m.ciudad : undefined,
    especialidades: Array.isArray(m.especialidades)
      ? m.especialidades.filter((x): x is string => typeof x === "string")
      : undefined,
    modalidad: typeof m.modalidad === "string" ? m.modalidad : undefined,
  };
}

interface TimelineEntry {
  kind: "dossier" | "decision" | "note" | "event";
  at: string;
  payload: unknown;
}

function appsheetBannerText(error: string | null): {
  title: string;
  detail: string;
} | null {
  if (!error) return null;
  if (error.startsWith("ambiguous_name")) {
    return {
      title: "AppSheet — nombre ambiguo",
      detail:
        "AppSheet tiene múltiples filas con este nombre. Resolvé manual: editá appsheet_row_id con el Row ID correcto, o eliminá los duplicados en AppSheet, luego limpiá appsheet_sync_pending.",
    };
  }
  return { title: "AppSheet — error de sincronización", detail: error };
}

export default async function TecnicoDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const tecnicoId = decodeURIComponent(params.id);

  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();
  if (!tec) {
    return (
      <div className="card p-6">
        <Link href="/hr/tecnicos" className="text-sm text-slate-500 hover:text-slate-700">
          ← Técnicos
        </Link>
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          Técnico no encontrado
        </h1>
      </div>
    );
  }

  const [
    regEventRes,
    dossiersRes,
    decisionsRes,
    notesRes,
    stateEventsRes,
    outboundRes,
    postulacionesRes,
    contratosRes,
    evaluationsRes,
    eventsRes,
  ] = await Promise.all([
    supa
      .from("eventos")
      .select("meta")
      .eq("type", "tecnico_registered")
      .eq("entity_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from("candidate_dossiers")
      .select("*")
      .eq("tecnico_id", tecnicoId)
      .order("created_at", { ascending: false }),
    supa
      .from("candidate_decisions")
      .select("*")
      .eq("tecnico_id", tecnicoId)
      .order("decided_at", { ascending: false }),
    supa
      .from("hr_notes")
      .select("*")
      .eq("tecnico_id", tecnicoId)
      .order("created_at", { ascending: false }),
    supa
      .from("eventos")
      .select("type, actor, meta, created_at")
      .eq("entity_id", tecnicoId)
      .in("type", [
        "candidate_dossier_submitted",
        "candidate_withdrawn",
        "cedula_merged",
        "appsheet_added",
        "appsheet_deleted",       // legacy — kept so historical revokes still render
        "appsheet_revoked",       // new soft-delete by tag (Estado_Redin = Revocado)
        "appsheet_add_skipped_existing",
      ])
      .order("created_at", { ascending: false }),
    supa
      .from("outbound_messages")
      .select("*")
      .eq("phone", tec.phone)
      .order("created_at", { ascending: false })
      .limit(50),
    supa
      .from("postulaciones")
      .select("*")
      .eq("tecnico_id", tecnicoId)
      .order("applied_at", { ascending: false }),
    supa
      .from("contratos")
      .select("*")
      .eq("tecnico_id", tecnicoId)
      .order("sent_at", { ascending: false, nullsFirst: false }),
    supa
      .from("tecnico_evaluations")
      .select("*")
      .eq("tecnico_id", tecnicoId)
      .order("created_at", { ascending: false }),
    supa
      .from("eventos")
      .select("type, actor, meta, created_at")
      .eq("entity_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const reg = parseRegistered(regEventRes.data?.meta);
  const dossiers = dossiersRes.data ?? [];
  const decisions = decisionsRes.data ?? [];
  const notes = notesRes.data ?? [];
  const stateEvents = stateEventsRes.data ?? [];
  const outbound = outboundRes.data ?? [];
  const postulaciones = postulacionesRes.data ?? [];
  const contratos = contratosRes.data ?? [];
  const evaluations = evaluationsRes.data ?? [];
  const events = eventsRes.data ?? [];

  // OT lookup for postulaciones, contratos, and evaluaciones — every list
  // below renders the OT human title (descripcion fallback ciudad) as primary.
  const otIds = [
    ...new Set([
      ...postulaciones.map((p) => p.ot_id),
      ...contratos.map((c) => c.ot_id).filter((x): x is string => !!x),
      ...evaluations.map((e) => e.ot_id),
    ]),
  ];
  const { data: ots } = otIds.length
    ? await supa
        .from("ots_mirror")
        .select("row_id, ciudad, especialidad, estado, data")
        .in("row_id", otIds)
    : { data: [] };
  interface OtSummary {
    titulo: string;
    ciudad: string | null;
    especialidad: string | null;
    estado: string | null;
  }
  const otByRowId = new Map<string, OtSummary>();
  for (const o of ots ?? []) {
    otByRowId.set(o.row_id, {
      titulo: otTitle(o),
      ciudad: o.ciudad,
      especialidad: o.especialidad,
      estado: o.estado,
    });
  }

  // Build merged timeline (reverse chronological).
  const timeline: TimelineEntry[] = [
    ...dossiers.map((d) => ({ kind: "dossier" as const, at: d.created_at, payload: d })),
    ...decisions.map((d) => ({ kind: "decision" as const, at: d.decided_at, payload: d })),
    ...notes.map((n) => ({ kind: "note" as const, at: n.created_at, payload: n })),
    ...stateEvents.map((e) => ({ kind: "event" as const, at: e.created_at, payload: e })),
  ];
  timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  // Visual pill: legacy / pre-enrichment workers (approved + profile_complete=false)
  // get an "Perfil incompleto" amber chip so HR can distinguish them from truly
  // assignable workers.
  const isIncompleteApproved =
    tec.candidate_state === "approved" && !tec.profile_complete;
  const stateClass = isIncompleteApproved
    ? "bg-amber-100 text-amber-800"
    : STATE_CLASS[tec.candidate_state] ?? "bg-slate-100 text-slate-700";
  const stateLabel = isIncompleteApproved ? "Perfil incompleto" : tec.candidate_state;
  const ph = phoneDisplay(tec);
  const banner = tec.appsheet_sync_pending
    ? appsheetBannerText(tec.appsheet_sync_last_error)
    : null;

  // Decision buttons gating per legal transitions.
  const canRevoke = tec.candidate_state === "approved";
  const canReopen =
    tec.candidate_state === "rejected" || tec.candidate_state === "withdrawn";

  // Gap A.5 — Documentos pendientes (ARL/EPS evidence). Surfaces the
  // declared-but-not-uploaded mandatory docs + "Pedir por WhatsApp" buttons.
  const missingDocs = await getMissingDocsForWorker(supa, tecnicoId);

  // Last HR doc-request events for "ya enviado hace X" badges next to each
  // pedido button. Indexed by tipo.
  const lastHrRequestByTipo = new Map<string, string>();
  for (const e of events ?? []) {
    if (e.type !== "hr_doc_request") continue;
    const meta = e.meta as { tipo?: string } | null;
    if (!meta?.tipo) continue;
    if (!lastHrRequestByTipo.has(meta.tipo)) {
      lastHrRequestByTipo.set(meta.tipo, e.created_at);
    }
  }
  // Same for Toño proactive follow-ups (Gap A.6) — show HR what the
  // cron has been doing on its own.
  const tonoFollowupCount = (events ?? []).filter(
    (e) => e.type === "tono_doc_followup"
  ).length;

  return (
    <div className="space-y-6">
      <Link href="/hr/tecnicos" className="text-sm text-slate-500 hover:text-slate-700">
        ← Técnicos
      </Link>

      {/* AppSheet projection warning — load-bearing visibility during pilot.
          Surfaces stuck-projection rows so HR catches the issue in the dashboard,
          not only via Telegram async pings. */}
      {banner && (
        <div className="card p-4 border-l-4 border-rose-500 bg-rose-50">
          <div className="text-xs uppercase tracking-wide text-rose-700 mb-1">
            ⚠ {banner.title} · intentos {tec.appsheet_sync_attempts}
          </div>
          <div className="text-sm text-rose-900">{banner.detail}</div>
        </div>
      )}

      {/* Profile header */}
      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              {tec.nombre ?? reg.nombre ?? "(sin nombre)"}
            </h1>
            <div className="text-sm text-slate-500 mt-1">
              {ph.callable ? (
                <a
                  href={`tel:${ph.callable}`}
                  className="text-slate-700 font-medium hover:underline underline-offset-2"
                >
                  📞 {ph.callable}
                </a>
              ) : (
                <span className="text-slate-400">Sin teléfono de contacto</span>
              )}
              {ph.waLabel && (
                <span className="text-slate-400"> · WA {ph.waLabel}</span>
              )}
              {tec.cedula && <> · cédula {tec.cedula}</>} · {reg.ciudad ?? "—"} ·
              onboarded {fmt(tec.onboarded_at)}
            </div>
            {reg.especialidades && reg.especialidades.length > 0 && (
              <div className="text-sm text-slate-700 mt-2">
                <span className="text-slate-500">Especialidades: </span>
                {reg.especialidades.join(", ")}
                {reg.modalidad && (
                  <span className="text-slate-500"> · {reg.modalidad}</span>
                )}
              </div>
            )}
            {tec.appsheet_row_id && (
              <div className="text-xs text-slate-500 mt-1">
                AppSheet Row ID: <span className="font-mono">{tec.appsheet_row_id}</span>
                {tec.appsheet_synced_at && <> · synced {fmt(tec.appsheet_synced_at)}</>}
              </div>
            )}
          </div>
          <span className={`inline-block rounded-full px-3 py-1 text-sm ${stateClass}`}>
            {stateLabel}
          </span>
        </div>

        {/* Decision actions — gated on current state */}
        {(canRevoke || canReopen) && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex gap-2 flex-wrap">
            {canRevoke && (
              <form action={submitDecision}>
                <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                <input type="hidden" name="prior_state" value={tec.candidate_state} />
                <input type="hidden" name="dossier_id" value="" />
                <input type="hidden" name="decision" value={"revoke" satisfies HrAction} />
                <button
                  type="submit"
                  className="text-sm bg-rose-600 hover:bg-rose-700 text-white rounded-md px-4 py-1.5"
                >
                  Revocar
                </button>
              </form>
            )}
            {canReopen && (
              <form action={submitDecision}>
                <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                <input type="hidden" name="prior_state" value={tec.candidate_state} />
                <input type="hidden" name="dossier_id" value="" />
                <input type="hidden" name="decision" value={"reopen" satisfies HrAction} />
                <button
                  type="submit"
                  className="text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-md px-4 py-1.5"
                >
                  Reabrir
                </button>
              </form>
            )}
          </div>
        )}
      </div>

      {/* Documentos pendientes — Gap A.5
          Surfaces declared-but-not-uploaded mandatory docs (ARL + EPS) so HR
          can chase via WhatsApp with one click. Proactive Toño cron also
          chases up to 2x (Gap A.6); the followup count is shown so HR knows
          whether the worker has been bothered enough. */}
      {missingDocs && missingDocs.missing.length > 0 && (
        <div className="card p-4 border-l-4 border-amber-400 bg-amber-50">
          <div className="text-xs uppercase tracking-wide text-amber-700 mb-2">
            Documentos pendientes — perfil incompleto sin esto
          </div>
          <div className="text-sm text-slate-700 mb-3">
            El técnico declaró tener {missingDocs.missing.map((m) => m.label.split(" ")[0]).join(" y ")} activa(s)
            pero no ha mandado evidencia. Para aprobar necesitamos foto/constancia.
            {tonoFollowupCount > 0 && (
              <span className="ml-1 text-slate-500">
                · Toño ya hizo seguimiento {tonoFollowupCount} {tonoFollowupCount === 1 ? "vez" : "veces"} (max 2).
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {missingDocs.missing.map((doc) => {
              const lastRequest = lastHrRequestByTipo.get(doc.tipo);
              return (
                <form key={doc.tipo} action={requestDocument} className="inline-block">
                  <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                  <input type="hidden" name="tipo" value={doc.tipo} />
                  <button
                    type="submit"
                    className="text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1.5 inline-flex items-center gap-2"
                    title={lastRequest ? `Última solicitud HR: ${fmt(lastRequest)}` : "Aún no se ha pedido por HR"}
                  >
                    Pedir {doc.label.split(" ")[0]} por WhatsApp
                    {lastRequest && (
                      <span className="text-amber-100 text-xs">· ya enviado</span>
                    )}
                  </button>
                </form>
              );
            })}
          </div>
        </div>
      )}

      {/* Add HR note */}
      <div className="card p-3">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
          Agregar nota
        </div>
        <form action={appendHrNote} className="space-y-2">
          <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
          <textarea
            name="body"
            placeholder="Observación, recordatorio, hand-off note..."
            className="w-full text-sm border border-slate-200 rounded px-2 py-1 resize-none"
            rows={2}
            maxLength={2000}
            required
          />
          <button
            type="submit"
            className="text-xs bg-slate-700 hover:bg-slate-800 text-white rounded px-3 py-1"
          >
            Agregar
          </button>
        </form>
      </div>

      {/* Timeline — dossiers + decisions + hr_notes + state events, reverse chronological */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">
          Línea de tiempo ({timeline.length})
        </h2>
        {timeline.length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">
            Aún sin actividad de calificación.
          </div>
        ) : (
          <ul className="space-y-2">
            {timeline.map((entry, i) => (
              <li key={i} className="card p-3 text-sm">
                {entry.kind === "dossier" && renderDossier(entry.payload)}
                {entry.kind === "decision" && renderDecision(entry.payload)}
                {entry.kind === "note" && renderNote(entry.payload)}
                {entry.kind === "event" && renderStateEvent(entry.payload)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Outbound WhatsApp messages */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">Mensajes enviados ({outbound.length})</h2>
        {outbound.length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">
            Aún no se han enviado mensajes a este número.
          </div>
        ) : (
          <ul className="space-y-2">
            {outbound.map((m) => {
              const statusClass =
                m.status === "sent"
                  ? "text-emerald-700"
                  : m.status === "failed"
                  ? "text-rose-700"
                  : "text-amber-700";
              return (
                <li key={m.id} className="card p-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      <span className={statusClass + " font-medium"}>{m.status}</span>
                      {m.sent_at && <span> · enviado {fmt(m.sent_at)}</span>}
                      {m.status === "pending" && <span> · creado {fmt(m.created_at)}</span>}
                      {m.attempts > 0 && <span> · intentos {m.attempts}</span>}
                    </span>
                    <span>{m.channel}</span>
                  </div>
                  <div className="text-sm text-slate-800 mt-1 whitespace-pre-wrap">
                    {m.body}
                  </div>
                  {m.last_error && (
                    <div className="text-xs text-rose-700 mt-1">
                      error: {m.last_error}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Postulaciones */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">Postulaciones ({postulaciones.length})</h2>
        {postulaciones.length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">Sin postulaciones aún.</div>
        ) : (
          <ul className="space-y-1">
            {postulaciones.map((p) => {
              const ot = otByRowId.get(p.ot_id);
              return (
                <li
                  key={p.id}
                  className="card p-3 text-sm flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/hr/shortlist/${encodeURIComponent(p.ot_id)}`}
                      className="text-slate-900 hover:text-amber-700 font-medium block truncate"
                    >
                      {ot?.titulo ?? "Trabajo sin título"}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {ot?.ciudad ?? "—"} · {ot?.especialidad ?? "—"} ·{" "}
                      {ot?.estado ?? "—"}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 shrink-0 text-right">
                    <span className="text-slate-700">{p.state}</span> · aplicó{" "}
                    {fmt(p.applied_at)}
                    {p.decided_at && (
                      <>
                        {" · decisión "}
                        {fmt(p.decided_at)}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Contratos */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">Contratos ({contratos.length})</h2>
        {contratos.length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">Sin contratos aún.</div>
        ) : (
          <ul className="space-y-1">
            {contratos.map((c) => {
              const ot = c.ot_id ? otByRowId.get(c.ot_id) : null;
              return (
                <li
                  key={c.id}
                  className="card p-3 text-sm flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/hr/contratos/${c.id}`}
                      className="text-slate-900 hover:text-amber-700 font-medium block truncate"
                    >
                      {ot?.titulo ?? "Contrato sin OT"}
                    </Link>
                    <div className="text-[11px] text-slate-400 font-mono">
                      {c.id.slice(0, 8)}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 shrink-0 text-right">
                    <span className="text-slate-700">{c.status}</span>
                    {c.sent_at && <> · enviado {fmt(c.sent_at)}</>}
                    {c.signed_at && <> · firmado {fmt(c.signed_at)}</>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Evaluaciones */}
      {evaluations.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold text-slate-900">
            Evaluaciones ({evaluations.length})
          </h2>
          <ul className="space-y-1">
            {evaluations.map((e) => {
              const ot = otByRowId.get(e.ot_id);
              return (
                <li key={e.id} className="card p-3 text-sm">
                  <div className="text-slate-900 font-medium">
                    {ot?.titulo ?? "Trabajo sin título"}
                  </div>
                  <div className="text-xs text-slate-500">
                    evaluador {e.evaluator} · {fmt(e.created_at)}
                  </div>
                  <div className="text-slate-700 mt-1">
                    cumplimiento {e.cumplimiento ?? "—"} · calidad {e.calidad ?? "—"} ·{" "}
                    actitud {e.actitud ?? "—"} · puntualidad {e.puntualidad ?? "—"} ·{" "}
                    rehire{" "}
                    {e.recommend_rehire === true
                      ? "sí"
                      : e.recommend_rehire === false
                      ? "no"
                      : "—"}
                  </div>
                  {e.notes && (
                    <div className="text-slate-600 mt-1 text-xs">{e.notes}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Raw event log */}
      <details className="card p-3">
        <summary className="cursor-pointer font-semibold text-slate-900">
          Bitácora ({events.length})
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {events.map((e, i) => (
            <li key={i} className="border-t border-slate-100 pt-1">
              <div className="flex justify-between">
                <span className="font-medium text-slate-700">{e.type}</span>
                <span className="text-slate-500">{fmt(e.created_at)}</span>
              </div>
              {e.actor && <div className="text-slate-500">actor: {e.actor}</div>}
              {e.meta && (
                <pre className="text-[11px] text-slate-600 whitespace-pre-wrap break-all">
                  {JSON.stringify(e.meta, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline renderers
// ---------------------------------------------------------------------------

function renderDossier(payload: unknown): JSX.Element {
  const d = payload as {
    id: string;
    created_at: string;
    tono_recommendation: TonoRecommendation;
    tono_confidence: number;
    tono_reasoning: string;
    prompt_sha: string | null;
    cedula: string;
    schema_version: number;
    payload: unknown;
  };
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span className="font-semibold text-amber-700 uppercase tracking-wide">
          Dossier · v{d.schema_version}
        </span>
        <span>{fmt(d.created_at)}</span>
      </div>
      <div className="mt-1 text-slate-800">
        Toño:{" "}
        <span className="font-medium">{d.tono_recommendation}</span> ({d.tono_confidence.toFixed(2)})
      </div>
      <div className="text-slate-700 mt-1 whitespace-pre-wrap">{d.tono_reasoning}</div>
      <div className="text-[10px] text-slate-500 mt-1">
        cédula {d.cedula}
        {d.prompt_sha && <> · prompt_sha {d.prompt_sha.slice(0, 12)}</>}
      </div>
      <details className="mt-1 text-[11px] text-slate-600">
        <summary className="cursor-pointer">payload completo</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all">
          {JSON.stringify(d.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function renderDecision(payload: unknown): JSX.Element {
  const d = payload as {
    id: string;
    decided_at: string;
    decided_by: string;
    decision: HrAction;
    prior_state: CandidateState;
    resulting_state: CandidateState;
    tono_recommendation_at_decision_time: TonoRecommendation | null;
    agreed_with_tono: boolean | null;
    hr_reasoning: string | null;
    dossier_id: string | null;
  };
  const agreement =
    d.agreed_with_tono === true ? "✓" : d.agreed_with_tono === false ? "✗" : "—";
  const agreementClass =
    d.agreed_with_tono === true
      ? "text-emerald-700"
      : d.agreed_with_tono === false
      ? "text-rose-700"
      : "text-slate-500";
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span className="font-semibold text-emerald-700 uppercase tracking-wide">
          Decisión HR
        </span>
        <span>{fmt(d.decided_at)}</span>
      </div>
      <div className="mt-1 text-slate-800">
        <span className="font-medium">{d.decision}</span> · {d.prior_state} →{" "}
        {d.resulting_state}{" "}
        {d.tono_recommendation_at_decision_time && (
          <span className="text-xs text-slate-500">
            (Toño sugirió {d.tono_recommendation_at_decision_time}){" "}
            <span className={agreementClass}>{agreement}</span>
          </span>
        )}
      </div>
      <div className="text-[10px] text-slate-500">{d.decided_by}</div>
      {d.hr_reasoning && (
        <div className="text-slate-700 mt-1 italic whitespace-pre-wrap">
          “{d.hr_reasoning}”
        </div>
      )}
    </div>
  );
}

function renderNote(payload: unknown): JSX.Element {
  const n = payload as {
    id: string;
    created_at: string;
    hr_user: string;
    body: string;
    dossier_id: string | null;
  };
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span className="font-semibold text-slate-700 uppercase tracking-wide">
          Nota HR
        </span>
        <span>{fmt(n.created_at)}</span>
      </div>
      <div className="text-[10px] text-slate-500">{n.hr_user}</div>
      <div className="text-slate-800 mt-1 whitespace-pre-wrap">{n.body}</div>
    </div>
  );
}

function renderStateEvent(payload: unknown): JSX.Element {
  const e = payload as {
    type: string;
    actor: string | null;
    meta: unknown;
    created_at: string;
  };
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span className="font-semibold text-slate-700 uppercase tracking-wide">
          {e.type}
        </span>
        <span>{fmt(e.created_at)}</span>
      </div>
      {e.actor && <div className="text-[10px] text-slate-500">{e.actor}</div>}
      {e.meta != null && (
        <pre className="text-[11px] text-slate-600 whitespace-pre-wrap break-all mt-1">
          {JSON.stringify(e.meta, null, 2)}
        </pre>
      )}
    </div>
  );
}
