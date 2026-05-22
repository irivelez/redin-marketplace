// Pre-LLM branch for job-acceptance replies (offers + preselections).
//
// Two paths land here:
//
//   Path B — HR-push offer:
//     HR clicks "Enviar oferta" on /hr/shortlist. System inserts `ot_offers`
//     row state='sent' and queues a WA text + alcance PDF. Worker replies
//     "acepto"/"paso". We flip ot_offers + upsert postulaciones to
//     'preseleccionado'.
//
//   Path A — Worker self-applies, HR preselects (Gap A):
//     Worker says "me postulo" → postulaciones state='postulado'.
//     HR clicks "Preseleccionar" → state='preseleccionado' + WA with alcance
//     PDF (dashboard/src/app/hr/shortlist/[ot_id]/page.tsx decide()).
//     Worker replies "acepto"/"paso" after reading scope. No `ot_offers`
//     row exists, but the recent preselection serves the same role.
//
// Flow:
//   1. Pattern-match the inbound text against accept/reject regexes anchored
//      on the first ~30 chars. If neither matches → return handled=false and
//      let Toño respond conversationally.
//   2. Resolve the inbound phone to a tecnico_id via tecnicos_extended (phone
//      first, contact_phone fallback). No worker row → handled=false.
//   3. Try to find an acceptance target, in order:
//        a. Open `ot_offers` row (Path B) — `state='sent'` AND
//           `now() < expires_at`. If found → handle as offer.
//        b. Recent `postulaciones` row state='preseleccionado' with
//           decided_at within last 14 days (Path A). If found → handle as
//           preselection.
//      Neither found → handled=false; LLM handles it.
//   4. Flip / log / event / reply per target type. See handleOfferIntent
//      and handlePreselectionIntent below.
//
// Architectural mirror of customer-ratings.ts — same return shape, same
// fail-open discipline (any DB error → handled=false, fall through to LLM).
//
// Edge cases:
//   - Worker replies "acepto" twice: the offer / preselection has already
//     been processed (offer is now 'accepted', preselection-accepted event
//     already logged). The lookup queries are designed so the SECOND reply
//     finds nothing fresh → handled=false → LLM responds conversationally.
//     Idempotent by construction.
//   - Reply lands 73h after offer (Path B, past expiry): ot_offers index
//     excludes past-expiry rows; preselection lookup may still find it if
//     within 14 days. We prefer the offer match (chronologically newest
//     intent); if no fresh offer, the preselection fallback handles it.
//   - Both an open offer AND a recent preselection exist: take the offer
//     (HR-push is the more recent/explicit signal).

import { createLogger, type ServerClient } from "@redin/shared";

const log = createLogger("tono:offer-replies");

// First ~30 chars matter; we don't want to match "acepto" buried inside a
// long sentence that means something else.
const PREFIX_WINDOW = 30;

// Anchored on a normalized prefix. Order matters when patterns overlap
// ("no acepto" must hit reject before accept's "acepto" alternative — but
// since accept is anchored at start-of-string and the reject regex includes
// "no acepto" explicitly, we test reject FIRST to be safe).
//
// TWO accept regexes (Gap A code review B1 fix):
//
//   LOOSE_ACCEPT_RE — Path B (HR-push ot_offers). The worker just received a
//   text saying "Responde 'acepto' o 'paso'", so any positive reply is
//   unambiguous: dale, claro, listo, ok, me interesa all mean "yes" to the
//   offer that was just sent.
//
//   STRICT_ACCEPT_RE — Path A (preselection). No fresh "responde acepto"
//   prompt arrived this turn (could be hours/days after the HR preselect).
//   The same words "dale" / "me interesa" / "quiero" are ALSO the canonical
//   postulation triggers from tono-system.ts:104 ("dale, me interesa el
//   primero"). If we treat those as acceptance of a stale preselection, we
//   silently accept the WRONG OT and never reach create_postulacion. Only
//   the explicit "acepto" family is safe to short-circuit on Path A.
const LOOSE_ACCEPT_RE =
  /^(acepto|aceptado|si\b|s[ií]\b|claro|listo|dale|ok\b|de acuerdo|me interesa|s[ií] acepto|yo acepto|quiero|si quiero|s[ií] quiero)/i;
