// classify_documento — Gemini 2.5 Flash multimodal document classifier.
//
// Called IMMEDIATELY after upload_documento to confirm the uploaded file
// matches the claimed tipo. If matches_expected=false, the agent re-prompts
// the worker to upload the correct document.
//
// Cost note: ~$0.001/call (Gemini 2.5 Flash vision).
// No per-call spend cap per decision #10 — Gemini Flash is cheap enough.
//
// Failure contract:
//   - Gemini 5xx → retry once after 500ms → on second failure returns
//     err('classifier_unavailable', retryable: true). The agent loop handles
//     this gracefully; it must NOT block the worker conversation.
//   - 5 second hard timeout via Promise.race.
//   - If the document is unreadable (bad scan, wrong file type) the model
//     returns classified_type='unreadable', confidence=0 — not an error.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  ClassifyDocumentoInput,
  ClassifyDocumentoOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

const MODEL_ID = "gemini-2.5-flash-preview-05-20";
const TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 500;

// Canonical tipo values the classifier may return.
const VALID_CLASSIFIED_TYPES = new Set([
  "cedula",
  "cert_electrica",
  "arl",
  "ss",
  "altura",
  "antecedentes",
  "cert_estudios",
  "cert_trabajos_previos",
  "evidencia_arl",
  "evidencia_eps",
  "paz_y_salvo",
  "contrato",
  "otro",
  "unreadable",
]);

// Loose alias map: worker-claimed tipo → classifier may return these equivalents.
// e.g. worker says "arl" → classifier returns "evidencia_arl" → still a match.
const LOOSE_MATCH_ALIASES: Record<string, string[]> = {
  arl: ["evidencia_arl", "arl"],
  evidencia_arl: ["arl", "evidencia_arl"],
  eps: ["evidencia_eps", "eps"],
  evidencia_eps: ["eps", "evidencia_eps"],
  ss: ["ss", "evidencia_eps"], // seguro social sometimes filed as eps
};

function looseMatch(classified: string, expected: string | undefined): boolean {
  if (!expected) return true; // no expectation = always a match
  if (classified === expected) return true;
  const aliases = LOOSE_MATCH_ALIASES[expected] ?? [];
  return aliases.includes(classified);
}

// Gemini response JSON schema (passed as response_schema for JSON mode).
const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    classified_type: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
    extracted_fields: {
      type: SchemaType.OBJECT,
      properties: {
        nombre: { type: SchemaType.STRING },
        cedula: { type: SchemaType.STRING },
        fecha_emision: { type: SchemaType.STRING },
        fecha_vencimiento: { type: SchemaType.STRING },
        eps_nombre: { type: SchemaType.STRING },
        arl_nombre: { type: SchemaType.STRING },
      },
      nullable: true,
    },
    discrepancies: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
  },
  required: ["classified_type", "confidence"],
};

interface GeminiClassifyResult {
  classified_type: string;
  confidence: number;
  extracted_fields?: Record<string, string | null>;
  discrepancies?: string[];
}

async function callGeminiClassifier(
  apiKey: string,
  fileUrl: string,
  mimeType: string
): Promise<GeminiClassifyResult> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      temperature: 0.1, // deterministic — we need consistent classification
      responseMimeType: "application/json",
      // @ts-expect-error — response_schema is in the API but not fully typed yet
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const prompt =
    "Analiza este documento. Clasifícalo en UNO de: " +
    "cedula | cert_electrica | arl | ss | altura | antecedentes | " +
    "cert_estudios | cert_trabajos_previos | evidencia_arl | evidencia_eps | " +
    "paz_y_salvo | contrato | otro. " +
    'Devuelve JSON: {classified_type: "<tipo>", confidence: 0-1, ' +
    "extracted_fields: {nombre?, cedula?, fecha_emision?, fecha_vencimiento?, eps_nombre?, arl_nombre?}, " +
    'discrepancies: string[]}. ' +
    "Si NO puedes leer el documento, classified_type='unreadable', confidence=0.";

  const result = await model.generateContent([
    {
      inlineData: undefined as never, // force fileData path below
    },
    {
      fileData: {
        fileUri: fileUrl,
        mimeType,
      },
    },
    { text: prompt },
  ]);

  const text = result.response.text();
  // JSON mode should give clean JSON, but be defensive.
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  const parsed = JSON.parse(jsonText) as GeminiClassifyResult;
  return parsed;
}

// Wraps the Gemini call with a 5-second hard timeout and one retry on 5xx.
async function callWithRetry(
  apiKey: string,
  fileUrl: string,
  mimeType: string
): Promise<GeminiClassifyResult> {
  const attempt = async (): Promise<GeminiClassifyResult> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("classifier_timeout")), TIMEOUT_MS)
    );
    return Promise.race([callGeminiClassifier(apiKey, fileUrl, mimeType), timeout]);
  };

  try {
    return await attempt();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Retry once after RETRY_DELAY_MS for transient errors.
    const isRetryable =
      msg.includes("classifier_timeout") ||
      msg.includes("503") ||
      msg.includes("500") ||
      msg.includes("502");
    if (!isRetryable) throw e;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await attempt();
  }
}

