// upload_documento — stores a document in Supabase Storage, writes documentos row,
// logs an event. Two modes:
//   1) content + contentType + filename  → this tool uploads to storage
//   2) storage_path already set          → we only record the row (dashboard already uploaded)

import { randomUUID } from "node:crypto";
import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  ToolResult,
  UploadDocumentoInput,
  UploadDocumentoNextAction,
  UploadDocumentoOutput,
} from "./types";
import { err, ok } from "./types";
import { classifyDocumento } from "./classify-documento";

const BUCKET = "documentos";
const VALID_TIPOS = new Set([
  "cedula",
  "cert_electrica",
  "arl",
  "ss",
  "altura",
  "antecedentes",
  "otro",
  // Story 17: optional dossier document types
  "cert_estudios",
  "cert_trabajos_previos",
  "evidencia_arl",
  // 2026-05-17: EPS evidence (self-declared eps_activa + uploaded carné)
  "evidencia_eps",
]);

function safeFilename(name: string): string {
  // Strip path components and anything weird. Keep dots for extension.
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
}

// How recently-created sibling rows count as "the same photo burst".
// WhatsApp batching holds a burst ≤8s; one LLM turn adds ~15-30s.
const BURST_WINDOW_MS = 60_000;

const TIPO_LABELS: Record<string, { label: string; plural: boolean }> = {
  cedula: { label: "tu cédula", plural: false },
  evidencia_arl: { label: "tu ARL", plural: false },
  arl: { label: "tu ARL", plural: false },
  evidencia_eps: { label: "tu EPS", plural: false },
  ss: { label: "tu seguridad social", plural: false },
  cert_estudios: { label: "tu certificado de estudios", plural: false },
  cert_trabajos_previos: { label: "tu constancia de trabajos", plural: false },
  cert_electrica: { label: "tu certificación eléctrica", plural: false },
  altura: { label: "tu certificado de alturas", plural: false },
  antecedentes: { label: "tus antecedentes", plural: true },
  otro: { label: "tu documento", plural: false },
};

interface AckCounts {
  cedulaTotal: number;
  burstSameTipo: number;
  burstMixed: boolean;
}

// Counts come from rows ALREADY inserted (including the current one), so the
// ack can name what we actually hold — never claim receipt of something that
// failed to persist.
async function loadAckCounts(
  ctx: ToolContext,
  tecnico_id: string,
  tipo: string
): Promise<AckCounts> {
  const counts: AckCounts = { cedulaTotal: 0, burstSameTipo: 1, burstMixed: false };
  try {
    const sinceIso = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const { data: recent } = await ctx.supabase
      .from("documentos")
      .select("tipo")
      .eq("tecnico_id", tecnico_id)
      .gte("created_at", sinceIso);
    const rows = recent ?? [];
    counts.burstSameTipo = Math.max(1, rows.filter((r) => r.tipo === tipo).length);
    counts.burstMixed = rows.some((r) => r.tipo !== tipo);
    if (tipo === "cedula") {
      const { count } = await ctx.supabase
        .from("documentos")
        .select("id", { count: "exact", head: true })
        .eq("tecnico_id", tecnico_id)
        .eq("tipo", "cedula");
      counts.cedulaTotal = count ?? 1;
    }
  } catch {
    // Counting is best-effort: a failed count degrades to a generic ack,
    // never to a failed upload.
  }
  return counts;
}

function buildAck(
  tipo: string,
  counts: AckCounts
): { suggested_reply: string; next_action: UploadDocumentoNextAction } {
  if (counts.burstMixed) {
    return {
      suggested_reply: "Recibí varias fotos. Las estoy clasificando.",
      next_action: "wait_for_classification",
    };
  }
  if (tipo === "cedula") {
    if (counts.cedulaTotal <= 1) {
      return {
        suggested_reply:
          "Listo, recibí tu cédula por la cara de adelante. Mándame ahora la de atrás.",
        next_action: "request_back_side",
      };
    }
    if (counts.cedulaTotal === 2) {
      return {
        suggested_reply: "Listo, recibí las dos caras de tu cédula. Sigamos.",
        next_action: "proceed_to_screening",
      };
    }
    return {
      suggested_reply:
        counts.burstSameTipo > 2
          ? `Listo, recibí las ${counts.burstSameTipo} fotos de tu cédula. Sigamos.`
          : "Listo, ya tengo las fotos de tu cédula. Sigamos.",
      next_action: "proceed_to_screening",
    };
  }
  const { label, plural } = TIPO_LABELS[tipo] ?? TIPO_LABELS["otro"]!;
  if (counts.burstSameTipo > 1) {
    return {
      suggested_reply: `Listo, recibí las ${counts.burstSameTipo} fotos de ${label}. El equipo las revisa.`,
      next_action: "done",
    };
  }
  return {
    suggested_reply: `Listo, recibí ${label}. El equipo ${plural ? "los" : "lo"} revisa.`,
    next_action: "done",
  };
}

