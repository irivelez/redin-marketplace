// CandidateDossier + 7-state machine + graduated-autonomy types
//
// The structured artifact Toño produces, the HR audit shapes, the AppSheet
// projection contract, and the cost kill switch shapes — all in one file so
// Stream A (agent) and Stream B (HR + projector) can build against a shared
// vocabulary without reaching into each other's code.
//
// Vocabulary (categorías, subcategorías, ciudades) is derived from real OT
// history pulled from AppSheet on 2026-05-07 (711 OTs, 363 actividades). The
// values match AppSheet exactly so dossier filters can be joined against
// ots_mirror/actividades_mirror without normalization.
//
// GRADUATED AUTONOMY (decision 9): Toño produces a RECOMMENDATION; HR makes
// the DECISION. Both are recorded separately so agreement is measurable.
// Phase 1: HR reviews 100% — no auto-execution, no confidence gating, no
// graduation logic. The data foundation only.

// ===========================================================================
// 1. Canonical 7-state machine
// ===========================================================================

/**
 * The seven candidate states. Authoritative — see migration 007 CHECK
 * constraint and docs/architecture/onboarding-contracts.md §STATE MACHINE.
 *
 *   screening  — Toño mid-conversation; pre-dossier
 *   pending    — dossier submitted; awaiting HR
 *   needs_call — HR scheduled a call before deciding; same queue, badged
 *   approved   — HR approved; AppSheet projection pending or done
 *   rejected   — HR rejected; may re-apply later via 'reopen'
 *   withdrawn  — candidate left (no cedula / silence); same phone+cedula resumes
 *   revoked    — previously approved, removed; AppSheet row deleted; TERMINAL
 */
export type CandidateState =
  | "screening"
  | "pending"
  | "needs_call"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "revoked";

export const CANDIDATE_STATES: readonly CandidateState[] = [
  "screening",
  "pending",
  "needs_call",
  "approved",
  "rejected",
  "withdrawn",
  "revoked",
] as const;

/**
 * Legal state transitions. Source of truth for the agent + dashboard guards.
 *   keys   = prior state
 *   values = states the prior may transition to
 *
 * Not in this map = ILLEGAL. Tool layer + server actions must reject.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = {
  screening:  ["pending", "needs_call", "withdrawn"],
  pending:    ["approved", "rejected", "needs_call"],
  needs_call: ["approved", "rejected", "pending"],
  approved:   ["revoked"],
  rejected:   ["screening"],   // 'reopen' decision
  withdrawn:  ["screening"],   // resume — automatic on cedula match or HR reopen
  revoked:    [],              // terminal
} as const;

export function isLegalTransition(from: CandidateState, to: CandidateState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Withdrawal reasons — short controlled vocabulary persisted in
 * tecnicos_extended.withdrawal_reason. Free text is allowed but the agent
 * picks from this list by default.
 */
export type WithdrawalReason =
  | "no_cedula_provided"        // worker refused to share cedula (decision 2)
  | "no_response"               // worker stopped responding mid-screening
  | "opted_out"                 // worker explicitly said "no me interesa"
  | "duplicate_phone"           // merged into another tecnico_id
  | "other";

// ---- Graduated autonomy (decision 9) ----
//
// Toño's RECOMMENDATION (not a final state). HR makes the DECISION. Both are
// recorded so we can measure agreement. Phase 1: HR reviews 100%.

/**
 * The three things Toño can suggest. Each maps 1:1 to one HR action for the
 * agreement check:
 *   recommend_approve ↔ HR.approve
 *   recommend_reject  ↔ HR.reject
 *   recommend_call    ↔ HR.schedule_call
 *
 * HR.unschedule_call / HR.revoke / HR.reopen have no recommendation analog
 * and are excluded from agreement metrics.
 */
export type TonoRecommendation =
  | "recommend_approve"
  | "recommend_reject"
  | "recommend_call";

export const TONO_RECOMMENDATION_VALUES: readonly TonoRecommendation[] = [
  "recommend_approve",
  "recommend_reject",
  "recommend_call",
] as const;

/**
 * Compute whether an HR decision matches a Toño recommendation. Returns null
 * when the HR action is not on the comparable axis (revoke / reopen /
 * unschedule_call) — caller stores agreed_with_tono = NULL in those cases.
 *
 * Used by Stream B's server actions at decision write time so the boolean is
 * persisted on candidate_decisions.agreed_with_tono.
 */
