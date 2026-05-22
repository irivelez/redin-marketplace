// One-off: insert a corrective tecnico_registered event for Alberto so
// identify_user picks ciudad=Popayán instead of Bucaramanga. The May 19
// event meta is now stale (worker said she's in Popayán on May 22).
//
// identify_user reads the MOST RECENT tecnico_registered event meta. We just
// insert a new one — no UPDATE needed.

import { createServerClient } from "@redin/shared";

const TECNICO_ID = "82b9791c-629b-4954-a39b-71cb4cc2d289";

async function main() {
  const supa = createServerClient();

  // Confirm the current state first
  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, phone, candidate_state, contact_phone")
    .eq("tecnico_id", TECNICO_ID)
    .maybeSingle();
  if (!tec) {
    console.error("Worker not found — bailing.");
    process.exit(1);
  }
  console.log("Worker:", JSON.stringify(tec, null, 2));

  // Read current latest tecnico_registered to confirm ciudad mismatch
  const { data: latest } = await supa
    .from("eventos")
    .select("created_at, meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", TECNICO_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const oldCiudad = (latest?.meta as { ciudad?: string } | null)?.ciudad;
  console.log(`Current latest event ciudad: ${oldCiudad}`);
  if (oldCiudad === "Popayan" || oldCiudad === "Popayán") {
    console.log("Already Popayán — no-op. Exiting.");
    process.exit(0);
  }

  // Insert the corrective event with all original fields preserved
  const newMeta = {
    phone: tec.phone,
    ciudad: "Popayán",
    nombre: tec.nombre,
    source: "dashboard",
    modalidad: "individual",
    contact_phone: tec.contact_phone,
    especialidades: ["Obra Civil (Locativo)"],
    correction_note:
      "Worker moved Bucaramanga → Popayán on 2026-05-22; corrected by ops during testing.",
  };

  const { data: inserted, error } = await supa
    .from("eventos")
    .insert({
      type: "tecnico_registered",
      entity_id: TECNICO_ID,
      actor: "hr:ops_correction",
      meta: newMeta,
    })
    .select("id, created_at")
    .single();

  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }
  console.log(`Corrected event inserted: id=${inserted?.id} created_at=${inserted?.created_at}`);

  // Verify: re-query latest
  const { data: confirm } = await supa
    .from("eventos")
    .select("created_at, meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", TECNICO_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const newCiudad = (confirm?.meta as { ciudad?: string } | null)?.ciudad;
  console.log(`Latest event ciudad after fix: ${newCiudad}`);
  if (newCiudad === "Popayán") {
    console.log("✅ Fix applied. Next identify_user call will return ciudad=Popayán.");
  } else {
    console.error("⚠️  Latest event ciudad is NOT Popayán — investigate.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
