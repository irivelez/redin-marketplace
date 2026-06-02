"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { IntegrityMonthly } from "@/lib/kpi-queries";

interface Props {
  data: IntegrityMonthly[];
}

export default function IntegrityCardClient({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#64748b" }} />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 10, fill: "#64748b" }}
          tickFormatter={(v) => `${Math.round(v)}%`}
          width={42}
        />
        <Tooltip
          formatter={(v: number) => `${v?.toFixed(1) ?? "—"}%`}
          contentStyle={{ borderRadius: 8, borderColor: "#cbd5e1", fontSize: 12 }}
        />
        <Line
          type="monotone"
          dataKey="completeness_pct"
          name="Integridad"
          stroke="#0ea5e9"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
