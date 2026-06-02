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
import { BOLIVAR_NATIONAL_EXPANSION, TONO_LIVE } from "@/lib/timeline";
import type { MonthlyKpi } from "@/lib/kpi-queries";

interface Props {
  data: MonthlyKpi[];
}

const BOLIVAR_MONTH = BOLIVAR_NATIONAL_EXPANSION.slice(0, 7);
const TONO_MONTH = TONO_LIVE.slice(0, 7);

export default function VolumeGeoClient({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 12 }}>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 11, fill: "#64748b" }}
          width={44}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fontSize: 11, fill: "#a16207" }}
          width={44}
        />
        <Tooltip contentStyle={{ borderRadius: 8, borderColor: "#cbd5e1", fontSize: 12 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="right" dataKey="distinct_cities" name="Ciudades" fill="#fde68a" />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="ots_created"
          name="OTs creadas"
          stroke="#0ea5e9"
          strokeWidth={2}
        />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="ots_facturado"
          name="OTs facturadas"
          stroke="#059669"
          strokeWidth={2}
        />
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="ots_cancelled"
          name="OTs canceladas"
          stroke="#dc2626"
          strokeWidth={2}
          strokeDasharray="3 3"
        />
        <ReferenceLine
          yAxisId="left"
          x={BOLIVAR_MONTH}
          stroke="#a16207"
          strokeWidth={2}
          strokeDasharray="2 2"
          label={{
            value: "Bolívar expansión nacional · 7 may",
            position: "top",
            fill: "#a16207",
            fontSize: 10,
            fontWeight: 600,
          }}
        />
        <ReferenceLine
          yAxisId="left"
          x={TONO_MONTH}
          stroke="#dc2626"
          strokeWidth={2}
          strokeDasharray="2 2"
          label={{
            value: "Toño live · 29 may",
            position: "insideTopRight",
            fill: "#dc2626",
            fontSize: 10,
            fontWeight: 600,
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
