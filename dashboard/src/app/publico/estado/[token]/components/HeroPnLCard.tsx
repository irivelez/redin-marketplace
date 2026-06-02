import { formatCOP, formatCOPCompact, formatPercent } from "@/lib/format-cop";
import type { HeroPnl } from "@/lib/kpi-queries";

interface Props {
  hero: HeroPnl;
}

interface CellProps {
  label: string;
  displayValue: string;
  fullValue?: string;
  mtdDisplay?: string | null;
  mtdFull?: string | null;
  tone?: "neutral" | "positive" | "negative" | "warning";
  source: string;
}

function Cell({ label, displayValue, fullValue, mtdDisplay, mtdFull, tone = "neutral", source }: CellProps) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
        ? "text-red-700"
        : tone === "warning"
          ? "text-amber-700"
          : "text-slate-900";
  return (
    <div className="flex flex-col gap-1 px-5 py-5 border-r border-slate-200 last:border-r-0 min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 leading-tight min-h-[28px]">
        {label}
      </div>
      <div
        className={`text-2xl font-semibold tabular-nums leading-tight ${toneClass}`}
        title={fullValue}
      >
        {displayValue}
      </div>
      {mtdDisplay && (
        <div className="text-xs text-slate-500 tabular-nums" title={mtdFull ?? undefined}>
          MTD: <span className="text-slate-700">{mtdDisplay}</span>
        </div>
      )}
      <div className="text-[10px] text-slate-400 mt-1 leading-tight">{source}</div>
    </div>
  );
}

function signedCompact(n: number): string {
  if (!n) return formatCOPCompact(0);
  const abs = formatCOPCompact(Math.abs(n));
  return n > 0 ? "+" + abs : "−" + abs;
}

function signedFull(n: number): string {
  if (!n) return formatCOP(0);
  const abs = formatCOP(Math.abs(n));
  return n > 0 ? "+" + abs : "−" + abs;
}

export default function HeroPnLCard({ hero }: Props) {
  const conservativeMargin = hero.margin_pct_conservative;
  const profitTone =
    hero.profit_conservative_lifetime > 0
      ? "positive"
      : hero.profit_conservative_lifetime < 0
        ? "negative"
        : "neutral";

  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
          Estado financiero · Redin
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          P&amp;L completo desde que AppSheet entró en operación (enero 2026). Todas las cifras en
          COP. Costo = suma conservadora de líneas APROBADO en Costos_Ejecucion; rentabilidad
          calculada sobre esa base.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 divide-y md:divide-y-0">
        <Cell
          label="Facturado"
          displayValue={formatCOPCompact(hero.revenue_billed_lifetime)}
          fullValue={formatCOP(hero.revenue_billed_lifetime)}
          mtdDisplay={signedCompact(hero.revenue_billed_mtd)}
          mtdFull={signedFull(hero.revenue_billed_mtd)}
          source="Valor_Facturado_Real"
        />
        <Cell
          label="Cobrado"
          displayValue={formatCOPCompact(hero.revenue_collected_lifetime)}
          fullValue={formatCOP(hero.revenue_collected_lifetime)}
          mtdDisplay={signedCompact(hero.revenue_collected_mtd)}
          mtdFull={signedFull(hero.revenue_collected_mtd)}
          source="por Fecha_Pago_Real"
        />
        <Cell
          label="Costo (líneas)"
          displayValue={formatCOPCompact(hero.cost_lineitem_aprobado_lifetime)}
          fullValue={formatCOP(hero.cost_lineitem_aprobado_lifetime)}
          source="Costos_Ejecucion APROBADO"
        />
        <Cell
          label="Utilidad bruta"
          displayValue={formatCOPCompact(hero.profit_conservative_lifetime)}
          fullValue={formatCOP(hero.profit_conservative_lifetime)}
          tone={profitTone}
          source="Facturado − Costo"
        />
        <Cell
          label="Margen"
          displayValue={formatPercent(conservativeMargin)}
          fullValue={formatPercent(conservativeMargin)}
          tone={conservativeMargin && conservativeMargin > 30 ? "positive" : "warning"}
          source="Utilidad / Facturado"
        />
        <Cell
          label="Cartera"
          displayValue={formatCOPCompact(hero.outstanding_cartera)}
          fullValue={formatCOP(hero.outstanding_cartera)}
          mtdDisplay={`${hero.outstanding_count} OTs`}
          tone="warning"
          source="Estado = Facturado"
        />
      </div>

      <footer className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-500">
        Cifras lifetime sobre {hero.ots_total} OTs en AppSheet. El costo &quot;rollup&quot; de
        AppSheet (Total_Ejecutado_Real) reporta {formatCOP(hero.cost_appsheet_rollup_lifetime)} —
        ~{formatCOP(hero.cost_appsheet_rollup_lifetime - hero.cost_lineitem_aprobado_lifetime)} por
        encima del conservador, lo que apunta a gastos aprobados pero sin desglosar en líneas
        (ver Panel 6 — Integridad).
      </footer>
    </section>
  );
}
