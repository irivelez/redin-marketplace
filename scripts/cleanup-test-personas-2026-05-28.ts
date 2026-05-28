// One-shot cleanup of test personas Camilo Navas + Jose Luis Capacho Santafe.
// Mirrors scripts/cleanup-tecnico.ts cascade pattern but keyed by tecnico_id
// (their cedula columns are NULL, so cedula-keyed script can't be used).
//
// Cascade order (FK-safe):
//   1. outbound_messages WHERE phone
//   2. sessions WHERE phone  (cascades to messages)
//   3. turns WHERE tecnico_id
//   4. eventos WHERE entity_id=tecnico_id
//   5. tecnicos_extended WHERE tecnico_id  (cascades to dossiers, decisions,
//      postulaciones, documentos, hr_notes, evaluations, ot_offers)
//
// No AppSheet cleanup needed — both have appsheet_row_id=null.

import { createClient } from "@supabase/supabase-js";

const TARGETS: Array<{ tecnico_id: string; expected_name: string }> = [
  { tecnico_id: "679d0714-1b7a-4a29-85a3-c44970ab5389", expected_name: "Camilo Navas" },
  { tecnico_id: "1631104c-a5fa-4580-9d86-9b774afcf860", expected_name: "Jose Luis Capacho" },
];

(async () => {
  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

  for (const t of TARGETS) {
    console.log(`\n=== ${t.expected_name} (${t.tecnico_id}) ===`);
    const { data: tec } = await supa
      .from("tecnicos_extended")
      .select("tecnico_id, nombre, phone, contact_phone, candidate_state, appsheet_row_id")
      .eq("tecnico_id", t.tecnico_id)
      .maybeSingle();
    if (!tec) {
      console.log("  ⚠️  not found, skipping");
      continue;
    }
    // Safety check — refuse if name doesn't match.
    if (!(tec.nombre ?? "").toLowerCase().includes(t.expected_name.toLowerCase().split(" ")[0])) {
      console.log(`  ❌ SAFETY ABORT: nombre is "${tec.nombre}", expected "${t.expected_name}"`);
      process.exit(1);
    }
    if (tec.appsheet_row_id) {
      console.log(`  ❌ has appsheet_row_id=${tec.appsheet_row_id} — refusing (this script doesn't do AppSheet)`);
      process.exit(1);
    }
    console.log(`  target: ${tec.nombre}, phone=${tec.phone}, state=${tec.candidate_state}`);

    // 1. outbound_messages WHERE phone
    const r1 = await supa.from("outbound_messages").delete().eq("phone", tec.phone);
    console.log(`  outbound_messages by phone: ${r1.error ? "ERR " + r1.error.message : "ok"}`);

    // 2. sessions WHERE phone
    const r2 = await supa.from("sessions").delete().eq("phone", tec.phone);
    console.log(`  sessions by phone: ${r2.error ? "ERR " + r2.error.message : "ok"}`);

    // 3. turns WHERE tecnico_id
    const r3 = await supa.from("turns").delete().eq("tecnico_id", t.tecnico_id);
    console.log(`  turns by tecnico_id: ${r3.error ? "ERR " + r3.error.message : "ok"}`);

    // 4. eventos WHERE entity_id=tecnico_id
    const r4 = await supa.from("eventos").delete().eq("entity_id", t.tecnico_id);
    console.log(`  eventos by entity_id: ${r4.error ? "ERR " + r4.error.message : "ok"}`);

    // 5. tecnicos_extended (cascades to documentos, dossiers, decisions, postulaciones,
    //    hr_notes, evaluations, ot_offers)
    const r5 = await supa.from("tecnicos_extended").delete().eq("tecnico_id", t.tecnico_id);
    console.log(`  tecnicos_extended (cascade): ${r5.error ? "ERR " + r5.error.message : "ok"}`);

    // Verify gone
    const { data: gone } = await supa
      .from("tecnicos_extended")
      .select("tecnico_id")
      .eq("tecnico_id", t.tecnico_id)
      .maybeSingle();
    console.log(`  verify: ${gone ? "❌ still present" : "✅ gone"}`);
  }
  console.log("\n=== DONE ===");
})();
