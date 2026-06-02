import { formatCOP, formatPercent, formatInt } from "@/lib/format-cop";
import type { ClientPnl } from "@/lib/kpi-queries";

interface Props {
  rows: ClientPnl[];
}

export default function ClientPnLTable({ rows }: Props) {
  const losingClients = rows.filter((r) => r.profit < 0);

  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          P&amp;L por cliente · lifetime
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Rentabilidad por cliente desde enero 2026. {losingClients.length > 0 ? (
            <span className="text-red-700 font-medium">
              Atención: {losingClients.length} cliente{losingClients.length > 1 ? "s" : ""}{" "}
              operando con pérdida.
            </span>
          ) : (
            <span>Todos los clientes operan con margen positivo.</span>
          )}
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Cliente</th>
              <th className="px-4 py-2.5 text-right font-medium">OTs</th>
              <th className="px-4 py-2.5 text-right font-medium">Facturado</th>
              <th className="px-4 py-2.5 text-right font-medium">Costo</th>
              <th className="px-4 py-2.5 text-right font-medium">Utilidad</th>
              <th className="px-4 py-2.5 text-right font-medium">Margen</th>
              <th className="px-4 py-2.5 text-right font-medium">% facturación</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const losing = r.profit < 0;
              const rowClass = losing
                ? "bg-red-50 hover:bg-red-100"
                : "hover:bg-slate-50";
              const profitClass = losing
                ? "text-red-700 font-semibold"
                : "text-slate-900 tabular-nums";
              return (
                <tr key={r.cliente} className={rowClass}>
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    {losing && (
                      <span className="text-red-700 font-bold mr-2" aria-label="advertencia">
                        ⚠
                      </span>
                    )}
                    {r.cliente}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                    {formatInt(r.ot_count)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-900">
                    {formatCOP(r.revenue_billed)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                    {formatCOP(r.cost)}
                  </td>
                  <td className={`px-4 py-2.5 text-right ${profitClass}`}>{formatCOP(r.profit)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                    {formatPercent(r.margin_pct)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                    {formatPercent(r.pct_of_total_revenue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Fuente: ots_mirror agrupado por ID_Cliente · costo = Total_Ejecutado_Real (rollup
        AppSheet). Las líneas APROBADO en Costos_Ejecucion son incompletas por cliente; usar
        rollup hace visible la pérdida en clientes con costos no desglosados.
      </footer>
    </section>
  );
}
