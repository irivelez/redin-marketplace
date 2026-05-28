// Redin Marketplace v1 — Supabase DB types
// Hand-authored to match migrations 001–009 exactly. Regenerate via
// `npm run gen:types` once SUPABASE_ACCESS_TOKEN is valid.

import type {
  CandidateState,
  WithdrawalReason,
  TonoRecommendation,
  CandidateDossier,
  HrAction,
  KillSwitchState,
  DailyLlmCostRow,
  CostKillSwitchOverride,
  TurnRow,
  TonoAgreementMetricRow,
} from "./dossier-types";

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// Re-export shared dossier vocabulary so consumers can import from one place.
export type {
  CandidateState,
  WithdrawalReason,
  TonoRecommendation,
  CandidateDossier,
  HrAction,
  KillSwitchState,
  DailyLlmCostRow,
  CostKillSwitchOverride,
  TurnRow,
  TonoAgreementMetricRow,
};


// ---------- Enums / literal unions ----------

export type TecnicoEstado = "activo" | "pausado" | "baneado";

export type QualificationCallOutcome =
  | "approved"
  | "rejected"
  | "needs_more_info"
  | "no_show";
export type SessionChannel = "whatsapp" | "dashboard" | "manos";
export type MessageRole = "user" | "assistant" | "tool";
export type PostulacionState =
  | "postulado"
  | "preseleccionado"
  | "asignado"
  | "rechazado"
  | "descartado"
  | "completado";
export type ContratoStatus = "borrador" | "enviado" | "firmado" | "cancelado";
export type DocumentoTipo =
  | "cedula"
  | "cert_electrica"
  | "arl"
  | "ss"
  | "altura"
  | "antecedentes"
  | "otro"
  // Story 17: optional dossier document types
  | "cert_estudios"
  | "cert_trabajos_previos"
  | "evidencia_arl"
  // Gap A.4 (Irina 2026-05-22): EPS evidence now mandatory alongside ARL.
  // upload_documento.ts already accepts this tipo at runtime; this is a
  // missing line in the shared type that broke the TS build.
  | "evidencia_eps";
export type EventoType =
  | "tecnico_registered"
  | "postulacion_created"
  | "shortlist_proposed"
  | "shortlist_decided"
  | "hr_decision"
  | "contract_drafted"
  | "contract_sent"
  | "contract_signed"
  | "contract_cancelled"
  | "escalation"
  | "document_uploaded"
  | "document_validated"
  | "offer_sent"
  | "agent_tool_call"
  | "message_received"
  | "message_sent"
  | "tecnico_re_registered"
  | "tecnico_legacy_bootstrap"
  | "qualification_review_requested"
  | "deprecated_tool_called"
  | "candidate_dossier_submitted"
  | "candidate_withdrawn"
  | "cedula_merged"
  | "cost_kill_switch_triggered"
  | "appsheet_schema_drift"
  | "refused"
  | "llm_call"
  | "llm_error"
  | "llm_retry"
  // Story 18: customer contact sent a message with no pending rating
  | "customer_contact_intent_attempt"
  | string; // open-ended

// ---------- Table row types ----------
// `type` (not `interface`) — required so these shapes extend `Record<string, unknown>`,
// which the Supabase `GenericTable.Row` constraint demands. Interfaces in strict mode
// are NOT assignable to Record because they lack an index signature — even though
// every property is indexable at runtime. See:
//   https://github.com/microsoft/TypeScript/issues/15300

export type TecnicoExtendedRow = {
  tecnico_id: string;
  phone: string;
  lider_phone: string | null;
  estado: TecnicoEstado;
  onboarded_at: string;
  source: string | null;
  appsheet_synced_at: string | null;
  // Migration 007: 7-state machine; replaces the old qualification_state column.
  candidate_state: CandidateState;
  // Migration 007: cross-system identity. Unique-but-nullable (partial index
  // WHERE cedula IS NOT NULL — multiple NULLs allowed).
  cedula: string | null;
  // Migration 007: filled when state flips to 'withdrawn'.
  withdrawal_reason: string | null;
  // Migration 007: AppSheet projection state (outbox pattern).
  appsheet_row_id: string | null;
  appsheet_sync_pending: boolean;
  appsheet_delete_pending: boolean;
  appsheet_sync_attempts: number;
  appsheet_sync_last_error: string | null;
  // Migration 009: legacy bootstrap + progressive enrichment.
  imported_at: string | null;
  import_source: string | null;
  profile_complete: boolean;
  legacy_popularidad: number | null;
  legacy_activity_count: number | null;
  enrichment_data: Json | null;
  // Migration 004
  last_jid: string | null;
  // Migration 010: first-class display name. NULL on legacy rows whose source
  // event was never written; consumers fall back to eventos.meta.nombre.
  nombre: string | null;
  // Migration 011: callable phone for HR, distinct from `phone` (the WA LID).
  // NULL on legacy rows until the worker next messages Toño; render "Sin
  // teléfono de contacto" — never fall back to `phone`, which may be masked.
  contact_phone: string | null;
};