const STRICT_ACCEPT_RE =
  /^(acepto|aceptado|s[ií] acepto|s[ií] acepto la|yo acepto|acepto la)/i;
const REJECT_RE =
  /^(paso|no\b|rechaz|no puedo|no me interesa|otro d[ií]a|esta vez no|no acepto|no gracias)/i;

export type OfferReplyResult =
  | { handled: false }
  | { handled: true; reply: string };

export interface OfferReplyContext {
  phone: string;
  text: string;
  supabase: ServerClient;
  telegram: { send(text: string): Promise<void> } | null;
  log: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

interface OpenOffer {
  id: string;
  ot_row_id: string;
  tecnico_id: string;
  state: string;
  sent_at: string;
  expires_at: string;
}

interface RecentPreselection {
  id: string;          // postulacion id
  ot_id: string;       // ot_row_id
  tecnico_id: string;
  decided_at: string | null;
}

export async function tryMatchOfferReply(
  ctx: OfferReplyContext
): Promise<OfferReplyResult> {
  // 1. Classify intent.
  const intent = classifyIntent(ctx.text);
  if (intent === "none") return { handled: false };

  try {
    // 2. Resolve tecnico_id. Try phone first (WA identity), then contact_phone
    // (the callable number — separate per migration 011).
    const worker = await loadWorker(ctx.supabase, ctx.phone);
    if (!worker) return { handled: false };

    // 3a. Strategy 1: open ot_offers row (Path B — HR-push). The query
    // enforces the 72h window via `now() < expires_at` so we don't need a
    // JS-side check.
    const offer = await loadOpenOffer(ctx.supabase, worker.tecnico_id);
    if (offer) {
      return await handleOfferIntent({ ctx, worker, offer, intent });
    }

    // 3b. Strategy 2: recent preselection (Path A — worker self-applied, HR
    // preselected). The dashboard /hr/shortlist Preseleccionar action now
    // sends the alcance PDF (Gap A), so the worker has the same scope info
    // a Path B offer would have included.
    const preselection = await loadRecentPreselection(ctx.supabase, worker.tecnico_id);
    if (preselection) {
      return await handlePreselectionIntent({ ctx, worker, preselection, intent });
    }

    // Nothing to accept/reject. Let the LLM respond.
    return { handled: false };
  } catch (e) {
    // Fail-open: any unexpected error falls through to the LLM, which is the
    // safest default (the worker still gets a response).
    ctx.log("error", "offer-reply failed", {
      phone: ctx.phone,
      error: e instanceof Error ? e.message : String(e),
    });
    return { handled: false };
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: HR-push offer (existing Path B behavior, factored out)
// ---------------------------------------------------------------------------
async function handleOfferIntent(args: {
  ctx: OfferReplyContext;
  worker: { tecnico_id: string; nombre: string };
  offer: OpenOffer;
  intent: Exclude<Intent, "none">;
}): Promise<OfferReplyResult> {
  const { ctx, worker, offer, intent } = args;

  // Flip the offer's state.
  // NOTE: cast to `any` — db-types.ts hasn't been regenerated to include
  // ot_offers (migration 014). Same pattern as dashboard/offer-actions.ts.
  // TODO: drop the cast after types regenerate.
  const newState = intent === "accept" ? "accepted" : "rejected";
  const { error: updErr } = await (ctx.supabase as any)
    .from("ot_offers")
    .update({
      state: newState,
      responded_at: new Date().toISOString(),
      response_text: ctx.text.slice(0, 1000),
    })
    .eq("id", offer.id)
    .eq("state", "sent"); // optimistic guard against races
  if (updErr) {
    ctx.log("error", "offer-reply: ot_offers update failed", {
      offer_id: offer.id,
      error: updErr.message,
    });
    return { handled: false };
  }

  // Load OT ciudad for messaging (best-effort; missing is non-fatal).
  const ciudad = await loadOtCiudad(ctx.supabase, offer.ot_row_id);

  // On accept: upsert postulaciones in 'preseleccionado' so the existing
  // /hr/shortlist "Generar contrato" flow takes over with no changes.
  //
  // Schema note (migrations/001_init.sql:35-45): postulaciones.tecnico_id
  // is `text` (not uuid), and the unique is on (ot_id, tecnico_id).
  if (intent === "accept") {
    const { error: upErr } = await ctx.supabase.from("postulaciones").upsert(
      {
        ot_id: offer.ot_row_id,
        tecnico_id: offer.tecnico_id,
        state: "preseleccionado",
        mensaje: "accepted_offer",
        applied_at: new Date().toISOString(),
        decided_by: "system:offer_accepted",
        decided_at: new Date().toISOString(),
      },
      { onConflict: "ot_id,tecnico_id" }
    );
    if (upErr) {
      // Don't bail — the offer is already flipped and HR will still see it.
      ctx.log("error", "offer-reply: postulaciones upsert failed", {
        offer_id: offer.id,
        ot_row_id: offer.ot_row_id,
        tecnico_id: offer.tecnico_id,
        error: upErr.message,
      });
    }
  }

  // Audit event.
  await ctx.supabase
    .from("eventos")
    .insert({
      type: intent === "accept" ? "offer_accepted" : "offer_rejected",
      entity_id: offer.ot_row_id,
      actor: `tecnico:${ctx.phone}`,
      meta: {
        ot_offer_id: offer.id,
        tecnico_id: offer.tecnico_id,
        response_text: ctx.text.slice(0, 1000),
      },
    })
    .then(({ error }) => {
      if (error) {
        ctx.log("warn", "offer-reply: eventos insert failed (non-fatal)", {
          error: error.message,
        });
      }
    });

  // Best-effort HR ping. Telegram errors are swallowed by the sink.
  if (ctx.telegram) {
    const shortOt = offer.ot_row_id.slice(0, 8);
    const ciudadStr = ciudad ?? "ciudad sin registrar";
    const tgText =
      intent === "accept"
        ? `✅ ${worker.nombre} ACEPTÓ la oferta para OT ${shortOt} en ${ciudadStr}. Revisa /hr/shortlist/${offer.ot_row_id} para generar el contrato.`
        : `❌ ${worker.nombre} RECHAZÓ la oferta para OT ${shortOt} en ${ciudadStr}.`;
    try {
      await ctx.telegram.send(tgText);
    } catch (e) {
      ctx.log("warn", "offer-reply: telegram send threw (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Worker-facing reply. MUST mention "preseleccionado" and "contrato" on
  // accept so the next step is unambiguous.
  const ciudadForReply = ciudad ?? "el sitio acordado";
  const reply =
    intent === "accept"
      ? `Listo, ${worker.nombre}. Quedaste preseleccionado para el trabajo en ${ciudadForReply}. El equipo te pasará el contrato por aquí para que lo firmes. ✅`
      : `Entendido, ${worker.nombre}. Sin problema — te avisamos cuando haya algo más que te encaje.`;

  ctx.log("info", "offer-reply: handled pre-LLM (offer)", {
    phone: ctx.phone,
    tecnico_id: offer.tecnico_id,
    ot_row_id: offer.ot_row_id,
    ot_offer_id: offer.id,
    intent,
  });

  return { handled: true, reply };
}

// ---------------------------------------------------------------------------
// Strategy 2: Preselection confirmation (Path A — Gap A)
// ---------------------------------------------------------------------------
async function handlePreselectionIntent(args: {
  ctx: OfferReplyContext;
  worker: { tecnico_id: string; nombre: string };
  preselection: RecentPreselection;
  intent: Exclude<Intent, "none">;
}): Promise<OfferReplyResult> {
  const { ctx, worker, preselection, intent } = args;

  // Gap A code review B1: re-validate accept with STRICT regex. "dale" /
  // "listo" / "me interesa" / "quiero" are postulation triggers (see
  // tono-system.ts:104), not preselection-acceptance. Fall through to the
  // LLM so create_postulacion runs against the OT just mentioned in chat.
  if (intent === "accept" && !isStrictAccept(ctx.text)) {
    ctx.log("info", "offer-reply: loose-accept fell through (preselection, strict-only)", {
      phone: ctx.phone,
      text: ctx.text.slice(0, 80),
    });
    return { handled: false };
  }

  const ciudad = await loadOtCiudad(ctx.supabase, preselection.ot_id);
  const nowIso = new Date().toISOString();

  if (intent === "reject") {
    // Worker rejects after reading scope. Flip the postulación to 'rechazado'
    // with a marker decided_by so HR can distinguish worker-initiated rejection
    // from HR rejection. The schema enum (postulado | preseleccionado |
    // asignado | rechazado | descartado | completado) doesn't have a
    // worker-specific value; decided_by carries the semantic.
    const { error: updErr } = await ctx.supabase
      .from("postulaciones")
      .update({
        state: "rechazado",
        decided_at: nowIso,
        decided_by: "system:preselection_worker_rejected",
      })
      .eq("id", preselection.id)
      .eq("state", "preseleccionado"); // race guard
    if (updErr) {
      ctx.log("error", "offer-reply: postulaciones reject update failed", {
        postulacion_id: preselection.id,
        error: updErr.message,
      });
      return { handled: false };
    }
  }
  // On accept: no postulacion state change — already 'preseleccionado'. The
  // event row IS the audit signal that the worker confirmed.

  // Audit event — AWAIT (Gap A code review N1) so the next inbound reply's
  // idempotency check in loadRecentPreselection sees this row.
  const { error: evErr } = await ctx.supabase
    .from("eventos")
    .insert({
      type:
        intent === "accept"
          ? "preselection_accepted"
          : "preselection_rejected",
      entity_id: preselection.ot_id,
      actor: `tecnico:${ctx.phone}`,
      meta: {
        postulacion_id: preselection.id,
        tecnico_id: preselection.tecnico_id,
        response_text: ctx.text.slice(0, 1000),
      },
    });
  if (evErr) {
    ctx.log("warn", "offer-reply: eventos insert failed (non-fatal)", {
      error: evErr.message,
    });
  }

  // Gap A code review B3: HR Telegram ping policy for Path A.
  //   - On ACCEPT, skip the ping. HR just clicked "Preseleccionar" from
  //     /hr/shortlist/[ot_id]; they're already on the page that's about to
  //     show the worker as ready for "Generar contrato". A push notification
  //     duplicates a UI signal.
  //   - On REJECT, keep the ping. HR may have moved on to other work and
  //     genuinely needs to know the worker bailed so they can re-shortlist.
  if (ctx.telegram && intent === "reject") {
    const shortOt = preselection.ot_id.slice(0, 8);
    const ciudadStr = ciudad ?? "ciudad sin registrar";
    const tgText = `❌ ${worker.nombre} RECHAZÓ la preselección para OT ${shortOt} en ${ciudadStr}.`;
    try {
      await ctx.telegram.send(tgText);
    } catch (e) {
      ctx.log("warn", "offer-reply: telegram send threw (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const ciudadForReply = ciudad ?? "el sitio acordado";
  const reply =
    intent === "accept"
      ? `Listo, ${worker.nombre}. Confirmado para el trabajo en ${ciudadForReply}. El equipo te pasará el contrato por aquí para que lo firmes. ✅`
      : `Entendido, ${worker.nombre}. Cancelamos esta postulación — te avisamos cuando haya algo más que te encaje.`;

  ctx.log("info", "offer-reply: handled pre-LLM (preselection)", {
    phone: ctx.phone,
    tecnico_id: preselection.tecnico_id,
    ot_row_id: preselection.ot_id,
    postulacion_id: preselection.id,
    intent,
  });

  return { handled: true, reply };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

export type Intent = "accept" | "reject" | "none";

// Preselection lookups must be recent so we don't accidentally interpret a
// stale "acepto" 2 months later. 14 days mirrors a reasonable HR-decision
// window — long enough to be lenient, short enough to avoid false positives.
const PRESELECTION_LOOKBACK_DAYS = 14;

// Public classifyIntent uses the LOOSE accept regex. It's the right call for
// the orchestrator's first-pass decision ("is this potentially an accept?").
// Path A (preselection) then re-validates with isStrictAccept before
// short-circuiting — see handlePreselectionIntent.
export function classifyIntent(raw: string): Intent {
  if (!raw) return "none";
  // Normalize: lowercase, trim, strip leading/trailing punctuation/whitespace.
  const normalized = raw
    .toLowerCase()
    .trim()
    .replace(/^[\s.,;:¡!¿?"'`*_-]+/, "")
    .replace(/[\s.,;:¡!¿?"'`*_-]+$/, "");
  if (!normalized) return "none";
  const head = normalized.slice(0, PREFIX_WINDOW);
  // Reject first — it includes "no acepto" which would otherwise be eaten by
  // the accept "acepto" alternation (though accept is start-anchored, leading
  // "no " would still leak through if accept tested first against a non-start
  // index — safer to keep order explicit).
  if (REJECT_RE.test(head)) return "reject";
  if (LOOSE_ACCEPT_RE.test(head)) return "accept";
  return "none";
}

// Strict accept — Path A re-validates here so "dale" / "listo" / "me interesa"
// / "quiero" fall through to the LLM (where the system prompt routes them to
// create_postulacion against the OT just mentioned in the conversation, NOT
// against a stale preselection on a different OT).
export function isStrictAccept(raw: string): boolean {
  if (!raw) return false;
  const normalized = raw
    .toLowerCase()
    .trim()
    .replace(/^[\s.,;:¡!¿?"'`*_-]+/, "")
    .replace(/[\s.,;:¡!¿?"'`*_-]+$/, "");
  if (!normalized) return false;
  const head = normalized.slice(0, PREFIX_WINDOW);
  return STRICT_ACCEPT_RE.test(head);
}

async function loadWorker(
  sb: ServerClient,
  phone: string
): Promise<{ tecnico_id: string; nombre: string } | null> {
  // Try phone column first (the WA identity, primary key for inbound match).
  const byPhone = await sb
    .from("tecnicos_extended")
    .select("tecnico_id, nombre")
    .eq("phone", phone)
    .maybeSingle();
  if (byPhone.data?.tecnico_id) {
    return {
      tecnico_id: byPhone.data.tecnico_id,
      nombre: byPhone.data.nombre ?? "compa",
    };
  }
  // Fallback: contact_phone (the callable number, separate per migration 011).
  const byContact = await sb
    .from("tecnicos_extended")
    .select("tecnico_id, nombre")
    .eq("contact_phone", phone)
    .maybeSingle();
  if (byContact.data?.tecnico_id) {
    return {
      tecnico_id: byContact.data.tecnico_id,
      nombre: byContact.data.nombre ?? "compa",
    };
  }
  return null;
}

async function loadOpenOffer(
  sb: ServerClient,
  tecnicoId: string
): Promise<OpenOffer | null> {
  const nowIso = new Date().toISOString();
  // NOTE: cast to `any` — db-types.ts hasn't been regenerated for ot_offers
  // (migration 014). Same convention as dashboard/offer-actions.ts.
  const { data, error } = await (sb as any)
    .from("ot_offers")
    .select("id, ot_row_id, tecnico_id, state, sent_at, expires_at")
    .eq("tecnico_id", tecnicoId)
    .eq("state", "sent")
    .gt("expires_at", nowIso)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.error("offer-reply: ot_offers query failed", {
      tecnico_id: tecnicoId,
      error: error.message,
    });
    return null;
  }
  return (data as OpenOffer | null) ?? null;
}

async function loadOtCiudad(
  sb: ServerClient,
  otRowId: string
): Promise<string | null> {
  try {
    const { data } = await sb
      .from("ots_mirror")
      .select("ciudad")
      .eq("row_id", otRowId)
      .maybeSingle();
    const ciudad = data?.ciudad;
    return typeof ciudad === "string" && ciudad.length > 0 ? ciudad : null;
  } catch {
    return null;
  }
}

// Look for a recent preselection (Path A — worker self-applied, HR
// preselected). Returns the most-recent postulación in 'preseleccionado'
// state for this worker, decided within the lookback window.
//
// IDEMPOTENCY (Gap A code review B2): compare each postulación's `decided_at`
// (when HR clicked "Preseleccionar") against the latest `preselection_accepted`
// event for that postulación. Three cases:
//   1. No accept event yet → fresh, return this row.
//   2. Accept event exists AND latest accept.created_at > postulación.decided_at
//      → worker has already confirmed THIS preselection; skip (idempotency).
//   3. Accept event exists BUT postulación.decided_at > latest accept.created_at
//      → HR re-preselected this row AFTER the worker had accepted (e.g., HR
//      re-pressed after a re-rejection). Treat as fresh — worker may accept
//      the new round.
async function loadRecentPreselection(
  sb: ServerClient,
  tecnicoId: string
): Promise<RecentPreselection | null> {
  const cutoff = new Date(
    Date.now() - PRESELECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await sb
    .from("postulaciones")
    .select("id, ot_id, tecnico_id, decided_at, state")
    .eq("tecnico_id", tecnicoId)
    .eq("state", "preseleccionado")
    .gte("decided_at", cutoff)
    .order("decided_at", { ascending: false })
    .limit(5); // small N so we can filter out already-confirmed below
  if (error) {
    log.error("offer-reply: postulaciones preselection query failed", {
      tecnico_id: tecnicoId,
      error: error.message,
    });
    return null;
  }
  const rows = (data as Array<RecentPreselection & { state: string }>) ?? [];
  if (rows.length === 0) return null;

  // Pull all preselection_accepted events for these postulaciones in one query
  // (entity_id is ot_id; postulacion_id is in meta).
  const otIds = rows.map((r) => r.ot_id);
  const { data: acceptedEvents } = await sb
    .from("eventos")
    .select("entity_id, meta, created_at")
    .eq("type", "preselection_accepted")
    .in("entity_id", otIds)
    .order("created_at", { ascending: false });

  // Map postulacion_id → latest accept event created_at.
  const latestAcceptByPostulacion = new Map<string, string>();
  for (const ev of acceptedEvents ?? []) {
    const meta = ev.meta as { postulacion_id?: string } | null;
    const pid = meta?.postulacion_id;
    if (!pid) continue;
    // Events are ordered desc, so the first row per postulacion_id is the latest.
    if (!latestAcceptByPostulacion.has(pid)) {
      latestAcceptByPostulacion.set(pid, ev.created_at as string);
    }
  }

  // First row whose decided_at > latest accept (or no accept yet) wins.
  const fresh = rows.find((r) => {
    const latestAccept = latestAcceptByPostulacion.get(r.id);
    if (!latestAccept) return true; // never accepted → fresh
    if (!r.decided_at) return false; // accepted but no decided_at — defensive skip
    return r.decided_at > latestAccept; // HR re-preselected after accept → fresh
  });
  if (!fresh) return null;
  return {
    id: fresh.id,
    ot_id: fresh.ot_id,
    tecnico_id: fresh.tecnico_id,
    decided_at: fresh.decided_at,
  };
}
