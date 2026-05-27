export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      actividades_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      arquitectos_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      candidate_decisions: {
        Row: {
          agreed_with_tono: boolean | null
          decided_at: string
          decided_by: string
          decision: string
          dossier_id: string | null
          hr_postulacion_id: string | null
          hr_reasoning: string | null
          id: string
          ot_id: string | null
          pool_hash: string | null
          prior_state: string
          resulting_state: string
          scope: string
          tecnico_id: string | null
          tono_confidence: number | null
          tono_reasoning: string | null
          tono_recommendation_at_decision_time: string | null
          tono_recommendation_postulacion_id: string | null
        }
        Insert: {
          agreed_with_tono?: boolean | null
          decided_at?: string
          decided_by: string
          decision: string
          dossier_id?: string | null
          hr_postulacion_id?: string | null
          hr_reasoning?: string | null
          id?: string
          ot_id?: string | null
          pool_hash?: string | null
          prior_state: string
          resulting_state: string
          scope?: string
          tecnico_id?: string | null
          tono_confidence?: number | null
          tono_reasoning?: string | null
          tono_recommendation_at_decision_time?: string | null
          tono_recommendation_postulacion_id?: string | null
        }
        Update: {
          agreed_with_tono?: boolean | null
          decided_at?: string
          decided_by?: string
          decision?: string
          dossier_id?: string | null
          hr_postulacion_id?: string | null
          hr_reasoning?: string | null
          id?: string
          ot_id?: string | null
          pool_hash?: string | null
          prior_state?: string
          resulting_state?: string
          scope?: string
          tecnico_id?: string | null
          tono_confidence?: number | null
          tono_reasoning?: string | null
          tono_recommendation_at_decision_time?: string | null
          tono_recommendation_postulacion_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_decisions_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "candidate_dossiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_decisions_hr_postulacion_id_fkey"
            columns: ["hr_postulacion_id"]
            isOneToOne: false
            referencedRelation: "postulaciones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_decisions_ot_id_fkey"
            columns: ["ot_id"]
            isOneToOne: false
            referencedRelation: "ots_mirror"
            referencedColumns: ["row_id"]
          },
          {
            foreignKeyName: "candidate_decisions_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "candidate_decisions_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "candidate_decisions_tono_recommendation_postulacion_id_fkey"
            columns: ["tono_recommendation_postulacion_id"]
            isOneToOne: false
            referencedRelation: "postulaciones"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_dossiers: {
        Row: {
          cedula: string
          created_at: string
          id: string
          payload: Json
          prompt_sha: string | null
          schema_version: number
          session_id: string | null
          submitted_by: string
          tecnico_id: string
          tono_confidence: number
          tono_reasoning: string
          tono_recommendation: string
        }
        Insert: {
          cedula: string
          created_at?: string
          id?: string
          payload: Json
          prompt_sha?: string | null
          schema_version?: number
          session_id?: string | null
          submitted_by?: string
          tecnico_id: string
          tono_confidence: number
          tono_reasoning: string
          tono_recommendation: string
        }
        Update: {
          cedula?: string
          created_at?: string
          id?: string
          payload?: Json
          prompt_sha?: string | null
          schema_version?: number
          session_id?: string | null
          submitted_by?: string
          tecnico_id?: string
          tono_confidence?: number
          tono_reasoning?: string
          tono_recommendation?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_dossiers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_dossiers_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "candidate_dossiers_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      clientes_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      contactos_mirror: {
        Row: {
          data: Json
          id_contacto: string | null
          row_id: string
          synced_at: string | null
          telefono: string | null
        }
        Insert: {
          data: Json
          id_contacto?: string | null
          row_id: string
          synced_at?: string | null
          telefono?: string | null
        }
        Update: {
          data?: Json
          id_contacto?: string | null
          row_id?: string
          synced_at?: string | null
          telefono?: string | null
        }
        Relationships: []
      }
      contratos: {
        Row: {
          created_by: string | null
          id: string
          ot_id: string | null
          pdf_storage_path: string | null
          sent_at: string | null
          signed_at: string | null
          signed_pdf_storage_path: string | null
          status: string | null
          tecnico_id: string
          zapsign_id: string | null
        }
        Insert: {
          created_by?: string | null
          id?: string
          ot_id?: string | null
          pdf_storage_path?: string | null
          sent_at?: string | null
          signed_at?: string | null
          signed_pdf_storage_path?: string | null
          status?: string | null
          tecnico_id: string
          zapsign_id?: string | null
        }
        Update: {
          created_by?: string | null
          id?: string
          ot_id?: string | null
          pdf_storage_path?: string | null
          sent_at?: string | null
          signed_at?: string | null
          signed_pdf_storage_path?: string | null
          status?: string | null
          tecnico_id?: string
          zapsign_id?: string | null
        }
        Relationships: []
      }
      cost_kill_switch_overrides: {
        Row: {
          id: string
          override_date: string
          reason: string | null
          reset_at: string
          reset_by: string
        }
        Insert: {
          id?: string
          override_date: string
          reason?: string | null
          reset_at?: string
          reset_by: string
        }
        Update: {
          id?: string
          override_date?: string
          reason?: string | null
          reset_at?: string
          reset_by?: string
        }
        Relationships: []
      }
      documentos: {
        Row: {
          classification_jsonb: Json | null
          classified_at: string | null
          classifier_model: string | null
          id: string
          storage_path: string
          tecnico_id: string
          tipo: string
          uploaded_at: string | null
          validated_at: string | null
          validated_by: string | null
        }
        Insert: {
          classification_jsonb?: Json | null
          classified_at?: string | null
          classifier_model?: string | null
          id?: string
          storage_path: string
          tecnico_id: string
          tipo: string
          uploaded_at?: string | null
          validated_at?: string | null
          validated_by?: string | null
        }
        Update: {
          classification_jsonb?: Json | null
          classified_at?: string | null
          classifier_model?: string | null
          id?: string
          storage_path?: string
          tecnico_id?: string
          tipo?: string
          uploaded_at?: string | null
          validated_at?: string | null
          validated_by?: string | null
        }
        Relationships: []
      }
      eventos: {
        Row: {
          actor: string | null
          created_at: string | null
          entity_id: string | null
          id: string
          meta: Json | null
          type: string
        }
        Insert: {
          actor?: string | null
          created_at?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          type: string
        }
        Update: {
          actor?: string | null
          created_at?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          type?: string
        }
        Relationships: []
      }
      hr_notes: {
        Row: {
          body: string
          created_at: string
          dossier_id: string | null
          hr_user: string
          id: string
          tecnico_id: string
        }
        Insert: {
          body: string
          created_at?: string
          dossier_id?: string | null
          hr_user: string
          id?: string
          tecnico_id: string
        }
        Update: {
          body?: string
          created_at?: string
          dossier_id?: string | null
          hr_user?: string
          id?: string
          tecnico_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hr_notes_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "candidate_dossiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hr_notes_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "hr_notes_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string | null
          created_at: string | null
          id: string
          role: string
          session_id: string | null
          tool_calls: Json | null
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          id?: string
          role: string
          session_id?: string | null
          tool_calls?: Json | null
        }
        Update: {
          content?: string | null
          created_at?: string | null
          id?: string
          role?: string
          session_id?: string | null
          tool_calls?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ofertas: {
        Row: {
          channel: string | null
          expires_at: string | null
          id: string
          ot_id: string
          sent_at: string | null
          tecnico_ids: string[]
        }
        Insert: {
          channel?: string | null
          expires_at?: string | null
          id?: string
          ot_id: string
          sent_at?: string | null
          tecnico_ids: string[]
        }
        Update: {
          channel?: string | null
          expires_at?: string | null
          id?: string
          ot_id?: string
          sent_at?: string | null
          tecnico_ids?: string[]
        }
        Relationships: []
      }
      ot_offers: {
        Row: {
          created_at: string
          document_message_id: string | null
          expires_at: string
          hr_user_email: string | null
          id: string
          meta: Json
          ot_row_id: string
          responded_at: string | null
          response_text: string | null
          sent_at: string
          state: string
          tecnico_id: string
          text_message_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          document_message_id?: string | null
          expires_at?: string
          hr_user_email?: string | null
          id?: string
          meta?: Json
          ot_row_id: string
          responded_at?: string | null
          response_text?: string | null
          sent_at?: string
          state?: string
          tecnico_id: string
          text_message_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          document_message_id?: string | null
          expires_at?: string
          hr_user_email?: string | null
          id?: string
          meta?: Json
          ot_row_id?: string
          responded_at?: string | null
          response_text?: string | null
          sent_at?: string
          state?: string
          tecnico_id?: string
          text_message_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ot_offers_document_message_id_fkey"
            columns: ["document_message_id"]
            isOneToOne: false
            referencedRelation: "outbound_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ot_offers_ot_row_id_fkey"
            columns: ["ot_row_id"]
            isOneToOne: false
            referencedRelation: "ots_mirror"
            referencedColumns: ["row_id"]
          },
          {
            foreignKeyName: "ot_offers_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "ot_offers_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "ot_offers_text_message_id_fkey"
            columns: ["text_message_id"]
            isOneToOne: false
            referencedRelation: "outbound_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      ots_extended: {
        Row: {
          alcance_jsonb: Json | null
          alcance_pdf_path: string | null
          appsheet_alcance_last_error: string | null
          appsheet_alcance_pending: boolean
          appsheet_alcance_sync_attempts: number
          created_at: string
          last_architect_arq_row_id: string | null
          last_architect_phone: string | null
          ot_row_id: string
          photo_paths: string[]
          updated_at: string
        }
        Insert: {
          alcance_jsonb?: Json | null
          alcance_pdf_path?: string | null
          appsheet_alcance_last_error?: string | null
          appsheet_alcance_pending?: boolean
          appsheet_alcance_sync_attempts?: number
          created_at?: string
          last_architect_arq_row_id?: string | null
          last_architect_phone?: string | null
          ot_row_id: string
          photo_paths?: string[]
          updated_at?: string
        }
        Update: {
          alcance_jsonb?: Json | null
          alcance_pdf_path?: string | null
          appsheet_alcance_last_error?: string | null
          appsheet_alcance_pending?: boolean
          appsheet_alcance_sync_attempts?: number
          created_at?: string
          last_architect_arq_row_id?: string | null
          last_architect_phone?: string | null
          ot_row_id?: string
          photo_paths?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ots_extended_ot_row_id_fkey"
            columns: ["ot_row_id"]
            isOneToOne: true
            referencedRelation: "ots_mirror"
            referencedColumns: ["row_id"]
          },
        ]
      }
      ots_mirror: {
        Row: {
          ciudad: string | null
          data: Json
          especialidad: string | null
          estado: string | null
          row_id: string
          synced_at: string | null
        }
        Insert: {
          ciudad?: string | null
          data: Json
          especialidad?: string | null
          estado?: string | null
          row_id: string
          synced_at?: string | null
        }
        Update: {
          ciudad?: string | null
          data?: Json
          especialidad?: string | null
          estado?: string | null
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      outbound_messages: {
        Row: {
          attachment_bucket: string | null
          attachment_filename: string | null
          attachment_path: string | null
          attempts: number
          body: string
          channel: string
          created_at: string
          id: string
          kind: string
          last_error: string | null
          meta: Json | null
          phone: string
          sent_at: string | null
          status: string
        }
        Insert: {
          attachment_bucket?: string | null
          attachment_filename?: string | null
          attachment_path?: string | null
          attempts?: number
          body: string
          channel?: string
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          meta?: Json | null
          phone: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          attachment_bucket?: string | null
          attachment_filename?: string | null
          attachment_path?: string | null
          attempts?: number
          body?: string
          channel?: string
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          meta?: Json | null
          phone?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: []
      }
      postulaciones: {
        Row: {
          applied_at: string | null
          decided_at: string | null
          decided_by: string | null
          id: string
          mensaje: string | null
          ot_id: string
          state: string
          tecnico_id: string
        }
        Insert: {
          applied_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          mensaje?: string | null
          ot_id: string
          state?: string
          tecnico_id: string
        }
        Update: {
          applied_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          mensaje?: string | null
          ot_id?: string
          state?: string
          tecnico_id?: string
        }
        Relationships: []
      }
      qualification_calls: {
        Row: {
          completed_at: string | null
          created_at: string | null
          hr_user: string | null
          id: string
          notes: string | null
          outcome: string | null
          scheduled_for: string | null
          tecnico_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          hr_user?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          scheduled_for?: string | null
          tecnico_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          hr_user?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          scheduled_for?: string | null
          tecnico_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "qualification_calls_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "qualification_calls_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      ratings: {
        Row: {
          created_at: string | null
          id: string
          notes: string | null
          ot_id: string
          ratee: string
          rater: string
          stars: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          notes?: string | null
          ot_id: string
          ratee: string
          rater: string
          stars?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          notes?: string | null
          ot_id?: string
          ratee?: string
          rater?: string
          stars?: number | null
        }
        Relationships: []
      }
      sessions: {
        Row: {
          channel: string
          id: string
          last_active: string | null
          meta: Json | null
          phone: string
          started_at: string | null
        }
        Insert: {
          channel: string
          id?: string
          last_active?: string | null
          meta?: Json | null
          phone: string
          started_at?: string | null
        }
        Update: {
          channel?: string
          id?: string
          last_active?: string | null
          meta?: Json | null
          phone?: string
          started_at?: string | null
        }
        Relationships: []
      }
      tecnico_evaluations: {
        Row: {
          actitud: number | null
          calidad: number | null
          created_at: string | null
          cumplimiento: number | null
          evaluator: string
          id: string
          notes: string | null
          ot_id: string
          puntualidad: number | null
          recommend_rehire: boolean | null
          tecnico_id: string
        }
        Insert: {
          actitud?: number | null
          calidad?: number | null
          created_at?: string | null
          cumplimiento?: number | null
          evaluator: string
          id?: string
          notes?: string | null
          ot_id: string
          puntualidad?: number | null
          recommend_rehire?: boolean | null
          tecnico_id: string
        }
        Update: {
          actitud?: number | null
          calidad?: number | null
          created_at?: string | null
          cumplimiento?: number | null
          evaluator?: string
          id?: string
          notes?: string | null
          ot_id?: string
          puntualidad?: number | null
          recommend_rehire?: boolean | null
          tecnico_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tecnico_evaluations_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "tecnico_evaluations_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      tecnicos_extended: {
        Row: {
          appsheet_delete_pending: boolean
          appsheet_row_id: string | null
          appsheet_sync_attempts: number
          appsheet_sync_last_error: string | null
          appsheet_sync_pending: boolean
          appsheet_synced_at: string | null
          candidate_state: string
          cedula: string | null
          contact_phone: string | null
          enrichment_data: Json | null
          estado: string | null
          import_source: string | null
          imported_at: string | null
          last_jid: string | null
          legacy_activity_count: number | null
          legacy_popularidad: number | null
          lider_phone: string | null
          nombre: string | null
          onboarded_at: string | null
          phone: string
          profile_complete: boolean
          source: string | null
          tecnico_id: string
          withdrawal_reason: string | null
        }
        Insert: {
          appsheet_delete_pending?: boolean
          appsheet_row_id?: string | null
          appsheet_sync_attempts?: number
          appsheet_sync_last_error?: string | null
          appsheet_sync_pending?: boolean
          appsheet_synced_at?: string | null
          candidate_state?: string
          cedula?: string | null
          contact_phone?: string | null
          enrichment_data?: Json | null
          estado?: string | null
          import_source?: string | null
          imported_at?: string | null
          last_jid?: string | null
          legacy_activity_count?: number | null
          legacy_popularidad?: number | null
          lider_phone?: string | null
          nombre?: string | null
          onboarded_at?: string | null
          phone: string
          profile_complete?: boolean
          source?: string | null
          tecnico_id: string
          withdrawal_reason?: string | null
        }
        Update: {
          appsheet_delete_pending?: boolean
          appsheet_row_id?: string | null
          appsheet_sync_attempts?: number
          appsheet_sync_last_error?: string | null
          appsheet_sync_pending?: boolean
          appsheet_synced_at?: string | null
          candidate_state?: string
          cedula?: string | null
          contact_phone?: string | null
          enrichment_data?: Json | null
          estado?: string | null
          import_source?: string | null
          imported_at?: string | null
          last_jid?: string | null
          legacy_activity_count?: number | null
          legacy_popularidad?: number | null
          lider_phone?: string | null
          nombre?: string | null
          onboarded_at?: string | null
          phone?: string
          profile_complete?: boolean
          source?: string | null
          tecnico_id?: string
          withdrawal_reason?: string | null
        }
        Relationships: []
      }
      tecnicos_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      turns: {
        Row: {
          candidate_state_at_turn: string | null
          channel: string
          completion_tokens: number | null
          cost_killed: boolean
          errors: Json | null
          escalated: boolean
          finished_at: string | null
          grounding_violations: Json | null
          id: string
          inbound_text: string
          latency_ms: number | null
          llm_iterations: number | null
          model: string | null
          outbound_text: string | null
          phone: string
          prompt_sha: string | null
          prompt_tokens: number | null
          refused: boolean
          session_id: string
          started_at: string
          tecnico_id: string | null
          tool_calls: Json | null
          turn_number: number
        }
        Insert: {
          candidate_state_at_turn?: string | null
          channel: string
          completion_tokens?: number | null
          cost_killed?: boolean
          errors?: Json | null
          escalated?: boolean
          finished_at?: string | null
          grounding_violations?: Json | null
          id?: string
          inbound_text: string
          latency_ms?: number | null
          llm_iterations?: number | null
          model?: string | null
          outbound_text?: string | null
          phone: string
          prompt_sha?: string | null
          prompt_tokens?: number | null
          refused?: boolean
          session_id: string
          started_at?: string
          tecnico_id?: string | null
          tool_calls?: Json | null
          turn_number: number
        }
        Update: {
          candidate_state_at_turn?: string | null
          channel?: string
          completion_tokens?: number | null
          cost_killed?: boolean
          errors?: Json | null
          escalated?: boolean
          finished_at?: string | null
          grounding_violations?: Json | null
          id?: string
          inbound_text?: string
          latency_ms?: number | null
          llm_iterations?: number | null
          model?: string | null
          outbound_text?: string | null
          phone?: string
          prompt_sha?: string | null
          prompt_tokens?: number | null
          refused?: boolean
          session_id?: string
          started_at?: string
          tecnico_id?: string | null
          tool_calls?: Json | null
          turn_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "turns_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      daily_llm_cost: {
        Row: {
          completion_tokens: number | null
          cost_usd: number | null
          prompt_tokens: number | null
          session_count: number | null
          turn_count: number | null
          utc_date: string | null
        }
        Relationships: []
      }
      shortlist_agreement_metrics: {
        Row: {
          agreed_with_tono: boolean | null
          decided_at: string | null
          decided_day: string | null
          decided_week: string | null
          decision_id: string | null
          hr_postulacion_id: string | null
          hr_user: string | null
          ot_id: string | null
          tono_confidence: number | null
          tono_reasoning: string | null
          tono_recommendation_postulacion_id: string | null
        }
        Insert: {
          agreed_with_tono?: boolean | null
          decided_at?: string | null
          decided_day?: never
          decided_week?: never
          decision_id?: string | null
          hr_postulacion_id?: string | null
          hr_user?: string | null
          ot_id?: string | null
          tono_confidence?: number | null
          tono_reasoning?: string | null
          tono_recommendation_postulacion_id?: string | null
        }
        Update: {
          agreed_with_tono?: boolean | null
          decided_at?: string | null
          decided_day?: never
          decided_week?: never
          decision_id?: string | null
          hr_postulacion_id?: string | null
          hr_user?: string | null
          ot_id?: string | null
          tono_confidence?: number | null
          tono_reasoning?: string | null
          tono_recommendation_postulacion_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_decisions_hr_postulacion_id_fkey"
            columns: ["hr_postulacion_id"]
            isOneToOne: false
            referencedRelation: "postulaciones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_decisions_ot_id_fkey"
            columns: ["ot_id"]
            isOneToOne: false
            referencedRelation: "ots_mirror"
            referencedColumns: ["row_id"]
          },
          {
            foreignKeyName: "candidate_decisions_tono_recommendation_postulacion_id_fkey"
            columns: ["tono_recommendation_postulacion_id"]
            isOneToOne: false
            referencedRelation: "postulaciones"
            referencedColumns: ["id"]
          },
        ]
      }
      tecnico_performance: {
        Row: {
          avg_score: number | null
          eval_count: number | null
          jobs_completed: number | null
          jobs_dropped: number | null
          rehire_no: number | null
          rehire_yes: number | null
          tecnico_id: string | null
        }
        Relationships: []
      }
      tono_agreement_metrics: {
        Row: {
          agreed_with_tono: boolean | null
          decided_at: string | null
          decided_day: string | null
          decided_week: string | null
          decision_id: string | null
          dossier_id: string | null
          hr_decision: string | null
          hr_user: string | null
          ot_id: string | null
          scope: string | null
          tecnico_id: string | null
          tono_recommendation: string | null
        }
        Insert: {
          agreed_with_tono?: boolean | null
          decided_at?: string | null
          decided_day?: never
          decided_week?: never
          decision_id?: string | null
          dossier_id?: string | null
          hr_decision?: string | null
          hr_user?: string | null
          ot_id?: string | null
          scope?: string | null
          tecnico_id?: string | null
          tono_recommendation?: string | null
        }
        Update: {
          agreed_with_tono?: boolean | null
          decided_at?: string | null
          decided_day?: never
          decided_week?: never
          decision_id?: string | null
          dossier_id?: string | null
          hr_decision?: string | null
          hr_user?: string | null
          ot_id?: string | null
          scope?: string | null
          tecnico_id?: string | null
          tono_recommendation?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_decisions_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "candidate_dossiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_decisions_ot_id_fkey"
            columns: ["ot_id"]
            isOneToOne: false
            referencedRelation: "ots_mirror"
            referencedColumns: ["row_id"]
          },
          {
            foreignKeyName: "candidate_decisions_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "candidate_decisions_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      turn_costs: {
        Row: {
          completion_tokens: number | null
          cost_usd: number | null
          id: string | null
          latency_ms: number | null
          model: string | null
          phone: string | null
          prompt_tokens: number | null
          session_id: string | null
          started_at: string | null
          turn_number: number | null
        }
        Insert: {
          completion_tokens?: number | null
          cost_usd?: never
          id?: string | null
          latency_ms?: number | null
          model?: string | null
          phone?: string | null
          prompt_tokens?: number | null
          session_id?: string | null
          started_at?: string | null
          turn_number?: number | null
        }
        Update: {
          completion_tokens?: number | null
          cost_usd?: never
          id?: string | null
          latency_ms?: number | null
          model?: string | null
          phone?: string | null
          prompt_tokens?: number | null
          session_id?: string | null
          started_at?: string | null
          turn_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "turns_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
