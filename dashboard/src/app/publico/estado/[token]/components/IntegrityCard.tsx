import dynamic from "next/dynamic";
import { formatCOP, formatInt, formatPercent } from "@/lib/format-cop";
import type { IntegrityLifetime, IntegrityMonthly } from "@/lib/kpi-queries";

const Chart = dynamic(() => import("./IntegrityCard.client"), {
  ssr: false,
  loading: () => (
    <div className="h-[160px] flex items-center justify-center text-sm text-slate-400">
      Cargando…
    </div>
  ),
});

interface Props {
  lifetime: IntegrityLifetime;
  monthly: IntegrityMonthly[];
}

export default function IntegrityCard({ lifetime, monthly }: Props) {
  const completeness = lifetime.completeness_pct ?? 0;
  const tone = completeness >= 90 ? "positive" : completeness >= 80 ? "warning" : "negative";
  const toneClass =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "warning"
        ? "text-amber-700"
        : "text-red-700";

  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Integridad de costos
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Proporción de OTs donde el rollup de costo en AppSheet coincide con la suma de líneas
          APROBADO en Costos_Ejecucion (tolerancia ±$100 COP). La brecha es costo aprobado pero
          sin desglosar — riesgo de margen oculto.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        <div className="px-6 py-5 flex flex-col gap-1">
          <div className="text-xs uppercase tracking-wide text-slate-500">Completitud</div>
          <div className={`text-3xl font-semibold tabular-nums ${toneClass}`}>
            {formatPercent(completeness)}
          </div>
          <div className="text-xs text-slate-500">
            {formatInt(lifetime.ots_reconciled)} de {formatInt(lifetime.ots_total)} OTs
            conciliadas
          </div>
        </div>

        <div className="px-6 py-5 flex flex-col gap-1">
          <div className="text-xs uppercase tracking-wide text-slate-500">OTs con discrepancia</div>
          <div className="text-3xl font-semibold tabular-nums text-amber-700">
            {formatInt(lifetime.ots_discrepant)}
          </div>
          <div className="text-xs text-slate-500">
            Sesgo neto AppSheet:{" "}
            <span className="text-slate-700">{formatCOP(lifetime.net_appsheet_bias)}</span>
          </div>
        </div>

        <div className="px-3 py-4">
          <Chart data={monthly} />
        </div>
      </div>

      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Fuente: ots_mirror.data-&gt;&gt;Total_Ejecutado_Real comparado con SUM Costos_Ejecucion.
        Valor_Gasto WHERE ESTADO=APROBADO, agrupado por ID_Orden.
      </footer>
    </section>
  );
}
