// HR shortlist view for a single OT — one-click preseleccionar / rechazar.
// Server actions write to `postulaciones` and log `shortlist_decided` events.
//
// v1.1 additions (Stream D):
//   - Toño recommendation card at the top (via Suspense skeleton fallback).
//   - decide() computes and persists agreed_with_tono when HR picks a candidate.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { rankPostulaciones } from "@/lib/ranking";
import { enqueueWhatsApp, enqueueWhatsAppDocument, tecnicoNotificationContext } from "@/lib/notify";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ContratoStatus, PostulacionState, WorkerProfile, OtAlcance } from "@redin/shared";
import { rankTecnicosForOT } from "@redin/shared";
import Link from "next/link";
import { Suspense } from "react";
import { makeDefaultToolContext } from "@redin/tools";
import { recommendShortlistCandidate } from "@redin/tools/recommend-shortlist-candidate";
import { sendOffer } from "./offer-actions";

export const dynamic = "force-dynamic";

// ---- Confidence label ----
function confidenceLabel(conf: number): string {
  if (conf >= 0.75) return "alto";
  if (conf >= 0.5) return "medio";
  return "bajo";
}

// ---- Rec card data loader (runs as server component, inside Suspense) ----

async function loadOrGenerateRec(otId: string): Promise<{
  recommended_postulacion_id: string;
  confidence: number;
  reasoning: string;
  cached: boolean;
} | null> {
  const supa = serviceClient();

  // Check for existing rec and current pool hash
  const { data: posts } = await supa
    .from("postulaciones")
    .select("id")
    .eq("ot_id", otId)
    .eq("state", "postulado");

  if (!posts || posts.length === 0) return null;

  // If only one candidate, skip the LLM — trivially pick the only one
  // (but still call so we cache the rec and compute pool_hash).
  const ctx = makeDefaultToolContext({ supabase: supa });
  const result = await recommendShortlistCandidate(ctx, { ot_id: otId });
  if (!result.ok) {
    console.warn("rec generation failed", { ot_id: otId, error: result.error });
    return null;
  }
  return result.data;
}

interface RecCardProps {
  otId: string;
  nombreByTec: Map<string, string | null>;
  postulacionTecnicoMap: Map<string, string>;
}

async function RecCardInner({ otId, nombreByTec, postulacionTecnicoMap }: RecCardProps) {
  const rec = await loadOrGenerateRec(otId);
  if (!rec) return null;

  const tecnicoId = postulacionTecnicoMap.get(rec.recommended_postulacion_id);
  const nombre = tecnicoId ? (nombreByTec.get(tecnicoId) ?? null) : null;
  const display = nombre ?? rec.recommended_postulacion_id.slice(0, 8);
  const confLabel = confidenceLabel(rec.confidence);
  const confColorClass =
    rec.confidence >= 0.75
      ? "text-emerald-700"
      : rec.confidence >= 0.5
        ? "text-amber-700"
        : "text-slate-500";

  return (
    <div className="card p-4 border-l-4 border-amber-400 bg-amber-50">
      <div className="text-xs uppercase tracking-wide text-amber-700 mb-1">
        Sugerencia de Toño {rec.cached ? "(en caché)" : ""}
      </div>
      <div className="text-sm text-slate-800">
        <span className="font-medium">{display}</span>
        {" · "}
        <span className={`font-medium ${confColorClass}`}>confianza {confLabel}</span>
        {" · "}
        <span className="text-slate-600 italic">{rec.reasoning}</span>
      </div>
      <div className="text-[11px] text-slate-400 mt-1 font-mono">
        postulacion: {rec.recommended_postulacion_id.slice(0, 8)}
      </div>
    </div>
  );
}

function RecCardSkeleton() {
  return (
    <div className="card p-4 border-l-4 border-amber-200 bg-amber-50 animate-pulse">
      <div className="text-xs uppercase tracking-wide text-amber-400 mb-1">
        Cargando sugerencia de Toño…
      </div>
      <div className="h-4 bg-amber-100 rounded w-3/4" />
    </div>
  );
}