export function computeAgreedWithTono(
  hrDecision: HrAction,
  tonoRec: TonoRecommendation | null
): boolean | null {
  if (tonoRec === null) return null;
  if (hrDecision === "approve") return tonoRec === "recommend_approve";
  if (hrDecision === "reject") return tonoRec === "recommend_reject";
  if (hrDecision === "schedule_call") return tonoRec === "recommend_call";
  return null;
}

// ===========================================================================
// 2. Specialty taxonomy (verbatim from AppSheet — 2026-05-07)
// ===========================================================================

// 7 worker-relevant categorías (Personal profesional and Poliza dropped — internal).
export const CATEGORIA_VALUES = [
  "Reparaciones Locativas",
  "Eléctrico y Datos",
  "Fachadas y Alturas",
  "Techos y Cubiertas",
  "Hidrosanitario (Plomería)",
  "Logística y Varios",
  "Climatización",
] as const;
export type Categoria = (typeof CATEGORIA_VALUES)[number];

// 26 subcategorías, grouped by parent. Internal admin subcategorías
// (SISO, Compra de Materiales, Viáticos, Poliza) are excluded.
export const SUBCATEGORIA_BY_CATEGORIA: Record<Categoria, readonly string[]> = {
  "Reparaciones Locativas": [
    "Pintura General (Muros/Cielos)",
    "Cerrajería (Chapas, Guardas, Brazos)",
    "Reparación de Pisos y Enchapes",
    "Carpintería (Muebles, Closets, Escritorios)",
    "Resanes y Drywall",
    "Vidrios y Divisiones",
    "Soldadura",
  ],
  "Eléctrico y Datos": [
    "Iluminación (Paneles LED, Balastos)",
    "Puntos Eléctricos (Tomas, Interruptores)",
    "Cableado Estructurado y Datos",
    "Identificación de Cortos/Fallas",
  ],
  "Fachadas y Alturas": [
    "Limpieza de Fachadas (Vidrio/Ladrillo)",
    "Impermeabilización de Cubiertas/Losas",
    "Trabajo en Andamios Certificados",
    "Mantenimiento de Avisos/Publicidad",
  ],
  "Techos y Cubiertas": [
    "Reparación de Goteras/Filtraciones",
    "Limpieza de Canales y Bajantes",
  ],
  "Hidrosanitario (Plomería)": [
    "Reparación de Fugas (Abasto, Tubos)",
    "Instalación Grifería y Baterías Sanitarias",
    "Destape de Cañerías/Sifones",
  ],
  "Logística y Varios": [
    "Alquiler de Equipos (Andamios, Plantas)",
    "Transporte y Acarreos (Mobiliario)",
    "Traslado/Instalación de Equipos",
  ],
  "Climatización": [
    "Instalación de Aire Acondicionado",
    "Mantenimiento de Aire Acondicionado",
    "Refrigeración Comercial",
  ],
};

export const SUBCATEGORIA_VALUES = Object.values(
  SUBCATEGORIA_BY_CATEGORIA
).flat() as readonly string[];
export type Subcategoria = (typeof SUBCATEGORIA_VALUES)[number];

// 27 canonical ciudades — case-normalized from 711 historical OTs.
export const CIUDAD_CANONICAL = [
  "Bogotá",
  "Cali",
  "Medellín",
  "Barranquilla",
  "Cartagena",
  "Bucaramanga",
  "Pereira",
  "Manizales",
  "Pasto",
  "Popayán",
  "Ibagué",
  "Neiva",
  "Villavicencio",
  "Yopal",
  "Arauca",
  "Florencia",
  "Mocoa",
  "Valledupar",
  "Palmira",
  "Jamundí",
  "Buga",
  "Girardot",
  "Espinal",
  "Melgar",
  "Obando",
  "Puerto Boyacá",
  "Santander de Quilichao",
] as const;
export type CiudadCanonical = (typeof CIUDAD_CANONICAL)[number];

// ===========================================================================
// 3. CandidateDossier (Toño's structured handoff — IMMUTABLE)
// ===========================================================================

export type TipoCedula = "CC" | "CE" | "PEP";
export type Modalidad = "individual" | "cuadrilla" | "lider";

