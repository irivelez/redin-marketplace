// view_photo — re-attach a previously-uploaded architect photo to the live
// LLM turn as a native Anthropic image block.
//
// Identity gate: arq_row_id injected from session.meta via agent dispatcher.
// Ownership check: shared verifyOtOwnership (same gate as attach_photos /
// set_alcance_ot / finalize_alcance).
//
// Storage: photo_paths in ots_extended may contain EITHER a bare object key
// ("incoming/<phone>/<uuid>.jpg") OR a signed-URL string left over from a
// prior attach_photos call. Both are reduced to the same object key under
// alcance-photos/, then a fresh 1h signed URL is minted. We never echo the
// stored URL — its signature may have expired by the time the model decides
// to re-examine.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";
import { verifyOtOwnership } from "./attach-photos";

export interface ViewPhotoInput {
  arq_row_id: string;
  ot_row_id: string;
  n: number;
}

export interface ViewPhotoOutput {
  image_url: string;
  n: number;
  caption?: string;
}

const BUCKET = "alcance-photos";
const SIGNED_URL_TTL_SECONDS = 3600;

// Normalize a photo_paths entry to a bucket-relative object key.
// Accepts both bare keys and full https signed URLs (.../alcance-photos/<key>?<query>).
function toObjectPath(entry: string): string {
  const marker = `/${BUCKET}/`;
  const idx = entry.indexOf(marker);
  const afterPrefix = idx >= 0 ? entry.slice(idx + marker.length) : entry;
  const qIdx = afterPrefix.indexOf("?");
  return qIdx >= 0 ? afterPrefix.slice(0, qIdx) : afterPrefix;
}

export async function viewPhoto(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult<ViewPhotoOutput>> {
  const arqRowId = typeof args.arq_row_id === "string" ? args.arq_row_id.trim() : "";
  const otRowId = typeof args.ot_row_id === "string" ? args.ot_row_id.trim() : "";
  const nRaw = args.n;
  const n =
    typeof nRaw === "number"
      ? Math.trunc(nRaw)
      : typeof nRaw === "string"
      ? Math.trunc(Number(nRaw))
      : NaN;

  if (!arqRowId) {
    return err("arq_row_id required — cédula not verified", {
      code: "no_identity",
      missing: ["arq_row_id"],
    });
  }
  if (!otRowId) {
    return err("ot_row_id required", { code: "missing_field", missing: ["ot_row_id"] });
  }
  if (!Number.isFinite(n) || n < 1) {
    return err("n must be a positive integer (1 = first photo)", {
      code: "photo_not_found",
    });
  }

  const ownershipErr = await verifyOtOwnership(ctx, otRowId, arqRowId);
  if (ownershipErr) return ownershipErr;

  const { data: ext, error: extErr } = await ctx.supabase
    .from("ots_extended")
    .select("photo_paths")
    .eq("ot_row_id", otRowId)
    .maybeSingle();

  if (extErr) {
    return err(`ots_extended query failed: ${extErr.message}`, { code: "db_error" });
  }

  const paths: string[] = Array.isArray(ext?.photo_paths)
    ? (ext.photo_paths as string[])
    : [];

  if (paths.length === 0) {
    return err("Esta OT no tiene fotos adjuntas todavía.", {
      code: "photo_not_found",
      user_message_hint: "Esta OT no tiene fotos adjuntas todavía.",
    });
  }

  if (n > paths.length) {
    return err(`OT tiene ${paths.length} foto(s); pediste la #${n}.`, {
      code: "photo_not_found",
      user_message_hint: `Esta OT solo tiene ${paths.length} foto(s).`,
    });
  }

  const rawEntry = paths[n - 1];
  if (typeof rawEntry !== "string" || rawEntry.length === 0) {
    return err(`photo_paths[${n - 1}] is empty`, { code: "photo_not_found" });
  }

  const objectPath = toObjectPath(rawEntry);
  const { data: signed, error: signErr } = await ctx.supabase.storage
    .from(BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    return err(
      `could not sign photo URL: ${signErr?.message ?? "no signedUrl returned"}`,
      { code: "storage_error" }
    );
  }

  return ok({ image_url: signed.signedUrl, n });
}
