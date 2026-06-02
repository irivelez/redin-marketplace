import dynamic from "next/dynamic";
import { formatCOP, formatInt } from "@/lib/format-cop";
import type { CarteraRow } from "@/lib/kpi-queries";

const Chart = dynamic(() => import("./CarteraHealth.client"), {
  ssr: false,
  loading: () => (
    <div className="h-[260px] flex items-center justify-center text-sm text-slate-400">
      Cargando…
    </div>
  ),
});

interface Props {
  rows: CarteraRow[];
}

const BUCKET_ORDER = ["0-30", "30-60", "60-90", "90+"] as const;

export default function CarteraHealth({ rows }: Props) {
  const byBucket = new Map<string, { ots: number; amount: number; clientes: Set<string> }>();
  for (const b of BUCKET_ORDER) byBucket.set(b, { ots: 0, amount: 0, clientes: new Set() });
  for (const r of rows) {
    const e = byBucket.get(r.aging_bucket);
    if (!e) continue;
    e.ots++;
    e.amount += r.valor_facturado_real;
    e.clientes.add(r.cliente);
  }
  const data = BUCKET_ORDER.map((b) => {
    const e = byBucket.get(b)!;
    return { bucket: b, ots: e.ots, amount: e.amount, clientes: e.clientes.size };
  });
  const total = rows.reduce((s, r) => s + r.valor_facturado_real, 0);
  const overdue = rows
    .filter((r) => r.days_outstanding > 60)
    .reduce((s, r) => s + r.valor_facturado_real, 0);
  const overduePct = total > 0 ? (overdue / total) * 100 : 0;

  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Cartera · cobranza pendiente
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          OTs facturadas sin pago confirmado, distribuidas por antigüedad. Industria sana: la
          mayoría debajo de 30 días. Rojo (90+) = riesgo de cobro.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        <div className="md:col-span-1 px-6 py-4 flex flex-col justify-center gap-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Total pendiente</div>
          <div className="text-2xl font-semibold text-slate-900 tabular-nums">
            {formatCOP(total)}
          </div>
          <div className="text-xs text-slate-500">{formatInt(rows.length)} OTs sin cobrar</div>
          <div className="mt-2 text-xs text-slate-500">
            <span className="text-red-700 font-semibold">{overduePct.toFixed(1)}%</span> vencido
            (más de 60 días)
          </div>
        </div>
        <div className="md:col-span-3 px-3 py-4">
          <Chart data={data} />
        </div>
      </div>

      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Fuente: ots_mirror donde Fecha_Facturacion existe y Fecha_Pago_Real es nulo · estado ≠
        Perdida. Days outstanding = current_date − Fecha_Facturacion.
      </footer>
    </section>
  );
}