/**
 * Boolean claims; document validation lives in the documentos table separately.
 *
 *   altura            — Trabajo seguro en alturas (≥1.5m). Required for any
 *                       "Fachadas y Alturas" OT.
 *   altura_avanzado   — Coordinador de trabajo en alturas. Some Bólivar contracts.
 *   retie             — Reglamento eléctrico colombiano. Required for high-V
 *                       Eléctrico y Datos work.
 *   andamios          — Operador certificado de andamio. Required for the
 *                       "Trabajo en Andamios Certificados" subcategoría.
 *   soldadura         — Safety + competence cert for "Soldadura" subcategoría.
 *   conte             — Consejo profesional electricista (CONTE).
 *   siso              — Curso/cert Sistema de Gestión de Seguridad y Salud en el Trabajo (SG-SST / SISO).
 *   otras             — Free text — anything else the worker mentions.
 */
export interface Certificaciones {
  altura: boolean;
  altura_avanzado: boolean;
  retie: boolean;
  andamios: boolean;
  soldadura: boolean;
  conte: boolean;
  siso: boolean;
  otras?: string;
}

/**
 * Coarse herramientas buckets — not a kit list. Detailed kit goes in `dossier`.
 */
export interface Herramientas {
  basicas: boolean;
  electrica_obra: boolean;
  electrica_medicion: boolean;
  altura_personal: boolean;
  andamio_propio: boolean;
  vehiculo_propio: boolean;
}

export interface Disponibilidad {
  inicio_inmediato: boolean;
  fines_de_semana: boolean;
  nocturno: boolean;
  viaja_otra_ciudad: boolean;
  ciudades_viaje?: CiudadCanonical[];
}

export interface CumplimientoLegal {
  arl_activa: boolean;
  arl_fondo?: string;
  eps_activa: boolean;
  /** Self-declaration; null = no preguntado. */
  antecedentes_limpios: boolean | null;
}

/**
 * The dossier — what Toño produces and HR reviews. IMMUTABLE once submitted
 * (decision 4). HR commentary lives in `hr_notes`, not edits to this payload.
 *
 * Hard filter fields (structured) drive shortlist matching.
 * Free-text `dossier` field carries nuance — NEVER used as a filter.
 */
export interface CandidateDossier {
  schema_version: 1;

  /** REQUIRED. Submission without cedula is rejected at the tool layer (decision 2). */
  cedula: {
    tipo: TipoCedula;
    /** Digits only; tool layer normalizes (strips dots/dashes). 5–11 digits. */
    numero: string;
  };

  modalidad: Modalidad;

  /** 1-4 categorías. 5+ accepted with a `gaps` warning. */
  categorias_principales: Categoria[];

  /** Each must be in SUBCATEGORIA_VALUES. */
  subcategorias: Subcategoria[];

  anos_experiencia: number;

  anos_por_categoria?: Partial<Record<Categoria, number>>;

  ciudad_base: CiudadCanonical;

  ciudades_cobertura?: CiudadCanonical[];

  certificaciones: Certificaciones;

  herramientas: Herramientas;

  disponibilidad: Disponibilidad;

  cumplimiento: CumplimientoLegal;

  referencias_externas?: string[];

  /** Free-text nuance, ≤ 2000 chars. Read by HR. NEVER used for filtering. */
  dossier: string;

  // ---- Optional document references (Story 17) ----
  // Captured only when the worker supplies them during screening. All are
  // OPTIONAL — their absence does NOT block dossier submission or HR approval.
  // HR sees soft "Sin …" badges from missing_optional; they are informational,
  // never state-machine blockers.

  /** doc id from upload_documento tipo='cert_estudios' if supplied */
  cert_estudios_doc_id?: string;

  /** doc id from upload_documento tipo='cert_trabajos_previos' if supplied */
  cert_trabajos_previos_doc_id?: string;

  /**
   * Whether the worker has their own vehicle (any type).
   * undefined = never asked / worker skipped the question.
   */
  tiene_vehiculo?: boolean;

  /**
   * Vehicle type narrated by the worker ("moto", "carro", "camioneta", etc.).
   * Populated only when tiene_vehiculo = true.
   */
  tipo_vehiculo?: string;

  /**
   * Colombian vehicle plate, uppercase, no separators (e.g. "ABC123" or "ABC12D").
   * Required when tiene_vehiculo = true (enforced by submit_candidate_dossier
   * validateVehicle — mirrors the INCOMPLETE_IDENTITY next_action envelope).
   * Must be absent when tiene_vehiculo = false.
   */
  placa_vehiculo?: string;

