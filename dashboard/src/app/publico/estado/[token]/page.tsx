import { notFound } from "next/navigation";
import {
  getCarteraAging,
  getClientPnl,
  getDataAsOf,
  getHeroPnl,
  getIntegrityLifetime,
  getIntegrityMonthly,
  getMonthly,
  getPerdida,
  getPerdidaSummary,
} from "@/lib/kpi-queries";
import { verifyEstadoToken } from "@/lib/estado-token";
import { formatCOT } from "@/lib/timeline";
import HeroPnLCard from "./components/HeroPnLCard";
import MonthlyTrendChart from "./components/MonthlyTrendChart";
import ClientPnLTable from "./components/ClientPnLTable";
import CarteraHealth from "./components/CarteraHealth";
import VolumeGeo from "./components/VolumeGeo";
import IntegrityCard from "./components/IntegrityCard";
import PerdidaSummary from "./components/PerdidaSummary";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

interface PageProps {
  params: { token: string };
}

export default async function EstadoPage({ params }: PageProps) {
  const id = verifyEstadoToken(params.token);
  if (!id) notFound();

  const [
    hero,
    monthly,
    clientPnl,
    perdida,
    perdidaSummary,
    cartera,
    integrityMonthly,
    integrityLifetime,
    dataAsOf,
  ] = await Promise.all([
    getHeroPnl(),
    getMonthly(),
    getClientPnl(),
    getPerdida(),
    getPerdidaSummary(),
    getCarteraAging(),
    getIntegrityMonthly(),
    getIntegrityLifetime(),
    getDataAsOf(),
  ]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <header className="space-y-2">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold text-slate-900">Estado financiero · Redin</h1>
            <span className="text-xs uppercase tracking-wider text-slate-500 border border-slate-300 px-2 py-0.5 rounded">
              Referencia operacional
            </span>
          </div>
          <p className="text-sm text-slate-600 max-w-3xl">
            Reporte privado de la operación de Redin (subcontratista de mantenimiento B2B,
            Colombia) construido sobre AppSheet — el sistema operativo de la empresa desde enero
            2026. Toño, el agente del marketplace de Deltanova, entró en producción el 29 de mayo
            de 2026. Los meses pre/post-29-mayo en las gráficas permiten ver si la operación
            cambia.
          </p>
        </header>

        <HeroPnLCard hero={hero} />
        <MonthlyTrendChart data={monthly} />
        <ClientPnLTable rows={clientPnl} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <CarteraHealth rows={cartera} />
          <IntegrityCard lifetime={integrityLifetime} monthly={integrityMonthly} />
        </div>

        <VolumeGeo data={monthly} />
        <PerdidaSummary summary={perdidaSummary} rows={perdida} />

        <footer className="mt-8 pt-6 border-t border-slate-200 text-xs text-slate-500 space-y-1">
          <div>
            Datos al {formatCOT(dataAsOf.ts)} (hora Colombia) · n={dataAsOf.n} OTs · refresh
            diario 23:59 COT.
          </div>
          <div>
            Fuente única: AppSheet &quot;Active&quot; (sistema operacional de Redin). URL no
            listada — comparte solo con quien necesita ver esto.
          </div>
        </footer>
      </div>
    </div>
  );
}
