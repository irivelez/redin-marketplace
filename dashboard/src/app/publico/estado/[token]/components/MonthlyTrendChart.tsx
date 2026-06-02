import dynamic from "next/dynamic";
import type { MonthlyKpi } from "@/lib/kpi-queries";

const Chart = dynamic(() => import("./MonthlyTrendChart.client"), {
  ssr: false,
  loading: () => (
    <div className="h-[360px] flex items-center justify-center text-sm text-slate-400">
      Cargando gráfica…
    </div>
  ),
});

interface Props {
  data: MonthlyKpi[];
}

export default function MonthlyTrendChart({ data }: Props) {
  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Tendencia mensual
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Facturado y cobrado por mes contra costo en líneas y utilidad. La marca vertical roja es
          la fecha de salida en producción de Toño (29 may 2026) — los meses posteriores son los
          que importan para evaluar impacto.
        </p>
      </header>
      <div className="px-3 py-4">
        <Chart data={data} />
      </div>
      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Fuente: Valor_Facturado_Real × Fecha_Facturacion · Fecha_Pago_Real ·
        Costos_Ejecucion.Valor_Gasto APROBADO × Fecha_Gasto.
      </footer>
    </section>
  );
}
