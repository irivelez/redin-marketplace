// attach_photos — appends photo URLs to an OT's ots_extended row.
//
// Identity gate: arq_row_id injected from session.meta via agent dispatcher.
// Ownership check: validates that ots_mirror.data->>'ID_Arquitecto' = arq_row_id.
//
// Security: `photo_urls` originate from the LLM and end up persisted verbatim
// into ots_extended.photo_paths, then later passed back to Supabase Storage by
// view_photo / finalize_alcance (and by the alcance PDF generator) to fetch
// bytes from the alcance-photos bucket. If we trusted whatever the model said,
// a prompt injection could persist a path that, once normalized by toObjectPath
// / objectPathFromStored, points outside `incoming/<phone>/` — exfiltrating any
// object in the bucket the service role can read. Fail-closed at the input
// gate: the only shapes we accept are (a) the legitimate signed URL the system
// itself minted in manos/src/whatsapp.ts handleImageMessage, or (b) a bare
// object key under `incoming/<phone>/<uuid>.<ext>`. Phone is resolved from the
// session that produced this turn (ctx.session_id → sessions.phone) when
// available; if not, we still enforce the same path SHAPE so traversal /
// arbitrary-bucket reads stay blocked.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";

export interface AttachPhotosInput {
  arq_row_id: string;
  ot_row_id: string;
  photo_urls: string[];
}

// Object-key shape we mint in manos/src/whatsapp.ts:
//   incoming/<phone>/<uuid>.jpg
// UUID is generated via crypto.randomUUID() (RFC 4122 — 8-4-4-4-12 hex digits,
// 36 chars total including hyphens). Extensions are limited to image types the
// upload pipeline (JPEG/PNG/WebP) actually produces. Case-insensitive on the
// extension so .JPG / .JPEG are not rejected on a roundtrip.
const PHOTO_OBJECT_PATH_RE =
  /^incoming\/[^/]+\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpe?g|png|webp)$/i;
const PHOTO_BUCKET = "alcance-photos";

/** Reduce a stored entry to its bucket-relative object key, or null if the
 *  shape isn't one we mint. Mirrors view-photo.toObjectPath but returns null
 *  on anything suspicious so caller can fail-closed. */
function extractObjectKey(entry: string): string | null {
  if (typeof entry !== "string" || entry.length === 0) return null;
  // Reject leading slash and parent-traversal segments anywhere in the input
  // BEFORE we slice — defense in depth in case the regex misses an encoding.
  if (entry.startsWith("/")) return null;
  if (entry.split("/").includes("..")) return null;

  // Full https signed URL? Locate the bucket marker and extract the path.
  if (/^https:\/\//i.test(entry)) {
    const marker = `/${PHOTO_BUCKET}/`;
    const idx = entry.indexOf(marker);
    if (idx < 0) return null;
    const afterPrefix = entry.slice(idx + marker.length);
    const qIdx = afterPrefix.indexOf("?");
    const key = qIdx >= 0 ? afterPrefix.slice(0, qIdx) : afterPrefix;
    if (!key || key.startsWith("/") || key.split("/").includes("..")) return null;
    return key;
  }
  // Bare object key.
  return entry;
}

/** Validate an LLM-supplied entry. Optional `expectedPhone` tightens the
 *  shape to `incoming/<phone>/...` when we have the session phone. */
export function isValidPhotoEntry(entry: string, expectedPhone?: string): boolean {
  const key = extractObjectKey(entry);
  if (!key) return false;
  if (!PHOTO_OBJECT_PATH_RE.test(key)) return false;
  if (expectedPhone) {
    // [^/]+ in the base regex already isolates the phone segment.
    const parts = key.split("/");
    if (parts.length < 3) return false;
    if (parts[1] !== expectedPhone) return false;
  }
  return true;
}

export interface AttachPhotosOutput {
  ot_row_id: string;
  total_photos: number;
}

