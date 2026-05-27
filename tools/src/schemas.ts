// Function-calling declarations for Toño's 14 LLM-visible tools.
// Kept in sync with types.ts and dossier-types.ts by hand — any change to
// tool I/O types must update this file.
//
// Type names are UPPERCASE (legacy from Gemini integration); tono/src/llm.ts
// lowercases them when converting to Anthropic input_schema. New entries
// follow the same convention so the converter handles all 14 uniformly.
//
// set_qualification_state is INTENTIONALLY ABSENT — it's been removed from
// the LLM-visible list per Stream A's contract update. The compat shim in
// tools/src/set-qualification-state.ts is still reachable through dispatchTool
// for any HR dashboard server action that hasn't been updated yet.

// PRD §20 input length caps — enforced at tool handler layer.
export const INPUT_CAPS = {
  nombre: 80,
  mensaje: 500,
  whatsapp: 2000,
} as const;

export const TOOL_DECLARATIONS = [
  {
    name: "identify_user",
    description:
      "Busca un técnico por teléfono. Siempre llámalo como PRIMER paso. Retorna {found: true, tecnico: {...}} o {found: false, phone}.",
    parameters: {
      type: "OBJECT",
      properties: {
        phone: { type: "STRING", description: "Teléfono en E.164 o local colombiano" },
      },
      required: ["phone"],
    },
  },
  {
    name: "register_tecnico",
    description:
      "Crea el perfil de un nuevo técnico. Pide nombre completo (con apellidos), ciudad, especialidades, modalidad, y un teléfono de contacto donde nuestra área de talento humano pueda llamar. Idempotente en phone.\n\nLa herramienta valida la identidad antes de escribir. Si rechaza con `error: 'INCOMPLETE_IDENTITY'`, vendrá con `next_action` ('ask_apellidos' o 'ask_contact_phone'), `missing[]` con lo que falta, y `user_message_hint` con la frase exacta a entregar al técnico (puedes parafrasearla pero pide LO MISMO que dice missing[]). NO insistas si el técnico ya respondió a esa pregunta — el handler decide.",
    parameters: {
      type: "OBJECT",
      properties: {
        phone: { type: "STRING", description: "El JID/identidad de WhatsApp (no para llamar)" },
        nombre: {
          type: "STRING",
          description:
            "Nombre completo del técnico, con apellidos. La herramienta rechaza nombres de un solo token.",
        },
        ciudad: { type: "STRING" },
        especialidades: { type: "ARRAY", items: { type: "STRING" } },
        modalidad: {
          type: "STRING",
          enum: ["individual", "solo", "cuadrilla", "lider"],
          description:
            "solo (alias: individual), cuadrilla, o lider. El prompt de Toño dice 'solo'; ambos se aceptan.",
        },
        lider_phone: {
          type: "STRING",
          description:
            "Solo si el técnico viene con un maestro/líder que ya responde por él",
        },
        contact_phone: {
          type: "STRING",
          description:
            "Teléfono donde nuestra área de talento humano puede llamar al técnico. 10 dígitos colombianos o +57 + 10 dígitos. Puede ser el mismo de WhatsApp o uno distinto. La herramienta rechaza si falta o no parece teléfono.",
        },
        source: {
          type: "STRING",
          description: "warm | ape | facebook | referral | dashboard | whatsapp",
        },
      },
      required: ["phone", "nombre", "ciudad", "especialidades", "modalidad"],
    },
  },
  {
    name: "read_pending_ots",
    description:
      "Lista OTs abiertas. Sin filtros retorna todas las pendientes. Si pasas tecnico_id, Toño prioriza por ciudad/especialidad del técnico.",
    parameters: {
      type: "OBJECT",
      properties: {
        ciudad: { type: "STRING" },
        especialidad: { type: "STRING" },
        tecnico_id: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
    },
  },
  {
    name: "create_postulacion",
    description:
      "Registra que un técnico se postuló a una OT. Idempotente: si ya existe la postulación, retorna {state: 'already_applied'}.",
    parameters: {
      type: "OBJECT",
      properties: {
        ot_id: { type: "STRING" },
        tecnico_id: { type: "STRING" },
        mensaje: { type: "STRING" },
      },
      required: ["ot_id", "tecnico_id"],
    },
  },
  {
    name: "read_my_postulaciones",
    description: "Lista todas las postulaciones de un técnico, con estado y datos de cada OT.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
      required: ["tecnico_id"],
    },
  },
  {
    name: "read_my_contratos",
    description:
      "Lista contratos del técnico (borrador, enviado, firmado, cancelado).",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
      required: ["tecnico_id"],
    },
  },
  {
    name: "upload_documento",
    description:
      "Registra un documento ya subido a Storage (cédula, ARL, certificados). No se usa desde WhatsApp directamente — Toño le pide al técnico subirlo por el dashboard.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        tipo: {
          type: "STRING",
          enum: [
            "cedula",
            "cert_electrica",
            "arl",
            "ss",
            "altura",
            "antecedentes",
            "otro",
            "cert_estudios",
            "cert_trabajos_previos",
            "evidencia_arl",
            "evidencia_eps",
          ],
        },
        filename: { type: "STRING" },
        storage_path: {
          type: "STRING",
          description: "Si el archivo ya está en Storage, pasa el path y se registra sin re-subir",
        },
        contentType: { type: "STRING" },
      },
      required: ["tecnico_id", "tipo", "filename"],
    },
  },
  {
    name: "escalate_to_hr",
    description:
      "Úsalo cuando el técnico pide hablar con una persona, cuando tu confianza es baja, o cuando hay un problema que no puedes resolver. Notifica a HR por Telegram.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        phone: { type: "STRING" },
        reason: {
          type: "STRING",
          description: "1 frase — por qué necesita HR",
        },
        context: {
          type: "STRING",
          description: "Resumen de la conversación y qué necesita HR resolver",
        },
      },
      required: ["reason", "context"],
    },
  },
  {
    name: "log_event",
    description:
      "Registra una observación del agente: frustración, duda, confirmación implícita. Usado para medición HITL — no es visible para el técnico.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING" },
        entity_id: { type: "STRING" },
        meta: { type: "OBJECT" },
      },
      required: ["type"],
    },
  },
  {
    name: "submit_candidate_dossier",
    description:
      "Envía el dossier estructurado del técnico a nuestra área de talento humano. Llámalo cuando ya tengas la cédula del técnico Y un panorama útil del perfil. Valida cédula contra registros existentes; si la cédula coincide con un técnico ya aprobado/rechazado/etc., retorna un código de outcome y NO crea un duplicado. El estado SIEMPRE queda en 'pending' tras una submisión exitosa — nuestra área de talento humano decide. Producir tono_recommendation + tono_confidence + tono_reasoning con base en lo que recolectaste; son una sugerencia, no una decisión final.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        dossier: {
          type: "OBJECT",
          description:
            "CandidateDossier completo. Ver tools/src/dossier-types.ts para la forma exacta. La cédula es OBLIGATORIA. tono_recommendation ∈ {recommend_approve, recommend_reject, recommend_call}. tono_confidence ∈ [0.0, 1.0]. tono_reasoning entre 10 y 500 caracteres explicando por qué la recomendación.",
          properties: {
            schema_version: { type: "INTEGER", enum: [1] },
            cedula: {
              type: "OBJECT",
              properties: {
                tipo: { type: "STRING", enum: ["CC", "CE", "PEP"] },
                numero: { type: "STRING", description: "Solo dígitos, 5-11 caracteres" },
              },
              required: ["tipo", "numero"],
            },
            modalidad: { type: "STRING", enum: ["individual", "cuadrilla", "lider"] },
            categorias_principales: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "1-4 categorías canónicas",
            },
            subcategorias: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Al menos 1 subcategoría canónica",
            },
            anos_experiencia: { type: "INTEGER", description: "0-60" },
            ciudad_base: { type: "STRING", description: "Ciudad canónica" },
            ciudades_cobertura: { type: "ARRAY", items: { type: "STRING" } },
            certificaciones: {
              type: "OBJECT",
              properties: {
                altura: { type: "BOOLEAN" },
                altura_avanzado: { type: "BOOLEAN" },
                retie: { type: "BOOLEAN" },
                andamios: { type: "BOOLEAN" },
                soldadura: { type: "BOOLEAN" },
                conte: { type: "BOOLEAN" },
                otras: { type: "STRING" },
              },
            },
            herramientas: {
              type: "OBJECT",
              properties: {
                basicas: { type: "BOOLEAN" },
                electrica_obra: { type: "BOOLEAN" },
                electrica_medicion: { type: "BOOLEAN" },
                altura_personal: { type: "BOOLEAN" },
                andamio_propio: { type: "BOOLEAN" },
                vehiculo_propio: { type: "BOOLEAN" },
              },
            },
            disponibilidad: {
              type: "OBJECT",
              properties: {
                inicio_inmediato: { type: "BOOLEAN" },
                fines_de_semana: { type: "BOOLEAN" },
                nocturno: { type: "BOOLEAN" },
                viaja_otra_ciudad: { type: "BOOLEAN" },
                ciudades_viaje: { type: "ARRAY", items: { type: "STRING" } },
              },
            },
            cumplimiento: {
              type: "OBJECT",
              properties: {
                arl_activa: { type: "BOOLEAN" },
                arl_fondo: { type: "STRING" },
                eps_activa: { type: "BOOLEAN" },
                antecedentes_limpios: { type: "BOOLEAN" },
              },
            },
            referencias_externas: { type: "ARRAY", items: { type: "STRING" } },
            tiene_vehiculo: {
              type: "BOOLEAN",
              description:
                "true si el técnico tiene vehículo propio; false si no; omite si no se preguntó.",
            },
            tipo_vehiculo: {
              type: "STRING",
              description:
                "Tipo de vehículo en palabras del técnico — moto, carro, camioneta, etc. Obligatorio si tiene_vehiculo=true.",
            },
            placa_vehiculo: {
              type: "STRING",
              description:
                "Placa colombiana en MAYÚSCULAS sin guiones ni espacios. Carro: 3 letras + 3 dígitos (ABC123). Moto: 3 letras + 2 dígitos + 1 letra (ABC12D). Obligatoria si tiene_vehiculo=true.",
            },
            cert_estudios_doc_id: {
              type: "STRING",
              description:
                "documento_id retornado por upload_documento(tipo='cert_estudios'). Opcional — solo si el técnico envió foto del título/constancia.",
            },
            cert_trabajos_previos_doc_id: {
              type: "STRING",
              description:
                "documento_id retornado por upload_documento(tipo='cert_trabajos_previos'). Opcional.",
            },
            arl_doc_id: {
              type: "STRING",
              description:
                "documento_id retornado por upload_documento(tipo='evidencia_arl'). Opcional — solo si el técnico envió foto del carné/constancia de ARL. Independiente de cumplimiento.arl_activa (declaración).",
            },
            eps_doc_id: {
              type: "STRING",
              description:
                "documento_id retornado por upload_documento(tipo='evidencia_eps'). Opcional — solo si el técnico envió foto del carné/constancia de EPS. Independiente de cumplimiento.eps_activa (declaración).",
            },
            dossier: {
              type: "STRING",
              description: "Texto libre, máx 2000 caracteres. Lo lee nuestra área de talento humano.",
            },
            tono_recommendation: {
              type: "STRING",
              enum: ["recommend_approve", "recommend_reject", "recommend_call"],
            },
            tono_confidence: { type: "NUMBER", description: "0.0-1.0" },
            tono_reasoning: {
              type: "STRING",
              description: "10-500 caracteres explicando la recomendación",
            },
            gaps: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Cosas que NO te quedaron firmes — útil si recommend_call",
            },
          },
          required: [
            "schema_version",
            "cedula",
            "modalidad",
            "categorias_principales",
            "subcategorias",
            "anos_experiencia",
            "ciudad_base",
            "certificaciones",
            "herramientas",
            "disponibilidad",
            "cumplimiento",
            "dossier",
            "tono_recommendation",
            "tono_confidence",
            "tono_reasoning",
            "gaps",
          ],
        },
      },
      required: ["tecnico_id", "dossier"],
    },
  },
  {
    name: "find_by_cedula",
    description:
      "Busca un técnico por cédula. Llámalo después de capturar la cédula del usuario, ANTES de submit_candidate_dossier, para detectar regresos en otro teléfono. Read-only.\n\nRetorna SIEMPRE un campo `next_action` que TE DICE qué hacer:\n- 'resume_screening'           → encontrado en screening|withdrawn; sigue calificando, submit_candidate_dossier al final.\n- 'tell_user_already_in_queue' → encontrado en pending; dile que el equipo está validando, NO sigas screening.\n- 'tell_user_team_will_call'   → encontrado en needs_call; dile que el equipo lo va a llamar, NO sigas.\n- 'tell_user_already_approved' → encontrado en approved; dile que ya está registrado y aprobado, NO sigas.\n- 'tell_user_was_rejected'     → encontrado en rejected|revoked; dile que el equipo lo contactará y llama escalate_to_hr con reason='rejected_returning'.\n- 'proceed_with_screening'     → no encontrado. Sigue con el flujo normal de calificación.\n\nTambién retorna `suggested_reply` (frase corta en español que puedes parafrasear) y, si found=true, tecnico_id + candidate_state + last_phone + nombre.\n\nLA INSTRUCCIÓN DE next_action GANA sobre cualquier momentum de la conversación. No la ignores.",
    parameters: {
      type: "OBJECT",
      properties: {
        cedula: {
          type: "STRING",
          description: "Solo dígitos, 5-11 caracteres",
        },
      },
      required: ["cedula"],
    },
  },
  {
    name: "mark_candidate_withdrawn",
    description:
      "Marca al técnico como retirado del proceso. Llámalo cuando el técnico se niega a dar la cédula (reason='no_cedula_provided'), pide salir explícitamente (reason='opted_out'), o ha estado sin responder (reason='no_response'). Idempotente. Solo se aplica a técnicos en 'screening'.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        reason: {
          type: "STRING",
          enum: [
            "no_cedula_provided",
            "no_response",
            "opted_out",
            "duplicate_phone",
            "other",
          ],
        },
        notes: {
          type: "STRING",
          description: "Texto opcional con contexto para HR",
        },
      },
      required: ["tecnico_id", "reason"],
    },
  },
  {
    name: "complete_legacy_profile",
    description:
      "Solo para CASO A (técnico legacy con profile_complete=false). Recolecta de forma incremental los datos faltantes (cédula, ciudad_base, categorías, certificaciones, etc.) y guarda en enrichment_data. NO crea candidate_dossiers. NO dispara revisión de nuestra área de talento humano. NO cambia el estado (queda 'approved'). Idempotente — pasar los mismos datos dos veces es no-op. profile_complete pasa a true automáticamente cuando hay cédula + ciudad_base + ≥1 categoría_principal.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        profile_data: {
          type: "OBJECT",
          description:
            "Subconjunto del perfil. Cualquier campo es opcional; pásale lo que tengas. La forma sigue CandidateDossier minus el triplete de recomendación.",
          properties: {
            cedula: {
              type: "OBJECT",
              properties: {
                tipo: { type: "STRING", enum: ["CC", "CE", "PEP"] },
                numero: { type: "STRING" },
              },
            },
            modalidad: { type: "STRING", enum: ["individual", "cuadrilla", "lider"] },
            ciudad_base: { type: "STRING" },
            ciudades_cobertura: { type: "ARRAY", items: { type: "STRING" } },
            categorias_principales: { type: "ARRAY", items: { type: "STRING" } },
            subcategorias: { type: "ARRAY", items: { type: "STRING" } },
            anos_experiencia: { type: "INTEGER" },
            certificaciones: { type: "OBJECT" },
            herramientas: { type: "OBJECT" },
            disponibilidad: { type: "OBJECT" },
            cumplimiento: { type: "OBJECT" },
            notas: { type: "STRING" },
          },
        },
      },
      required: ["tecnico_id", "profile_data"],
    },
  },
  {
    name: "classify_documento",
    description:
      "Clasifica un documento subido por el técnico usando visión multimodal. Llámalo INMEDIATAMENTE después de upload_documento para confirmar que el documento corresponde al tipo solicitado. Devuelve classified_type, matches_expected (bool), confidence (0-1). Si matches_expected=false, dile al técnico amablemente y pide el documento correcto.",
    parameters: {
      type: "OBJECT",
      properties: {
        documento_id: {
          type: "STRING",
          description: "ID del documento retornado por upload_documento",
        },
        expected_tipo: {
          type: "STRING",
          description:
            "El tipo que el técnico/agente declaró al subir el documento. Opcional — si se omite se usa el tipo almacenado en la fila. Valores: cedula | cert_electrica | arl | ss | altura | antecedentes | cert_estudios | cert_trabajos_previos | evidencia_arl | evidencia_eps | paz_y_salvo | contrato | otro",
        },
      },
      required: ["documento_id"],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DECLARATIONS)[number]["name"];

export const TOOL_NAMES: ToolName[] = TOOL_DECLARATIONS.map((d) => d.name);
