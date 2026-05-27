// HR qualification queue — workers with candidate_state in (pending, needs_call).
// Per docs/architecture/onboarding-contracts.md §3.5 (graduated autonomy):
//   1. Recommendation badge (green/red/amber)
//   2. Raw confidence (0.78, NOT bucketed)
//   3. "why?" expand revealing tono_reasoning + gaps
//   4. Deterministic sort: needs_call rows → pending+recommend_call FIFO
//      → pending+recommend_approve by confidence DESC → pending+recommend_reject
//      by confidence DESC
//   5. One-click decisions are still HR's: decided_by = hr:<email>, never
//      "[Toño-approved]" attribution.
//   6. HR can disagree with one click — agreed_with_tono captures divergence.
//   7. hr_reasoning textarea (optional, encouraged when diverging from Toño).
//
// Plus per §5.2: hr_notes thread per candidate, append-only, reverse-chronological.
//
// This page is the SERVER boundary: fetch, sort, summarize, build a plain
// QueueItem[]. The client component (QueueListClient) owns interaction state
// — visible-count, optimistic card removal on approve/reject (friction #6).

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import {
  QueueListClient,
  type QueueItem,
  type QueueDossier,
} from "./QueueListClient";
import type { CandidateState, TonoRecommendation } from "@redin/shared";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface RegisteredMeta {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
}

function parseRegisteredMeta(meta: unknown): RegisteredMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  const out: RegisteredMeta = {};
  if (typeof m.nombre === "string") out.nombre = m.nombre;
  if (typeof m.ciudad === "string") out.ciudad = m.ciudad;
  if (Array.isArray(m.especialidades)) {
    out.especialidades = m.especialidades.filter((x): x is string => typeof x === "string");
  }
  if (typeof m.modalidad === "string") out.modalidad = m.modalidad;
  return out;
}

interface DossierPayloadShape {
  ciudad_base?: unknown;
  categorias_principales?: unknown;
  subcategorias?: unknown;
  gaps?: unknown;
  missing_optional?: unknown;
}

