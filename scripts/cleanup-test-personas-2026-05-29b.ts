// One-shot cleanup of 3 test personas from the 2026-05-29 /hr/tecnicos view.
// Keyed by tecnico_id (verified via survey); each pins an expected nombre
// substring as a safety check, and the resolved tecnico must match phone too.
//
// Closes the FK-cascade gaps cleanup-tecnico.ts misses:
//   * documentos Storage files (incoming/{phone}/*)
//   * contratos rows + their Storage files
//
// Cascade order (FK-safe), per target:
//   1. Storage documentos/{...} + contratos/{contract_id}/*
//   2. contratos rows
//   3. outbound_messages by phone
//   4. sessions by phone (cascades messages)
//   5. turns by tecnico_id
//   6. eventos by entity_id = tecnico_id
//   7. tecnicos_extended (cascades dossiers, decisions, postulaciones,
//      documentos, hr_notes, evaluations, ot_offers, qualification_calls)
//   8. AppSheet Tecnicos row if appsheet_row_id present
//
// Dry-run by default; pass --confirm to execute.

import { createServerClient, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "../sync/src/appsheet";

const TARGETS: Array<{ tecnico_id: string; phone: string; expected_name: string }> = [
  { tecnico_id: "0a002df4-1bf3-428c-9880-7174b69a1f65", phone: "+137877543452841", expected_name: "Juan Alberto Alayon" },
  { tecnico_id: "799922b4-9581-4300-a9c2-bd91c14bd6db", phone: "+234488068088059", expected_name: "Laura Fajardo" },
  { tecnico_id: "f7220d62-bb67-42b4-8a3a-b7f7c574f516", phone: "+207794896687116", expected_name: "Edgar Andrés Ordoñez" },
];

const DOCS_BUCKET = "documentos";
const CONTRATOS_BUCKET = "contratos";

(async () => {
  const supa = createServerClient();
  const confirm = process.argv.includes("--confirm");
  let appsheet: AppSheetReadClient | null = null;

  for (const t of TARGETS) {
    console.log(`\n=== ${t.expected_name} (${t.tecnico_id}) ===`);
    const { data: tec } = await supa
      .from("tecnicos_extended")
      .select("tecnico_id, nombre, phone, candidate_state, appsheet_row_id")
      .eq("tecnico_id", t.tecnico_id)
      .maybeSingle();
    if (!tec) {
      console.log("  already gone, skipping");
      continue;
    }
    const first = (t.expected_name.toLowerCase().split(/\s+/)[0]) ?? "";
    if (!(tec.nombre ?? "").toLowerCase().includes(first)) {
      console.error(`  SAFETY ABORT: nombre is ${JSON.stringify(tec.nombre)}, expected to contain "${first}"`);
      process.exit(1);
    }
    if (tec.phone !== t.phone) {
      console.error(`  SAFETY ABORT: phone is ${tec.phone}, expected ${t.phone}`);
      process.exit(1);
    }
    console.log(`  target: ${tec.nombre}, phone=${tec.phone}, state=${tec.candidate_state}, appsheet=${tec.appsheet_row_id ?? "(none)"}`);

    const { data: docRows } = await supa.from("documentos").select("storage_path").eq("tecnico_id", t.tecnico_id);
    const docPaths = (docRows ?? []).map((d) => d.storage_path).filter((p): p is string => typeof p === "string" && p.length > 0);
    const { data: contracts } = await supa.from("contratos").select("id").eq("tecnico_id", t.tecnico_id);
    const contractIds = (contracts ?? []).map((c) => c.id);

    if (!confirm) {
      console.log(`  [dry-run] would remove docs storage: ${JSON.stringify(docPaths)}`);
      console.log(`  [dry-run] would remove contratos rows: ${JSON.stringify(contractIds)}`);
      console.log("  [dry-run] pass --confirm to execute");
      continue;
    }

    if (docPaths.length) {
      const { error } = await supa.storage.from(DOCS_BUCKET).remove(docPaths);
      console.log(`  storage documentos (${docPaths.length}): ${error ? "ERR " + error.message : "ok"}`);
    }
    for (const cid of contractIds) {
      const { data: files } = await supa.storage.from(CONTRATOS_BUCKET).list(cid);
      const paths = (files ?? []).map((f) => `${cid}/${f.name}`);
      if (paths.length) {
        const { error } = await supa.storage.from(CONTRATOS_BUCKET).remove(paths);
        console.log(`  storage contratos/${cid.slice(0, 8)} (${paths.length}): ${error ? "ERR " + error.message : "ok"}`);
      }
    }
    const rC = await supa.from("contratos").delete().eq("tecnico_id", t.tecnico_id);
    console.log(`  contratos rows: ${rC.error ? "ERR " + rC.error.message : "ok"}`);
    const rO = await supa.from("outbound_messages").delete().eq("phone", tec.phone);
    console.log(`  outbound_messages by phone: ${rO.error ? "ERR " + rO.error.message : "ok"}`);
    const rS = await supa.from("sessions").delete().eq("phone", tec.phone);
    console.log(`  sessions by phone: ${rS.error ? "ERR " + rS.error.message : "ok"}`);
    const rT = await supa.from("turns").delete().eq("tecnico_id", t.tecnico_id);
    console.log(`  turns by tecnico_id: ${rT.error ? "ERR " + rT.error.message : "ok"}`);
    const rE = await supa.from("eventos").delete().eq("entity_id", t.tecnico_id);
    console.log(`  eventos by entity_id: ${rE.error ? "ERR " + rE.error.message : "ok"}`);
    const rTec = await supa.from("tecnicos_extended").delete().eq("tecnico_id", t.tecnico_id);
    console.log(`  tecnicos_extended (cascade): ${rTec.error ? "ERR " + rTec.error.message : "ok"}`);

    if (tec.appsheet_row_id && tec.nombre) {
      if (!appsheet) {
        appsheet = new AppSheetReadClient({ appId: requireEnv("APPSHEET_APP_ID"), accessKey: requireEnv("APPSHEET_ACCESS_KEY") });
      }
      try {
        const result = await appsheet.deleteTecnico(tec.appsheet_row_id, tec.nombre);
        console.log(`  AppSheet row ${tec.appsheet_row_id}: ${result.alreadyGone ? "alreadyGone" : "deleted"}`);
      } catch (e) {
        console.log(`  AppSheet delete FAILED: ${e instanceof Error ? e.message : String(e)} (manual cleanup needed for ${tec.appsheet_row_id})`);
      }
    }

    const { data: gone } = await supa.from("tecnicos_extended").select("tecnico_id").eq("tecnico_id", t.tecnico_id).maybeSingle();
    console.log(`  verify: ${gone ? "STILL PRESENT" : "gone"}`);
  }
  console.log("\n=== DONE ===");
})().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
