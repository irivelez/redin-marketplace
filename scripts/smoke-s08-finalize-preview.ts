// S08 smoke test — verifies that finalize_alcance enqueues 2 outbound_messages
// rows (text+link, document) for the architect's session phone.
//
// SAFE: uses a clearly fake test phone (+19999999900) so even if the Manos
// drainer is running, it cannot deliver to a real architect. The test session
// + 2 outbound rows are deleted at the end.
//
// Target OT: LK4cgHD0DlytRsCBwx8zKZ ("TEST TONO — DO NOT EXECUTE", state 4,
// has alcance_jsonb, no PDF yet). This finalize call CREATES the missing
// PDF (non-destructive — no existing PDF to overwrite).
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/smoke-s08-finalize-preview.ts

import { createServerClient, createLogger } from "@redin/shared";
import { finalizeAlcance } from "@redin/tools/manos";
import { makeDefaultToolContext } from "@redin/tools";

const TEST_PHONE = "+19999999900"; // fake — must not match any real architect
const OT_ROW_ID = "LK4cgHD0DlytRsCBwx8zKZ";
const ARQ_ROW_ID = "3Ueb6rlyBC9l2LNRF09D2x";

async function main(): Promise<void> {
  const supabase = createServerClient();
  const logger = createLogger("smoke-s08");

  // 1. Create a fake Manos session for the test phone.
  logger.info("creating test session", { phone: TEST_PHONE });
  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .insert({ phone: TEST_PHONE, channel: "manos" })
    .select("id, phone, channel")
    .single();
  if (sessErr || !session) {
    throw new Error(`session create failed: ${sessErr?.message ?? "no row"}`);
  }
  logger.info("test session created", { session_id: session.id });

  const ctx = makeDefaultToolContext({
    supabase,
    logger,
    session_id: session.id,
  });

  let result: Awaited<ReturnType<typeof finalizeAlcance>> | null = null;
  try {
    // 2. Invoke finalizeAlcance.
    logger.info("invoking finalizeAlcance", {
      arq_row_id: ARQ_ROW_ID,
      ot_row_id: OT_ROW_ID,
    });
    result = await finalizeAlcance(ctx, {
      arq_row_id: ARQ_ROW_ID,
      ot_row_id: OT_ROW_ID,
    });
    logger.info("finalizeAlcance returned", { result });

    if (!result.ok) {
      throw new Error(
        `finalizeAlcance failed: ${result.error} (code=${result.code ?? "n/a"})`
      );
    }

    // 3. Verify 2 outbound_messages rows landed.
    const { data: outRows, error: outErr } = await supabase
      .from("outbound_messages")
      .select(
        "id, phone, channel, kind, body, attachment_path, attachment_bucket, attachment_filename, meta, status, created_at"
      )
      .eq("phone", TEST_PHONE)
      .eq("channel", "manos")
      .order("created_at", { ascending: true });
    if (outErr) throw new Error(`outbound query failed: ${outErr.message}`);

    const rows = outRows ?? [];
    console.log("\n=== OUTBOUND ROWS for test phone ===");
    console.log(JSON.stringify(rows, null, 2));

    // Assertions.
    const linkRow = rows.find(
      (r) =>
        r.kind === "text" &&
        (r.meta as Record<string, unknown> | null)?.["kind"] ===
          "manos_alcance_preview_link"
    );
    const docRow = rows.find(
      (r) =>
        r.kind === "document" &&
        (r.meta as Record<string, unknown> | null)?.["kind"] ===
          "manos_alcance_preview_doc"
    );

    const fail = (m: string): never => {
      throw new Error(`ASSERTION FAILED: ${m}`);
    };

    if (!linkRow) fail("no link row (kind=text, meta.kind=manos_alcance_preview_link)");
    if (!docRow) fail("no document row (kind=document, meta.kind=manos_alcance_preview_doc)");

    if (linkRow) {
      if (!linkRow.body.includes("Listo")) fail("link body missing 'Listo'");
      if (!linkRow.body.includes("http")) fail("link body missing http URL");
      const meta = linkRow.meta as Record<string, unknown> | null;
      if (meta?.["ot_row_id"] !== OT_ROW_ID) fail("link meta.ot_row_id mismatch");
      if (meta?.["arq_row_id"] !== ARQ_ROW_ID) fail("link meta.arq_row_id mismatch");
    }
    if (docRow) {
      if (docRow.attachment_bucket !== "alcance-photos")
        fail(`doc attachment_bucket = ${docRow.attachment_bucket}, expected alcance-photos`);
      if (docRow.attachment_path !== `${OT_ROW_ID}/alcance.pdf`)
        fail(`doc attachment_path = ${docRow.attachment_path}`);
      if (!docRow.attachment_filename?.endsWith(".pdf"))
        fail(`doc attachment_filename = ${docRow.attachment_filename}`);
      if (docRow.status !== "pending")
        fail(`doc status = ${docRow.status}, expected pending`);
    }

    console.log("\n✅ ALL ASSERTIONS PASSED");
    console.log(`   - link row id: ${linkRow?.id}`);
    console.log(`   - doc  row id: ${docRow?.id}`);
    console.log(`   - pdf_url: ${result.data.pdf_url.slice(0, 80)}...`);
    console.log(`   - alcance_pdf_path: ${result.data.alcance_pdf_path}`);
  } finally {
    // 4. Cleanup: delete the 2 outbound rows + the test session.
    // Don't delete the PDF (it's a real finalize for LK4 — leave it there).
    console.log("\n--- cleanup ---");
    const { error: delOutErr, count: delOutCount } = await supabase
      .from("outbound_messages")
      .delete({ count: "exact" })
      .eq("phone", TEST_PHONE)
      .eq("channel", "manos");
    console.log(
      `deleted ${delOutCount ?? "?"} outbound_messages rows${
        delOutErr ? ` (error: ${delOutErr.message})` : ""
      }`
    );

    const { error: delSessErr } = await supabase
      .from("sessions")
      .delete()
      .eq("id", session.id);
    console.log(
      `deleted test session ${session.id}${delSessErr ? ` (error: ${delSessErr.message})` : ""}`
    );
  }
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
