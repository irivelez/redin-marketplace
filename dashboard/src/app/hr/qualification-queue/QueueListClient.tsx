// Client wrapper around the qualification queue. The server component
// (page.tsx) does all the data fetching, sorting, and dossier summarization
// and passes a plain QueueItem[] in. This component owns:
//
//   - The visible count in the header (decrements optimistically on
//     approve/reject — friction #6).
//   - Per-card "removed" state with a CSS transition so cards visibly fade
//     and slide out before the server-side revalidation removes them from
//     the next render.
//
// schedule_call / unschedule_call are NOT optimistically removed — they
// shuffle the worker between queue buckets but the worker stays in the
// queue. Animating them out would flicker when revalidation puts them
// back in.
//
// Submission pattern: imperative call to submitDecision via useTransition.
// We do NOT use <form action={submitDecision}> with submitter buttons
// because React 18 client-component form intercepts can drop the submit
// button's name/value from FormData — the original server-rendered code
// flagged this exact risk in a comment ("If FormData drops the clicked
// button's value, switch to per-button formAction"). The imperative path
// builds FormData explicitly and is unambiguous.

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { submitDecision, appendHrNote } from "@/lib/decisions";
import type { CandidateState, HrAction, TonoRecommendation } from "@redin/shared";
import { phoneDisplay } from "@/lib/phone-display";

export interface QueueDossier {
  id: string;
  tono_recommendation: TonoRecommendation;
  tono_confidence: number;
  tono_reasoning: string;
  cedula: string;
  ciudad_base: string | null;
  categorias: string[];
  subcategorias: string[];
  gaps: string[];
  /** Story 17: optional doc keys that were NOT provided by the worker. */
  missing_optional: string[];
}

export interface QueueNote {
  id: string;
  hr_user: string;
  body: string;
  created_at_human: string;
}

export interface QueueItem {
  tecnico_id: string;
  display_name: string;
  display_ciudad: string;
  contact_phone: string | null;
  phone: string;
  last_jid: string | null;
  candidate_state: CandidateState;
  onboarded_at_human: string;
  dossier: QueueDossier | null;
  notes: QueueNote[];
  has_cedula_doc: boolean;
}

const REMOVES_FROM_QUEUE = new Set<HrAction>(["approve", "reject"]);

// Story 17 + 2026-05-17 (eps): maps missing_optional key → human-readable badge.
// "Sin doc X" means "no document uploaded" — independent of whether the worker
// self-declared having it in cumplimiento.<x>_activa. The declaration appears in
// tono_reasoning; the badge reflects only document attachment.
const MISSING_OPTIONAL_LABELS: Record<string, string> = {
  ARL: "Sin doc ARL",
  EPS: "Sin doc EPS",
  cert_estudios: "Sin doc estudios",
  cert_trabajos_previos: "Sin doc trabajos previos",
  vehiculo: "Sin vehículo",
  // Defensive: surfaces only if a tiene_vehiculo=true dossier ever lands without
  // a valid placa. submit_candidate_dossier.validateVehicle should prevent this.
  placa: "Sin placa",
};

function MissingOptionalBadge({ missingKey }: { missingKey: string }): JSX.Element {
  const label = MISSING_OPTIONAL_LABELS[missingKey] ?? `Sin ${missingKey}`;
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 border border-slate-200">
      {label}
    </span>
  );
}

function recommendationBadge(rec: TonoRecommendation): {
  label: string;
  className: string;
  borderClass: string;
} {
  switch (rec) {
    case "recommend_approve":
      return {
        label: "Toño sugiere aprobar",
        className: "bg-emerald-100 text-emerald-800 border-emerald-300",
        borderClass: "border-l-emerald-500",
      };
    case "recommend_reject":
      return {
        label: "Toño sugiere rechazar",
        className: "bg-rose-100 text-rose-800 border-rose-300",
        borderClass: "border-l-rose-500",
      };
    case "recommend_call":
      return {
        label: "Toño sugiere llamar",
        className: "bg-amber-100 text-amber-800 border-amber-300",
        borderClass: "border-l-amber-500",
      };
  }
}

