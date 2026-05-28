// HR pipeline — OTs in state "4. Coordinar – Listo para ejecutar" with a
// per-OT status pill that tells HR what action is owed:
//
//   Esperando decisión        — postulados exist, no preselección yet
//   Listo para contrato       — preseleccionados, contract not sent
//   Contrato enviado          — sent, awaiting signature
//   Asignado en Redin         — contract signed; waiting on architect to
//                               confirm the assignment in AppSheet
//   Sin postulaciones         — open OT, nobody applied
//
// Sort: needs-HR-action first; passive states sink. Each card carries a
// "Compartir con arquitecto" button that copies a signed public link
// (lib/public-token) for the architect-facing slim view.
//
// v1.1:
//   - rankPostulaciones uses especialidadFit + proximidad signals (worker
//     profiles passed through).
//   - OT alcance from ots_extended is LEFT-JOINed; "✓ alcance" chip on cards
//     where present; NudgeArchitectButton on cards where absent.
//   - Agreement-rate header block from shortlist_agreement_metrics
//     (scope='shortlist') — measures HR↔Toño shortlist agreement.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { rankPostulaciones } from "@/lib/ranking";
import { otTitle, tecnicoLabel, otTotalOrdenCalculado } from "@/lib/ot-display";
import { signOtPublicToken } from "@/lib/public-token";
import { OFFERABLE_ESTADO } from "@redin/tools/read-pending-ots";
import type { PostulacionRow, ContratoStatus, WorkerProfile, OtAlcance } from "@redin/shared";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { CopyShareLinkButton } from "@/components/CopyShareLinkButton";
import { NudgeArchitectButton } from "@/components/NudgeArchitectButton";

export const dynamic = "force-dynamic";

type OtStatusKey =
  | "esperando_decision"
  | "listo_para_contrato"
  | "contrato_enviado"
  | "asignado_en_redin"
  | "sin_postulaciones";

interface OtStatus {
  key: OtStatusKey;
  label: string;
  className: string;
  sortIndex: number;
}

function computeOtStatus(args: {
  postCount: number;
  postStates: Set<string>;
  contractStates: Set<ContratoStatus>;
}): OtStatus {
  const { postCount, postStates, contractStates } = args;

  if (postCount === 0) {
    return {
      key: "sin_postulaciones",
      label: "Sin postulaciones",
      className: "bg-slate-100 text-slate-600",
      sortIndex: 4,
    };
  }
  if (postStates.has("asignado") || contractStates.has("firmado")) {
    return {
      key: "asignado_en_redin",
      label: "Asignado en Redin",
      className: "bg-slate-900 text-white",
      sortIndex: 5,
    };
  }
  if (contractStates.has("enviado")) {
    return {
      key: "contrato_enviado",
      label: "Contrato enviado",
      className: "bg-blue-100 text-blue-800",
      sortIndex: 3,
    };
  }
  if (postStates.has("preseleccionado")) {
    return {
      key: "listo_para_contrato",
      label: "Listo para contrato",
      className: "bg-emerald-100 text-emerald-800",
      sortIndex: 2,
    };
  }
  return {
    key: "esperando_decision",
    label: "Esperando decisión",
    className: "bg-amber-100 text-amber-800",
    sortIndex: 1,
  };
}

