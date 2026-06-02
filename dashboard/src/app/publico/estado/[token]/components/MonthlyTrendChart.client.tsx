"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCOP, formatCOPCompact } from "@/lib/format-cop";
import { TONO_LIVE } from "@/lib/timeline";
import type { MonthlyKpi } from "@/lib/kpi-queries";

interface Props {
  data: MonthlyKpi[];
}

const TONO_MONTH = TONO_LIVE.slice(0, 7);

export default function MonthlyTrendChartClient({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={360}>
      <ComposedChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 12 }}>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
        <YAxis
          tick={{ fontSize: 11, fill: "#64748b" }}
          tickFormatter={(v: number) => formatCOPCompact(v)}
          width={88}
        />
        <Tooltip
          formatter={(v: number) => formatCOP(v)}
          labelStyle={{ color: "#0f172a", fontWeight: 600 }}
          contentStyle={{ borderRadius: 8, borderColor: "#cbd5e1", fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="revenue_billed" name="Facturado" fill="#0ea5e9" />
        <Bar dataKey="cost_lineitem_aprobado" name="Costo (líneas)" fill="#fb923c" />
        <Line
          type="monotone"
          dataKey="revenue_collected"
          name="Cobrado"
          stroke="#059669"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
        <Line
          type="monotone"
          dataKey="profit_conservative"
          name="Utilidad"
          stroke="#7c3aed"
          strokeWidth={2}
          strokeDasharray="4 4"
          dot={{ r: 3 }}
        />
        <ReferenceLine
          x={TONO_MONTH}
          stroke="#dc2626"
          strokeWidth={2}
          strokeDasharray="2 2"
          label={{
            value: "Toño live · 29 may 2026",
            position: "top",
            fill: "#dc2626",
            fontSize: 11,
            fontWeight: 600,
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
