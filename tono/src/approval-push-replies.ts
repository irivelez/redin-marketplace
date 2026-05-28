// Pre-LLM short-circuit for numeric / ordinal replies to an HR approval push.
//
// Context:
//   When HR approves a worker via /hr/qualification-queue, the dashboard's
//   submitDecision → fireApprovalPush enqueues a WhatsApp message that lists
//   the open OTs in the worker's ciudad as a numbered menu:
//
//     ¡Felicidades, Camilo! Tu perfil quedó aprobado.
//     Hay 2 trabajos para ti:
//     1. OC 57832 - Interrapidisimo Racol Yopal — $179.640 · Yopal
//     2. Garantia cubierta Yopal interrapidisimo — $330.000 · Yopal
//     ¿Cuál te interesa? Respóndeme con el número o pídeme más detalles.
//
//   Workers reply "2" or "el primero" or "la segunda". Pre-fix, the LLM had
//   no context for the push (it was sent via outbound_messages but never
//   persisted to messages) and responded "¿Qué significa '2'?" — the
//   May25-camilo2 trust-destroying regression.
//
// This handler runs BEFORE the LLM and short-circuits the happy path:
//   1. Parse a 1-based index from numeric/ordinal Spanish replies.
//   2. Look up the most recent approval_push outbound for this phone, sent
//      within PUSH_LOOKBACK_MIN minutes. Read ot_row_ids[] from its meta.
//   3. Resolve index → ot_row_id → call createPostulacion.
//   4. Reply with a friendly confirmation that names the OT.
//
// Falls through to the LLM (handled=false) on:
//   - non-numeric reply
//   - no recent push / push missing ot_row_ids
//   - index out of range
//   - createPostulacion error
//   - any unexpected error (fail-open)
//
// Same architectural shape as offer-replies.ts and customer-ratings.ts:
// pure-ish function over a context bag, fail-open discipline, no LLM cost.

import { createLogger, type ServerClient } from "@redin/shared";
import { createPostulacion, makeDefaultToolContext } from "@redin/tools";

const log = createLogger("tono:approval-push-replies");

// 30 minutes covers the common "worker reads push, types reply within seconds
// to minutes" pattern. Past this window we fall through to the LLM, which now
// sees the push in its conversation history (persisted via outbound.ts) and
// can interpret naturally.
const PUSH_LOOKBACK_MIN = 30;

// fireApprovalPush caps the menu at 3 OTs (MAX_OT_LINES in decisions.ts), but
// we accept up to 9 to stay future-proof if the cap is ever raised.
const MAX_INDEX = 9;

