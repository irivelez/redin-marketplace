// data-wrap.ts — Role-marker helper for prompt injection defense (PRD §20).
//
// All user-generated and AppSheet-origin content injected into the LLM must be
// wrapped in <data source="..."> tags. The system prompt instructs the model to
// treat anything inside <data> as content, never as instructions.

export type DataSource =
  | "tecnico"
  | "appsheet"
  | "tool"
  | "tecnico_voice_transcript";

/**
 * Wrap a string in a <data source="..."> block before it enters the LLM.
 * Callers are responsible for choosing the right source label:
 *   "tecnico"  — content typed directly by the técnico (inbound WhatsApp message)
 *   "appsheet" — content read from AppSheet via mirror tables (OT descriptions, etc.)
 *   "tool"     — any tool output fed back into the conversation as context
 *   "tecnico_voice_transcript" — Groq Whisper transcript of a voice note the
 *                técnico sent (same injection defense as typed text)
 */
export function wrapData(content: string, source: DataSource): string {
  return `<data source="${source}">${content}</data>`;
}