  /** doc id from upload_documento tipo='evidencia_arl' if supplied */
  arl_doc_id?: string;

  /** doc id from upload_documento tipo='evidencia_eps' if supplied (2026-05-17) */
  eps_doc_id?: string;

  /**
   * Which optional fields were NOT provided. Populated by submit_candidate_dossier
   * from the absent optional fields above. HR queue reads this to render soft
   * "Sin ARL" / "Sin cert. estudios" etc. badges.
   * Always present — empty array if the worker filled everything.
   */
  missing_optional: string[];

  // ---- Graduated-autonomy fields (decision 9) ----
  // Toño's SUGGESTION + how sure + why. HR sees all three on the queue card.
  // Phase 1: HR reviews 100% regardless. No auto-execution.

  /** What Toño suggests HR do. Not a final state — HR may agree or diverge. */
  tono_recommendation: TonoRecommendation;

  /**
   * Self-reported certainty in the recommendation. 0.0 = "guessing",
   * 1.0 = "absolutely sure". Drives queue pre-sort:
   *   high-confidence recommend_approve → top
   *   high-confidence recommend_reject  → bottom (HR batches through)
   *   recommend_call (any confidence)   → top regardless
   * Future use: confidence-threshold gating for selective autonomy. NOT today.
   */
  tono_confidence: number;

  /**
   * Short explanation of WHY this recommendation. 1-3 sentences. Renders to
   * HR as the "why?" expandable on the queue card. Crucial: HR must be able
   * to evaluate Toño's reasoning, not just his label.
   */
  tono_reasoning: string;

  /** Things Toño KNOWS aren't firm — drives HR's call agenda if `recommend_call`. */
  gaps: string[];
}

// ===========================================================================
// 4. Tool I/O — agent-facing contracts
// ===========================================================================

// ---- submit_candidate_dossier ----
// Atomic: validates payload + cedula uniqueness, inserts candidate_dossiers
// row, flips candidate_state (screening → pending OR needs_call), logs event.

export interface SubmitCandidateDossierInput {
  tecnico_id: string;
  dossier: CandidateDossier;
}

/**
 * Outcome codes:
 *
 *   submitted          — dossier landed; state flipped to pending|needs_call.
 *   merged             — cedula matched another tecnico in screening|withdrawn;
 *                        agent's tecnico_id row was merged into the existing
 *                        record. The submission proceeded against `existing_tecnico_id`.
 *   already_decided    — cedula matches an approved|pending|needs_call record.
 *                        No change. Agent tells worker "ya estás registrado".
 *   blocked            — cedula matches a rejected|revoked record. Agent escalates to HR.
 *   cedula_conflict    — cedula format invalid OR collision the agent must resolve.
 *   invalid_payload    — schema/validation error; details in `error`.
 */
export type SubmitDossierCode =
  | "submitted"
  | "merged"
  | "already_decided"
  | "blocked"
  | "cedula_conflict"
  | "invalid_payload";

export interface SubmitCandidateDossierOutput {
  code: SubmitDossierCode;
  dossier_id?: string;
  /** Effective tecnico_id after potential merge. */
  effective_tecnico_id: string;
  resulting_state?: CandidateState;
  /** When code='already_decided' or 'blocked' or 'merged' — the existing match's state. */
  existing_state?: CandidateState;
  /** Soft issues (e.g. "ciudad_base coerced to canonical"). */
  warnings?: string[];
  /** Set when code='invalid_payload' or 'cedula_conflict'. */
  error?: string;
}

// ---- find_by_cedula ----
// Cedula identity lookup so Toño can recognize a returning worker on a new
// phone (decision 6). Auth-free; agent calls it after gathering cedula.
//
// The output carries a `next_action` directive so the agent's branch handling
// is encoded in the tool result, not just in the prompt. The prompt's "REGLA
// ABSOLUTA" requires the agent to obey next_action over conversation momentum.

