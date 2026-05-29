// finalize_alcance — generates a PDF of the OT scope and uploads to
// alcance-photos/<ot_row_id>/alcance.pdf. Returns the PDF URL.
//
// Reuses the @react-pdf/renderer pattern from dashboard/src/lib/contract-pdf.ts.
// Identity gate: arq_row_id injected from session.meta via agent dispatcher.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";
import { verifyOtOwnership } from "./attach-photos";
import type { AlcanceShape } from "./set-alcance-ot";
import { Readable } from "node:stream";

export interface FinalizeAlcanceInput {
  arq_row_id: string;
  ot_row_id: string;
}

export interface FinalizeAlcanceOutput {
  ot_row_id: string;
  pdf_url: string;
  alcance_pdf_path: string;
}

export async function finalizeAlcance(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult<FinalizeAlcanceOutput>> {
  const arqRowId = typeof args.arq_row_id === "string" ? args.arq_row_id.trim() : "";
  const otRowId = typeof args.ot_row_id === "string" ? args.ot_row_id.trim() : "";

  if (!arqRowId) {
    return err("arq_row_id required — cédula not verified", {
      code: "no_identity",
      missing: ["arq_row_id"],
    });
  }
  if (!otRowId) {
    return err("ot_row_id required", { code: "missing_field", missing: ["ot_row_id"] });
  }

  // Ownership check.
  const ownershipErr = await verifyOtOwnership(ctx, otRowId, arqRowId);
  if (ownershipErr) return ownershipErr;

  // Load the existing alcance_jsonb.
  const { data: extRow, error: extErr } = await ctx.supabase
    .from("ots_extended")
    .select("alcance_jsonb, photo_paths, last_architect_arq_row_id")
    .eq("ot_row_id", otRowId)
    .maybeSingle();

  if (extErr) {
    return err(`ots_extended query failed: ${extErr.message}`, { code: "db_error" });
  }
  if (!extRow?.alcance_jsonb) {
    return err("No alcance found for this OT. Run set_alcance_ot first.", {
      code: "no_alcance",
      user_message_hint: "Primero necesito guardar el alcance. ¿Me cuentas los detalles?",
    });
  }

  const alcance = extRow.alcance_jsonb as unknown as AlcanceShape;
  const photoPaths: string[] = Array.isArray(extRow.photo_paths)
    ? (extRow.photo_paths as string[])
    : [];

  // Load OT metadata for the PDF.
  const { data: otRow } = await ctx.supabase
    .from("ots_mirror")
    .select("ciudad, especialidad, data")
    .eq("row_id", otRowId)
    .maybeSingle();

  const otData = otRow?.data as Record<string, unknown> | null;
  const idOrden =
    (typeof otData?.["ID_Orden"] === "string" ? otData["ID_Orden"] : null) ??
    (typeof otData?.["ID Orden"] === "string" ? otData["ID Orden"] : null) ??
    otRowId.slice(0, 8);
  const descripcion =
    typeof otData?.["Descripcion"] === "string" && otData["Descripcion"].trim()
      ? (otData["Descripcion"] as string).trim()
      : typeof otData?.["Descripción"] === "string" && otData["Descripción"].trim()
      ? (otData["Descripción"] as string).trim()
      : null;
  const otBriefTitle = descripcion ?? `OT ${idOrden}`;

  // Load architect name.
  const { data: arqRow } = await ctx.supabase
    .from("arquitectos_mirror")
    .select("data")
    .eq("row_id", arqRowId)
    .maybeSingle();
  const arqData = arqRow?.data as Record<string, unknown> | null;
  // AppSheet `Arquitecto` table — display-name column is "Arquitecto". Older
  // assumed keys kept as fallbacks for safety.
  const arqNombre =
    (typeof arqData?.["Arquitecto"] === "string" && arqData["Arquitecto"].trim()
      ? (arqData["Arquitecto"] as string).trim()
      : null) ??
    (typeof arqData?.["Nombre"] === "string" && arqData["Nombre"].trim()
      ? (arqData["Nombre"] as string).trim()
      : null) ??
    (typeof arqData?.["Nombre de Arquitecto"] === "string"
      ? (arqData["Nombre de Arquitecto"] as string).trim()
      : null) ??
    "Arquitecto";

  // Resolve each stored photo to an embeddable data URI. photo_paths holds
  // signed URLs which can expire, so we download the bytes via the storage
  // object path (derived from the URL) rather than trusting the URL itself.
  const photos = await resolveAlcancePhotos(ctx, photoPaths);

  // Generate PDF.
  const pdfBuffer = await generateAlcancePdf({
    otRowId,
    idOrden,
    ciudad: otRow?.ciudad ?? "",
    especialidad: alcance.especialidad,
    arqNombre,
    alcance,
    photos,
    generatedAt: new Date().toISOString(),
  });

  const storagePath = `${otRowId}/alcance.pdf`;

  // Upload to alcance-photos bucket.
  const { error: uploadErr } = await ctx.supabase.storage
    .from("alcance-photos")
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadErr) {
    return err(`PDF upload failed: ${uploadErr.message}`, { code: "storage_error" });
  }

  // Get a signed URL (24h — architect sees it immediately after this call).
  const { data: signedData } = await ctx.supabase.storage
    .from("alcance-photos")
    .createSignedUrl(storagePath, 86400);

  const pdfUrl = signedData?.signedUrl ?? `supabase://alcance-photos/${storagePath}`;

  // Update ots_extended with the PDF path.
  await ctx.supabase
    .from("ots_extended")
    .update({
      alcance_pdf_path: storagePath,
      updated_at: new Date().toISOString(),
    })
    .eq("ot_row_id", otRowId);

  // Log event.
  await ctx.supabase.from("eventos").insert({
    type: "alcance_finalized",
    entity_id: otRowId,
    actor: `arquitecto:${arqRowId}`,
    meta: {
      ot_row_id: otRowId,
      arq_row_id: arqRowId,
      storage_path: storagePath,
      photo_count: photoPaths.length,
    },
  });

  // S08 — Architect feedback loop: send link + PDF document back into the
  // Manos WA thread so the architect sees what was generated and can ask
  // for a redo without leaving WhatsApp. Non-fatal — alcance is already
  // finalized in storage; preview-send failures are logged, not raised.
  try {
    await enqueueArchitectAlcancePreview(ctx, {
      otRowId,
      arqRowId,
      storagePath,
      pdfUrl,
      otBriefTitle,
      idOrden,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.warn("manos alcance preview enqueue failed", {
      ot_row_id: otRowId,
      arq_row_id: arqRowId,
      error: msg,
    });
  }

  return ok({
    ot_row_id: otRowId,
    pdf_url: pdfUrl,
    alcance_pdf_path: storagePath,
  });
}

// S08 — Enqueue two outbound_messages rows so the Manos drainer
// (manos/src/outbound.ts) sends the architect (a) a text with a signed
// link to the PDF and (b) the PDF as a native WhatsApp document.
//
// The architect's phone is the phone of the session that invoked this
// tool — looked up via ctx.session_id from the sessions table. If the
// session phone can't be resolved (e.g. tool invoked from a non-WA
// context like a smoke script), the preview is skipped silently.
async function enqueueArchitectAlcancePreview(
  ctx: ToolContext,
  args: {
    otRowId: string;
    arqRowId: string;
    storagePath: string;
    pdfUrl: string;
    otBriefTitle: string;
    idOrden: string;
  }
): Promise<void> {
  const sessionId = ctx.session_id;
  if (!sessionId) {
    ctx.logger.info("manos alcance preview skipped — no session_id in ctx", {
      ot_row_id: args.otRowId,
    });
    return;
  }

  const { data: sessionRow, error: sessionErr } = await ctx.supabase
    .from("sessions")
    .select("phone, channel")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) {
    throw new Error(`sessions lookup failed: ${sessionErr.message}`);
  }
  const architectPhone = sessionRow?.phone;
  if (!architectPhone) {
    ctx.logger.info("manos alcance preview skipped — session has no phone", {
      ot_row_id: args.otRowId,
      session_id: sessionId,
    });
    return;
  }
  // Manos drainer only picks up channel="manos". Anything else (dashboard
  // smoke tools, etc) should not be DMed by mistake.
  if (sessionRow.channel !== "manos") {
    ctx.logger.info("manos alcance preview skipped — session channel != manos", {
      ot_row_id: args.otRowId,
      session_id: sessionId,
      channel: sessionRow.channel,
    });
    return;
  }

  // Mint a fresh 24h signed URL for the link message. The PDF is already
  // uploaded above; this just generates a shareable URL. We re-mint rather
  // than reuse pdfUrl in case storage policy or path changes in future.
  const { data: signed, error: signErr } = await ctx.supabase.storage
    .from("alcance-photos")
    .createSignedUrl(args.storagePath, 86400);
  if (signErr) {
    ctx.logger.warn("signed URL mint failed for preview link", {
      ot_row_id: args.otRowId,
      error: signErr.message,
    });
  }
  const pdfLink = signed?.signedUrl ?? args.pdfUrl;

  const linkBody = pdfLink.startsWith("http")
    ? `Listo. Ya quedó el alcance para "${args.otBriefTitle}".\n\nLo puedes abrir aquí:\n${pdfLink}\n\nTambién te lo paso como documento. Si algo está mal, dime y lo regeneramos.`
    : `Listo. Ya quedó el alcance para "${args.otBriefTitle}". Te lo paso como documento adjunto.`;

  // 1) Text message with signed link (works on laptop browser, easy to forward).
  const { error: textInsErr } = await ctx.supabase.from("outbound_messages").insert({
    phone: architectPhone,
    channel: "manos",
    kind: "text",
    body: linkBody,
    meta: {
      kind: "manos_alcance_preview_link",
      ot_row_id: args.otRowId,
      arq_row_id: args.arqRowId,
    },
  });
  if (textInsErr) {
    throw new Error(`outbound text insert failed: ${textInsErr.message}`);
  }

  // 2) Native WA document attachment (durable in chat history, inline preview).
  const { error: docInsErr } = await ctx.supabase.from("outbound_messages").insert({
    phone: architectPhone,
    channel: "manos",
    kind: "document",
    body: `Alcance OT ${args.idOrden}`,
    attachment_path: args.storagePath,
    attachment_bucket: "alcance-photos",
    attachment_filename: `Alcance_OT_${args.idOrden}.pdf`,
    meta: {
      kind: "manos_alcance_preview_doc",
      ot_row_id: args.otRowId,
      arq_row_id: args.arqRowId,
    },
  });
  if (docInsErr) {
    throw new Error(`outbound document insert failed: ${docInsErr.message}`);
  }

  ctx.logger.info("manos alcance preview enqueued", {
    ot_row_id: args.otRowId,
    arq_row_id: args.arqRowId,
    phone: architectPhone,
  });
}

// ---- PDF generation ----

interface AlcancePdfProps {
  otRowId: string;
  idOrden: string;
  ciudad: string;
  especialidad: string;
  arqNombre: string;
  alcance: AlcanceShape;
  photos: { dataUri: string }[];
  generatedAt: string;
}

const ALCANCE_BUCKET = "alcance-photos";

function objectPathFromStored(stored: string): string {
  const marker = `/${ALCANCE_BUCKET}/`;
  const idx = stored.indexOf(marker);
  const raw = idx >= 0 ? stored.slice(idx + marker.length) : stored;
  const noQuery = raw.split("?")[0] ?? raw;
  return noQuery.startsWith(`${ALCANCE_BUCKET}/`)
    ? noQuery.slice(ALCANCE_BUCKET.length + 1)
    : noQuery;
}

function mediaTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function resolveAlcancePhotos(
  ctx: ToolContext,
  photoPaths: string[]
): Promise<{ dataUri: string }[]> {
  const out: { dataUri: string }[] = [];
  for (const stored of photoPaths) {
    const objectPath = objectPathFromStored(stored);
    const { data, error } = await ctx.supabase.storage
      .from(ALCANCE_BUCKET)
      .download(objectPath);
    if (error || !data) {
      ctx.logger.warn("alcance photo download failed — skipping in PDF", {
        object_path: objectPath,
        error: error?.message,
      });
      continue;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    out.push({ dataUri: `data:${mediaTypeFor(objectPath)};base64,${buf.toString("base64")}` });
  }
  return out;
}

async function generateAlcancePdf(props: AlcancePdfProps): Promise<Buffer> {
  // Dynamic import to avoid bundling @react-pdf/renderer in non-PDF contexts.
  const { pdf, Document, Page, Text, View, Image, StyleSheet } = await import(
    "@react-pdf/renderer"
  );
  const React = await import("react");

  const styles = StyleSheet.create({
    page: { padding: 48, fontSize: 10.5, fontFamily: "Helvetica", lineHeight: 1.45 },
    h1: { fontSize: 14, marginBottom: 4, fontWeight: "bold", textAlign: "center" },
    sub: { fontSize: 9, color: "#475569", marginBottom: 14, textAlign: "center" },
    h2: { fontSize: 11, marginTop: 10, marginBottom: 4, fontWeight: "bold" },
    p: { marginBottom: 5, textAlign: "justify" },
    kv: { marginBottom: 2 },
    list: { marginLeft: 14, marginBottom: 4 },
    listItem: { marginBottom: 2 },
    foot: {
      marginTop: 18,
      fontSize: 8.5,
      color: "#475569",
      borderTopWidth: 1,
      borderTopColor: "#e2e8f0",
      paddingTop: 8,
    },
    photoBlock: { marginBottom: 12 },
    photoLabel: { fontSize: 9, color: "#475569", marginBottom: 3 },
    photo: { maxWidth: 380, maxHeight: 460, objectFit: "contain" },
  });

  const fechaLegible = new Date(props.generatedAt).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const doc = React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "LETTER" as const, style: styles.page },

      React.createElement(Text, { style: styles.h1 }, "ALCANCE DE ORDEN DE TRABAJO"),
      React.createElement(
        Text,
        { style: styles.sub },
        `OT ${props.idOrden} · ${props.ciudad || "Colombia"} · ${fechaLegible}`
      ),

      React.createElement(Text, { style: styles.h2 }, "ARQUITECTO RESPONSABLE"),
      React.createElement(Text, { style: styles.kv }, props.arqNombre),

      React.createElement(Text, { style: styles.h2 }, "ESPECIALIDAD"),
      React.createElement(Text, { style: styles.p }, props.alcance.especialidad),

      ...(props.alcance.subcategoria
        ? [
            React.createElement(Text, { style: styles.h2 }, "SUBCATEGORÍA"),
            React.createElement(Text, { style: styles.p }, props.alcance.subcategoria),
          ]
        : []),

      ...(props.alcance.cantidades && props.alcance.cantidades.length > 0
        ? [
            React.createElement(Text, { style: styles.h2 }, "CANTIDADES"),
            React.createElement(
              View,
              { style: styles.list },
              ...props.alcance.cantidades.map((item, i) =>
                React.createElement(Text, { key: `q${i}`, style: styles.listItem }, `• ${item}`)
              )
            ),
          ]
        : []),

      ...(props.alcance.conditions && props.alcance.conditions.length > 0
        ? [
            React.createElement(Text, { style: styles.h2 }, "CONDICIONES DEL SITIO"),
            React.createElement(
              View,
              { style: styles.list },
              ...props.alcance.conditions.map((item, i) =>
                React.createElement(Text, { key: `c${i}`, style: styles.listItem }, `• ${item}`)
              )
            ),
          ]
        : []),

      ...(props.alcance.schedule_notes
        ? [
            React.createElement(Text, { style: styles.h2 }, "HORARIO / PLAZO"),
            React.createElement(Text, { style: styles.p }, props.alcance.schedule_notes),
          ]
        : []),

      ...(props.alcance.value_estimate
        ? [
            React.createElement(Text, { style: styles.h2 }, "VALOR ESTIMADO"),
            React.createElement(
              Text,
              { style: styles.p },
              `COP ${props.alcance.value_estimate}`
            ),
          ]
        : []),

      React.createElement(Text, { style: styles.h2 }, "RESUMEN"),
      React.createElement(Text, { style: styles.p }, props.alcance.summary),

      ...(props.photos.length > 0
        ? [
            React.createElement(Text, { style: styles.h2 }, "REGISTRO FOTOGRÁFICO"),
            ...props.photos.map((photo, i) =>
              React.createElement(
                View,
                { key: `ph${i}`, style: styles.photoBlock, wrap: false },
                React.createElement(Text, { style: styles.photoLabel }, `Foto ${i + 1}`),
                React.createElement(Image, { style: styles.photo, src: photo.dataUri })
              )
            ),
          ]
        : []),

      React.createElement(
        Text,
        { style: styles.foot },
        `Generado por Manos (Redin Marketplace) el ${fechaLegible}. OT: ${props.otRowId}.`
      )
    )
  );

  const stream = await pdf(doc).toBuffer();
  // pdf().toBuffer() may return a Buffer or a Readable depending on version.
  if (Buffer.isBuffer(stream)) return stream;
  // Handle Readable.
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
