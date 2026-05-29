// Cleanup utility for ORPHANED contracts — rows in `contratos` whose
// tecnico_id no longer exists in `tecnicos_extended`. This is the gap left
// by scripts/cleanup-tecnico.ts: contratos has NO FK CASCADE from
// tecnicos_extended, so deleting a test worker leaves the contract behind
// and HR's Contratos page shows "(sin nombre)" for the trabajador column.
//
// What gets cleaned per orphan contract:
//   1. Storage bucket: contratos/{contract_id}/* (draft.pdf + any signed-*)
//   2. outbound_messages: attachment_path LIKE '{contract_id}/%'
//   3. eventos: entity_id = contract_id  (covers contract_sent + contract_signed)
//   4. contratos row itself
//
// Safety: any contract whose tecnico_id IS still present in tecnicos_extended
// is KEPT and reported — never touched. Dry-run by default.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/cleanup-orphaned-contratos.ts            # dry-run
//   npx tsx --env-file=.env.local scripts/cleanup-orphaned-contratos.ts --confirm  # actually delete

import { createServerClient } from "@redin/shared";

const BUCKET = "contratos";

type Contract = {
  id: string;
  tecnico_id: string;
  ot_id: string | null;
  status: string | null;
  pdf_storage_path: string | null;
  signed_pdf_storage_path: string | null;
  sent_at: string | null;
};

(async () => {
  const supa = createServerClient();
  const confirm = process.argv.includes("--confirm");

  // contratos has no created_at column (per migrations/001_init.sql:56-67).
  const { data: all, error } = await supa
    .from("contratos")
    .select(
      "id, tecnico_id, ot_id, status, pdf_storage_path, signed_pdf_storage_path, sent_at"
    )
    .order("sent_at", { ascending: false, nullsFirst: false });
  if (error) {
    console.error("contratos query failed:", error.message);
    process.exit(1);
  }
  const rows = (all ?? []) as Contract[];
  console.log(`Total contratos in table: ${rows.length}`);

  // 2. Classify each as ORPHAN (tecnico gone) or LIVE (tecnico exists).
  const orphans: Contract[] = [];
  const live: Array<{ c: Contract; nombre: string }> = [];
  for (const c of rows) {
    if (!c.tecnico_id) {
      orphans.push(c);
      continue;
    }
    const { data: tec, error: tecErr } = await supa
      .from("tecnicos_extended")
      .select("tecnico_id, nombre")
      .eq("tecnico_id", c.tecnico_id)
      .maybeSingle();
    if (tecErr) {
      console.error(`  tecnico lookup failed for ${c.tecnico_id}:`, tecErr.message);
      process.exit(1);
    }
    if (tec) {
      live.push({ c, nombre: tec.nombre ?? "(no name)" });
    } else {
      orphans.push(c);
    }
  }

  if (live.length > 0) {
    console.log(`\n=== ${live.length} LIVE contract(s) — will be KEPT ===`);
    for (const { c, nombre } of live) {
      console.log(`  KEEP id=${c.id.slice(0, 8)}… tecnico=${nombre} status=${c.status}`);
    }
  }

  if (orphans.length === 0) {
    console.log("\nNo orphaned contratos. Nothing to clean.");
    return;
  }

  // 3. Survey what each orphan owns across surfaces.
  console.log(`\n=== ${orphans.length} ORPHANED contract(s) ===`);
  type Plan = {
    c: Contract;
    storagePaths: string[];
    outboundCount: number;
    eventosCount: number;
  };
  const plans: Plan[] = [];
  for (const c of orphans) {
    const { data: files, error: listErr } = await supa.storage.from(BUCKET).list(c.id);
    if (listErr) {
      console.error(`  storage list ${c.id}: ${listErr.message}`);
    }
    const storagePaths = (files ?? []).map((f) => `${c.id}/${f.name}`);

    const { count: outboundCount, error: omErr } = await supa
      .from("outbound_messages")
      .select("*", { count: "exact", head: true })
      .like("attachment_path", `${c.id}/%`);
    if (omErr) console.error(`  outbound count ${c.id}: ${omErr.message}`);

    const { count: eventosCount, error: evErr } = await supa
      .from("eventos")
      .select("*", { count: "exact", head: true })
      .eq("entity_id", c.id);
    if (evErr) console.error(`  eventos count ${c.id}: ${evErr.message}`);

    plans.push({
      c,
      storagePaths,
      outboundCount: outboundCount ?? 0,
      eventosCount: eventosCount ?? 0,
    });

    console.log(`\n  contract ${c.id}`);
    console.log(`    tecnico_id=${c.tecnico_id ?? "(null)"} → NOT in tecnicos_extended`);
    console.log(`    ot_id=${c.ot_id} status=${c.status} sent_at=${c.sent_at}`);
    console.log(`    storage files (${storagePaths.length}):`);
    for (const p of storagePaths) console.log(`      - ${p}`);
    console.log(`    outbound_messages refs: ${outboundCount ?? 0}`);
    console.log(`    eventos refs (entity_id=contract): ${eventosCount ?? 0}`);
  }

  if (!confirm) {
    console.log("\nDry run. Pass --confirm to actually delete.");
    return;
  }

  // 4. Execute deletes per orphan. Order: storage → outbound → eventos → contratos row.
  console.log(`\n=== DELETING ===`);
  for (const plan of plans) {
    const { c, storagePaths } = plan;
    console.log(`\n  contract ${c.id}`);

    if (storagePaths.length > 0) {
      const { error: rmErr } = await supa.storage.from(BUCKET).remove(storagePaths);
      console.log(
        `    storage remove (${storagePaths.length}): ${rmErr ? "ERR " + rmErr.message : "ok"}`
      );
    } else {
      console.log(`    storage: nothing to remove`);
    }

    const r1 = await supa
      .from("outbound_messages")
      .delete()
      .like("attachment_path", `${c.id}/%`);
    console.log(`    outbound_messages: ${r1.error ? "ERR " + r1.error.message : "ok"}`);

    const r2 = await supa.from("eventos").delete().eq("entity_id", c.id);
    console.log(`    eventos: ${r2.error ? "ERR " + r2.error.message : "ok"}`);

    const r3 = await supa.from("contratos").delete().eq("id", c.id);
    console.log(`    contratos row: ${r3.error ? "ERR " + r3.error.message : "ok"}`);
  }

  // 5. Verify.
  const { count: remaining } = await supa
    .from("contratos")
    .select("*", { count: "exact", head: true });
  console.log(`\nRemaining contratos rows: ${remaining ?? 0}`);
  console.log(`Live (kept): ${live.length}`);
  console.log(`Done.`);
})().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