/**
 * What the agent MUST do based on the lookup result. Six values:
 *
 *   resume_screening                — found in screening|withdrawn; pick up
 *                                      the thread, finish gathering missing
 *                                      fields, submit_candidate_dossier when
 *                                      ready.
 *   tell_user_already_in_queue      — found in pending; tell worker their
 *                                      perfil is in HR queue and stop screening.
 *   tell_user_team_will_call        — found in needs_call; tell worker HR will
 *                                      call them; stop screening.
 *   tell_user_already_approved      — found in approved; tell worker they're
 *                                      already registered and approved; stop.
 *   tell_user_was_rejected          — found in rejected|revoked; escalate via
 *                                      escalate_to_hr (with reason
 *                                      "rejected_returning") after telling
 *                                      the worker. Do NOT auto-reopen.
 *   proceed_with_screening          — found=false. Continue the normal CASE B
 *                                      screening flow. Per the 2026-05-16
 *                                      policy, we no longer attempt fuzzy
 *                                      name reconciliation against legacy
 *                                      bootstrap rows: any legacy worker
 *                                      messaging from a new phone is treated
 *                                      as a new candidate. Duplicates, if
 *                                      they happen, are merged manually.
 */
export type FindByCedulaNextAction =
  | "resume_screening"
  | "tell_user_already_in_queue"
  | "tell_user_team_will_call"
  | "tell_user_already_approved"
  | "tell_user_was_rejected"
  | "proceed_with_screening";

export interface FindByCedulaInput {
  cedula: string;
}
export interface FindByCedulaOutput {
  found: boolean;
  /** Populated when found=true. */
  tecnico_id?: string;
  candidate_state?: CandidateState;
  /** Last seen phone — agent can compare against current session phone to detect a phone-switch resumption. */
  last_phone?: string;
  /** From the latest dossier submission, if any. */
  nombre?: string;
  /** ALWAYS populated. Encodes the branch decision so the agent doesn't have to derive it. */
  next_action: FindByCedulaNextAction;
  /** A short Spanish phrase the agent can paraphrase. Always present; matches next_action. */
  suggested_reply: string;
}

// ---- mark_candidate_withdrawn ----
// Toño calls this when the worker refuses cedula or otherwise opts out. Sets
// candidate_state = 'withdrawn' + records the reason. Idempotent.

export interface MarkCandidateWithdrawnInput {
  tecnico_id: string;
  reason: WithdrawalReason;
  /** Optional free-text expansion. */
  notes?: string;
}
export interface MarkCandidateWithdrawnOutput {
  tecnico_id: string;
  prior_state: CandidateState;
  resulting_state: CandidateState;            // 'withdrawn' on success; prior on already-terminal
  noop: boolean;                              // true if state was already terminal
}

// ===========================================================================
// 5. HR-side contracts (Stream B writes; Stream A's surface is the queue read)
// ===========================================================================

export type HrAction =
  | "approve"          // pending|needs_call → approved (also fires AppSheet Add)
  | "reject"           // pending|needs_call → rejected
  | "schedule_call"    // pending → needs_call
  | "unschedule_call"  // needs_call → pending
  | "revoke"           // approved → revoked  (also fires AppSheet Delete)
  | "reopen";          // rejected|withdrawn → screening

export interface CandidateDecision {
  id: string;
  tecnico_id: string;
  /** The dossier HR was reading at decision time. Null on agent-only paths or for state changes that don't reference a dossier (revoke, reopen). */
  dossier_id: string | null;
  decision: HrAction;
  resulting_state: CandidateState;
  prior_state: CandidateState;
  /**
   * IMMUTABLE snapshot of dossier.tono_recommendation as seen by HR at the
   * moment of decision. NOT a live join — preserves HR's actual view even if
   * a newer dossier was submitted later. NULL when no dossier was reviewed
   * (revoke, reopen, unschedule_call).
   */
  tono_recommendation_at_decision_time: TonoRecommendation | null;
  /**
   * Derived but stored for queryability. true = HR matched Toño's
   * recommendation; false = HR diverged; NULL = non-comparable (revoke,
   * reopen, unschedule_call) or no recommendation snapshot. Server action
   * computes via computeAgreedWithTono() at write time.
   */
  agreed_with_tono: boolean | null;
  /** Free-text "why HR decided what they decided." Distinct from per-candidate hr_notes. */
  hr_reasoning: string | null;
  decided_by: string;                          // 'hr:<email>' | 'system'
  decided_at: string;
}

export interface SubmitDecisionInput {
  tecnico_id: string;
  decision: HrAction;
  hr_reasoning?: string;
  decided_by: string;
}

// ---- HR notes (decision 4) ----

export interface HrNote {
  id: string;
  tecnico_id: string;
  dossier_id: string | null;
  body: string;
  hr_user: string;                             // 'hr:<email>'
  created_at: string;
}