// ---- Server actions ----

async function decide(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();
  const postulacionId = formData.get("postulacion_id");
  const nextState = formData.get("state");
  const otId = formData.get("ot_id");
  if (
    typeof postulacionId !== "string" ||
    typeof nextState !== "string" ||
    typeof otId !== "string"
  ) {
    return;
  }
  const state = nextState as PostulacionState;
  const nowIso = new Date().toISOString();

  const { data: prior } = await supa
    .from("postulaciones")
    .select("id, state")
    .eq("id", postulacionId)
    .maybeSingle();

  const { error } = await supa
    .from("postulaciones")
    .update({
      state,
      decided_at: nowIso,
      decided_by: `hr:${hrEmail}`,
    })
    .eq("id", postulacionId);
  if (error) {
    console.error("decide failed", error);
    return;
  }

  // Compute agreed_with_tono if HR is picking a candidate (preseleccionado)
  // by comparing with the Toño rec for this OT.
  if (state === "preseleccionado") {
    const { data: recRow } = await supa
      .from("candidate_decisions")
      .select("id, tono_recommendation_postulacion_id")
      .eq("ot_id", otId)
      .eq("scope", "shortlist" as "shortlist")
      .maybeSingle();

    if (recRow) {
      const agreedWithTono =
        recRow.tono_recommendation_postulacion_id === postulacionId;

      // Update the shortlist decision row with HR's pick + agreement
      await supa
        .from("candidate_decisions")
        .update({
          hr_postulacion_id: postulacionId,
          agreed_with_tono: agreedWithTono,
          decided_by: `hr:${hrEmail}`,
          decided_at: nowIso,
        })
        .eq("id", recRow.id);
    }
  }

  await supa.from("eventos").insert({
    type: "shortlist_decided",
    entity_id: postulacionId,
    actor: `hr:${hrEmail}`,
    meta: {
      from_state: prior?.state ?? null,
      to_state: state,
      ot_id: otId,
    },
  });

  if (state === "preseleccionado") {
    const { data: post } = await supa
      .from("postulaciones")
      .select("tecnico_id")
      .eq("id", postulacionId)
      .maybeSingle();
    if (post?.tecnico_id) {
      const { phone, descripcion } = await tecnicoNotificationContext(
        supa,
        post.tecnico_id,
        otId
      );
      // Gap A: attach the alcance PDF so the worker can read the scope before
      // accepting. Worker's "acepto" reply is captured pre-LLM in
      // tono/src/offer-replies.ts (extended to recognize preselection-stage
      // acceptances, not just HR-push ot_offers).
      let alcancePdfPath: string | null = null;
      try {
        const { data: ext } = await supa
          .from("ots_extended")
          .select("alcance_pdf_path")
          .eq("ot_row_id", otId)
          .maybeSingle();
        alcancePdfPath = ext?.alcance_pdf_path ?? null;
      } catch {
        alcancePdfPath = null;
      }
      if (phone) {
        const trabajo = descripcion ?? "el trabajo";
        const bodyText = alcancePdfPath
          ? `Buenas — quedaste preseleccionado para "${trabajo}". Te paso el alcance del trabajo en el documento adjunto. Revísalo bien: si te interesa, responde "acepto"; si no, responde "paso".`
          : `Buenas — quedaste preseleccionado para "${trabajo}". El cliente revisa tu perfil; te aviso apenas decidan.`;
        await enqueueWhatsApp(supa, {
          phone,
          body: bodyText,
          meta: { kind: "preseleccionado", postulacion_id: postulacionId, ot_id: otId },
        });
        if (alcancePdfPath) {
          await enqueueWhatsAppDocument(supa, {
            phone,
            body: `Alcance del trabajo — OT ${otId.slice(0, 8)}`,
            attachment_path: alcancePdfPath,
            attachment_bucket: "alcance-photos",
            attachment_filename: `Alcance_OT_${otId.slice(0, 8)}.pdf`,
            meta: {
              kind: "preseleccionado_alcance",
              postulacion_id: postulacionId,
              ot_id: otId,
            },
          });
        }
      }
    }
  }

  revalidatePath(`/hr/shortlist/${encodeURIComponent(otId)}`);
  revalidatePath("/hr/pipeline");
}