function summarizeDossierPayload(payload: unknown): {
  ciudad_base: string | null;
  categorias: string[];
  subcategorias: string[];
  gaps: string[];
  missing_optional: string[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ciudad_base: null, categorias: [], subcategorias: [], gaps: [], missing_optional: [] };
  }
  const p = payload as DossierPayloadShape;
  const ciudad =
    typeof p.ciudad_base === "string" ? (p.ciudad_base as string) : null;
  const cats = Array.isArray(p.categorias_principales)
    ? (p.categorias_principales as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const subs = Array.isArray(p.subcategorias)
    ? (p.subcategorias as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const gaps = Array.isArray(p.gaps)
    ? (p.gaps as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  // Story 17: missing_optional was added later — may be absent on legacy dossiers.
  const missingOptional = Array.isArray(p.missing_optional)
    ? (p.missing_optional as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { ciudad_base: ciudad, categorias: cats, subcategorias: subs, gaps, missing_optional: missingOptional };
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("es-CO");
}

// Deterministic sort key per §3.5 #4. Lower tuple = higher in queue.
function sortKey(args: {
  candidate_state: CandidateState;
  onboarded_at: string;
  rec: TonoRecommendation | null;
  conf: number;
}): [number, number, number] {
  const { candidate_state, onboarded_at, rec, conf } = args;
  const ts = new Date(onboarded_at).getTime();
  if (candidate_state === "needs_call") return [0, ts, 0];
  if (rec === "recommend_call") return [1, ts, 0];
  if (rec === "recommend_approve") return [2, -conf, 0];
  if (rec === "recommend_reject") return [3, -conf, 0];
  return [4, ts, 0];
}

export default async function HrQualificationQueuePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();

  const { data: tecnicos } = await supa
    .from("tecnicos_extended")
    .select("*")
    .in("candidate_state", ["pending", "needs_call"])
    .limit(100);

  const ids = (tecnicos ?? []).map((t) => t.tecnico_id);

  // TODO(scale): two-query stitch is O(N+latest-dossier-per-N). Pilot scale
  // (~50 candidates) is fine; revisit with a Postgres view or RPC at >5k.
  const [regEventsRes, dossiersRes, notesRes, cedulaDocsRes] = ids.length
    ? await Promise.all([
        supa
          .from("eventos")
          .select("entity_id, meta, created_at")
          .eq("type", "tecnico_registered")
          .in("entity_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("candidate_dossiers")
          .select("*")
          .in("tecnico_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("hr_notes")
          .select("*")
          .in("tecnico_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("documentos")
          .select("tecnico_id")
          .eq("tipo", "cedula")
          .in("tecnico_id", ids),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const tecnicosWithCedula = new Set(
    (cedulaDocsRes.data ?? []).map((d) => d.tecnico_id as string)
  );

  const regByTec = new Map<string, RegisteredMeta>();
  for (const e of regEventsRes.data ?? []) {
    if (!e.entity_id || regByTec.has(e.entity_id)) continue;
    regByTec.set(e.entity_id, parseRegisteredMeta(e.meta));
  }

  const latestDossierByTec = new Map<string, QueueDossier>();
  for (const d of dossiersRes.data ?? []) {
    if (latestDossierByTec.has(d.tecnico_id)) continue;
    const sum = summarizeDossierPayload(d.payload);
    latestDossierByTec.set(d.tecnico_id, {
      id: d.id,
      tono_recommendation: d.tono_recommendation as TonoRecommendation,
      tono_confidence: Number(d.tono_confidence),
      tono_reasoning: d.tono_reasoning,
      cedula: d.cedula,
      ciudad_base: sum.ciudad_base,
      categorias: sum.categorias,
      subcategorias: sum.subcategorias,
      gaps: sum.gaps,
      missing_optional: sum.missing_optional,
    });
  }

  const notesByTec = new Map<string, QueueItem["notes"]>();
  for (const n of notesRes.data ?? []) {
    const arr = notesByTec.get(n.tecnico_id) ?? [];
    arr.push({
      id: n.id,
      hr_user: n.hr_user,
      body: n.body,
      created_at_human: fmtTime(n.created_at),
    });
    notesByTec.set(n.tecnico_id, arr);
  }

  const sorted = [...(tecnicos ?? [])].sort((a, b) => {
    const da = latestDossierByTec.get(a.tecnico_id);
    const db_ = latestDossierByTec.get(b.tecnico_id);
    const ka = sortKey({
      candidate_state: a.candidate_state,
      onboarded_at: a.onboarded_at,
      rec: da?.tono_recommendation ?? null,
      conf: da?.tono_confidence ?? 0,
    });
    const kb = sortKey({
      candidate_state: b.candidate_state,
      onboarded_at: b.onboarded_at,
      rec: db_?.tono_recommendation ?? null,
      conf: db_?.tono_confidence ?? 0,
    });
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2] - kb[2];
  });

  const items: QueueItem[] = sorted.map((tec) => {
    const reg = regByTec.get(tec.tecnico_id);
    const dossier = latestDossierByTec.get(tec.tecnico_id) ?? null;
    return {
      tecnico_id: tec.tecnico_id,
      display_name: tec.nombre ?? reg?.nombre ?? "(sin nombre)",
      display_ciudad: dossier?.ciudad_base ?? reg?.ciudad ?? "—",
      contact_phone: tec.contact_phone ?? null,
      phone: tec.phone,
      last_jid: tec.last_jid ?? null,
      candidate_state: tec.candidate_state,
      onboarded_at_human: fmtTime(tec.onboarded_at),
      dossier,
      notes: notesByTec.get(tec.tecnico_id) ?? [],
      has_cedula_doc: tecnicosWithCedula.has(tec.tecnico_id),
    };
  });

  return (
    <div className="space-y-2">
      <QueueListClient items={items} />
    </div>
  );
}