export interface AppendHrNoteInput {
  tecnico_id: string;
  dossier_id?: string | null;
  body: string;
  hr_user: string;
}

// ===========================================================================
// 6. AppSheet projection contract (Stream B's projector)
// ===========================================================================

/**
 * Verified against the live AppSheet API on 2026-05-07. The TECNICOS table
 * accepts only these columns (the rest are computed/server-managed).
 */
export interface AppSheetTecnicosWriteRow {
  /** Display name. REQUIRED. The string AppSheet's autocomplete searches. */
  "Nombre de Tecnico": string;
  /** E.164 phone. Optional in AppSheet; required in our flow. */
  Telefono?: string;
  /** Email if known. Most warm imports leave this empty. */
  EMAIL?: string;
}

export interface AppSheetTecnicosAddResponseRow extends AppSheetTecnicosWriteRow {
  _RowNumber: string;
  "Row ID": string;
  Popularidad_Tecnico?: string;
  "Related DETALLE DE ACTIVIDADESs"?: string;
}

/** Projector outcome — used by Stream B's drainer. */
export type ProjectorAction = "added" | "found_existing" | "deleted" | "skipped";

export interface ProjectorTickResult {
  tecnico_id: string;
  action: ProjectorAction;
  appsheet_row_id?: string;
  attempts: number;
  error?: string;
}

// ===========================================================================
// 7. Cost kill switch (decision 8)
// ===========================================================================

/**
 * Daily cost rollup row from the `daily_llm_cost` view. The agent reads
 * today's row at the start of every NEW conversation; the dashboard widget
 * reads it for the live spend display.
 */
export interface DailyLlmCostRow {
  utc_date: string;                  // YYYY-MM-DD
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  turn_count: number;
  session_count: number;
}

/**
 * Manual kill-switch override. Insert one for today (UTC) to suspend the cap
 * for the rest of the day. Auto-resets at UTC midnight (no override row for
 * tomorrow → fresh budget).
 */
export interface CostKillSwitchOverride {
  id: string;
  override_date: string;             // YYYY-MM-DD
  reset_by: string;                  // 'hr:<email>'
  reset_at: string;
  reason: string | null;
}

export interface KillSwitchState {
  /** USD spent today (UTC). 0 if no turns yet. */
  today_cost_usd: number;
  /** Cap from env TONO_DAILY_COST_USD_LIMIT (default 10). */
  cap_usd: number;
  /** True if today_cost_usd >= cap_usd AND no override row exists. */
  would_block_new_conversations: boolean;
  /** Active override for today, if any. */
  override?: CostKillSwitchOverride;
}

// ---- Graduated-autonomy metrics (decision 9) ----
//
// Row-level shape of the `tono_agreement_metrics` view in migration 007.
// Stream B (or any future analytics consumer) types raw query results against
// this. NO dashboard built today; the view is the data foundation.

export interface TonoAgreementMetricRow {
  decision_id: string;
  tecnico_id: string;
  dossier_id: string | null;
  decided_at: string;
  decided_day: string;                         // YYYY-MM-DD
  decided_week: string;                        // YYYY-MM-DD (Monday of week)
  hr_user: string;
  tono_recommendation: TonoRecommendation;
  hr_decision: HrAction;
  agreed_with_tono: boolean | null;
}

// ===========================================================================
// 8. Per-turn trace (Stream A writes)
// ===========================================================================

export interface TurnRow {
  id: string;
  session_id: string;
  turn_number: number;
  phone: string;
  channel: "whatsapp" | "dashboard" | "manos";
  tecnico_id: string | null;
  candidate_state_at_turn: CandidateState | null;

  inbound_text: string;
  outbound_text: string | null;

  tool_calls:
    | Array<{
        name: string;
        args: Record<string, unknown>;
        result_ok: boolean;
        code?: string;
        latency_ms?: number;
      }>
    | null;

  model: string | null;
  prompt_sha: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  llm_iterations: number | null;

  latency_ms: number | null;

  errors:
    | Array<{ stage: "llm" | "router" | "tool" | "cost"; code: string; message?: string }>
    | null;

  grounding_violations:
    | Array<{ token: string; kind: "number" | "proper_noun" | "placa" | "country_name"; reason: string }>
    | null;

  escalated: boolean;
  refused: boolean;
  cost_killed: boolean;

  started_at: string;
  finished_at: string | null;
}