export async function uploadDocumento(
  ctx: ToolContext,
  input: UploadDocumentoInput
): Promise<ToolResult<UploadDocumentoOutput>> {
  const INVALID_INPUT_HINTS = {
    user_message_hint: "Dame un segundo, estoy registrando tu foto.",
    suggested_recovery: "retry_upload" as const,
  };
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input", ...INVALID_INPUT_HINTS });
  }
  if (!VALID_TIPOS.has(input.tipo)) {
    return err(`tipo must be one of: ${[...VALID_TIPOS].join(", ")}`, {
      code: "invalid_input",
      ...INVALID_INPUT_HINTS,
    });
  }
  if (!input.storage_path && !input.content) {
    return err("either storage_path or content must be provided", {
      code: "invalid_input",
      ...INVALID_INPUT_HINTS,
    });
  }

  // Verify the técnico exists.
  const { data: tec, error: tecErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (tecErr) {
    return err(`db error: ${tecErr.message}`, {
      code: "db_error",
      retryable: true,
      user_message_hint:
        "Uy, se me trabó el sistema guardando tu foto. Dame un momento y lo intento de nuevo.",
      suggested_recovery: "retry_upload",
    });
  }
  if (!tec) {
    return err("tecnico_id not found", {
      code: "not_found",
      user_message_hint:
        "Tuve un lío registrando tu documento. Ya le aviso al equipo de Redin para que te ayuden.",
      suggested_recovery: "escalate_to_hr",
    });
  }

  let storagePath = input.storage_path?.trim() ?? "";

  if (!storagePath) {
    const fname = safeFilename(input.filename || "documento");
    storagePath = `${input.tecnico_id}/${input.tipo}/${Date.now()}-${randomUUID()}-${fname}`;
    const body = input.content instanceof Buffer ? input.content : Buffer.from(input.content!);
    const { error: upErr } = await ctx.supabase.storage
      .from(BUCKET)
      .upload(storagePath, body, {
        contentType: input.contentType ?? "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      return err(`storage upload failed: ${upErr.message}`, {
        code: "storage_error",
        retryable: true,
        user_message_hint: "Hubo un problema recibiendo tu foto. ¿Me la reenvías, por favor?",
        suggested_recovery: "retry_upload",
      });
    }
  }

  const { data: inserted, error: insertErr } = await ctx.supabase
    .from("documentos")
    .insert({
      tecnico_id: input.tecnico_id,
      tipo: input.tipo,
      storage_path: storagePath,
    })
    .select("id")
    .single();
  if (insertErr) {
    return err(`insert failed: ${insertErr.message}`, {
      code: "db_error",
      retryable: true,
      user_message_hint:
        "Uy, se me trabó el sistema guardando tu foto. Dame un momento y lo intento de nuevo.",
      suggested_recovery: "retry_upload",
    });
  }

  await recordEvent(ctx, {
    type: "document_uploaded",
    entity_id: inserted.id,
    actor: input.actor ?? ctx.defaultActor,
    meta: {
      tecnico_id: input.tecnico_id,
      tipo: input.tipo,
      storage_path: storagePath,
    },
  });

  // Fire-and-forget: classify the doc so HR's DocViewer shows Toño's verdict
  // without waiting on LLM compliance to call classify_documento manually.
  // Latency from Gemini multimodal (~3-5s) would block the WA reply, so we
  // intentionally do not await. Failures only become a warning log entry —
  // the upload itself is durable in storage and the documentos row already
  // exists.
  void classifyDocumento(ctx, {
    documento_id: inserted.id,
    expected_tipo: input.tipo,
  }).catch((e: unknown) => {
    ctx.logger.warn("upload_documento: auto-classify failed (non-blocking)", {
      documento_id: inserted.id,
      tipo: input.tipo,
      error: e instanceof Error ? e.message : String(e),
    });
  });

  const counts = await loadAckCounts(ctx, input.tecnico_id, input.tipo);
  const ack = buildAck(input.tipo, counts);

  return ok({
    documento_id: inserted.id,
    storage_path: storagePath,
    document_type: input.tipo,
    suggested_reply: ack.suggested_reply,
    next_action: ack.next_action,
  });
}