export async function attachPhotos(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult<AttachPhotosOutput>> {
  const arqRowId = typeof args.arq_row_id === "string" ? args.arq_row_id.trim() : "";
  const otRowId = typeof args.ot_row_id === "string" ? args.ot_row_id.trim() : "";
  const photoUrls = Array.isArray(args.photo_urls)
    ? (args.photo_urls as unknown[]).filter((u): u is string => typeof u === "string")
    : [];

  if (!arqRowId) {
    return err("arq_row_id required — cédula not verified", {
      code: "no_identity",
      missing: ["arq_row_id"],
    });
  }
  if (!otRowId) {
    return err("ot_row_id required", { code: "missing_field", missing: ["ot_row_id"] });
  }
  if (photoUrls.length === 0) {
    return err("photo_urls must contain at least one URL", {
      code: "missing_field",
      missing: ["photo_urls"],
    });
  }

  const expectedPhone = await resolveSessionPhone(ctx);
  for (const entry of photoUrls) {
    if (!isValidPhotoEntry(entry, expectedPhone)) {
      return err(
        "photo_urls contained an entry that is not a recognised alcance-photos signed URL or incoming/<phone>/<uuid>.<ext> object key",
        { code: "invalid_photo_url" }
      );
    }
  }

  const ownershipErr = await verifyOtOwnership(ctx, otRowId, arqRowId);
  if (ownershipErr) return ownershipErr;

  // Upsert ots_extended row and append photo_paths.
  const { data: existing } = await ctx.supabase
    .from("ots_extended")
    .select("photo_paths")
    .eq("ot_row_id", otRowId)
    .maybeSingle();

  const currentPaths: string[] = Array.isArray(existing?.photo_paths)
    ? (existing.photo_paths as string[])
    : [];
  const updatedPaths = [...currentPaths, ...photoUrls];

  const attachPayload = {
    ot_row_id: otRowId,
    photo_paths: updatedPaths,
    last_architect_arq_row_id: arqRowId,
    updated_at: new Date().toISOString(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upsertErr } = await ctx.supabase
    .from("ots_extended")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(attachPayload as any, { onConflict: "ot_row_id" });

  if (upsertErr) {
    return err(`ots_extended upsert failed: ${upsertErr.message}`, { code: "db_error" });
  }

  // Log event.
  await ctx.supabase.from("eventos").insert({
    type: "alcance_photo_attached",
    entity_id: otRowId,
    actor: `arquitecto:${arqRowId}`,
    meta: { ot_row_id: otRowId, arq_row_id: arqRowId, photo_count: photoUrls.length },
  });

  return ok({ ot_row_id: otRowId, total_photos: updatedPaths.length });
}

async function resolveSessionPhone(ctx: ToolContext): Promise<string | undefined> {
  const sessionId = ctx.session_id;
  if (!sessionId) return undefined;
  try {
    const { data } = await ctx.supabase
      .from("sessions")
      .select("phone")
      .eq("id", sessionId)
      .maybeSingle();
    const phone = data?.phone;
    return typeof phone === "string" && phone.length > 0 ? phone : undefined;
  } catch {
    return undefined;
  }
}

// Architects scope OTs BEFORE execution. States 1-4 are pre-execution
// (creation, validation, coordination, ready-to-execute). Once an OT moves
// into state 5+ the technician is already engaged and scope must not be
// rewritten — that protects the blue-collar from a moving target mid-job.
// AppSheet literals are prefix-matched (e.g. "1. ...", "2. ...", "3. ...",
// "4. Coordinar – Listo para ejecutar") because the suffix wording has
// changed historically without warning.
export const SCOPABLE_STATE_PREFIXES = ["1.", "2.", "3.", "4."] as const;

// Shared ownership + state verifier — used by all 3 write tools
// (set_alcance_ot, attach_photos, finalize_alcance). It is the single
// authoritative gate for "can this architect mutate this OT's scope right
// now?". Returning a ToolError short-circuits the calling tool.
export async function verifyOtOwnership(
  ctx: ToolContext,
  otRowId: string,
  arqRowId: string
): Promise<ToolResult<never> | null> {
  const { data: otRow, error } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id, estado, data")
    .eq("row_id", otRowId)
    .maybeSingle();

  if (error) {
    return err(`ots_mirror query failed: ${error.message}`, { code: "db_error" });
  }
  if (!otRow) {
    return err("OT not found", {
      code: "not_found",
      user_message_hint: "Esa OT no existe en el sistema.",
    });
  }

  const d = otRow.data as Record<string, unknown>;
  // AppSheet `Ordenes_Trabajo` column for the assigned architect is `ID_Arquitecto`
  // (foreign key to arquitectos_mirror.row_id). `Arquitecto_Asignado` is a
  // separate (and in practice empty) AppSheet field; do not rely on it.
  const idArq = String(d["ID_Arquitecto"] ?? "").trim();
  if (idArq !== arqRowId) {
    const realName = typeof d["Nombre_Arquitecto_Real"] === "string"
      ? (d["Nombre_Arquitecto_Real"] as string).trim()
      : "";
    const hint = realName
      ? `Esa OT está asignada a ${realName}, no a ti — no puedo editar el alcance.`
      : "Esa OT no está asignada a ti — no puedo editar el alcance.";
    return err("OT is not assigned to this architect", {
      code: "not_your_ot",
      user_message_hint: hint,
    });
  }

  // State gate: only OTs in pre-execution states 1-4 may have their scope
  // edited from Manos. Anything else (5+ executing, 6+ closed, etc.) is
  // rejected with not_scopable_state so the LLM can explain to the
  // architect that the moment to capture scope has passed.
  const estado = typeof otRow.estado === "string" ? otRow.estado.trim() : "";
  const scopable = SCOPABLE_STATE_PREFIXES.some((p) => estado.startsWith(p));
  if (!scopable) {
    return err("OT is not in a scopable state", {
      code: "not_scopable_state",
      user_message_hint: `Esa OT está en estado "${estado}". Solo puedo capturar alcance para OTs en estados 1-4 (antes de ejecución).`,
    });
  }

  return null; // ownership + state verified
}
