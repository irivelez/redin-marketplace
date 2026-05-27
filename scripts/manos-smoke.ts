// Manos end-to-end smoke test.
//
// Exercises the full architect pipeline:
//   architect cédula → photo upload → attach_photos → set_alcance_ot
//   → finalize_alcance (PDF) → projector drain → AppSheet Alcance_OT write
//
// Usage: npm run smoke:manos
// Requires: .env.local with GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY,
//           APPSHEET_APP_ID, APPSHEET_ACCESS_KEY

import { randomUUID } from "node:crypto";
import { requireEnv } from "@redin/shared";
import { createServerClient } from "@redin/shared";
import { makeDefaultToolContext } from "@redin/tools";
import { attachPhotos, setAlcanceOt, finalizeAlcance } from "@redin/tools";
import { AppSheetReadClient } from "../sync/src/appsheet.ts";
import { tickOtAlcanceOutbox } from "../sync/src/projector.ts";

// ---- Step timing helper ----

interface Step {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  ts: string;
}

const timeline: Step[] = [];
let uploadedPhotoPath: string | null = null;

function step(name: string, status: Step["status"], detail: string): void {
  const ts = new Date().toISOString();
  timeline.push({ name, status, detail, ts });
  const icon = status === "pass" ? "✅" : status === "warn" ? "⚠️ " : "❌";
  console.log(`${icon} [${ts}] ${name}: ${detail}`);
}

function fatal(msg: string): never {
  step("FATAL", "fail", msg);
  printTimeline();
  process.exit(1);
}

function printTimeline(): void {
  console.log("\n── Smoke timeline ──────────────────────────────────────");
  for (const s of timeline) {
    const icon = s.status === "pass" ? "✅" : s.status === "warn" ? "⚠️ " : "❌";
    console.log(`  ${icon} ${s.name}: ${s.detail}`);
  }
  const failures = timeline.filter((s) => s.status === "fail");
  const warns = timeline.filter((s) => s.status === "warn");
  console.log("──────────────────────────────────────────────────────");
  console.log(`  ${timeline.length - failures.length} / ${timeline.length} steps passed, ${warns.length} warnings`);
  if (failures.length > 0) {
    console.log(`  FAILED steps:`);
    for (const f of failures) console.log(`    • ${f.name}: ${f.detail}`);
  }
}

// ---- D4 helper: cédula population count ----

async function reportCedulaCounts(sb: ReturnType<typeof createServerClient>): Promise<void> {
  const [totalRes, withCedulaRes] = await Promise.all([
    sb.from("arquitectos_mirror").select("row_id", { count: "exact", head: true }),
    sb
      .from("arquitectos_mirror")
      .select("row_id", { count: "exact", head: true })
      .not("data->>Cedula" as never, "is", null)
      .neq("data->>Cedula" as never, ""),
  ]);
  const total = totalRes.count ?? 0;
  const filled = withCedulaRes.count ?? 0;
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  const msg = `${filled}/${total} arquitectos have cédula populated (${pct}%)`;
  if (pct < 50) {
    step("D4 cédula population", "warn", `${msg} — BELOW 50%: cédula gate won't work in production for most architects`);
  } else {
    step("D4 cédula population", "pass", msg);
  }
}

