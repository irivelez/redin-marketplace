import { formatCOP, formatInt } from "@/lib/format-cop";
import type { PerdidaRow, PerdidaSummary } from "@/lib/kpi-queries";

interface Props {
  summary: PerdidaSummary;
  rows: PerdidaRow[];
}

function topN<K extends string | number | null>(
  rows: PerdidaRow[],
  pick: (r: PerdidaRow) => K,
  n: number,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = pick(r);
    if (k === null || k === undefined || k === "") continue;
    const key = String(k);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

const REASON_LABEL: Record<string, string> = {
  duplicate_renumbered: "Duplicado renumerado",
  duplicate: "Duplicado",
  client_cancelled: "Cliente canceló",
  client_rejected: "Cliente rechazó",
  client_never_approved: "Sin aprobación",
  warranty_followup: "Garantía",
  no_contractor: "Sin contratista",
  no_description: "Sin descripción",
  other: "Otro",
};

interface BarRowProps {
  label: string;
  count: number;
  total: number;
}

function BarRow({ label, count, total }: BarRowProps) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-40 shrink-0 text-slate-700 truncate" title={label}>
        {label}
      </div>
      <div className="flex-1 bg-slate-100 rounded h-5 relative overflow-hidden">
        <div
          className="bg-slate-500 h-full"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <div className="w-10 text-right tabular-nums text-slate-700">{formatInt(count)}</div>
    </div>
  );
}

export default function PerdidaSummary({ summary, rows }: Props) {
  const totalForBars = summary.total;
  const reasons = topN(rows, (r) => r.reason_guess, 7);
  const cities = topN(rows, (r) => r.ciudad, 7);
  const clients = topN(rows, (r) => r.cliente, 7);

  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          OTs perdidas o canceladas
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Solo {formatInt(summary.real_lost_count)} de {formatInt(summary.total)} OTs en estado
          &quot;Perdida / Cancelada&quot; son oportunidades realmente perdidas; el resto son
          cierres administrativos (duplicados renumerados con el patrón &quot;PASA A LA ORDEN
          N_X&quot;). El valor estimado de las oportunidades realmente perdidas es{" "}
          <span className="text-slate-700 font-medium">
            {formatCOP(summary.real_lost_value_estimated)}
          </span>
          .
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        <div className="px-6 py-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Total</div>
          <div className="text-2xl font-semibold tabular-nums">{formatInt(summary.total)}</div>
        </div>
        <div className="px-6 py-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Oportunidad real</div>
          <div className="text-2xl font-semibold tabular-nums text-red-700">
            {formatInt(summary.real_lost_count)}
          </div>
        </div>
        <div className="px-6 py-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Cierre admin.</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-700">
            {formatInt(summary.admin_close_count)}
          </div>
        </div>
        <div className="px-6 py-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Cobrado admin.</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-700">
            {formatCOP(summary.admin_close_value_billed)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100 border-t border-slate-100">
        <div className="px-6 py-4 flex flex-col gap-2">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Razón (estimada)</div>
          {reasons.map((r) => (
            <BarRow
              key={r.key}
              label={REASON_LABEL[r.key] ?? r.key}
              count={r.count}
              total={totalForBars}
            />
          ))}
        </div>
        <div className="px-6 py-4 flex flex-col gap-2">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Ciudades</div>
          {cities.map((c) => (
            <BarRow key={c.key} label={c.key} count={c.count} total={totalForBars} />
          ))}
        </div>
        <div className="px-6 py-4 flex flex-col gap-2">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Clientes</div>
          {clients.map((c) => (
            <BarRow key={c.key} label={c.key} count={c.count} total={totalForBars} />
          ))}
        </div>
      </div>

      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Fuente: ots_mirror donde estado=&quot;99. Perdida / Cancelada&quot;. Categoría
        real_lost/admin_close: Valor_Facturado_Real=0 vs &gt;0. Razón inferida por palabras clave
        en Descripcion — sin campo estructurado de motivo de cancelación en AppSheet.
      </footer>
    </section>
  );
}
