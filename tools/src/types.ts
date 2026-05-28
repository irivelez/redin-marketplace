// Public tool I/O types. These are the agent's contract with the system.
// Each tool returns a `ToolResult<T>` so error handling is uniform and the
// agent never sees a thrown exception it can't attribute.

import type {
  ContratoRow,
  DocumentoTipo,
  PostulacionRow,
  TecnicoExtendedRow,
} from "@redin/shared";

export type Actor = `agent` | `tecnico:${string}` | `hr:${string}` | `system`;

export interface ToolSuccess<T> {
  ok: true;
  data: T;
}
export interface ToolError {
  ok: false;
  error: string;
  code?: string;
  retryable?: boolean;
  // Tool-driven control signals. Used when the tool refuses but knows what
  // the agent should ask the user next — the agent reads these and follows
  // them verbatim (see Toño's REGLA ABSOLUTA on next_action). Currently
  // populated by register_tecnico's INCOMPLETE_IDENTITY rejection.
  next_action?: string;
  missing?: string[];
  user_message_hint?: string;
}
export type ToolResult<T> = ToolSuccess<T> | ToolError;

export function ok<T>(data: T): ToolSuccess<T> {
  return { ok: true, data };
}
export function err(
  error: string,
  opts?: {
    code?: string;
    retryable?: boolean;
    next_action?: string;
    missing?: string[];
    user_message_hint?: string;
  }
): ToolError {
  return {
    ok: false,
    error,
    code: opts?.code,
    retryable: opts?.retryable,
    next_action: opts?.next_action,
    missing: opts?.missing,
    user_message_hint: opts?.user_message_hint,
  };
}

// ---------- identify_user ----------
export interface IdentifyUserInput {
  phone: string;
}
// nombre / ciudad / especialidades / modalidad are enriched from the latest
// `tecnico_registered` event (or `tecnicos_mirror` for AppSheet-source rows).
// They live on the row object so the agent treats them as authoritative profile.
export type IdentifyUserTecnico = TecnicoExtendedRow & {
  nombre: string | null;
  ciudad: string | null;
  especialidades: string[] | null;
  modalidad: string | null;
};

// Compact summary of the worker's most-recent submitted dossier. The agent
// uses this to AVOID re-asking fields that are already known (Gap A.2).
// Only populated when the worker has a dossier (candidate_state in pending,
// needs_call, approved, revoked, rejected) — never for fresh 'screening'.
export interface DossierSummary {
  submitted_at: string;                          // ISO timestamp
  // Self-declared profile fields
  cedula_present: boolean;
  modalidad: string | null;                      // 'individual' | 'cuadrilla'
  ciudad_base: string | null;
  ciudades_cobertura: string[] | null;
  categorias_principales: string[] | null;
  subcategorias: string[] | null;
  anos_experiencia: number | null;
  // Compliance declarations (true = declared yes; null = unknown)
  arl_activa: boolean | null;
  eps_activa: boolean | null;
  antecedentes_limpios: boolean | null;
  // Tools & vehicle
  vehiculo_propio: boolean | null;
  tipo_vehiculo: string | null;
  placa_vehiculo: string | null;
  herramientas_basicas: boolean | null;
  // Certifications (declared)
  cert_altura: boolean | null;
  cert_retie: boolean | null;
  cert_andamios: boolean | null;
  // Document presence (uploaded artifacts, separate from declared status)
  has_arl_doc: boolean;
  has_eps_doc: boolean;
  has_cert_estudios_doc: boolean;
  has_cert_trabajos_doc: boolean;
  // External references collected (jefe anterior, etc.)
  has_referencias: boolean;
  referencias_count: number;
  // Toño's last recommendation snapshot
  tono_recommendation: "recommend_approve" | "recommend_reject" | "recommend_call";
  tono_confidence: number;
}

export type IdentifyUserOutput =
  | {
      found: true;
      tecnico: IdentifyUserTecnico;
      /**
       * Present when the worker has submitted a dossier (candidate_state in
       * pending/needs_call/approved/revoked/rejected). Use this to skip
       * re-asking fields the worker already provided. Absent for fresh
       * screening workers (no prior dossier).
       */
      dossier_summary?: DossierSummary;
    }
  | { found: false; phone: string };

// ---------- register_tecnico ----------
export interface RegisterTecnicoInput {
  phone: string;
  nombre: string;
  ciudad: string;
  especialidades: string[]; // 1+ items
  // Accepts "solo" as alias for "individual" — normalized in register-tecnico.ts.
  modalidad: "individual" | "solo" | "cuadrilla" | "lider";
  lider_phone?: string | null;
  // Migration 011: separate callable phone. May be the same digits as `phone`
  // (the WhatsApp identity / LID) or different. Required by validateIdentity in
  // the handler; optional in this shape because the LLM may forget on first
  // call — the tool returns INCOMPLETE_IDENTITY with next_action="ask_contact_phone"
  // and the agent loops back.
  contact_phone?: string | null;
  source?: string;
  actor?: Actor;
}
export interface RegisterTecnicoOutput {
  tecnico_id: string;
  created: boolean; // false if already existed; we upsert by phone
}