export type CandidateDossierRow = {
  id: string;
  tecnico_id: string;
  session_id: string | null;
  submitted_by: string;
  payload: Json;
  cedula: string;
  tono_recommendation: TonoRecommendation;
  tono_confidence: number;
  tono_reasoning: string;
  prompt_sha: string | null;
  schema_version: number;
  created_at: string;
};

export type CandidateDecisionRow = {
  id: string;
  // Migration 012: nullable for shortlist-scope rows (per-OT decisions, not per-worker).
  tecnico_id: string | null;
  dossier_id: string | null;
  decision: HrAction;
  resulting_state: CandidateState;
  prior_state: CandidateState;
  tono_recommendation_at_decision_time: TonoRecommendation | null;
  agreed_with_tono: boolean | null;
  hr_reasoning: string | null;
  decided_by: string;
  decided_at: string;
  // Migration 012: shortlist-scope extensions.
  scope: "qualification" | "shortlist";
  ot_id: string | null;
  tono_recommendation_postulacion_id: string | null;
  hr_postulacion_id: string | null;
  pool_hash: string | null;
  tono_confidence: number | null;
  tono_reasoning: string | null;
};

export type HrNoteRow = {
  id: string;
  tecnico_id: string;
  dossier_id: string | null;
  body: string;
  hr_user: string;
  created_at: string;
};

// Flatten TurnRow (declared as an interface in dossier-types.ts) into a mapped
// type so it's index-signature-compatible with supabase-js's GenericTable.Row
// constraint of Record<string, unknown>. Pure type-level re-aliasing — same
// shape, just record-compatible.
export type TurnsRow = { [K in keyof TurnRow]: TurnRow[K] };

export type CostKillSwitchOverrideRow = {
  id: string;
  override_date: string;
  reset_by: string;
  reset_at: string;
  reason: string | null;
};

export type QualificationCallRow = {
  id: string;
  tecnico_id: string;
  scheduled_for: string | null;
  completed_at: string | null;
  outcome: QualificationCallOutcome | null;
  notes: string | null;
  hr_user: string | null;
  created_at: string;
};

export type TecnicoEvaluationRow = {
  id: string;
  tecnico_id: string;
  ot_id: string;
  evaluator: string;
  cumplimiento: number | null;
  calidad: number | null;
  actitud: number | null;
  puntualidad: number | null;
  recommend_rehire: boolean | null;
  notes: string | null;
  created_at: string;
};

export type TecnicoPerformanceRow = {
  tecnico_id: string;
  eval_count: number;
  avg_score: number | null;
  rehire_yes: number;
  rehire_no: number;
  jobs_completed: number;
  jobs_dropped: number;
};

export type SessionRow = {
  id: string;
  phone: string;
  channel: SessionChannel;
  started_at: string;
  last_active: string;
  // Migration 012: per-session metadata blob (Manos uses it to persist arq_row_id).
  meta: Json | null;
};

export type MessageRow = {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string | null;
  tool_calls: Json | null;
  created_at: string;
};