function publicOriginFromHeaders(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const h = headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

interface OtsExtendedRow {
  ot_row_id: string;
  alcance_jsonb: unknown | null;
}

/** LEFT JOIN ots_extended — graceful degrade when table doesn't exist yet. */
async function fetchOtsExtendedForPipeline(
  supa: ReturnType<typeof serviceClient>,
  otIds: string[]
): Promise<Map<string, OtsExtendedRow>> {
  if (otIds.length === 0) return new Map();
  try {
    // Cast through `unknown` — ots_extended is added by Stream A migration 012
    // and is not yet in the hand-authored Database schema. The query degrades
    // gracefully (returns empty map) if the table doesn't exist.
    const { data, error } = await (supa as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          in: (col: string, vals: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      };
    })
      .from("ots_extended")
      .select("ot_row_id, alcance_jsonb")
      .in("ot_row_id", otIds);
    if (error) return new Map();
    const map = new Map<string, OtsExtendedRow>();
    for (const row of (data ?? []) as OtsExtendedRow[]) {
      map.set(row.ot_row_id, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

export default async function HrPipelinePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const origin = publicOriginFromHeaders();

  // Agreement rate from shortlist_agreement_metrics (scope='shortlist')
  // Query: total decisions + agreed decisions for the header block.
  const { data: agreementRows } = await supa
    .from("shortlist_agreement_metrics")
    .select("agreed_with_tono");
  const totalDecisions = (agreementRows ?? []).length;
  const agreedCount = (agreementRows ?? []).filter((r) => r.agreed_with_tono === true).length;
  const agreementPct =
    totalDecisions > 0 ? Math.round((agreedCount / totalDecisions) * 100) : null;

  // Pipeline shows ONLY assignable OTs — state "4. Coordinar – Listo para ejecutar".
  const { data: offerableOts } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data, synced_at")
    .eq("estado", OFFERABLE_ESTADO)
    .order("synced_at", { ascending: false });
  const pendingOts = offerableOts ?? [];
  const offerableIds = pendingOts.map((o) => o.row_id);

  // LEFT JOIN ots_extended for alcance chip + nudge button.
  const extendedMap = await fetchOtsExtendedForPipeline(supa, offerableIds);

  // Postulaciones AND contratos scoped to the offerable OTs only — both
  // feed the per-OT status pill computation and the ranking display.
  const [postsRes, contratosRes] = offerableIds.length
    ? await Promise.all([
        supa.from("postulaciones").select("*").in("ot_id", offerableIds),
        supa
          .from("contratos")
          .select("id, ot_id, status, sent_at")
          .in("ot_id", offerableIds)
          .order("sent_at", { ascending: false, nullsFirst: true }),
      ])
    : [
        { data: [] as PostulacionRow[] },
        {
          data: [] as {
            id: string;
            ot_id: string | null;
            status: ContratoStatus;
            sent_at: string | null;
          }[],
        },
      ];
  const allPostsForPending: PostulacionRow[] = postsRes.data ?? [];
  const contratoStatesByOt = new Map<string, Set<ContratoStatus>>();
  // Active contract id per OT — first non-cancelado we encounter.
  const activeContractIdByOt = new Map<string, string>();
  for (const c of contratosRes.data ?? []) {
    if (!c.ot_id) continue;
    const s = contratoStatesByOt.get(c.ot_id) ?? new Set<ContratoStatus>();
    s.add(c.status);
    contratoStatesByOt.set(c.ot_id, s);
    if (c.status !== "cancelado" && !activeContractIdByOt.has(c.ot_id)) {
      activeContractIdByOt.set(c.ot_id, c.id);
    }
  }

  const tecnicoIds = [...new Set(allPostsForPending.map((p) => p.tecnico_id))];

  // Internal performance (calidad signal).
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

  // Worker ciudad + especialidades from tecnico_registered events.
  // Both are needed for the new especialidadFit + proximidad ranking signals.
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

  const postsByOt = new Map<string, PostulacionRow[]>();
  for (const p of allPostsForPending) {
    if (!postsByOt.has(p.ot_id)) postsByOt.set(p.ot_id, []);
    postsByOt.get(p.ot_id)!.push(p);
  }

  // Build otFields + otAlcance maps for ranking.
  const otFieldsMap = new Map<
    string,
    { ciudad: string | null; especialidad: string | null; subcategoria?: string | null }
  >();
  const otAlcanceMap = new Map<string, OtAlcance | null>();
  for (const ot of pendingOts) {
    otFieldsMap.set(ot.row_id, { ciudad: ot.ciudad, especialidad: ot.especialidad });
    const ext = extendedMap.get(ot.row_id);
    if (ext) {
      const aj = ext.alcance_jsonb as Record<string, unknown> | null;
      otAlcanceMap.set(ot.row_id, aj
        ? {
            especialidad: typeof aj.especialidad === "string" ? aj.especialidad : null,
            subcategoria: typeof aj.subcategoria === "string" ? aj.subcategoria : null,
          }
        : null);
    } else {
      otAlcanceMap.set(ot.row_id, null);
    }
  }

  // Pre-compute status + sort key for every OT.
  interface OtRow {
    ot: (typeof pendingOts)[number];
    posts: PostulacionRow[];
    status: OtStatus;
    hasAlcance: boolean;
  }
  const rows: OtRow[] = pendingOts.map((ot) => {
    const posts = postsByOt.get(ot.row_id) ?? [];
    const postStates = new Set(posts.map((p) => p.state));
    const contractStates = contratoStatesByOt.get(ot.row_id) ?? new Set();
    const status = computeOtStatus({
      postCount: posts.length,
      postStates,
      contractStates,
    });
    const ext = extendedMap.get(ot.row_id);
    const hasAlcance = !!(ext && ext.alcance_jsonb !== null);
    return { ot, posts, status, hasAlcance };
  });
  rows.sort((a, b) => {
    if (a.status.sortIndex !== b.status.sortIndex) {
      return a.status.sortIndex - b.status.sortIndex;
    }
    return (
      new Date(b.ot.synced_at ?? 0).getTime() -
      new Date(a.ot.synced_at ?? 0).getTime()
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Pipeline HR</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/hr/qualification-queue"
            className="text-sm text-amber-600 hover:text-amber-700 font-medium"
          >
            Cola de calificación →
          </Link>
          <Link
            href="/hr/tecnicos"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Técnicos →
          </Link>
          <Link
            href="/hr/contratos"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Contratos →
          </Link>
          <Link
            href="/hr/evaluations"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Evaluaciones →
          </Link>
        </div>
      </div>

      {/* Agreement-rate header block — Stream D */}
      <div className="card p-4 bg-slate-50 flex items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
            Acuerdo HR ↔ Toño
          </div>
          {agreementPct !== null ? (
            <div className="text-2xl font-bold text-slate-900">
              {agreementPct}%{" "}
              <span className="text-sm font-normal text-slate-500">
                sobre {totalDecisions}{" "}
                {totalDecisions === 1 ? "decisión" : "decisiones"} de shortlist
              </span>
            </div>
          ) : (
            <div className="text-sm text-slate-500 italic">
              Sin decisiones de shortlist aún
            </div>
          )}
        </div>
        {agreementPct !== null && (
          <div
            className={`text-xs rounded-full px-3 py-1 font-medium ${
              agreementPct >= 75
                ? "bg-emerald-100 text-emerald-800"
                : agreementPct >= 50
                  ? "bg-amber-100 text-amber-800"
                  : "bg-red-100 text-red-800"
            }`}
          >
            {agreementPct >= 75
              ? "Alto acuerdo"
              : agreementPct >= 50
                ? "Acuerdo moderado"
                : "Bajo acuerdo"}
          </div>
        )}
      </div>

      <p className="text-sm text-slate-600">
        OTs en estado <strong>4. Coordinar – Listo para ejecutar</strong>.
        Ordenadas por acción pendiente: las que necesitan tu decisión arriba.
        Comparte con un arquitecto para que vea las postulaciones sin entrar
        a este sistema.
      </p>
      {rows.length === 0 && (
        <div className="card p-4 text-sm text-slate-500">
          No hay OTs listas para asignar en este momento.
        </div>
      )}
      <ul className="space-y-4">
        {rows.map(({ ot, posts, status, hasAlcance }) => {
          const ranked = rankPostulaciones({
            postulaciones: posts,
            openPosByTecnico: openPosByTec,
            ratingByTecnico: ratingByTec,
            workerProfiles,
            otFields: otFieldsMap,
            otAlcance: otAlcanceMap,
          });
          const publicUrl = `${origin}/publico/ot/${signOtPublicToken(ot.row_id)}`;
          const preselCount = posts.filter((p) => p.state === "preseleccionado").length;
          const postuladoCount = posts.filter((p) => p.state === "postulado").length;

          // Determine if this OT lacks alcance. We check ots_extended in the
          // data field of the ot row; since ots_extended is a separate table
          // (added by Stream A's migration 012), we degrade gracefully when it
          // doesn't exist — show the nudge button for all state-4 OTs without
          // a known alcance. A future query can check ots_extended directly.
          // For now: show the button always (Stream A will populate alcance; the
          // button is idempotent on re-click).
          const showNudgeButton = true;

          return (
            <li key={ot.row_id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span>{ot.ciudad ?? "—"} · {ot.especialidad ?? "—"}</span>
                    {otTotalOrdenCalculado(ot.data).label && (
                      <span className="inline-flex items-center text-[11px] bg-slate-100 text-slate-700 rounded-full px-2 py-0.5 font-medium tabular-nums">
                        {otTotalOrdenCalculado(ot.data).label}
                      </span>
                    )}
                    {hasAlcance ? (
                      <span className="inline-flex items-center gap-0.5 text-[11px] bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 font-medium">
                        ✓ alcance
                      </span>
                    ) : (
                      <NudgeArchitectButton otId={ot.row_id} />
                    )}
                  </div>
                  <div className="font-medium text-slate-900 truncate">
                    {otTitle(ot)}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {ot.row_id.slice(0, 8)}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className={`text-xs rounded-full px-2 py-0.5 ${status.className}`}
                  >
                    {status.label}
                  </span>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    {posts.length === 0
                      ? "0 postulaciones"
                      : `${posts.length} ${posts.length === 1 ? "postulación" : "postulaciones"}${preselCount ? ` · ${preselCount} preseleccionada${preselCount === 1 ? "" : "s"}` : ""}${postuladoCount && preselCount ? ` · ${postuladoCount} esperando` : ""}`}
                  </div>
                  {status.key === "sin_postulaciones" && (
                    <Link
                      href={`/hr/shortlist/${encodeURIComponent(ot.row_id)}`}
                      className="text-[11px] text-amber-600 hover:text-amber-700 font-medium"
                    >
                      Sugerir técnicos →
                    </Link>
                  )}
                </div>
              </div>

              {ranked.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {ranked.slice(0, 5).map((r) => (
                    <li
                      key={r.postulacion.id}
                      className="flex items-center justify-between border-t border-slate-100 pt-1"
                    >
                      <span className="text-slate-700">
                        {tecnicoLabel({
                          nombre: nombreByTec.get(r.postulacion.tecnico_id) ?? null,
                          ciudad: ciudadByTec.get(r.postulacion.tecnico_id) ?? null,
                        })}
                        {" · "}
                        <span className="text-slate-500">{r.postulacion.state}</span>
                      </span>
                      <span className="text-xs text-slate-500">
                        fit {r.scores.especialidadFit.toFixed(2)} ·{" "}
                        prox {r.scores.proximidad.toFixed(0)} ·{" "}
                        dispo {r.scores.disponibilidad.toFixed(2)} ·{" "}
                        calidad {r.scores.calidad?.toFixed(1) ?? "—"}
                      </span>
                    </li>
                  ))}
                  {ranked.length > 5 && (
                    <li className="text-xs text-slate-500 pt-1">
                      +{ranked.length - 5} más
                    </li>
                  )}
                </ul>
              )}

              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4 flex-wrap">
                {(() => {
                  const activeContractId = activeContractIdByOt.get(ot.row_id);
                  if (activeContractId) {
                    return (
                      <>
                        <Link
                          href={`/hr/contratos/${activeContractId}`}
                          className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                        >
                          Ver contrato →
                        </Link>
                        <Link
                          href={`/hr/shortlist/${encodeURIComponent(ot.row_id)}`}
                          className="text-xs text-slate-500 hover:text-slate-700"
                        >
                          Ver postulaciones
                        </Link>
                      </>
                    );
                  }
                  return (
                    <Link
                      href={`/hr/shortlist/${encodeURIComponent(ot.row_id)}`}
                      className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                    >
                      Ver postulaciones →
                    </Link>
                  );
                })()}
                <CopyShareLinkButton url={publicUrl} />
                {showNudgeButton && (
                  <NudgeArchitectButton otId={ot.row_id} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
