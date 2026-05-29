// Manos tool set — declarations + dispatcher.
// These are the 4 tools visible to the Manos LLM. arq_row_id is injected
// from session.meta by the agent layer before each dispatch call.

import type { ToolContext, ToolResult } from "@redin/tools";
import {
  listMyPendingOts,
  attachPhotos,
  setAlcanceOt,
  finalizeAlcance,
  viewPhoto,
} from "@redin/tools/manos";

// ---------------------------------------------------------------------------
// Tool declarations (Gemini-flavored UPPERCASE types — lowercased in llm.ts)
// ---------------------------------------------------------------------------

export const MANOS_TOOL_DECLARATIONS = [
  {
    name: "list_my_pending_ots",
    description:
      "Lista las Órdenes de Trabajo del arquitecto en estado '4. Coordinar – Listo para ejecutar' que todavía no tienen alcance. Retorna hasta 10 OTs con ot_row_id, descripción, ciudad y especialidad.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: [],
    },
  },
  {
    name: "attach_photos",
    description:
      "Adjunta URLs de fotos a una OT. Las fotos deben haber sido subidas a Supabase Storage por el handler de WhatsApp antes de llamar esta herramienta.",
    parameters: {
      type: "OBJECT",
      properties: {
        ot_row_id: {
          type: "STRING",
          description: "El row_id de la OT en ots_mirror.",
        },
        photo_urls: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "URLs de las fotos en Supabase Storage.",
        },
      },
      required: ["ot_row_id", "photo_urls"],
    },
  },
  {
    name: "set_alcance_ot",
    description:
      "Guarda el alcance estructurado de una OT en Supabase. Llámalo cuando el arquitecto haya confirmado los detalles del scope. Activa el outbox para AppSheet writeback.",
    parameters: {
      type: "OBJECT",
      properties: {
        ot_row_id: {
          type: "STRING",
          description: "El row_id de la OT.",
        },
        alcance: {
          type: "OBJECT",
          description: "Scope estructurado de la OT.",
          properties: {
            especialidad: { type: "STRING", description: "Especialidad principal (ej. 'Eléctrico')." },
            subcategoria: { type: "STRING", description: "Subcategoría específica (ej. 'Iluminación')." },
            cantidades: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Lista de ítems con cantidades (ej. ['30m² fachada vidrio', '10m muro pintura']).",
            },
            conditions: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Condiciones del sitio o trabajo (ej. ['altura 2m', 'acceso interior']).",
            },
            schedule_notes: { type: "STRING", description: "Notas sobre horario o plazo estimado." },
            value_estimate: { type: "STRING", description: "Valor estimado en pesos colombianos (ej. '1.500.000')." },
            summary: { type: "STRING", description: "Resumen de 1-2 líneas del alcance." },
          },
          required: ["especialidad", "summary"],
        },
      },
      required: ["ot_row_id", "alcance"],
    },
  },
  {
    name: "finalize_alcance",
    description:
      "Genera el PDF formal del alcance y lo sube a Supabase Storage. Retorna la URL del PDF. Llámalo solo después de que el arquitecto haya confirmado el alcance con set_alcance_ot.",
    parameters: {
      type: "OBJECT",
      properties: {
        ot_row_id: {
          type: "STRING",
          description: "El row_id de la OT.",
        },
      },
      required: ["ot_row_id"],
    },
  },
  {
    name: "view_photo",
    description:
      "Vuelve a abrir una foto que el arquitecto ya envió en un turno anterior, para examinarla de nuevo nativamente (la imagen llega como bloque visual en el siguiente turno). Úsalo solo si necesitas verificar un detalle visual específico que no quedó claro en el análisis visual de la conversación.",
    parameters: {
      type: "OBJECT",
      properties: {
        ot_row_id: {
          type: "STRING",
          description: "El row_id de la OT cuya foto quieres re-examinar.",
        },
        n: {
          type: "INTEGER",
          description: "Número de la foto a re-examinar (1 = primera foto enviada para esta OT).",
        },
      },
      required: ["ot_row_id", "n"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type ManosToolArgs = Record<string, unknown>;

export async function dispatchManosTools(
  ctx: ToolContext,
  name: string,
  args: ManosToolArgs
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "list_my_pending_ots":
      return listMyPendingOts(ctx, args);
    case "attach_photos":
      return attachPhotos(ctx, args);
    case "set_alcance_ot":
      return setAlcanceOt(ctx, args);
    case "finalize_alcance":
      return finalizeAlcance(ctx, args);
    case "view_photo":
      return viewPhoto(ctx, args);
    default:
      return {
        ok: false,
        error: `unknown manos tool: ${name}`,
        code: "unknown_tool",
      };
  }
}
