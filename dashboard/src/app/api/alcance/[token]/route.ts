// Public, token-gated viewer for an OT's alcance (scope) PDF. No login — the
// HMAC token in the URL proves the caller holds a link we minted (see
// @redin/shared ot-public-token). This is what we write into AppSheet's
// Alcance_OT column so HR/Jose can click straight to the scope PDF.
//
// Streams the PDF inline from the private `alcance-photos` bucket via the
// service-role client. Mirrors the documentos/[id]/view streaming pattern.

import { NextResponse } from "next/server";
import { verifyOtPublicToken } from "@redin/shared";
import { serviceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { token: string } }
) {
  const secret = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!secret) {
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  const otRowId = verifyOtPublicToken(params.token, secret);
  if (!otRowId) {
    return NextResponse.json({ error: "invalid or expired link" }, { status: 404 });
  }

  const supa = serviceClient();
  const { data: ote, error } = await supa
    .from("ots_extended")
    .select("ot_row_id, alcance_pdf_path")
    .eq("ot_row_id", otRowId)
    .maybeSingle();
  if (error || !ote?.alcance_pdf_path) {
    return NextResponse.json({ error: "alcance not found" }, { status: 404 });
  }

  const { data: blob, error: dlErr } = await supa.storage
    .from("alcance-photos")
    .download(ote.alcance_pdf_path);
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: `storage download failed: ${dlErr?.message ?? "no body"}` },
      { status: 502 }
    );
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  const filename = `alcance-${otRowId.slice(0, 8)}.pdf`;
  return new Response(new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
