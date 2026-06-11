// Groq Whisper transcription — shared voice helper.
//
// Ported verbatim from manos/src/transcribe.ts (production-working pattern,
// 2026-06-11) so Toño can accept voice notes too. Manos keeps its own copy
// untouched for now; consolidate manos onto this helper in a later pass.
//
// Accepts OGG/Opus bytes directly from Baileys (no re-encoding needed).
// Returns Spanish text, or null on persistent failure (caller sends polite
// fallback message to the sender).
//
// Model: whisper-large-v3-turbo — same Whisper Large v3 backbone as OpenAI,
// ~0.13s for a 30s note at $0.04/hr. When Anthropic ships native audio on
// Haiku/Sonnet, swap is a single file change here.

import Groq from "groq-sdk";
import { createLogger } from "./logger";

const log = createLogger("shared:voice");

// Groq client is stateless — create once and reuse.
let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (groqClient) return groqClient;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  groqClient = new Groq({ apiKey });
  return groqClient;
}

export interface TranscribeResult {
  text: string;
  provenance: "groq-whisper-large-v3-turbo";
}

/**
 * Transcribe OGG/Opus audio bytes to Spanish text using Groq Whisper.
 *
 * Returns null on failure — caller must send a fallback message to the
 * sender asking them to type a brief summary.
 *
 * Retry policy: one retry on 5xx/network error, then null. We do NOT add a
 * second provider (per Manos spec §3.4 — swap is a single file change).
 */
export async function transcribeAudio(
  audioBytes: Buffer,
  filename = "audio.ogg"
): Promise<TranscribeResult | null> {
  const client = getGroqClient();

  const attempt = async (): Promise<string> => {
    // Groq SDK accepts a File-like object or ReadStream. We use Blob here
    // since File extends Blob and is available in Node 20+.
    // Wrap Buffer in a Uint8Array to satisfy BlobPart typing.
    const blob = new Blob([new Uint8Array(audioBytes)], { type: "audio/ogg" });
    const file = new File([blob], filename, { type: "audio/ogg" });

    // response_format: "text" makes the SDK return a string directly.
    // The generic return type is TranscriptionCreateResponse which is a union;
    // we cast through unknown to get the string.
    const result = await client.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
      language: "es",
      response_format: "text",
    });

    const text: string =
      typeof result === "string"
        ? result
        : typeof (result as unknown as { text?: string }).text === "string"
          ? ((result as unknown as { text: string }).text)
          : "";
    return text.trim();
  };

  try {
    const text = await attempt();
    log.info("transcribed", {
      bytes: audioBytes.length,
      text_len: text.length,
    });
    return { text, provenance: "groq-whisper-large-v3-turbo" };
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    log.warn("transcription attempt 1 failed, retrying", { error: firstMsg });

    // Retry once — only for transient server/network errors.
    const isRetryable = isTransientError(firstErr);
    if (!isRetryable) {
      log.error("transcription failed (non-retryable)", { error: firstMsg });
      return null;
    }

    await new Promise((res) => setTimeout(res, 500));

    try {
      const text = await attempt();
      log.info("transcribed (retry ok)", {
        bytes: audioBytes.length,
        text_len: text.length,
      });
      return { text, provenance: "groq-whisper-large-v3-turbo" };
    } catch (secondErr) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      log.error("transcription failed after retry", { error: secondMsg });
      return null;
    }
  }
}

function isTransientError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  // Groq SDK throws Groq.APIError for HTTP errors.
  if ("status" in e) {
    const status = (e as { status?: number }).status;
    if (status !== undefined) {
      return status >= 500 && status < 600;
    }
  }
  // Network-level errors.
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}