export interface ApprovalPushReplyContext {
  phone: string;
  text: string;
  supabase: ServerClient;
  log: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

export type ApprovalPushReplyResult =
  | { handled: false }
  | { handled: true; reply: string };

// ---------------------------------------------------------------------------
// Intent parser
// ---------------------------------------------------------------------------

// Spanish ordinals → 1-based index. Includes feminine/masculine, common
// abbreviations workers actually type, and accent-stripped variants (we
// normalize before lookup so "séptimo" also hits "septimo").
const ORDINAL_MAP: Record<string, number> = {
  primero: 1, primer: 1, primera: 1, "1ero": 1, "1er": 1, "1ro": 1, "1ra": 1,
  segundo: 2, segunda: 2, "2do": 2, "2da": 2,
  tercero: 3, tercer: 3, tercera: 3, "3ero": 3, "3ro": 3, "3ra": 3, "3er": 3,
  cuarto: 4, cuarta: 4, "4to": 4, "4ta": 4,
  quinto: 5, quinta: 5, "5to": 5, "5ta": 5,
  sexto: 6, sexta: 6, "6to": 6, "6ta": 6,
  septimo: 7, "7mo": 7, "7ma": 7,
  octavo: 8, octava: 8, "8vo": 8, "8va": 8,
  noveno: 9, novena: 9, "9no": 9, "9na": 9,
};

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Parse a 1-based index from a reply that looks like a menu selection.
 * Returns null on anything that's not a clear numeric/ordinal pick.
 *
 * Accepts (case/accent-insensitive):
 *   - bare or punctuated digit: "2", "2.", "2)"
 *   - articled digit: "el 2", "la 2", "los 2"
 *   - "opcion 2", "opción 2", "la opcion 2"
 *   - intent + number: "me interesa el 2", "quiero la 1", "escojo 3"
 *   - ordinal words / abbreviations: "primero", "el primer", "la segunda",
 *     "2do", "1ra"
 *
 * Rejects:
 *   - long sentences (>60 chars post-normalize — ambiguous)
 *   - multiple numbers ("1 y 2", "el 1 o el 2")
 *   - numbers outside 1..MAX_INDEX
 */
export function parseSelectionIndex(text: string): number | null {
  if (!text) return null;
  const norm = normalize(text);
  if (norm.length === 0 || norm.length > 60) return null;

  // Multiple digits = ambiguous. Let the LLM handle.
  const allDigits = norm.match(/\d/g);
  if (allDigits && allDigits.length > 1) return null;

  const trimmed = norm
    .replace(
      /^(me interesa|me sirve|me gusta|quiero|dame|pasame|escojo|elijo|prefiero|voy con|tomo|seleccione|seleccionar|necesito)\s+/u,
      ""
    )
    .replace(/^(la\s+)?(opcion|opciono)\s+/u, "")
    .replace(/^(el|la|los|las|un|una|este|esta|ese|esa)\s+/u, "")
    .trim();

  const numMatch = /^([1-9])\s*[.)°]?\s*$/.exec(trimmed);
  if (numMatch) {
    const n = parseInt(numMatch[1]!, 10);
    return n >= 1 && n <= MAX_INDEX ? n : null;
  }

  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  if (firstWord in ORDINAL_MAP) {
    const idx = ORDINAL_MAP[firstWord]!;
    return idx >= 1 && idx <= MAX_INDEX ? idx : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Push lookup
// ---------------------------------------------------------------------------

interface ApprovalPushMeta {
  kind?: string;
  tecnico_id?: string;
  ot_row_ids?: unknown;
  ciudad?: string | null;
}

interface RecentApprovalPush {
  outbound_id: string;
  tecnico_id: string;
  ot_row_ids: string[];
  created_at: string;
}

async function loadRecentApprovalPush(
  sb: ServerClient,
  phone: string
): Promise<RecentApprovalPush | null> {
  const cutoffIso = new Date(
    Date.now() - PUSH_LOOKBACK_MIN * 60 * 1000
  ).toISOString();
  const { data, error } = await sb
    .from("outbound_messages")
    .select("id, meta, created_at")
    .eq("phone", phone)
    .contains("meta", { kind: "approval_push" })
    .gte("created_at", cutoffIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn("approval-push lookup failed", { phone, error: error.message });
    return null;
  }
  if (!data) return null;
  const meta = (data.meta as ApprovalPushMeta | null) ?? {};
  const tecnicoId = meta.tecnico_id;
  const otRowIdsRaw = meta.ot_row_ids;
  if (!tecnicoId || !Array.isArray(otRowIdsRaw) || otRowIdsRaw.length === 0) {
    return null;
  }
  const otRowIds = otRowIdsRaw.filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (otRowIds.length === 0) return null;
  return {
    outbound_id: data.id as string,
    tecnico_id: tecnicoId,
    ot_row_ids: otRowIds,
    created_at: data.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function tryMatchApprovalPushReply(
  ctx: ApprovalPushReplyContext
): Promise<ApprovalPushReplyResult> {
  const index = parseSelectionIndex(ctx.text);
  if (index === null) return { handled: false };

  try {
    const push = await loadRecentApprovalPush(ctx.supabase, ctx.phone);
    if (!push) {
      ctx.log("info", "approval-push: numeric reply but no recent push", {
        phone: ctx.phone,
        index,
        text: ctx.text.slice(0, 60),
      });
      return { handled: false };
    }

    if (index > push.ot_row_ids.length) {
      ctx.log("info", "approval-push: index out of range, falling through", {
        phone: ctx.phone,
        index,
        available: push.ot_row_ids.length,
      });
      return { handled: false };
    }

    const otRowId = push.ot_row_ids[index - 1]!;
    const toolCtx = makeDefaultToolContext({
      supabase: ctx.supabase,
      defaultActor: `tecnico:${ctx.phone}`,
    });

    const result = await createPostulacion(toolCtx, {
      ot_id: otRowId,
      tecnico_id: push.tecnico_id,
      mensaje: `selected_from_approval_push:#${index}`,
      actor: `tecnico:${ctx.phone}`,
    });

    if (!result.ok) {
      ctx.log("warn", "approval-push: createPostulacion failed, falling through", {
        phone: ctx.phone,
        ot_row_id: otRowId,
        error: result.error,
        code: result.code,
      });
      return { handled: false };
    }

    const ot = result.data.ot;
    const ciudad =
      typeof ot.ciudad === "string" && ot.ciudad.length > 0
        ? ot.ciudad
        : "tu zona";
    const descRaw = typeof ot.descripcion === "string" ? ot.descripcion : "";
    const desc =
      descRaw.length > 70 ? `${descRaw.slice(0, 69).trimEnd()}…` : descRaw;
    const alreadyApplied = result.data.state === "already_applied";

    const reply = alreadyApplied
      ? buildAlreadyAppliedReply(desc, ciudad, index)
      : buildAppliedReply(desc, ciudad, index);

    ctx.log("info", "approval-push: handled pre-LLM", {
      phone: ctx.phone,
      ot_row_id: otRowId,
      index,
      state: result.data.state,
    });

    return { handled: true, reply };
  } catch (e) {
    ctx.log("error", "approval-push handler threw, falling through", {
      phone: ctx.phone,
      error: e instanceof Error ? e.message : String(e),
    });
    return { handled: false };
  }
}

function buildAppliedReply(desc: string, ciudad: string, index: number): string {
  const tail = desc ? `: *${desc}* en ${ciudad}` : ` en ${ciudad}`;
  return `Listo, ya quedaste postulado para el trabajo #${index}${tail}. ✅\n\nEl equipo lo revisa y te aviso por aquí apenas haya respuesta.`;
}

function buildAlreadyAppliedReply(
  desc: string,
  ciudad: string,
  index: number
): string {
  const tail = desc ? `: *${desc}* en ${ciudad}` : ` en ${ciudad}`;
  return `Ya estabas postulado para el trabajo #${index}${tail}. El equipo lo revisa y te aviso cuando haya respuesta. ✅`;
}