export function QueueListClient({ items }: { items: QueueItem[] }): JSX.Element {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const visibleCount = items.length - removed.size;

  function markRemoved(id: string): void {
    setRemoved((s) => {
      const n = new Set(s);
      n.add(id);
      return n;
    });
  }

  function unmarkRemoved(id: string): void {
    setRemoved((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Cola de calificación</h1>
          <span
            className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-slate-900 text-white text-xs font-medium tabular-nums"
            aria-label={`${visibleCount} pendientes`}
          >
            {visibleCount}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/hr/tecnicos" className="text-sm text-slate-600 hover:text-slate-900">
            Técnicos →
          </Link>
          <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
            Pipeline →
          </Link>
          <Link href="/hr/contratos" className="text-sm text-slate-500 hover:text-slate-700">
            Contratos →
          </Link>
        </div>
      </div>
      <p className="text-sm text-slate-600 mt-2">
        Técnicos esperando aprobación. Toño deja una recomendación; HR decide.
        El borde izquierdo y el badge muestran qué sugiere; clic en{" "}
        <em>¿por qué?</em> para leer el razonamiento completo.
      </p>

      {items.length === 0 ? (
        <div className="card p-4 text-sm text-slate-500 mt-6">
          Cola al día — no hay técnicos esperando revisión.
        </div>
      ) : visibleCount === 0 ? (
        <div className="card p-4 text-sm text-emerald-700 mt-6">
          ✓ Cola al día — todas las decisiones se sincronizan en segundo plano.
        </div>
      ) : (
        <ul className="space-y-3 mt-6">
          {items.map((tec) => (
            <QueueCard
              key={tec.tecnico_id}
              tec={tec}
              isRemoved={removed.has(tec.tecnico_id)}
              onMarkRemoved={markRemoved}
              onUnmarkRemoved={unmarkRemoved}
            />
          ))}
        </ul>
      )}
    </>
  );
}

interface QueueCardProps {
  tec: QueueItem;
  isRemoved: boolean;
  onMarkRemoved: (id: string) => void;
  onUnmarkRemoved: (id: string) => void;
}

function QueueCard({
  tec,
  isRemoved,
  onMarkRemoved,
  onUnmarkRemoved,
}: QueueCardProps): JSX.Element {
  const [reasoning, setReasoning] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const badge = tec.dossier
    ? recommendationBadge(tec.dossier.tono_recommendation)
    : null;
  const borderColor = badge?.borderClass ?? "border-l-slate-300";

  function decide(action: HrAction): void {
    setError(null);
    if (action === "approve" && !tec.has_cedula_doc && !reasoning.trim()) {
      setError(
        "Falta foto de la cédula. Sube el documento o explica en la nota cómo validaste la identidad."
      );
      document.getElementById(`hr_reasoning_${tec.tecnico_id}`)?.focus();
      return;
    }
    if (REMOVES_FROM_QUEUE.has(action)) {
      onMarkRemoved(tec.tecnico_id);
    }
    const fd = new FormData();
    fd.set("tecnico_id", tec.tecnico_id);
    fd.set("prior_state", tec.candidate_state);
    fd.set("dossier_id", tec.dossier?.id ?? "");
    fd.set("decision", action);
    if (reasoning.trim()) fd.set("hr_reasoning", reasoning.trim());

    startTransition(async () => {
      try {
        await submitDecision(fd);
        // submitDecision is void; we only know it didn't throw. The next
        // server revalidation either removes this row from items (success)
        // or leaves it (stale_click / stale_dossier). The QueueListClient
        // doesn't auto-undo the optimistic removal — see TODO below.
      } catch (e) {
        // Real exception (network, RSC, etc). Restore the row and show error.
        if (REMOVES_FROM_QUEUE.has(action)) {
          onUnmarkRemoved(tec.tecnico_id);
        }
        setError(e instanceof Error ? e.message : "Error desconocido");
      }
    });
  }

  return (
    <li
      className={`card p-4 border-l-4 ${borderColor} transition-all duration-300 ease-out ${
        isRemoved
          ? "opacity-0 -translate-x-6 max-h-0 mt-0 mb-0 p-0 overflow-hidden border-0"
          : ""
      }`}
      aria-hidden={isRemoved ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/hr/tecnicos/${encodeURIComponent(tec.tecnico_id)}`}
              className="font-medium text-slate-900 hover:text-amber-700"
            >
              {tec.display_name}
            </Link>
            <span className="text-slate-500 font-normal">
              · {tec.display_ciudad}
            </span>
            {tec.candidate_state === "needs_call" && (
              <span className="text-xs bg-violet-100 text-violet-800 rounded-full px-2 py-0.5">
                📞 cita pendiente
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {(() => {
              const ph = phoneDisplay(tec);
              return (
                <>
                  {ph.callable ? (
                    <a
                      href={`tel:${ph.callable}`}
                      className="text-slate-700 font-medium underline-offset-2 hover:underline"
                    >
                      📞 {ph.callable}
                    </a>
                  ) : (
                    <span className="text-slate-400">Sin teléfono de contacto</span>
                  )}
                  {ph.waLabel && (
                    <span className="text-slate-400"> · WA {ph.waLabel}</span>
                  )}
                </>
              );
            })()}
            {tec.dossier && <> · cédula {tec.dossier.cedula}</>} · onboarded{" "}
            {tec.onboarded_at_human}
          </div>

          {tec.dossier && badge && (
            <div className="mt-3 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`text-xs rounded-full px-2 py-0.5 border ${badge.className}`}
                >
                  {badge.label}
                </span>
                <span className="text-xs text-slate-600 tabular-nums">
                  ({tec.dossier.tono_confidence.toFixed(2)})
                </span>
                <div
                  className="h-[3px] w-12 bg-slate-200 rounded overflow-hidden"
                  aria-hidden
                >
                  <div
                    className="h-full bg-slate-500"
                    style={{
                      width: `${Math.min(100, Math.max(0, tec.dossier.tono_confidence * 100))}%`,
                    }}
                  />
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-600 hover:text-slate-900">
                    ¿por qué?
                  </summary>
                  <div className="mt-1 text-slate-700 whitespace-pre-wrap border-l-2 border-slate-200 pl-2">
                    {tec.dossier.tono_reasoning}
                    {tec.dossier.gaps.length > 0 && (
                      <div className="mt-2">
                        <div className="text-slate-500 uppercase tracking-wide text-[10px] mb-0.5">
                          Vacíos detectados
                        </div>
                        <ul className="list-disc list-inside text-slate-600">
                          {tec.dossier.gaps.map((g, i) => (
                            <li key={i}>{g}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              </div>
            </div>
          )}

          {tec.dossier &&
            (tec.dossier.categorias.length > 0 ||
              tec.dossier.subcategorias.length > 0) && (
              <div className="text-sm text-slate-700 mt-2">
                {tec.dossier.categorias.length > 0 && (
                  <div>
                    <span className="text-slate-500">Categorías: </span>
                    {tec.dossier.categorias.join(", ")}
                  </div>
                )}
                {tec.dossier.subcategorias.length > 0 && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {tec.dossier.subcategorias.join(" · ")}
                  </div>
                )}
              </div>
            )}

          {!tec.has_cedula_doc && (
            <div className="mt-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 text-rose-800 border border-rose-300 px-2 py-0.5 text-xs font-semibold">
                ❌ Falta foto de la cédula
              </span>
              <span className="ml-2 text-[11px] text-rose-700">
                Sube el documento o agrega nota explicando la validación.
              </span>
            </div>
          )}

          {tec.dossier && tec.dossier.missing_optional.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {tec.dossier.missing_optional.map((key) => (
                <MissingOptionalBadge key={key} missingKey={key} />
              ))}
            </div>
          )}

          {tec.notes.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                Notas HR ({tec.notes.length})
              </div>
              <ul className="space-y-1">
                {tec.notes.map((n) => (
                  <li
                    key={n.id}
                    className="text-xs text-slate-700 bg-slate-50 rounded px-2 py-1"
                  >
                    <div className="text-[10px] text-slate-500">
                      {n.hr_user} · {n.created_at_human}
                    </div>
                    <div className="whitespace-pre-wrap">{n.body}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form action={appendHrNote} className="mt-3 flex gap-2">
            <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
            <input
              type="text"
              name="body"
              placeholder="Agregar nota..."
              className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
              maxLength={2000}
              required
            />
            <button
              type="submit"
              className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 rounded px-2 py-1"
            >
              Agregar
            </button>
          </form>
        </div>

        <div className="flex flex-col gap-2 shrink-0 w-44">
          <label
            className="text-[10px] uppercase tracking-wide text-slate-500"
            title="Especialmente útil cuando discrepas con la recomendación de Toño."
            htmlFor={`hr_reasoning_${tec.tecnico_id}`}
          >
            Notas de decisión (opcional)
          </label>
          <textarea
            id={`hr_reasoning_${tec.tecnico_id}`}
            name="hr_reasoning"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            placeholder="Especialmente útil cuando discrepas con Toño."
            className="text-xs border border-slate-200 rounded px-2 py-1 resize-none"
            rows={2}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => decide("approve")}
            className="w-full text-xs bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md px-3 py-1"
          >
            {pending ? "Procesando…" : "Aprobar"}
          </button>
          {tec.candidate_state === "pending" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => decide("schedule_call")}
              className="w-full text-xs bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md px-3 py-1"
            >
              Pedir llamada
            </button>
          )}
          {tec.candidate_state === "needs_call" && (
            <button
              type="button"
              disabled={pending}
              onClick={() => decide("unschedule_call")}
              className="w-full text-xs bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 rounded-md px-3 py-1"
            >
              Quitar llamada
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => decide("reject")}
            className="w-full text-xs border border-slate-300 hover:bg-slate-50 disabled:opacity-50 text-slate-700 rounded-md px-3 py-1"
          >
            Rechazar
          </button>
          {error && (
            <div className="rounded bg-rose-50 border border-rose-200 px-2 py-1 text-[11px] text-rose-900">
              {error}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
