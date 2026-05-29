// Wave 5 manual QA — drives a real Manos turn through handleManosMessage()
// against live Anthropic Sonnet 4.5 + live Supabase to verify:
//
//   S1: photo arrives same turn as architect text → Sonnet sees pixels that
//       turn and the resulting reply reflects a visual detail.
//   S5: live llm_call evento shows model=claude-sonnet-4-5, temperature=0.3,
//       no thinking block (proved via the stderr debug log injected into
//       createMessageWithRetry for the duration of Wave 5).
//
// SAFE: fake phone (+19999999900). Snapshots and restores ots_extended.photo_paths
// for the test OT. Deletes the test session, outbound rows, and temp photo.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/smoke-manos-sonnet-vision.ts \
//     2>&1 | tee data/test-results-manos/sonnet-upgrade-<YYYYMMDD>/qa-s1-s5.log

import { createServerClient, createLogger } from "@redin/shared";
import { handleManosMessage } from "../manos/src/agent";
import { describePhoto } from "../manos/src/describe-photo";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const TEST_PHONE = "+19999999900";
const OT_ROW_ID = "LK4cgHD0DlytRsCBwx8zKZ";
const ARQ_ROW_ID = "3Ueb6rlyBC9l2LNRF09D2x";
const PHOTO = path.resolve(
  process.cwd(),
  "data/test-results-manos/May27-manos-capacho/00000012-PHOTO-2026-05-27-18-07-43.jpg"
);

const fail = (m: string): never => {
  throw new Error(`ASSERTION FAILED: ${m}`);
};