export type PostulacionRow = {
  id: string;
  ot_id: string;
  tecnico_id: string;
  state: PostulacionState;
  mensaje: string | null;
  applied_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type OfertaRow = {
  id: string;
  ot_id: string;
  tecnico_ids: string[];
  sent_at: string;
  expires_at: string | null;
  channel: string;
};

export type ContratoRow = {
  id: string;
  tecnico_id: string;
  ot_id: string | null;
  status: ContratoStatus;
  pdf_storage_path: string | null;
  signed_pdf_storage_path: string | null;
  zapsign_id: string | null;
  sent_at: string | null;
  signed_at: string | null;
  created_by: string | null;
};

export type DocumentoRow = {
  id: string;
  tecnico_id: string;
  tipo: DocumentoTipo;
  storage_path: string;
  validated_by: string | null;
  validated_at: string | null;
  uploaded_at: string;
  classification_jsonb: Json | null;
  classified_at: string | null;
  classifier_model: string | null;
};

export type EventoRow = {
  id: string;
  type: EventoType;
  entity_id: string | null;
  actor: string | null;
  meta: Json | null;
  created_at: string;
};

export type RatingRow = {
  id: string;
  ot_id: string;
  rater: string;
  ratee: string;
  stars: number;
  notes: string | null;
  created_at: string;
};

export type OutboundStatus = "pending" | "sent" | "failed";
export type OutboundKind = "text" | "document";
export type OutboundMessageRow = {
  id: string;
  phone: string;
  body: string;
  channel: string;
  status: OutboundStatus;
  attempts: number;
  created_at: string;
  sent_at: string | null;
  last_error: string | null;
  meta: Json | null;
  kind: OutboundKind;
  attachment_path: string | null;
  attachment_filename: string | null;
  attachment_bucket: string | null;
};

export type MirrorRowBase = {
  row_id: string;
  data: Json;
  synced_at: string;
};

export type TecnicoMirrorRow = MirrorRowBase;
export type ClienteMirrorRow = MirrorRowBase;
export type ArquitectoMirrorRow = MirrorRowBase;
export type ActividadMirrorRow = MirrorRowBase;

export type OTMirrorRow = MirrorRowBase & {
  ciudad: string | null;
  especialidad: string | null;
  estado: string | null;
};

// Migration 012: Manos write-side extension to ots_mirror.
// Holds architect-submitted alcance (scope) + photo paths + AppSheet writeback state.
export type OtsExtendedRow = {
  ot_row_id: string;
  alcance_jsonb: Json | null;
  alcance_pdf_path: string | null;
  photo_paths: string[];
  last_architect_arq_row_id: string | null;
  last_architect_phone: string | null;
  created_at: string;
  updated_at: string;
  // AppSheet writeback outbox — mirrors tecnicos_extended pattern.
  appsheet_alcance_pending: boolean;
  appsheet_alcance_sync_attempts: number;
  appsheet_alcance_last_error: string | null;
};

export type ContactoMirrorRow = MirrorRowBase & {
  id_contacto: string | null;
  telefono: string | null;
};

// Migration 012: shortlist agreement metrics view row
export type ShortlistAgreementMetricRow = {
  decision_id: string;
  ot_id: string;
  decided_at: string;
  decided_day: string;
  decided_week: string;
  hr_user: string;
  tono_recommendation_postulacion_id: string;
  hr_postulacion_id: string;
  agreed_with_tono: boolean | null;
  tono_confidence: number | null;
  tono_reasoning: string | null;
};

// ---------- Supabase Database schema handle ----------

type NoRelationships = [];

type NullableKeys<T> = {
  [K in keyof T]: null extends T[K] ? K : never;
}[keyof T];
type OptionalNulls<T> = Omit<T, NullableKeys<T>> & Partial<Pick<T, NullableKeys<T>>>;

type Table<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: NoRelationships;
};

