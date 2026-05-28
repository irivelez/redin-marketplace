// One-shot post-test verifier for a Toño WhatsApp session.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-tono-session.ts <phone>
//   e.g. npx tsx --env-file=.env.local scripts/verify-tono-session.ts +137877543452841
//
// Prints: worker identity + state, turn latencies (avg/min/max), classification
// results, outbound duplicate check, dossier quality, concerning eventos.
// Read-only — never mutates DB.

import { createClient } from "@supabase/supabase-js";

const PHONE = process.argv[2];
if (!PHONE) {
  console.error("usage: verify-tono-session.ts <phone>");
  console.error("  e.g. verify-tono-session.ts +137877543452841");
  process.exit(1);
}

const fmt = (n: number, w = 5) => String(n).padStart(w);
const ms = (n: number | null | undefined) => (n == null ? "  -  " : fmt(Math.round(n)) + "ms");

(async () => {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

  console.log(`\n=== ${PHONE} ===`);

  const { data: ext } = await sb
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, cedula, contact_phone, candidate_state, appsheet_row_id")
    .eq("phone", PHONE)
    .limit(1);
  const tec = ext?.[0];
  if (tec) {
    console.log(
      `worker: ${tec.nombre ?? "<no nombre>"} (id=${tec.tecnico_id.slice(0, 8)}…, ` +
        `cedula=${tec.cedula ?? "-"}, state=${tec.candidate_state}` +
        `${tec.appsheet_row_id ? `, appsheet=${tec.appsheet_row_id}` : ""})`,
    );
  } else {
    console.log("worker: (no tecnico_extended row — anonymous session)");
  }

  const { data: sessions } = await sb
    .from("sessions")
    .select("id, started_at, last_active")
    .eq("phone", PHONE)
    .order("started_at", { ascending: false });
  console.log(`sessions: ${sessions?.length ?? 0}`);

  if (tec) {
    const { data: turns } = await sb
      .from("turns")
      .select("started_at, latency_ms, model, prompt_tokens, completion_tokens, llm_iterations, refused, escalated")
      .eq("tecnico_id", tec.tecnico_id)
      .order("started_at", { ascending: true });
    if (turns && turns.length) {
      const lats = turns.map((t) => t.latency_ms ?? 0).filter((n) => n > 0);
      const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
      const min = Math.min(...lats);
      const max = Math.max(...lats);
      const tokIn = turns.reduce((a, t) => a + (t.prompt_tokens ?? 0), 0);
      const tokOut = turns.reduce((a, t) => a + (t.completion_tokens ?? 0), 0);
      const models = [...new Set(turns.map((t) => t.model).filter(Boolean))];
      console.log(
        `turns: ${turns.length} | avg ${ms(avg)} min ${ms(min)} max ${ms(max)} | ` +
          `tokens ${tokIn}/${tokOut} | model: ${models.join(", ") || "?"}`,
      );
      const refused = turns.filter((t) => t.refused).length;
      const escalated = turns.filter((t) => t.escalated).length;
      if (refused || escalated) console.log(`  ⚠️  refused=${refused} escalated=${escalated}`);
    } else {
      console.log("turns: 0");
    }

    const { data: docs } = await sb
      .from("documentos")
      .select("tipo, classification_jsonb, classifier_model")
      .eq("tecnico_id", tec.tecnico_id)
      .order("uploaded_at", { ascending: true });
    if (docs && docs.length) {
      console.log(`documentos: ${docs.length}`);
      for (const d of docs) {
        const cj = d.classification_jsonb as { classified_type?: string; confidence?: number; matches_expected?: boolean } | null;
        const mark = cj?.matches_expected === true ? "✅" : cj?.matches_expected === false ? "❌" : "  ";
        const classified = cj?.classified_type ?? "NOT_CLASSIFIED";
        const conf = cj?.confidence == null ? "-" : cj.confidence.toFixed(2);
        console.log(`  ${d.tipo.padEnd(24)} → ${classified.padEnd(22)} ${conf}  ${mark}`);
      }
    } else {
      console.log("documentos: 0");
    }

    const { data: dos } = await sb
      .from("candidate_dossiers")
      .select("created_at, tono_recommendation, tono_confidence, tono_reasoning, payload")
      .eq("tecnico_id", tec.tecnico_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (dos?.[0]) {
      const d = dos[0];
      const p = d.payload as { ciudad_base?: string; subcategorias?: string[]; certificaciones?: Record<string, boolean> } | null;
      const certs = p?.certificaciones
        ? Object.entries(p.certificaciones).filter(([_, v]) => v).map(([k]) => k).join(",") || "none"
        : "?";
      console.log(
        `dossier: ${d.tono_recommendation} conf=${d.tono_confidence?.toFixed(2)} | ` +
          `${p?.ciudad_base ?? "?"} | subs=${(p?.subcategorias ?? []).length} | certs=${certs}`,
      );
    } else {
      console.log("dossier: none");
    }
  }

  const { data: out } = await sb
    .from("outbound_messages")
    .select("id, kind, status, body")
    .eq("phone", PHONE)
    .order("created_at", { ascending: true });
  if (out && out.length) {
    const bodyKeys = new Map<string, number>();
    for (const o of out) {
      const k = (o.body ?? "").slice(0, 80);
      bodyKeys.set(k, (bodyKeys.get(k) ?? 0) + 1);
    }
    const dupes = [...bodyKeys.entries()].filter(([_, c]) => c > 1);
    const failed = out.filter((o) => o.status !== "sent" && o.status !== "delivered").length;
    console.log(
      `outbound: ${out.length} sent, ${bodyKeys.size} unique${dupes.length ? `, ⚠️  ${dupes.length} duplicate-body groups` : ", 0 dupes"}${failed ? `, ⚠️  ${failed} non-sent` : ""}`,
    );
    for (const [b, c] of dupes) console.log(`  x${c}: "${b.slice(0, 60)}…"`);
  } else {
    console.log("outbound: 0");
  }

  const sids = (sessions ?? []).map((s) => s.id);
  if (sids.length) {
    const { data: evs } = await sb
      .from("eventos")
      .select("type, created_at")
      .in("entity_id", sids)
      .in("type", ["llm_retry", "llm_error", "grounding_blocked", "grounding_violation_logged", "empty_reply_no_tools"])
      .order("created_at", { ascending: true });
    console.log(`concerning eventos: ${evs?.length ?? 0}${evs?.length ? "  " + evs.map((e) => e.type).join(", ") : ""}`);
  }

  console.log("");
})();