export async function classifyDocumento(
  ctx: ToolContext,
  input: ClassifyDocumentoInput
): Promise<ToolResult<ClassifyDocumentoOutput>> {
  if (!input.documento_id?.trim()) {
    return err("documento_id required", { code: "invalid_input" });
  }

  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    return err("GEMINI_API_KEY not configured", { code: "config_error" });
  }

  // 1. Look up the documento row.
  const { data: doc, error: docErr } = await ctx.supabase
    .from("documentos")
    .select("id, tecnico_id, tipo, storage_path")
    .eq("id", input.documento_id)
    .maybeSingle();

  if (docErr) {
    return err(`db error: ${docErr.message}`, { code: "db_error", retryable: true });
  }
  if (!doc) {
    return err("documento not found", { code: "not_found" });
  }

  // SECURITY (2026-05-28): Ownership check — prevent cross-worker PII leak.
  // The LLM controls documento_id and the schema has no tecnico_id arg, so
  // the router can't override it. Without this check, a worker who gets any
  // other worker's documento_id into the LLM context (via leaked logs, a
  // future tool return, or prompt injection) could trigger classification of
  // foreign cédula/EPS/ARL evidence. Habeas Data Ley 1581 violation.
  //
  // ctx.session_tecnico_id is the live TurnSession value injected by Toño's
  // routedDispatch (agent.ts). Absent in smoke-test / dashboard-direct calls
  // (no WA session backing the call) — ownership check skips for those.
  if (ctx.session_tecnico_id && ctx.session_tecnico_id !== doc.tecnico_id) {
    ctx.logger.warn("classify_documento: cross-worker access blocked", {
      session_id: ctx.session_id,
      session_tecnico_id: ctx.session_tecnico_id,
      doc_tecnico_id: doc.tecnico_id,
      documento_id: input.documento_id,
    });
    return err("documento not accessible", { code: "forbidden" });
  }

  const storagePath: string = doc.storage_path;
  const workerClaimedTipo: string = doc.tipo;
  const expectedTipo = input.expected_tipo ?? workerClaimedTipo;

  // 2. Generate a signed URL from Supabase Storage (TTL 300s).
  const { data: signedData, error: signedErr } = await ctx.supabase.storage
    .from("documentos")
    .createSignedUrl(storagePath, 300);

  if (signedErr || !signedData?.signedUrl) {
    return err(
      `storage signed URL failed: ${signedErr?.message ?? "no url returned"}`,
      { code: "storage_error", retryable: true }
    );
  }

  // Infer MIME type from path extension; default to application/pdf.
  const ext = storagePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
  };
  const mimeType = mimeMap[ext] ?? "application/pdf";

  // 3. Call Gemini 2.5 Flash multimodal classifier.
  let geminiResult: GeminiClassifyResult;
  try {
    geminiResult = await callWithRetry(apiKey, signedData.signedUrl, mimeType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.warn("classify_documento: Gemini call failed after retry", {
      documento_id: input.documento_id,
      error: msg,
    });
    return err("classifier_unavailable", { code: "classifier_unavailable", retryable: true });
  }

  // 4. Validate parsed result.
  const classifiedType = VALID_CLASSIFIED_TYPES.has(geminiResult.classified_type)
    ? geminiResult.classified_type
    : "otro";
  const confidence = Math.max(0, Math.min(1, geminiResult.confidence ?? 0));
  const extractedFields =
    geminiResult.extracted_fields &&
    typeof geminiResult.extracted_fields === "object" &&
    Object.keys(geminiResult.extracted_fields).length > 0
      ? geminiResult.extracted_fields
      : undefined;

  // 5. Compute matches_expected (loose match).
  const matchesExpected = looseMatch(classifiedType, expectedTipo);

  // 6. Persist classification back to documentos row.
  const classificationJsonb = {
    classified_type: classifiedType,
    confidence,
    matches_expected: matchesExpected,
    extracted_fields: extractedFields ?? null,
    discrepancies: geminiResult.discrepancies ?? [],
    model: MODEL_ID,
    classified_at: new Date().toISOString(),
  };

  const classificationJsonbPath = `documentos/${input.documento_id}/classification`;

  const { error: updateErr } = await ctx.supabase
    .from("documentos")
    .update({
      classification_jsonb: classificationJsonb,
      classified_at: new Date().toISOString(),
      classifier_model: MODEL_ID,
    })
    .eq("id", input.documento_id);

  if (updateErr) {
    // Non-fatal: classification result still returned; we just warn.
    ctx.logger.warn("classify_documento: failed to persist classification", {
      documento_id: input.documento_id,
      error: updateErr.message,
    });
  }

  // 7. Emit evento (§22 format).
  await recordEvent(ctx, {
    type: "document_classified",
    entity_id: input.documento_id,
    actor: ctx.defaultActor,
    meta: {
      classified_type: classifiedType,
      confidence,
      matches_expected: matchesExpected,
      expected_tipo: expectedTipo,
      worker_claimed_tipo: workerClaimedTipo,
      model: MODEL_ID,
    },
  }).catch((e) => {
    // evento failure must not crash the tool — but warn so monitoring catches it.
    ctx.logger.warn("classify_documento: evento insert failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  // 8. Return structured result.
  // SECURITY (2026-05-28): extracted_fields + classification_jsonb_path
  // intentionally NOT returned to the LLM. Full payload is in the DB column
  // documentos.classification_jsonb for HR's DocViewer. See types.ts comment.
  const output: ClassifyDocumentoOutput = {
    classified_type: classifiedType,
    matches_expected: matchesExpected,
    confidence,
  };

  return ok(output);
}
