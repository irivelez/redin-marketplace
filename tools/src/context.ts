// ToolContext = the ambient dependencies every tool receives. Passed explicitly so
// tests can swap in a mock supabase or mock escalation sink.

import { createLogger, createServerClient, type Logger, type ServerClient } from "@redin/shared";
import type { Actor } from "./types";

export interface EscalationSink {
  notify(payload: {
    escalation_id: string;
    reason: string;
    context: string;
    tecnico_id?: string | null;
    phone?: string | null;
  }): Promise<{ delivered: boolean }>;
}

export interface ToolContext {
  supabase: ServerClient;
  logger: Logger;
  defaultActor: Actor;
  escalationSink?: EscalationSink | null;
  now?: () => Date;
  session_id?: string;
  session_tecnico_id?: string | null;
}

export function makeDefaultToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    supabase: overrides?.supabase ?? createServerClient(),
    logger: overrides?.logger ?? createLogger("tools"),
    defaultActor: overrides?.defaultActor ?? "system",
    escalationSink: overrides?.escalationSink ?? null,
    now: overrides?.now,
    session_id: overrides?.session_id,
    session_tecnico_id: overrides?.session_tecnico_id,
  };
}

// A no-op sink — used in tests or when no Telegram channel is wired yet.
// Writes to the log only. `eventos` row still gets written by the tool.
export class LoggingEscalationSink implements EscalationSink {
  constructor(private logger: Logger) {}
  async notify(payload: {
    escalation_id: string;
    reason: string;
    context: string;
    tecnico_id?: string | null;
    phone?: string | null;
  }): Promise<{ delivered: boolean }> {
    this.logger.warn("escalation (no-op sink, logging only)", { ...payload });
    return { delivered: false };
  }
}
