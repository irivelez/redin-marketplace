// Photo vision-captioning for Manos.
//
// Claude cannot fetch URLs, so a photo sent as a link in the prompt is invisible
// to the model. This helper sends the raw image bytes to Claude Haiku 4.5 vision
// and returns a short Spanish description of the construction-relevant content.
// The caption flows into the conversation as text, so the scope the LLM builds
// (often a few turns later) reflects what the photo actually shows.
//
// Model is env-overridable (MANOS_VISION_MODEL); defaults to the same Haiku
// already wired in llm.ts — no new SDK or API key.

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@redin/shared";

const log = createLogger("manos:vision");

const VISION_MODEL = process.env.MANOS_VISION_MODEL?.trim() || "claude-haiku-4-5";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

const PROMPT = `Describe esta foto de un sitio de obra para un alcance de trabajo, en español, en máximo 3 frases. Enfócate en lo útil para cotizar y ejecutar: qué se ve, materiales, cantidades aproximadas, dimensiones si se pueden estimar, condiciones del sitio (altura, acceso, riesgos). No inventes datos que no se vean. No saludes ni agregues comentarios.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  client = new Anthropic({ apiKey, maxRetries: 0 });
  return client;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`vision timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export async function describePhoto(
  imageBytes: Buffer,
  mediaType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg"
): Promise<string | null> {
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    log.warn("photo too large for vision — skipping", { bytes: imageBytes.length });
    return null;
  }
  try {
    const response = await withTimeout(
      getClient().messages.create({
        model: VISION_MODEL,
        max_tokens: 256,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageBytes.toString("base64") },
              },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
      TIMEOUT_MS
    );
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!text) {
      log.warn("vision returned empty caption");
      return null;
    }
    log.info("photo described", { bytes: imageBytes.length, caption_len: text.length });
    return text;
  } catch (e) {
    log.error("describePhoto failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
