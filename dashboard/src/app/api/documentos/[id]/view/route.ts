// HR-side viewer for a single document uploaded by a worker. Auth-gated;
// resolves the documentos row, downloads the binary from the `documentos`
// Storage bucket, and streams it back inline (so PDF/JPG render in browser).
//
// Mirrors the contract/draft pattern — same auth pattern, same Blob wrap.
// Bucket is `documentos` (see tools/src/upload-documento.ts:16).

import { NextResponse } from "next/server";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Map common extensions to content-types. Falls back to octet-stream which
// browsers will treat as a download. We sniff the filename in storage_path
// because the original mime isn't persisted on the documentos row.
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const supa = serviceClient();
  const { data: doc, error } = await supa
    .from("documentos")
    .select("id, tecnico_id, tipo, storage_path, uploaded_at")
    .eq("id", params.id)
    .maybeSingle();
  if (error || !doc) {
    return NextResponse.json({ error: "documento not found" }, { status: 404 });
  }

  const { data: blob, error: dlErr } = await supa.storage
    .from("documentos")
    .download(doc.storage_path);
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: `storage download failed: ${dlErr?.message ?? "no body"}` },
      { status: 502 }
    );
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  const mime = mimeFromPath(doc.storage_path);
  // Inline disposition so PDFs/images render in the browser tab; HR can
  // still right-click → save.
  const filename = `${doc.tipo}-${doc.id.slice(0, 8)}.${(doc.storage_path.split(".").pop() ?? "bin")}`;
  return new Response(new Blob([new Uint8Array(buffer)], { type: mime }), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