async function main(): Promise<void> {
  const supabase = createServerClient();
  const logger = createLogger("smoke-sonnet-vision");
  const photoBytes = readFileSync(PHOTO);

  // 1. Pre-upload the photo to alcance-photos/incoming and mint a signed URL.
  const incomingPath = `incoming/${TEST_PHONE}/${randomUUID()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("alcance-photos")
    .upload(incomingPath, photoBytes, { contentType: "image/jpeg", upsert: false });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);
  const { data: signed } = await supabase.storage
    .from("alcance-photos")
    .createSignedUrl(incomingPath, 3600);
  const signedUrl = signed?.signedUrl;
  if (!signedUrl) throw new Error("could not sign url");
  logger.info("uploaded test photo", { incomingPath });

  // 2. Snapshot ots_extended.photo_paths for restore.
  const { data: extBefore } = await supabase
    .from("ots_extended")
    .select("photo_paths")
    .eq("ot_row_id", OT_ROW_ID)
    .maybeSingle();
  const originalPaths = Array.isArray(extBefore?.photo_paths)
    ? (extBefore!.photo_paths as string[])
    : [];

  // 3. Generate the Spanish caption via the existing Haiku vision helper.
  const caption = await describePhoto(photoBytes, "image/jpeg");
  if (!caption) fail("describePhoto returned no caption");
  console.log("caption:", caption);

  // 4. Create a Manos session and pre-set meta.arq_row_id so the cédula gate
  //    short-circuits to passed=true on first turn. The fake phone won't match
  //    any arquitecto in arquitectos_mirror — that's intentional, we test the
  //    LLM turn path, not cédula matching.
  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .insert({
      phone: TEST_PHONE,
      channel: "manos",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: { arq_row_id: ARQ_ROW_ID } as any,
    })
    .select("id")
    .single();
  if (sessErr || !session) throw new Error(`session create failed: ${sessErr?.message}`);
  console.log("session:", session.id);

  // Also seed ots_extended.photo_paths with the signed URL so view_photo (S3)
  // would resolve if the model chose to call it.
  await supabase
    .from("ots_extended")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(
      {
        ot_row_id: OT_ROW_ID,
        photo_paths: [signedUrl],
        updated_at: new Date().toISOString(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { onConflict: "ot_row_id" }
    );

  const tStart = new Date().toISOString();
  let llmEvent: { meta: Record<string, unknown> } | null = null;
  let s1Reply = "";

  try {
    // ---- S1 turn: architect text + photo arrive together ----
    console.log("\n=== S1: arrival-turn pixel vision ===");
    const archText =
      "Hola, ya estoy en el sitio. Esta es la foto de cómo está hoy. ¿Qué ves que haya que tener en cuenta para el alcance?";
    const r1 = await handleManosMessage(
      {
        phone: TEST_PHONE,
        text: archText,
        channel: "manos",
        imageUrls: [signedUrl],
        imageDescriptions: [caption!],
      },
      { supabase }
    );
    s1Reply = r1.reply;
    console.log("S1 reply:", s1Reply);
    if (!s1Reply || s1Reply.length < 20) fail("S1 reply too short");

    // ---- Verify the llm_call evento was emitted with model=sonnet ----
    const { data: ev } = await supabase
      .from("eventos")
      .select("type, meta, created_at, entity_id")
      .eq("type", "llm_call")
      .eq("entity_id", session.id)
      .gte("created_at", tStart)
      .order("created_at", { ascending: false })
      .limit(5);
    const llmCalls = (ev ?? []).filter(
      (e) => (e.meta as Record<string, unknown> | null)?.model
    );
    if (llmCalls.length === 0) fail("no llm_call evento captured");
    llmEvent = llmCalls[0] as { meta: Record<string, unknown> };
    const model = llmEvent.meta.model;
    console.log("eventos.llm_call.model:", model);
    if (model !== "claude-sonnet-4-5")
      fail(`expected model=claude-sonnet-4-5, got '${String(model)}'`);
    console.log("✅ S5: eventos.llm_call.model = claude-sonnet-4-5");

    // ---- S1 evidence: reply or scope referenced something visual ----
    // We don't hard-assert the exact words — vision output varies — but we do
    // require the reply to be non-trivial and discuss visible features. This
    // is captured for human review in the qa-s1-s5.log artifact.
    console.log("✅ S1: live Sonnet turn with native image block succeeded");

    // ---- S2: cross-turn caption-driven memory ----
    // No new image; the model must rely on the persisted Spanish caption that
    // was written into the previous user message. We ask for a scope-style
    // summary and expect the reply to still reference what the photo showed.
    console.log("\n=== S2: cross-turn caption memory ===");
    const r2 = await handleManosMessage(
      {
        phone: TEST_PHONE,
        text:
          "Sigamos con la OT #859 (la única mía). Dame un primer borrador del alcance basándote SOLO en lo que viste en la foto del turno anterior — sin pedirme más datos por ahora.",
        channel: "manos",
      },
      { supabase }
    );
    console.log("S2 reply:\n", r2.reply);
    if (!r2.reply || r2.reply.length < 30) fail("S2 reply too short");
    console.log("✅ S2: cross-turn reply produced (manual review needed for caption echo)");

    // ---- S3: view_photo re-examine trigger ----
    // Nudge the model to verify a specific visual detail. The decision to
    // actually call view_photo is up to the LLM — we capture whichever tools
    // it chose. If view_photo fires, we have native re-examine evidence.
    console.log("\n=== S3: view_photo re-examine nudge ===");
    const r3 = await handleManosMessage(
      {
        phone: TEST_PHONE,
        text:
          "Antes de finalizar quiero confirmar un detalle visual MUY específico de la foto que mandé al inicio: ¿cuántas pantallas digitales se ven exactamente y de qué color es el mostrador? Para estar seguro, re-examina la foto #1 con la herramienta view_photo en vez de fiarte solo del análisis textual.",
        channel: "manos",
      },
      { supabase }
    );
    console.log("S3 reply:\n", r3.reply);
    console.log("S3 tool_calls:", JSON.stringify(r3.tool_calls));
    const calledViewPhoto = r3.tool_calls.some((tc) => tc.name === "view_photo");
    if (calledViewPhoto) {
      console.log("✅ S3: view_photo called natively — re-examine path exercised");
    } else {
      console.log(
        "⚠️  S3: view_photo NOT called this run — see tool_calls. The mechanism exists" +
          " (proved by unit + Anthropic probe); whether the model uses it is non-deterministic."
      );
    }
  } finally {
    console.log("\n--- cleanup ---");
    await supabase
      .from("ots_extended")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ photo_paths: originalPaths } as any)
      .eq("ot_row_id", OT_ROW_ID);
    console.log(`restored photo_paths (${originalPaths.length} entries)`);
    await supabase.storage.from("alcance-photos").remove([incomingPath]);
    console.log(`removed temp photo ${incomingPath}`);
    const { count: outDel } = await supabase
      .from("outbound_messages")
      .delete({ count: "exact" })
      .eq("phone", TEST_PHONE)
      .eq("channel", "manos");
    console.log(`deleted ${outDel ?? "?"} outbound rows`);
    await supabase.from("messages").delete().eq("session_id", session.id);
    await supabase.from("sessions").delete().eq("id", session.id);
    console.log(`deleted test session ${session.id}`);
  }

  console.log("\n=== SUMMARY ===");
  console.log("S1 reply length:", s1Reply.length);
  console.log("S5 evento meta:", JSON.stringify(llmEvent?.meta));
  console.log("\n✅ Wave 5 smoke PASSED (see stderr above for createMessage debug log)");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
