// Session + message persistence. One session per (phone, channel) where channel='whatsapp'.
// We consolidate: if a session already exists for this phone+channel within the last
// SESSION_TTL_MIN minutes, reuse it. Otherwise start a new one.

import { createLogger, type ServerClient } from "@redin/shared";
import type { Json, MessageRole, SessionChannel, SessionRow, MessageRow } from "@redin/shared";

const log = createLogger("tono:session");

export const SESSION_TTL_MIN = 60;
// Most-recent message rows we feed back to Haiku each turn. Each LLM turn
// generates 2-3 message rows (user input + assistant text + optional tool_use),
// so 80 messages ≈ 25-30 conversational turns. The previous value (24) was
// sized for Gemini's PRD §19 spec and caused a real bug in Carlos's screening
// (2026-05-25): by turn 22 the cédula intake from turn 9 had dropped out of
// context, Toño re-asked for the cédula number AND for the photos, and the
// worker saw a one-sided conversation. Long-term fix is a "collected_so_far"
// summary block that survives truncation; bumping the window is the day-1 patch.
export const CONTEXT_WINDOW = 80;

export class SessionStore {
  constructor(private supabase: ServerClient) {}

  async getOrCreate(phone: string, channel: SessionChannel): Promise<SessionRow> {
    const cutoff = new Date(Date.now() - SESSION_TTL_MIN * 60_000).toISOString();
    const { data: existing, error } = await this.supabase
      .from("sessions")
      .select("*")
      .eq("phone", phone)
      .eq("channel", channel)
      .gte("last_active", cutoff)
      .order("last_active", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      log.error("session lookup failed", { phone, error: error.message });
      throw new Error(`session lookup: ${error.message}`);
    }
    if (existing) return existing;
    const { data: created, error: createErr } = await this.supabase
      .from("sessions")
      .insert({ phone, channel })
      .select("*")
      .single();
    if (createErr || !created) {
      throw new Error(`session create failed: ${createErr?.message ?? "unknown"}`);
    }
    return created;
  }

  async touch(sessionId: string): Promise<void> {
    const { error } = await this.supabase
      .from("sessions")
      .update({ last_active: new Date().toISOString() })
      .eq("id", sessionId);
    if (error) log.warn("session touch failed", { sessionId, error: error.message });
  }

  async recordMessage(params: {
    sessionId: string;
    role: MessageRole;
    content?: string | null;
    toolCalls?: Json | null;
  }): Promise<void> {
    const { error } = await this.supabase.from("messages").insert({
      session_id: params.sessionId,
      role: params.role,
      content: params.content ?? null,
      tool_calls: params.toolCalls ?? null,
    });
    if (error) {
      log.error("message insert failed", { sessionId: params.sessionId, error: error.message });
      throw new Error(`message insert: ${error.message}`);
    }
  }

  async recentMessages(sessionId: string, limit = CONTEXT_WINDOW): Promise<MessageRow[]> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      log.error("messages fetch failed", { sessionId, error: error.message });
      throw new Error(`messages fetch: ${error.message}`);
    }
    return (data ?? []).reverse(); // oldest-first for the LLM prompt
  }
}
