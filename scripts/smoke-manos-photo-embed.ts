// Smoke for the Manos photo fixes:
//   1. describePhoto() returns a Spanish vision caption for a real site photo
//      (proves the scope can now reflect what's in the photo).
//   2. finalizeAlcance() embeds that photo into alcance.pdf (proves the report
//      shows the image, not just a "N fotos" placeholder).
//
// SELF-CLEANING + SAFE: uses a fake session phone (+19999999900) so the Manos
// drainer can't deliver to a real architect. Snapshots and restores the TEST
// OT's photo_paths, deletes the temp incoming photo, the 2 preview outbound
// rows, and the test session.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/smoke-manos-photo-embed.ts

import { createServerClient, createLogger } from "@redin/shared";
import { finalizeAlcance } from "@redin/tools/manos";
import { makeDefaultToolContext } from "@redin/tools";
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
  const logger = createLogger("smoke-photo-embed");
  const photoBytes = readFileSync(PHOTO);

  console.log("\n=== PART 1: vision caption (describePhoto) ===");
  const caption = await describePhoto(photoBytes, "image/jpeg");
  console.log("caption:", caption);
  if (!caption || caption.length < 15) fail("describePhoto returned no usable caption");
  console.log("✅ vision caption produced");

  console.log("\n=== PART 2: PDF embeds the photo ===");
  const incomingPath = `incoming/${TEST_PHONE}/${randomUUID()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("alcance-photos")
    .upload(incomingPath, photoBytes, { contentType: "image/jpeg", upsert: false });
  if (upErr) throw new Error(`temp photo upload failed: ${upErr.message}`);
  const { data: signed } = await supabase.storage
    .from("alcance-photos")
    .createSignedUrl(incomingPath, 3600);
  const photoUrl = signed?.signedUrl;
  if (!photoUrl) throw new Error("could not sign temp photo");

  const { data: extBefore } = await supabase
    .from("ots_extended")
    .select("photo_paths")
    .eq("ot_row_id", OT_ROW_ID)
    .maybeSingle();
  const originalPhotoPaths = Array.isArray(extBefore?.photo_paths)
    ? (extBefore!.photo_paths as string[])
    : [];

  const { data: session } = await supabase
    .from("sessions")
    .insert({ phone: TEST_PHONE, channel: "manos" })
    .select("id")
    .single();
  if (!session) throw new Error("session create failed");

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("ots_extended")
      .update({ photo_paths: [photoUrl] } as any)
      .eq("ot_row_id", OT_ROW_ID);

    const ctx = makeDefaultToolContext({ supabase, logger, session_id: session.id });
    const result = await finalizeAlcance(ctx, {
      arq_row_id: ARQ_ROW_ID,
      ot_row_id: OT_ROW_ID,
    });
    if (!result.ok) fail(`finalizeAlcance failed: ${result.error} (${result.code})`);

    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from("alcance-photos")
      .download(`${OT_ROW_ID}/alcance.pdf`);
    if (dlErr || !pdfBlob) fail(`could not download generated PDF: ${dlErr?.message}`);
    const pdf = Buffer.from(await pdfBlob!.arrayBuffer());
    const hex = pdf.toString("hex");

    console.log(`pdf bytes: ${pdf.length}`);
    if (pdf.subarray(0, 4).toString() !== "%PDF") fail("output is not a PDF");
    const hasJpegBytes = hex.includes("ffd8ff");
    const hasImageXObject = pdf.includes("/Image") || pdf.includes("DCTDecode");
    if (!hasJpegBytes) fail("PDF contains no embedded JPEG (no SOI marker)");
    if (!hasImageXObject) fail("PDF has no image XObject (/Image or DCTDecode)");
    if (pdf.length < 20_000) fail(`PDF suspiciously small (${pdf.length}B) — image likely not embedded`);
    console.log("✅ PDF contains an embedded JPEG image XObject");
  } finally {
    console.log("\n--- cleanup ---");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("ots_extended")
      .update({ photo_paths: originalPhotoPaths } as any)
      .eq("ot_row_id", OT_ROW_ID);
    console.log(`restored photo_paths (${originalPhotoPaths.length} entries)`);
    await supabase.storage.from("alcance-photos").remove([incomingPath]);
    console.log(`removed temp photo ${incomingPath}`);
    const { count } = await supabase
      .from("outbound_messages")
      .delete({ count: "exact" })
      .eq("phone", TEST_PHONE)
      .eq("channel", "manos");
    console.log(`deleted ${count ?? "?"} outbound rows`);
    await supabase.from("sessions").delete().eq("id", session.id);
    console.log(`deleted test session ${session.id}`);
  }

  console.log("\n✅ ALL ASSERTIONS PASSED — vision + PDF embed both work");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
