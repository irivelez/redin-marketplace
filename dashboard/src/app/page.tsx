// Public landing — live list of pending OTs (client identity redacted).
// Acquisition hook + social proof. Server-rendered so SEO and share cards work.

import { serviceClient } from "@/lib/supabase-server";
import { redactForPublic } from "@/lib/redact";
import { buildWaLink } from "@/lib/wa-link";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 30;

interface OtRow {
  row_id: string;
  ciudad: string | null;
  especialidad: string | null;
  estado: string | null;
  data: unknown;
}

// Only OTs in this state are "offerable" to a maestro de obra. Earlier
// states aren't ready for a worker to take; later states are already in
// motion or closed. The state literal must match AppSheet exactly
// (em-dash, leading "4." prefix).
const OFFERABLE_ESTADO = "4. Coordinar – Listo para ejecutar";

function descripcionFrom(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

// 2026-05-28: source switched Valor_Estimado → Total_Orden_Calculado per HR.
// Returns null when TOC is 0 or missing — caller omits the price entirely.
function valorLabelFrom(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as Record<string, unknown>).Total_Orden_Calculado;
  if (typeof raw !== "string") return null;
  const num = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return null;
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(num);
}

// Pulls Fecha_Programada from the AppSheet OT row and returns dd/mm/yyyy.
// Tolerates ISO ("2026-05-12") and US ("5/12/2026") formats — both come out
// of AppSheet depending on column type.
function fechaProgramadaLabelFrom(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as Record<string, unknown>).Fecha_Programada;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default async function Home() {
  const supa = serviceClient();
  const { data, error } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("estado", OFFERABLE_ESTADO)
    .order("synced_at", { ascending: false })
    .limit(100);

  const pending: OtRow[] = data ?? [];
  const loadError = error?.message;

  return (
    <div className="space-y-8">
      <section className="card p-6">
        <h1 className="text-2xl font-semibold text-slate-900">
          Trabajo de mantenimiento, directo con Redin.
        </h1>
        <p className="mt-2 text-slate-600 max-w-2xl">
          Conectamos técnicos (electricistas, plomeros, pintores, albañiles) con
          solicitudes reales de mantenimiento. Trabajamos para clientes
          empresariales grandes en toda Colombia. Si eres técnico y quieres que
          Toño te avise cuando entre algo en tu ciudad, empieza por WhatsApp.
        </p>
        <div className="mt-4 flex gap-3">
          <a
            href={buildWaLink({
              text: "Hola Toño, soy técnico y quiero que me avises cuando haya trabajo.",
            })}
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-md px-4 py-2 transition"
            target="_blank"
            rel="noreferrer"
          >
            Quiero trabajar (WhatsApp)
          </a>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 border border-slate-300 hover:bg-slate-100 text-slate-700 font-medium rounded-md px-4 py-2 transition"
          >
            Ya tengo cuenta
          </Link>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Trabajos abiertos ahora ({pending.length})
        </h2>
        {loadError && (
          <div className="card p-4 text-red-700 text-sm">
            No pude cargar los trabajos: {loadError}
          </div>
        )}
        {!loadError && pending.length === 0 && (
          <div className="card p-4 text-slate-600 text-sm">
            Ahora mismo no hay solicitudes abiertas. Déjanos tu WhatsApp y te
            avisamos apenas entre algo en tu ciudad.
          </div>
        )}
        <ul className="grid sm:grid-cols-2 gap-3">
          {pending.map((ot) => {
            const valorLabel = valorLabelFrom(ot.data);
            const fechaLabel = fechaProgramadaLabelFrom(ot.data);
            return (
            <li key={ot.row_id} className="card p-4 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm text-slate-500">
                    {ot.ciudad ?? "Colombia"} ·{" "}
                    {ot.especialidad ?? "mantenimiento"}
                  </div>
                  <div className="font-medium text-slate-900 mt-0.5">
                    {(ot.estado ?? "Abierta").replace(/^[\d. ]+/, "")}
                  </div>
                </div>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {redactForPublic(descripcionFrom(ot.data))}
              </p>
              {(valorLabel || fechaLabel) && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                  {valorLabel && (
                    <span>
                      <span className="text-slate-500">Presupuesto:</span>{" "}
                      <span className="font-medium text-slate-900">{valorLabel}</span>
                    </span>
                  )}
                  {fechaLabel && (
                    <span>
                      <span className="text-slate-500">Inicia:</span>{" "}
                      <span className="font-medium text-slate-900">{fechaLabel}</span>
                    </span>
                  )}
                </div>
              )}
              <div className="mt-4">
                <Link
                  href={`/aplicar/${encodeURIComponent(ot.row_id)}`}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                >
                  Aplicar a este trabajo →
                </Link>
              </div>
            </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
