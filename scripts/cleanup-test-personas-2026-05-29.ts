// Cleanup utility for the 4 test técnicos visible on /hr/tecnicos at 2026-05-29.
// Identified by exact WA phone match; each entry pins an expected nombre
// substring as a safety check (refuses if the row's nombre does not contain it).
//
// Closes the surfaces that scripts/cleanup-tecnico.ts misses:
//   * contratos rows + Storage files under bucket "contratos/{contract_id}/*"
//   * documentos Storage files under bucket "documentos/{tecnico_id}/*"
//
// Cascade order (FK-safe), per target:
//   1. Storage: remove all files under contratos/{contract_id}/ for every contract
//   2. Storage: remove all files under documentos/{tecnico_id}/
//   3. contratos rows                                  (no FK from tecnicos_extended)
//   4. outbound_messages by phone                      (no FK)
//   5. sessions by phone                               (no FK; cascades to messages)
//   6. turns by tecnico_id                             (no FK)
//   7. eventos by entity_id = tecnico_id               (no FK)
//   8. tecnicos_extended by tecnico_id                 (cascades to dossiers,
//      decisions, postulaciones, documentos, hr_notes, evaluations, ot_offers,
//      qualification_calls)
//   9. AppSheet Tecnicos row if appsheet_row_id present
//
// Dry-run by default; pass --confirm to execute.

