import dynamic from "next/dynamic";
import type { MonthlyKpi } from "@/lib/kpi-queries";

const Chart = dynamic(() => import("./VolumeGeo.client"), {
  ssr: false,
  loading: () => (
    <div className="h-[300px] flex items-center justify-center text-sm text-slate-400">
      Cargando…
    </div>
  ),
});

interface Props {
  data: MonthlyKpi[];
}

export default function VolumeGeo({ data }: Props) {
  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Volumen de OTs y huella geográfica
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          OTs creadas, facturadas y canceladas por mes (eje izquierdo). Ciudades únicas servidas
          por mes (eje derecho, barras). La expansión nacional de Bolívar el 7 de mayo agregó 341
          OTs en un día sobre 175 ciudades.
        </p>
      </header>
      <div className="px-3 py-4">
        <Chart data={data} />
      </div>
      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Fuente: ots_mirror agrupado por mes de Fecha_Creacion / Fecha_Facturacion / TS_Cancelacion
        respectivamente. Ciudades = COUNT DISTINCT ciudad por mes de creación.
      </footer>
    </section>
  );
}