// ---------- read_pending_ots ----------
export interface ReadPendingOtsInput {
  ciudad?: string;
  especialidad?: string;
  tecnico_id?: string; // if given, filters by tecnico's profile match
  limit?: number;
}
export interface PendingOtSummary {
  ot_id: string;
  ciudad: string | null;
  especialidad: string | null;
  estado: string | null;
  descripcion: string;
  shortlist_count: number;
  postulacion_count: number;
  created_at: string | null;
  // Budget — Valor_Estimado from AppSheet, parsed and pre-formatted as COP
  // ($ X.XXX.XXX). The agent should quote the label as-is; the numeric form
  // is exposed only for downstream sorts/filters.
  valor_estimado: number | null;
  valor_estimado_label: string | null;
  // Fecha_Programada from AppSheet, formatted dd/mm/yyyy. Tells the worker
  // when the job actually starts.
  fecha_programada: string | null;
  // Alcance fields from ots_extended (Stream A migration 012). Present when
  // the architect has enriched the OT via Manos. Both are null when the table
  // doesn't exist yet or when the architect hasn't filled in alcance yet.
  has_alcance?: boolean;
  alcance_pdf_url?: string | null;
}
export interface ReadPendingOtsOutput {
  ots: PendingOtSummary[];
  matched_by_profile: boolean;
}

// ---------- create_postulacion ----------
export interface CreatePostulacionInput {
  ot_id: string;
  tecnico_id: string;
  mensaje?: string;
  actor?: Actor;
}
export interface CreatePostulacionOutput {
  postulacion_id: string;
  state: "postulado" | "already_applied";
  // Echoed back so the agent can summarize the OT for the worker without
  // a separate read_pending_ots round-trip.
  ot: {
    ciudad: string | null;
    especialidad: string | null;
    descripcion: string;
    estado: string | null;
  };
}

// ---------- read_my_postulaciones ----------
export interface ReadMyPostulacionesInput {
  tecnico_id: string;
  limit?: number;
}
export interface PostulacionSummary {
  postulacion: PostulacionRow;
  ot: {
    ot_id: string;
    ciudad: string | null;
    especialidad: string | null;
    estado: string | null;
    descripcion: string;
  } | null;
}
export interface ReadMyPostulacionesOutput {
  postulaciones: PostulacionSummary[];
}

// ---------- read_my_contratos ----------
export interface ReadMyContratosInput {
  tecnico_id: string;
  limit?: number;
}
export interface ReadMyContratosOutput {
  contratos: ContratoRow[];
}

// ---------- upload_documento ----------
export interface UploadDocumentoInput {
  tecnico_id: string;
  tipo: DocumentoTipo;
  filename: string;
  // Either raw bytes or a storage_path if already uploaded out-of-band.
  content?: Uint8Array | Buffer;
  contentType?: string;
  storage_path?: string;
  actor?: Actor;
}
export interface UploadDocumentoOutput {
  documento_id: string;
  storage_path: string;
}

// ---------- escalate_to_hr ----------
export interface EscalateToHrInput {
  tecnico_id?: string;
  phone?: string;
  reason: string;
  context: string;
  actor?: Actor;
}
export interface EscalateToHrOutput {
  escalation_id: string;
  delivered_to_telegram: boolean;
}

// ---------- set_qualification_state — DEPRECATED COMPATIBILITY SHIM ----------
// Removed from the LLM-visible tool list (schemas.ts) — the agent can no
// longer call it. Dispatch entry remains so HR dashboard server actions
// referencing the legacy name keep working until Stream B retires them.
// See tools/src/set-qualification-state.ts for the translation table.
export interface SetQualificationStateInput {
  tecnico_id: string;
  state:
    | "needs_review"
    | "qualified"
    | "rejected"
    | "needs_call"
    | "pending";
  summary?: string;
  actor?: Actor;
}
export interface SetQualificationStateOutput {
  tecnico_id: string;
  state: string;
  prior_state?: string;
}

// ---------- log_event ----------
export interface LogEventInput {
  type: string;
  entity_id?: string | null;
  actor?: Actor;
  meta?: Record<string, unknown>;
}
export interface LogEventOutput {
  evento_id: string;
}

// ---------- classify_documento ----------
export interface ClassifyDocumentoInput {
  documento_id: string;
  // The tipo the worker/agent claimed when uploading. Used to compute
  // matches_expected (loose match). Defaults to the stored tipo if omitted.
  expected_tipo?: string;
}
export interface ClassifyDocumentoOutput {
  // One of: cedula | cert_electrica | arl | ss | altura | antecedentes |
  // cert_estudios | cert_trabajos_previos | evidencia_arl | evidencia_eps |
  // paz_y_salvo | contrato | otro | unreadable
  classified_type: string;
  // true if classified_type matches expected_tipo (loose: evidencia_arl ~ arl, etc.)
  matches_expected: boolean;
  // Gemini's self-reported confidence [0, 1]
  confidence: number;
  // SECURITY (2026-05-28): extracted_fields used to live here but contained
  // PII (cedula number, EPS/ARL provider names, fechas). Returning that to
  // the LLM was a Habeas Data Ley 1581 exposure — the LLM can echo it into
  // a worker's WA reply. Full payload is still persisted to
  // documentos.classification_jsonb for HR's DocViewer; only the chat-facing
  // contract is narrowed. Discrepancies surfaced through HR dashboard, not Toño.
}