async function createContract(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();
  const tecnicoId = formData.get("tecnico_id");
  const otId = formData.get("ot_id");
  if (typeof tecnicoId !== "string" || typeof otId !== "string") return;

  const { data: contract, error } = await supa
    .from("contratos")
    .insert({
      tecnico_id: tecnicoId,
      ot_id: otId,
      status: "borrador",
      created_by: `hr:${hrEmail}`,
    })
    .select("id")
    .single();
  if (error || !contract) {
    console.error("contract create failed", error);
    return;
  }

  await supa.from("eventos").insert({
    type: "contract_drafted",
    entity_id: contract.id,
    actor: `hr:${hrEmail}`,
    meta: { tecnico_id: tecnicoId, ot_id: otId },
  });

  const { phone, descripcion } = await tecnicoNotificationContext(supa, tecnicoId, otId);
  if (phone) {
    const trabajo = descripcion ?? "el trabajo";
    await enqueueWhatsApp(supa, {
      phone,
      body: `Avanzamos con el contrato de "${trabajo}". Te lo paso en un momento para que lo revises.`,
      meta: { kind: "contract_drafted", contract_id: contract.id, ot_id: otId },
    });
  }

  redirect(`/hr/contratos/${encodeURIComponent(contract.id)}`);
}

interface Props {
  params: { ot_id: string };
}