export interface Database {
  public: {
    Tables: {
      tecnicos_extended: Table<
        TecnicoExtendedRow,
        OptionalNulls<
          Omit<
            TecnicoExtendedRow,
            | "onboarded_at"
            | "estado"
            | "candidate_state"
            | "appsheet_sync_pending"
            | "appsheet_delete_pending"
            | "appsheet_sync_attempts"
            | "profile_complete"
          > & {
            onboarded_at?: string;
            estado?: TecnicoEstado;
            candidate_state?: CandidateState;
            appsheet_sync_pending?: boolean;
            appsheet_delete_pending?: boolean;
            appsheet_sync_attempts?: number;
            profile_complete?: boolean;
          }
        >,
        Partial<TecnicoExtendedRow>
      >;
      candidate_dossiers: Table<
        CandidateDossierRow,
        OptionalNulls<
          Omit<
            CandidateDossierRow,
            "id" | "submitted_by" | "schema_version" | "created_at"
          > & {
            id?: string;
            submitted_by?: string;
            schema_version?: number;
            created_at?: string;
          }
        >,
        Partial<CandidateDossierRow>
      >;
      candidate_decisions: Table<
        CandidateDecisionRow,
        OptionalNulls<
          Omit<CandidateDecisionRow, "id" | "decided_at" | "scope"> & {
            id?: string;
            decided_at?: string;
            scope?: "qualification" | "shortlist";
          }
        >,
        Partial<CandidateDecisionRow>
      >;
      hr_notes: Table<
        HrNoteRow,
        OptionalNulls<
          Omit<HrNoteRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<HrNoteRow>
      >;
      turns: Table<
        TurnsRow,
        OptionalNulls<
          Omit<
            TurnsRow,
            "id" | "started_at" | "escalated" | "refused" | "cost_killed"
          > & {
            id?: string;
            started_at?: string;
            escalated?: boolean;
            refused?: boolean;
            cost_killed?: boolean;
          }
        >,
        Partial<TurnsRow>
      >;
      cost_kill_switch_overrides: Table<
        CostKillSwitchOverrideRow,
        OptionalNulls<
          Omit<CostKillSwitchOverrideRow, "id" | "reset_at"> & {
            id?: string;
            reset_at?: string;
          }
        >,
        Partial<CostKillSwitchOverrideRow>
      >;
      qualification_calls: Table<
        QualificationCallRow,
        OptionalNulls<
          Omit<QualificationCallRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<QualificationCallRow>
      >;
      tecnico_evaluations: Table<
        TecnicoEvaluationRow,
        OptionalNulls<
          Omit<TecnicoEvaluationRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<TecnicoEvaluationRow>
      >;
      sessions: Table<
        SessionRow,
        OptionalNulls<
          Omit<SessionRow, "id" | "started_at" | "last_active"> & {
            id?: string;
            started_at?: string;
            last_active?: string;
            meta?: Json | null;
          }
        >,
        Partial<SessionRow>
      >;
      messages: Table<
        MessageRow,
        OptionalNulls<
          Omit<MessageRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<MessageRow>
      >;
      postulaciones: Table<
        PostulacionRow,
        OptionalNulls<
          Omit<PostulacionRow, "id" | "state" | "applied_at"> & {
            id?: string;
            state?: PostulacionState;
            applied_at?: string;
          }
        >,
        Partial<PostulacionRow>
      >;
      ofertas: Table<
        OfertaRow,
        OptionalNulls<
          Omit<OfertaRow, "id" | "sent_at" | "channel"> & {
            id?: string;
            sent_at?: string;
            channel?: string;
          }
        >,
        Partial<OfertaRow>
      >;
      contratos: Table<
        ContratoRow,
        OptionalNulls<
          Omit<ContratoRow, "id" | "status"> & {
            id?: string;
            status?: ContratoStatus;
          }
        >,
        Partial<ContratoRow>
      >;
      documentos: Table<
        DocumentoRow,
        OptionalNulls<
          Omit<DocumentoRow, "id" | "uploaded_at"> & {
            id?: string;
            uploaded_at?: string;
          }
        >,
        Partial<DocumentoRow>
      >;
      eventos: Table<
        EventoRow,
        OptionalNulls<
          Omit<EventoRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<EventoRow>
      >;
      ratings: Table<
        RatingRow,
        OptionalNulls<
          Omit<RatingRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<RatingRow>
      >;
      outbound_messages: Table<
        OutboundMessageRow,
        OptionalNulls<
          Omit<
            OutboundMessageRow,
            "id" | "created_at" | "channel" | "status" | "attempts" | "kind"
          > & {
            id?: string;
            created_at?: string;
            channel?: string;
            status?: OutboundStatus;
            attempts?: number;
            kind?: OutboundKind;
          }
        >,
        Partial<OutboundMessageRow>
      >;
      tecnicos_mirror: Table<
        TecnicoMirrorRow,
        Omit<TecnicoMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<TecnicoMirrorRow>
      >;
      ots_mirror: Table<
        OTMirrorRow,
        Omit<OTMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<OTMirrorRow>
      >;
      ots_extended: Table<
        OtsExtendedRow,
        OptionalNulls<
          Omit<
            OtsExtendedRow,
            | "created_at"
            | "updated_at"
            | "appsheet_alcance_pending"
            | "appsheet_alcance_sync_attempts"
          > & {
            created_at?: string;
            updated_at?: string;
            appsheet_alcance_pending?: boolean;
            appsheet_alcance_sync_attempts?: number;
          }
        >,
        Partial<OtsExtendedRow>
      >;
      clientes_mirror: Table<
        ClienteMirrorRow,
        Omit<ClienteMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ClienteMirrorRow>
      >;
      arquitectos_mirror: Table<
        ArquitectoMirrorRow,
        Omit<ArquitectoMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ArquitectoMirrorRow>
      >;
      actividades_mirror: Table<
        ActividadMirrorRow,
        Omit<ActividadMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ActividadMirrorRow>
      >;
      contactos_mirror: Table<
        ContactoMirrorRow,
        Omit<ContactoMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ContactoMirrorRow>
      >;
    };
    Views: {
      tecnico_performance: {
        Row: TecnicoPerformanceRow;
        Relationships: NoRelationships;
      };
      daily_llm_cost: {
        // Materialize via mapped type — DailyLlmCostRow is an interface in
        // dossier-types.ts and supabase-js's GenericView constraint requires
        // Record<string, unknown>-compatible Rows. Mapped types satisfy that.
        Row: { [K in keyof DailyLlmCostRow]: DailyLlmCostRow[K] };
        Relationships: NoRelationships;
      };
      turn_costs: {
        Row: {
          id: string;
          session_id: string;
          turn_number: number;
          phone: string;
          model: string | null;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          cost_usd: number;
          latency_ms: number | null;
          started_at: string;
        };
        Relationships: NoRelationships;
      };
      tono_agreement_metrics: {
        Row: { [K in keyof TonoAgreementMetricRow]: TonoAgreementMetricRow[K] };
        Relationships: NoRelationships;
      };
      shortlist_agreement_metrics: {
        Row: ShortlistAgreementMetricRow;
        Relationships: NoRelationships;
      };
    };
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}
