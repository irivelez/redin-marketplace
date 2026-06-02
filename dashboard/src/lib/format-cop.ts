// Money + number formatters for Colombian Pesos (COP) display.
//
// Reused across every panel in the Redin financial-reference dashboard.
// All Spanish-locale, no fraction digits (COP is whole-peso by convention).

const COP_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const ES_CO_NUMBER = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 0,
});

function compactScaled(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000_000) {
    const scaled = value / 1_000_000_000;
    const digits = abs >= 10_000_000_000 ? 1 : 2;
    return `${sign}$${Math.abs(scaled).toLocaleString("es-CO", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} mil M`;
  }
  if (abs >= 1_000_000) {
    const scaled = value / 1_000_000;
    const digits = abs >= 100_000_000 ? 0 : abs >= 10_000_000 ? 1 : 1;
    return `${sign}$${Math.abs(scaled).toLocaleString("es-CO", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} M`;
  }
  if (abs >= 1_000) {
    const scaled = value / 1_000;
    return `${sign}$${Math.abs(scaled).toLocaleString("es-CO", { maximumFractionDigits: 0 })} K`;
  }
  return `${sign}$${ES_CO_NUMBER.format(Math.abs(value))}`;
}

const PCT_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "percent",
  maximumFractionDigits: 1,
});

const INT_FORMATTER = new Intl.NumberFormat("es-CO");

export function formatCOP(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return COP_FORMATTER.format(value);
}

// Compact form for chart-axis ticks and dense hero cells.
// Native Intl es-CO compact stops at "millones" (so $1.86B renders "1.866 M"),
// which is technically correct but reads as a huge unscaled number. We hand-
// roll the scale so big totals show as "mil M" (Colombian for "billions") and
// mid-range numbers show as "M" — what a Colombian CFO actually says out loud.
export function formatCOPCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return compactScaled(value);
}

// Pass 0.052 → "5,2%". Pass 5.2 if you want it scaled, then divide by 100.
export function formatPercent(value: number | null | undefined, asFraction = false): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return PCT_FORMATTER.format(asFraction ? value : value / 100);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return INT_FORMATTER.format(value);
}

// Signed delta — useful for MTD-vs-prior cards. Adds "+" prefix on positive.
export function formatCOPDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const formatted = formatCOP(Math.abs(value));
  if (value > 0) return "+" + formatted;
  if (value < 0) return "−" + formatted;
  return formatted;
}