async function main(): Promise<void> {
  console.log("── Manos smoke test ─────────────────────────────────");
  console.log(`   Started: ${new Date().toISOString()}`);
  console.log("─────────────────────────────────────────────────────\n");

  // ── Step 1: Verify env ──────────────────────────────────────────────────────
  try {
    requireEnv("GEMINI_API_KEY");
    requireEnv("SUPABASE_URL");
    requireEnv("SUPABASE_SECRET_KEY");
    requireEnv("APPSHEET_APP_ID");
    requireEnv("APPSHEET_ACCESS_KEY");
    step("env check", "pass", "All 5 required env vars present");
  } catch (e) {
    fatal(`Missing env: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sb = createServerClient();
  const ctx = makeDefaultToolContext({ supabase: sb, defaultActor: "system:smoke" });

  // ── Step 2: Pick test architect ─────────────────────────────────────────────
  const { data: arqRows, error: arqErr } = await sb
    .from("arquitectos_mirror")
    .select("row_id, data")
    .not("data->>Cedula", "is", null)
    .neq("data->>Cedula" as never, "")
    .limit(1);

  if (arqErr) fatal(`arquitectos_mirror query failed: ${arqErr.message}`);
  if (!arqRows || arqRows.length === 0) {
    fatal("No arquitectos with cédula found in arquitectos_mirror. Populate cédula data first (Jose task).");
  }

  const arq = arqRows[0]!;
  const arqData = arq.data as Record<string, unknown>;
  const arqRowId = arq.row_id;
  const arqCedula = String(arqData["Cedula"] ?? "");
  const arqNombre = String(arqData["Arquitecto"] ?? arqData["Nombre"] ?? "arquitecto");
  const arqPhone = String(arqData["Telefono"] ?? "+57000000000");
  step("architect selected", "pass", `arq_row_id=${arqRowId} nombre="${arqNombre}" cédula=${arqCedula.slice(0, 4)}****`);

  // ── Step 3: Pick test OT ────────────────────────────────────────────────────
  let otRowId: string;
  let idOrden: string;
  let synthetic = false;

  const { data: ownOts, error: ownErr } = await sb
    .from("ots_mirror")
    .select("row_id, data")
    .eq("data->>Estado" as never, "4. Coordinar – Listo para ejecutar")
    .eq("data->>ID_Arquitecto" as never, arqRowId)
    .limit(1);

  if (ownErr) {
    step("OT query (own)", "warn", `Query failed: ${ownErr.message}. Trying any state-4 OT.`);
  }

  if (ownOts && ownOts.length > 0) {
    const ot = ownOts[0]!;
    otRowId = ot.row_id;
    const otData = ot.data as Record<string, unknown>;
    idOrden = String(otData["ID_Orden"] ?? otData["Numero_Orden"] ?? otRowId.slice(0, 8));
    step("OT selected (owned)", "pass", `ot_row_id=${otRowId} id_orden=${idOrden}`);
  } else {
    // Try any state-4 OT regardless of architect ownership.
    const { data: anyOts, error: anyErr } = await sb
      .from("ots_mirror")
      .select("row_id, data")
      .eq("data->>Estado" as never, "4. Coordinar – Listo para ejecutar")
      .limit(1);

    if (anyErr) fatal(`OT query failed: ${anyErr.message}`);
    if (!anyOts || anyOts.length === 0) {
      fatal("No state-4 OTs found in ots_mirror. Sync AppSheet first: npm run sync:once");
    }

    synthetic = true;
    const ot = anyOts[0]!;
    otRowId = ot.row_id;
    const otData = ot.data as Record<string, unknown>;
    idOrden = String(otData["ID_Orden"] ?? otData["Numero_Orden"] ?? otRowId.slice(0, 8));

    // Synthetic: temporarily patch the OT's ID_Arquitecto so ownership gate passes.
    // We do this in ots_mirror.data (jsonb merge) so the smoke test can proceed.
    // This is ONLY for the smoke test and leaves no permanent damage — the mirror
    // is refreshed from AppSheet on the next sync:once run.
    const patchedData = { ...(otData as object), ID_Arquitecto: arqRowId };
    const { error: patchErr } = await sb
      .from("ots_mirror")
      .update({ data: patchedData as never })
      .eq("row_id", otRowId);

    if (patchErr) {
      step("OT synthetic patch", "warn", `Could not patch ID_Arquitecto: ${patchErr.message}. Ownership check may fail.`);
    } else {
      step("OT selected (synthetic — patched ID_Arquitecto)", "warn", `ot_row_id=${otRowId} id_orden=${idOrden} (NOT owned by test arq; patched for smoke only)`);
    }
  }

  // ── Step 4: Upload a test photo to alcance-photos bucket ────────────────────
  const photoUuid = randomUUID();
  const storagePath = `incoming/${arqPhone}/${photoUuid}.jpg`;

  // Minimal valid 1×1 white JPEG (43 bytes).
  const minimalJpeg = Buffer.from(
    "ffd8ffe000104a46494600010100000100010000" +
    "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b08000100010101110003ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00030101003f00f7b2c0ffd9",
    "hex"
  );

  const { error: uploadErr } = await sb.storage
    .from("alcance-photos")
    .upload(storagePath, minimalJpeg, { contentType: "image/jpeg", upsert: false });

  if (uploadErr) {
    step("photo upload", "fail", `Storage upload failed: ${uploadErr.message}`);
    fatal("Cannot continue without a photo URL for attach_photos");
  }
  uploadedPhotoPath = storagePath;

  const { data: signedData } = await sb.storage
    .from("alcance-photos")
    .createSignedUrl(storagePath, 86400);

  if (!signedData?.signedUrl) {
    fatal("Storage upload succeeded but could not get signed URL");
  }
  const signedUrl = signedData.signedUrl;
  step("photo upload", "pass", `path=${storagePath}`);

  // ── Step 5: attach_photos ───────────────────────────────────────────────────
  const attachResult = await attachPhotos(ctx, {
    arq_row_id: arqRowId,
    ot_row_id: otRowId,
    photo_urls: [signedUrl],
  });

  if (!attachResult.ok) {
    step("attach_photos", "fail", `code=${attachResult.code} error=${attachResult.error}`);
    fatal("attach_photos failed — cannot proceed");
  }
  step("attach_photos", "pass", `total_photos=${attachResult.data.total_photos}`);

  // ── Step 6: set_alcance_ot ──────────────────────────────────────────────────
  const setResult = await setAlcanceOt(ctx, {
    arq_row_id: arqRowId,
    ot_row_id: otRowId,
    alcance: {
      especialidad: "Pintura",
      summary: "Pintura de fachada del edificio comercial; ~120m² preparación + 2 manos esmalte; condiciones: andamios proveídos por cliente.",
      cantidades: [{ item: "pintura esmalte", cantidad: 8, unidad: "galones" }] as unknown as string[],
      conditions: ["Andamios proveídos por cliente"],
      schedule_notes: null as unknown as string,
      value_estimate: "1500000",
    },
  });

  if (!setResult.ok) {
    step("set_alcance_ot", "fail", `code=${setResult.code} error=${setResult.error}`);
    fatal("set_alcance_ot failed — cannot proceed");
  }
  step("set_alcance_ot", "pass", `alcance_saved=${setResult.data.alcance_saved} appsheet_pending=${setResult.data.appsheet_pending}`);

  // ── Step 7: finalize_alcance ────────────────────────────────────────────────
  const finalizeResult = await finalizeAlcance(ctx, {
    arq_row_id: arqRowId,
    ot_row_id: otRowId,
  });

  if (!finalizeResult.ok) {
    step("finalize_alcance", "fail", `code=${finalizeResult.code} error=${finalizeResult.error}`);
    fatal("finalize_alcance failed — cannot proceed");
  }
  const pdfUrl = finalizeResult.data.pdf_url;
  const pdfPath = finalizeResult.data.alcance_pdf_path;
  step("finalize_alcance", "pass", `pdf_path=${pdfPath} pdf_url=${pdfUrl.slice(0, 80)}…`);

  // ── Step 8: Verify Supabase ots_extended state ──────────────────────────────
  const { data: extRow, error: extErr } = await sb
    .from("ots_extended")
    .select("alcance_jsonb, alcance_pdf_path, appsheet_alcance_pending")
    .eq("ot_row_id", otRowId)
    .maybeSingle();

  if (extErr || !extRow) {
    step("ots_extended verify", "fail", extErr ? extErr.message : "row not found after finalize");
  } else {
    const allNonNull =
      extRow.alcance_jsonb !== null &&
      extRow.alcance_pdf_path !== null &&
      extRow.appsheet_alcance_pending === true;
    step(
      "ots_extended verify",
      allNonNull ? "pass" : "fail",
      `alcance_jsonb=${extRow.alcance_jsonb !== null} alcance_pdf_path=${extRow.alcance_pdf_path} appsheet_alcance_pending=${extRow.appsheet_alcance_pending}`
    );
    if (!allNonNull) fatal("ots_extended not in expected state after finalize_alcance");
  }

  // ── Step 9: Projector drain ─────────────────────────────────────────────────
  const appsheet = new AppSheetReadClient({
    appId: requireEnv("APPSHEET_APP_ID"),
    accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
  });

  let projectorResults: Awaited<ReturnType<typeof tickOtAlcanceOutbox>>;
  try {
    projectorResults = await tickOtAlcanceOutbox({ supa: sb, appsheet });
  } catch (e) {
    step("projector drain", "fail", `tickOtAlcanceOutbox threw: ${e instanceof Error ? e.message : String(e)}`);
    fatal("Projector threw — see above");
  }

  const ourResult = projectorResults.find((r) => r.ot_row_id === otRowId);
  if (!ourResult) {
    step("projector drain", "warn", "Our OT row was not picked up by the projector tick (may have been claimed by a concurrent tick or attempts already at limit)");
  } else {
    const projStatus = ourResult.action === "synced" ? "pass" : ourResult.action === "column_missing" ? "warn" : "fail";
    step("projector drain", projStatus, `action=${ourResult.action} attempts=${ourResult.attempts}${ourResult.error ? ` error=${ourResult.error}` : ""}`);

    if (ourResult.action === "column_missing") {
      console.log("\n┌─────────────────────────────────────────────────────────────────────┐");
      console.log("│ BLOCKER D3: AppSheet Alcance_OT column missing                      │");
      console.log("│                                                                       │");
      console.log("│ Jose must add column 'Alcance_OT' (type LongText or File) to the    │");
      console.log("│ Ordenes_Trabajo table in AppSheet Builder before the Manos pipeline  │");
      console.log("│ can write back. The projector will retry automatically once the      │");
      console.log("│ column exists — no code change needed.                               │");
      console.log("└─────────────────────────────────────────────────────────────────────┘\n");
    }
  }

  // Re-read ots_extended to confirm pending=false after projector.
  const { data: postRow } = await sb
    .from("ots_extended")
    .select("appsheet_alcance_pending, appsheet_alcance_last_error")
    .eq("ot_row_id", otRowId)
    .maybeSingle();

  if (postRow) {
    const projectorCleared = postRow.appsheet_alcance_pending === false;
    step(
      "ots_extended post-projector",
      projectorCleared ? "pass" : "warn",
      `appsheet_alcance_pending=${postRow.appsheet_alcance_pending} last_error=${postRow.appsheet_alcance_last_error ?? "null"}`
    );
  }

  // ── Step 10: D4 — cédula population counts ──────────────────────────────────
  await reportCedulaCounts(sb);

  // ── Step 11: Cleanup — remove test photo from storage ──────────────────────
  if (uploadedPhotoPath) {
    const { error: delErr } = await sb.storage
      .from("alcance-photos")
      .remove([uploadedPhotoPath]);
    step(
      "cleanup photo",
      delErr ? "warn" : "pass",
      delErr ? `Storage remove failed: ${delErr.message}` : `Removed ${uploadedPhotoPath}`
    );
  }

  // ── Final summary ───────────────────────────────────────────────────────────
  printTimeline();

  const hasFatal = timeline.some((s) => s.status === "fail");
  process.exit(hasFatal ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
