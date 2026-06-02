// Anchor dates for the Redin financial reference dashboard.
//
// These are the only timeline markers the dashboard renders. Every chart
// that touches time uses them — both as ReferenceLine x-values and as
// annotation copy. Edit here, propagates everywhere.

export const APPSHEET_LIVE = "2026-01-01"; // First month of AppSheet operation
export const TONO_LIVE = "2026-05-29"; // Toño marketplace agent went live
export const BOLIVAR_NATIONAL_EXPANSION = "2026-05-07"; // 341 OTs in 1 day, 175 cities

export const COT_TZ = "America/Bogota"; // Colombia is UTC-5 year-round

// Returns YYYY-MM-DD for today in Colombia local time.
export function todayCOT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Render an ISO/SQL timestamp as a Colombia-local string for footers.
export function formatCOT(
  iso: string | Date,
  opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  },
): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", { ...opts, timeZone: COT_TZ }).format(date);
}
