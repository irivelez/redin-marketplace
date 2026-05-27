// Check the latest conversation: which session, what code ran (turn meta),
// what tools were called, was ciudad updated, was dossier touched.

import { createServerClient } from "@redin/shared";

const TECNICO_ID = "82b9791c-629b-4954-a39b-71cb4cc2d289";
const PHONE = "+137877543452841";

async function main() {
  const supa = createServerClient();

  // Latest 2 sessions for this phone
  const { data: sessions } = await supa
    .from("sessions")
    .select("id, started_at, last_active")
    .eq("phone", PHONE)
    .order("last_active", { ascending: false })
    .limit(3);

  console.log("=== Latest sessions ===");
  for (const s of sessions ?? []) {
    console.log(`  ${s.id}  started=${s.started_at}  last_active=${s.last_active}`);
  }

  if (!sessions || sessions.length === 0) return;
  const newest = sessions[0]!;
  console.log(`\n=== Newest session full message thread (${newest.id}) ===\n`);
  const { data: msgs } = await supa
    .from("messages")
    .select("role, content, tool_calls, created_at")
    .eq("session_id", newest.id)
    .order("created_at", { ascending: true });
  for (const m of msgs ?? []) {
    console.log(`[${m.created_at}] ${m.role.toUpperCase()}`);
    if (m.content) console.log(`  ${m.content.slice(0, 400)}`);
    if (m.tool_calls) {
      const tc = m.tool_calls as unknown;
      console.log(`  tool_calls: ${JSON.stringify(tc).slice(0, 700)}`);
    }
    console.log();
  }

  // Turns for this session with routing mode info from meta
  const { data: turns } = await supa
    .from("turns")
    .select("turn_number, started_at, candidate_state_at_turn, inbound_text, outbound_text, tool_calls, refused, escalated, cost_usd, errors, model")
    .eq("session_id", newest.id)
    .order("turn_number", { ascending: true });
  console.log("=== Turns ===");
  let totalCost = 0;
  for (const t of turns ?? []) {
    const tools = Array.isArray(t.tool_calls)
      ? (t.tool_calls as Array<{ name: string }>).map((x) => x.name).join(", ")
      : "—";
    totalCost += t.cost_usd ?? 0;
    console.log(`turn ${t.turn_number} ${t.started_at} state=${t.candidate_state_at_turn} cost=$${(t.cost_usd ?? 0).toFixed(4)}`);
    console.log(`  in:    ${(t.inbound_text ?? "").slice(0, 80)}`);
    console.log(`  out:   ${(t.outbound_text ?? "").slice(0, 120)}`);
    console.log(`  tools: ${tools}`);
    if (t.errors) console.log(`  errors: ${JSON.stringify(t.errors)}`);
  }
  console.log(`\nTotal cost for session: $${totalCost.toFixed(4)}`);

  // Current worker state
  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("*")
    .eq("tecnico_id", TECNICO_ID)
    .maybeSingle();
  console.log("\n=== Current worker state ===");
  console.log(JSON.stringify(tec, null, 2));

  // Latest tecnico_registered event meta (where ciudad lives)
  const { data: lastReg } = await supa
    .from("eventos")
    .select("created_at, actor, meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", TECNICO_ID)
    .order("created_at", { ascending: false })
    .limit(3);
  console.log("\n=== Latest tecnico_registered events ===");
  for (const r of lastReg ?? []) {
    console.log(`  ${r.created_at} actor=${r.actor}`);
    console.log(`    ${JSON.stringify(r.meta)}`);
  }

  // Latest dossier
  const { data: doss } = await supa
    .from("candidate_dossiers")
    .select("id, created_at, dossier")
    .eq("tecnico_id", TECNICO_ID)
    .order("created_at", { ascending: false })
    .limit(2);
  console.log("\n=== Latest dossiers ===");
  for (const d of doss ?? []) {
    console.log(`  ${d.created_at}  id=${d.id}`);
    console.log(`  dossier excerpt: ${JSON.stringify(d.dossier).slice(0, 500)}`);
  }

  // Events for this worker since the latest session started
  const since = new Date(Date.parse(newest.started_at as string) - 60000).toISOString();
  const { data: events } = await supa
    .from("eventos")
    .select("created_at, type, actor, meta")
    .eq("entity_id", TECNICO_ID)
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  console.log(`\n=== Events since session start (${since}) ===`);
  for (const e of events ?? []) {
    console.log(`  ${e.created_at} ${e.type} actor=${e.actor}`);
    if (e.meta) console.log(`    ${JSON.stringify(e.meta).slice(0, 200)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