import { createServerClient, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "../sync/src/appsheet";

const TARGETS: Array<{ phone: string; expected_name: string }> = [
  { phone: "+243279866110061", expected_name: "Juan José Capacho" },
  { phone: "+33887895953632", expected_name: "Jose Luis Capacho" },
  { phone: "+5700196413681", expected_name: "QA 95f0" },
  { phone: "+5700096413681", expected_name: "QA 6630" },
];

const CONTRATOS_BUCKET = "contratos";
const DOCUMENTOS_BUCKET = "documentos";

type Tecnico = {
  tecnico_id: string;
  nombre: string | null;
  phone: string;
  contact_phone: string | null;
  cedula: string | null;
  candidate_state: string | null;
  appsheet_row_id: string | null;
};

(async () => {
  const supa = createServerClient();
  const confirm = process.argv.includes("--confirm");

  const { data: rows, error } = await supa
    .from("tecnicos_extended")
    .select(
      "tecnico_id, nombre, phone, contact_phone, cedula, candidate_state, appsheet_row_id"
    )
    .in(
      "phone",
      TARGETS.map((t) => t.phone)
    );
  if (error) {
    console.error("tecnicos_extended query failed:", error.message);
    process.exit(1);
  }
  const found = (rows ?? []) as Tecnico[];
  console.log(`Resolved ${found.length}/${TARGETS.length} target(s) by phone\n`);

  const plans: Array<{
    target: (typeof TARGETS)[number];
    tec: Tecnico;
    contracts: Array<{ id: string }>;
    documentosCount: number;
    storageContractsFiles: string[];
    storageDocumentosFiles: string[];
  }> = [];

  for (const t of TARGETS) {
    const tec = found.find((r) => r.phone === t.phone);
    if (!tec) {
      console.log(`SKIP ${t.phone} (${t.expected_name}) — no tecnicos_extended row (already clean?)`);
      continue;
    }
    const nombreLc = (tec.nombre ?? "").toLowerCase();
    if (!nombreLc.includes(t.expected_name.toLowerCase())) {
      console.error(
        `\nSAFETY ABORT for ${t.phone}: nombre is ${JSON.stringify(tec.nombre)}, ` +
          `does not contain ${JSON.stringify(t.expected_name)}.`
      );
      console.error("Refusing to delete a tecnico whose name does not match the expected substring.");
      process.exit(1);
    }

    const { data: contracts } = await supa
      .from("contratos")
      .select("id")
      .eq("tecnico_id", tec.tecnico_id);

    const { count: documentosCount } = await supa
      .from("documentos")
      .select("*", { count: "exact", head: true })
      .eq("tecnico_id", tec.tecnico_id);

    const storageContractsFiles: string[] = [];
    for (const c of contracts ?? []) {
      const { data: files } = await supa.storage
        .from(CONTRATOS_BUCKET)
        .list(c.id);
      for (const f of files ?? []) {
        storageContractsFiles.push(`${c.id}/${f.name}`);
      }
    }

    const { data: docRows } = await supa
      .from("documentos")
      .select("storage_path")
      .eq("tecnico_id", tec.tecnico_id);
    const storageDocumentosFiles = (docRows ?? [])
      .map((d) => d.storage_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);

    plans.push({
      target: t,
      tec,
      contracts: contracts ?? [],
      documentosCount: documentosCount ?? 0,
      storageContractsFiles,
      storageDocumentosFiles,
    });
  }

  console.log("=== SURVEY ===");
  for (const p of plans) {
    const { tec, target, contracts, documentosCount, storageContractsFiles, storageDocumentosFiles } = p;
    console.log(`\n  ${target.expected_name}`);
    console.log(`    tecnico_id=${tec.tecnico_id}`);
    console.log(`    phone=${tec.phone} contact_phone=${tec.contact_phone}`);
    console.log(`    cedula=${tec.cedula ?? "(null)"} state=${tec.candidate_state} appsheet_row_id=${tec.appsheet_row_id ?? "(null)"}`);

    const surveyTables: Array<[string, string]> = [
      ["candidate_dossiers", "tecnico_id"],
      ["candidate_decisions", "tecnico_id"],
      ["postulaciones", "tecnico_id"],
      ["ot_offers", "tecnico_id"],
      ["documentos", "tecnico_id"],
      ["hr_notes", "tecnico_id"],
      ["tecnico_evaluations", "tecnico_id"],
      ["qualification_calls", "tecnico_id"],
      ["turns", "tecnico_id"],
      ["eventos", "entity_id"],
    ];
    for (const [tbl, col] of surveyTables) {
      const { count } = await (supa as any)
        .from(tbl)
        .select("*", { count: "exact", head: true })
        .eq(col, tec.tecnico_id);
      console.log(`    ${tbl.padEnd(22)} ${col.padEnd(10)} ${String(count ?? 0).padStart(3)}`);
    }
    for (const tbl of ["sessions", "outbound_messages"]) {
      const { count } = await (supa as any)
        .from(tbl)
        .select("*", { count: "exact", head: true })
        .eq("phone", tec.phone);
      console.log(`    ${tbl.padEnd(22)} ${"phone".padEnd(10)} ${String(count ?? 0).padStart(3)}`);
    }

    console.log(`    contratos rows: ${contracts.length}`);
    for (const c of contracts) console.log(`      contract ${c.id}`);
    console.log(`    documentos rows: ${documentosCount}`);
    console.log(`    storage contratos/* files: ${storageContractsFiles.length}`);
    for (const f of storageContractsFiles) console.log(`      - ${f}`);
    console.log(`    storage documentos/* files: ${storageDocumentosFiles.length}`);
    for (const f of storageDocumentosFiles) console.log(`      - ${f}`);
  }

  if (plans.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  if (!confirm) {
    console.log("\nDry run. Pass --confirm to actually delete.");
    return;
  }

  console.log("\n=== DELETING ===");
  let appsheet: AppSheetReadClient | null = null;
  for (const p of plans) {
    const { tec, target, storageContractsFiles, storageDocumentosFiles } = p;
    console.log(`\n  ${target.expected_name} (${tec.tecnico_id})`);

    if (storageContractsFiles.length > 0) {
      const { error: rmErr } = await supa.storage
        .from(CONTRATOS_BUCKET)
        .remove(storageContractsFiles);
      console.log(`    storage contratos (${storageContractsFiles.length}): ${rmErr ? "ERR " + rmErr.message : "ok"}`);
    }

    if (storageDocumentosFiles.length > 0) {
      const { error: rmErr } = await supa.storage
        .from(DOCUMENTOS_BUCKET)
        .remove(storageDocumentosFiles);
      console.log(`    storage documentos (${storageDocumentosFiles.length}): ${rmErr ? "ERR " + rmErr.message : "ok"}`);
    }

    const rContratos = await supa.from("contratos").delete().eq("tecnico_id", tec.tecnico_id);
    console.log(`    contratos rows: ${rContratos.error ? "ERR " + rContratos.error.message : "ok"}`);

    const rOut = await supa.from("outbound_messages").delete().eq("phone", tec.phone);
    console.log(`    outbound_messages by phone: ${rOut.error ? "ERR " + rOut.error.message : "ok"}`);

    const rSess = await supa.from("sessions").delete().eq("phone", tec.phone);
    console.log(`    sessions by phone: ${rSess.error ? "ERR " + rSess.error.message : "ok"}`);

    const rTurns = await supa.from("turns").delete().eq("tecnico_id", tec.tecnico_id);
    console.log(`    turns by tecnico_id: ${rTurns.error ? "ERR " + rTurns.error.message : "ok"}`);

    const rEv = await supa.from("eventos").delete().eq("entity_id", tec.tecnico_id);
    console.log(`    eventos by entity_id: ${rEv.error ? "ERR " + rEv.error.message : "ok"}`);

    const rTec = await supa.from("tecnicos_extended").delete().eq("tecnico_id", tec.tecnico_id);
    console.log(`    tecnicos_extended (cascade): ${rTec.error ? "ERR " + rTec.error.message : "ok"}`);

    if (tec.appsheet_row_id && tec.nombre) {
      if (!appsheet) {
        appsheet = new AppSheetReadClient({
          appId: requireEnv("APPSHEET_APP_ID"),
          accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
        });
      }
      try {
        const result = await appsheet.deleteTecnico(tec.appsheet_row_id, tec.nombre);
        console.log(`    AppSheet row ${tec.appsheet_row_id}: ${result.alreadyGone ? "alreadyGone" : "deleted"}`);
      } catch (e: any) {
        console.log(`    AppSheet delete FAILED: ${e?.message ?? String(e)}`);
        console.log(`      manual cleanup needed for Row ID ${tec.appsheet_row_id}`);
      }
    } else {
      console.log(`    AppSheet: skip (appsheet_row_id=${tec.appsheet_row_id})`);
    }

    const { data: verify } = await supa
      .from("tecnicos_extended")
      .select("tecnico_id")
      .eq("tecnico_id", tec.tecnico_id)
      .maybeSingle();
    console.log(`    verify: ${verify ? "STILL PRESENT" : "gone"}`);
  }

  console.log("\nDone.");
})().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
