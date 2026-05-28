// OT and tecnico display helpers — extract a human title from an ots_mirror
// row's free-form `data` JSON, and a "nombre · ciudad" line for tecnicos.
// Keeps UUID render-fallbacks out of the page templates.
//
// Used by: hr/pipeline, hr/shortlist, hr/contratos, hr/tecnicos detail.

const OT_DESC_KEYS = [
  "Descripcion",
  "descripcion",
  "Resumen Visual",
  "Actividad_Descripcion",
] as const;

export function otDescripcion(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of OT_DESC_KEYS) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

// "Cleaning de fachada 2026" if the OT carries a description, otherwise
// "Trabajo en Valledupar" if we know the city, otherwise just "Trabajo sin
// título". Never returns the OT row_id — that's a system identifier, not a
// human label. The row_id should appear only as small monospace metadata
// next to the title, never as the primary heading.
export function otTitle(ot: {
  ciudad: string | null;
  data: unknown;
} | null | undefined): string {
  if (!ot) return "Trabajo sin título";
  const desc = otDescripcion(ot.data);
  if (desc) return desc;
  if (ot.ciudad) return `Trabajo en ${ot.ciudad}`;
  return "Trabajo sin título";
}

// "Manuel · Valledupar" if both, "Manuel" if only nombre, "(sin nombre)" if
// nothing. Never returns a UUID slice.
export function tecnicoLabel(args: {
  nombre: string | null | undefined;
  ciudad: string | null | undefined;
}): string {
  const nombre = args.nombre?.trim() || null;
  const ciudad = args.ciudad?.trim() || null;
  if (nombre && ciudad) return `${nombre} · ${ciudad}`;
  if (nombre) return nombre;
  return "(sin nombre)";
}

// Parses Valor_Estimado from an ots_mirror.data blob. Returns { num, label }
// where label is COP-formatted ("$658.192") or null when the field is
// missing/non-numeric. Used by HR-internal pages (pipeline, técnicos,
// shortlist, contratos) — the initial estimate is the right context there.
// Worker-facing surfaces should use otTotalOrdenCalculado instead.
export function otValorEstimado(data: unknown): {
  num: number | null;
  label: string | null;
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { num: null, label: null };
  }
  const raw = (data as Record<string, unknown>).Valor_Estimado;
  if (typeof raw !== "string") return { num: null, label: null };
  const num = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return { num: null, label: null };
  const label = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(num);
  return { num, label };
}

// 2026-05-28: worker-facing valor — reads Total_Orden_Calculado (post-cotización
// final amount), not Valor_Estimado. Per HR: workers should see the truthful
// calculated total when known. Returns null when TOC is missing or 0 so the
// caller can OMIT the price entirely (no "$0", no "por confirmar" — just
// silence). Used by decisions.ts approval push and read_pending_ots (Toño).
export function otTotalOrdenCalculado(data: unknown): {
  num: number | null;
  label: string | null;
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { num: null, label: null };
  }
  const raw = (data as Record<string, unknown>).Total_Orden_Calculado;
  if (typeof raw !== "string") return { num: null, label: null };
  const num = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return { num: null, label: null };
  const label = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(num);
  return { num, label };
}