export default async function HrShortlistPage({ params }: Props) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const otId = decodeURIComponent(params.ot_id);
  const supa = serviceClient();

  const { data: ot } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("row_id", otId)
    .maybeSingle();
  const otHeadline = otTitle(ot);
  const { data: posts } = await supa
    .from("postulaciones")
    .select("*")
    .eq("ot_id", otId)
    .order("applied_at", { ascending: false });

  const tecnicoIds = [...new Set((posts ?? []).map((p) => p.tecnico_id))];
  const { data: perfRows } = tecnicoIds.length
    ? await supa
        .from("tecnico_performance")
        .select("tecnico_id, avg_score, eval_count")
        .in("tecnico_id", tecnicoIds)
    : { data: [] };
  const ratingByTec = new Map<string, number | null>();
  for (const id of tecnicoIds) ratingByTec.set(id, null);
  for (const r of perfRows ?? []) {
    ratingByTec.set(
      r.tecnico_id,
      r.eval_count > 0 && r.avg_score !== null ? r.avg_score : null
    );
  }

  const { data: openPosRows } = tecnicoIds.length
    ? await supa
        .from("postulaciones")
        .select("tecnico_id,state")
        .in("tecnico_id", tecnicoIds)
        .in("state", ["postulado", "preseleccionado"])
    : { data: [] };
  const openPosByTec = new Map<string, number>();
  for (const r of openPosRows ?? []) {
    openPosByTec.set(r.tecnico_id, (openPosByTec.get(r.tecnico_id) ?? 0) + 1);
  }

  const { data: tecRows } = tecnicoIds.length
    ? await supa
        .from("tecnicos_extended")
        .select("tecnico_id, nombre")
        .in("tecnico_id", tecnicoIds)
    : { data: [] };
  const nombreByTec = new Map<string, string | null>();
  for (const r of tecRows ?? []) {
    nombreByTec.set(r.tecnico_id, r.nombre ?? null);
  }

  // Worker ciudad + especialidades live in eventos.meta (tecnico_registered).
  // Bulk-load so HR can spot worker-vs-OT city mismatches and so the new
  // especialidadFit + proximidad ranking signals work on the shortlist view.
  const { data: ciudadEvents } = tecnicoIds.length
    ? await supa
        .from("eventos")
        .select("entity_id, meta, created_at")
        .eq("type", "tecnico_registered")
        .in("entity_id", tecnicoIds)
        .order("created_at", { ascending: false })
    : { data: [] };
  const ciudadByTec = new Map<string, string | null>();
  const workerProfiles = new Map<string, WorkerProfile>();
  for (const e of ciudadEvents ?? []) {
    if (!e.entity_id || ciudadByTec.has(e.entity_id)) continue;
    const meta = e.meta as Record<string, unknown> | null;
    const ciudad = meta && typeof meta.ciudad === "string" ? meta.ciudad : null;
    ciudadByTec.set(e.entity_id, ciudad);
    const especialidades = Array.isArray(meta?.especialidades)
      ? (meta!.especialidades as unknown[]).filter(
          (x): x is string => typeof x === "string"
        )
      : null;
    workerProfiles.set(e.entity_id, { ciudad, especialidades });
  }

  const { data: contractsForOt } = await supa
    .from("contratos")
    .select("id, tecnico_id, status, sent_at, signed_at")
    .eq("ot_id", otId)
    .order("sent_at", { ascending: false, nullsFirst: true });
  const activeContract = (contractsForOt ?? []).find(
    (c) => c.status !== "cancelado"
  );
  const contractWorkerId = activeContract?.tecnico_id ?? null;
  const contractStatusLabel: Record<ContratoStatus, string> = {
    borrador: "Borrador",
    enviado: "Enviado",
    firmado: "Firmado",
    cancelado: "Cancelado",
  };

  // Build OT-level maps for the ranking signals.
  const otFieldsMap = new Map([
    [
      otId,
      {
        ciudad: ot?.ciudad ?? null,
        especialidad: ot?.especialidad ?? null,
      },
    ],
  ]);
  // otAlcance LEFT JOIN — graceful degrade when ots_extended doesn't exist yet.
  // Cast through unknown: ots_extended is not in the hand-authored Database
  // schema yet (Stream A migration 012 adds it in parallel).
  let otAlcanceMap: Map<string, OtAlcance | null> = new Map([[otId, null]]);
  try {
    const { data: extRow } = await (supa as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => Promise<{ data: unknown | null; error: unknown }>;
          };
        };
      };
    })
      .from("ots_extended")
      .select("alcance_jsonb")
      .eq("ot_row_id", otId)
      .maybeSingle();
    if (extRow) {
      const aj = (extRow as { alcance_jsonb: unknown }).alcance_jsonb as Record<string, unknown> | null;
      otAlcanceMap = new Map([
        [
          otId,
          aj
            ? {
                especialidad: typeof aj.especialidad === "string" ? aj.especialidad : null,
                subcategoria: typeof aj.subcategoria === "string" ? aj.subcategoria : null,
              }
            : null,
        ],
      ]);
    }
  } catch {
    // ots_extended not yet available — keep null
  }

  const ranked = rankPostulaciones({
    postulaciones: posts ?? [],
    openPosByTecnico: openPosByTec,
    ratingByTecnico: ratingByTec,
    workerProfiles,
    otFields: otFieldsMap,
    otAlcance: otAlcanceMap,
  });

  // Build postulacion → tecnico_id map for the rec card
  const postulacionTecnicoMap = new Map<string, string>();
  for (const p of posts ?? []) {
    postulacionTecnicoMap.set(p.id, p.tecnico_id);
  }

  const hasPostulados = (posts ?? []).some((p) => p.state === "postulado");

  return (
    <div className="space-y-4">
      <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
        ← pipeline
      </Link>
      <div className="card p-4">
        <div className="text-sm text-slate-500">
          {ot?.ciudad ?? "—"} · {ot?.especialidad ?? "—"}
        </div>
        <div className="font-semibold text-slate-900 mt-0.5">{otHeadline}</div>
        <div className="text-sm text-slate-700 mt-1">{ot?.estado ?? "—"}</div>
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          {otId.slice(0, 8)}
        </div>
      </div>

      {/* Toño recommendation card — non-blocking via Suspense */}
      {hasPostulados && (
        <Suspense fallback={<RecCardSkeleton />}>
          <RecCardInner
            otId={otId}
            nombreByTec={nombreByTec}
            postulacionTecnicoMap={postulacionTecnicoMap}
          />
        </Suspense>
      )}

      {activeContract && (
        <div className="card p-4 border-l-4 border-blue-500 bg-blue-50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-blue-700">
                Contrato en curso ·{" "}
                {contractStatusLabel[activeContract.status]}
              </div>
              <div className="font-medium text-slate-900 mt-0.5">
                {tecnicoLabel({
                  nombre:
                    nombreByTec.get(activeContract.tecnico_id) ?? null,
                  ciudad:
                    ciudadByTec.get(activeContract.tecnico_id) ?? null,
                })}
              </div>
              <div className="text-xs text-slate-600 mt-1">
                {activeContract.signed_at && (
                  <>Firmado {new Date(activeContract.signed_at).toLocaleString("es-CO")}</>
                )}
                {!activeContract.signed_at && activeContract.sent_at && (
                  <>Enviado {new Date(activeContract.sent_at).toLocaleString("es-CO")}</>
                )}
                {!activeContract.signed_at && !activeContract.sent_at && (
                  <>Borrador en preparación</>
                )}
              </div>
              <div className="text-xs text-slate-600 mt-2">
                Las decisiones de preselección y contratación están bloqueadas
                hasta que este contrato se complete o se cancele.
              </div>
            </div>
            <Link
              href={`/hr/contratos/${activeContract.id}`}
              className="text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md px-3 py-1.5 shrink-0"
            >
              Ver contrato →
            </Link>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {ranked.map((r) => {
          const isContractedWorker =
            !!contractWorkerId && contractWorkerId === r.postulacion.tecnico_id;
          const lockedByContract = !!activeContract;
          const canPreseleccionar =
            !lockedByContract &&
            r.postulacion.state !== "preseleccionado" &&
            r.postulacion.state !== "asignado";
          const canRechazar =
            !lockedByContract && r.postulacion.state !== "rechazado";
          const canGenerarContrato =
            !lockedByContract && r.postulacion.state === "preseleccionado";

          return (
            <li
              key={r.postulacion.id}
              className={`card p-4 ${
                lockedByContract && !isContractedWorker ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Link
                    href={`/hr/tecnicos/${encodeURIComponent(r.postulacion.tecnico_id)}`}
                    className="font-medium text-slate-900 hover:text-amber-700"
                  >
                    {tecnicoLabel({
                      nombre: nombreByTec.get(r.postulacion.tecnico_id) ?? null,
                      ciudad: ciudadByTec.get(r.postulacion.tecnico_id) ?? null,
                    })}
                  </Link>
                  <div className="text-xs text-slate-500">
                    Estado: {r.postulacion.state} · Aplicó{" "}
                    {new Date(r.postulacion.applied_at).toLocaleString("es-CO")}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    fit {r.scores.especialidadFit.toFixed(2)} ·{" "}
                    prox {r.scores.proximidad.toFixed(0)} ·{" "}
                    dispo {r.scores.disponibilidad.toFixed(2)} ·{" "}
                    calidad {r.scores.calidad?.toFixed(1) ?? "—"}
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  {lockedByContract ? (
                    isContractedWorker ? (
                      <Link
                        href={`/hr/contratos/${activeContract.id}`}
                        className="text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md px-3 py-1 text-center"
                      >
                        Ver contrato →
                      </Link>
                    ) : (
                      <span className="text-[11px] text-slate-500 italic text-right max-w-[10rem]">
                        Bloqueado: contrato en curso con otro técnico
                      </span>
                    )
                  ) : (
                    <>
                      <form action={decide}>
                        <input type="hidden" name="postulacion_id" value={r.postulacion.id} />
                        <input type="hidden" name="ot_id" value={otId} />
                        <input type="hidden" name="state" value="preseleccionado" />
                        <button
                          type="submit"
                          className="text-xs bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md px-3 py-1 w-full"
                          disabled={!canPreseleccionar}
                        >
                          Preseleccionar
                        </button>
                      </form>
                      <form action={decide}>
                        <input type="hidden" name="postulacion_id" value={r.postulacion.id} />
                        <input type="hidden" name="ot_id" value={otId} />
                        <input type="hidden" name="state" value="rechazado" />
                        <button
                          type="submit"
                          className="text-xs border border-slate-300 hover:bg-slate-50 disabled:opacity-50 text-slate-700 rounded-md px-3 py-1 w-full"
                          disabled={!canRechazar}
                        >
                          Rechazar
                        </button>
                      </form>
                      {canGenerarContrato && (
                        <form action={createContract}>
                          <input type="hidden" name="tecnico_id" value={r.postulacion.tecnico_id} />
                          <input type="hidden" name="ot_id" value={otId} />
                          <button
                            type="submit"
                            className="text-xs bg-slate-900 hover:bg-slate-800 text-white rounded-md px-3 py-1 w-full"
                          >
                            Generar contrato
                          </button>
                        </form>
                      )}
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {ranked.length === 0 && (
          <EmptyStateRanking otId={otId} />
        )}
      </ul>
    </div>
  );
}

// ---- Empty-state ranking block ----
// Renders when there are zero postulaciones for this OT. Calls the v1 supply
// engine (rankTecnicosForOT) to surface the top approved técnicos so HR can
// push an offer manually via the "Enviar oferta" button per row.
async function EmptyStateRanking({ otId }: { otId: string }) {
  const supa = serviceClient();
  const result = await rankTecnicosForOT(supa, otId, { limit: 10 });

  // Friendly fallback: no approved técnicos in the system yet.
  if (result.ranked.length === 0 && result.total_approved === 0) {
    return (
      <li className="card p-4 text-sm text-slate-500">
        No hay técnicos aprobados en el sistema todavía.{" "}
        <Link href="/hr/tecnicos" className="text-amber-600 hover:text-amber-700">
          Ver candidatos →
        </Link>
      </li>
    );
  }

  return (
    <>
      <li className="card p-4 border-l-4 border-amber-400 bg-amber-50">
        <div className="text-sm font-semibold text-slate-900">
          Top 10 técnicos aprobados — envíales una oferta para activar este trabajo
        </div>
        <div className="text-xs text-slate-600 mt-1">
          Sin postulaciones para esta OT. Estos son los técnicos aprobados mejor
          rankeados; haz clic en &ldquo;Enviar oferta&rdquo; para que reciban un
          WhatsApp con el alcance del trabajo.
        </div>
      </li>
      {result.ranked.map((r) => (
        <li key={r.tecnico_id} className="card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <Link
                href={`/hr/tecnicos/${encodeURIComponent(r.tecnico_id)}`}
                className="font-medium text-slate-900 hover:text-amber-700"
              >
                {r.nombre || "(sin nombre)"}
                {r.ciudad ? <span className="text-slate-500"> · {r.ciudad}</span> : null}
              </Link>
              {r.reasons.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.reasons.map((reason, idx) => (
                    <span
                      key={idx}
                      className="text-[11px] bg-slate-100 text-slate-600 rounded-full px-2 py-0.5"
                    >
                      {reason}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-xs text-slate-500 mt-1">
                fit {r.score_fit.toFixed(2)} · prox {r.score_proximidad.toFixed(0)} ·{" "}
                calidad {r.score_calidad !== null ? r.score_calidad.toFixed(1) : "—"}
              </div>
            </div>
            <div className="shrink-0">
              <form action={sendOffer}>
                <input type="hidden" name="ot_row_id" value={otId} />
                <input type="hidden" name="tecnico_id" value={r.tecnico_id} />
                <button
                  type="submit"
                  className="text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1.5"
                >
                  Enviar oferta
                </button>
              </form>
            </div>
          </div>
        </li>
      ))}
      <li className="text-xs text-slate-500 px-2">
        OT especialidad: {result.ot_especialidad ?? "sin declarar"} (fuente: {result.alcance_source})
      </li>
    </>
  );
}
