"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCOP, formatInt } from "@/lib/format-cop";

interface BucketRow {
  bucket: string;
  ots: number;
  amount: number;
  clientes: number;
}

interface Props {
  data: BucketRow[];
}

const BUCKET_COLORS: Record<string, string> = {
  "0-30": "#10b981",
  "30-60": "#facc15",
  "60-90": "#f97316",
  "90+": "#dc2626",
};

export default function CarteraHealthClient({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 12 }}>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
        <XAxis dataKey="bucket" tick={{ fontSize: 12, fill: "#475569" }} />
        <YAxis
          yAxisId="left"
          orientation="left"
          tick={{ fontSize: 11, fill: "#64748b" }}
          tickFormatter={(v: number) => formatInt(v)}
          width={56}
        />
        <Tooltip
          formatter={(value: number, name: string) =>
            name === "amount" ? formatCOP(value) : formatInt(value)
          }
          contentStyle={{ borderRadius: 8, borderColor: "#cbd5e1", fontSize: 12 }}
        />
        <Bar yAxisId="left" dataKey="ots" name="OTs">
          {data.map((d) => (
            <Cell key={d.bucket} fill={BUCKET_COLORS[d.bucket] ?? "#64748b"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
