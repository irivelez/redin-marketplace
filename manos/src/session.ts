// Session + message persistence for Manos.
// Sessions are keyed by (phone, channel="manos").
// Mirrors tono/src/session.ts exactly but with manos logger prefix.

import { createLogger, type ServerClient } from "@redin/shared";
import type { Json, MessageRole, SessionChannel, SessionRow, MessageRow } from "@redin/shared";

const log = createLogger("manos:session");

export const SESSION_TTL_MIN = 60;
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
