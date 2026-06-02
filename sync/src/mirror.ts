// AppSheet → Supabase mirror worker. Single-flight guarantee: if a refresh is
// in flight, callers await it instead of starting a second one.

import {
  createLogger,
  createServerClient,
  normalizePhone,
  type Json,
  type ServerClient,
} from "@redin/shared";
import {
  AppSheetReadClient,
  MIRROR_TABLES,
  type AppSheetOT,
  type AppSheetCosto,
} from "./appsheet";

interface AppSheetContacto extends Record<string, string | undefined> {
  "Row ID"?: string;
  ID_Contacto?: string;
  Telefono?: string;
}

function appsheetDate(s: string | undefined): string | null {
  if (!s) return null;
  const datePart = s.split(" ")[0] ?? "";
  const parts = datePart.split("/");
  if (parts.length !== 3) return null;
  const mm = parseInt(parts[0] ?? "", 10);
  const dd = parseInt(parts[1] ?? "", 10);
  const yyyy = parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(mm) || !Number.isFinite(dd) || !Number.isFinite(yyyy)) return null;
  return `${yyyy.toString().padStart(4, "0")}-${mm.toString().padStart(2, "0")}-${dd.toString().padStart(2, "0")}`;
}

function appsheetNumeric(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Cap on how many customer-rating WhatsApps the cron can enqueue per run.
// Belt-and-suspenders against runaway sends if dedup ever breaks.
const CUSTOMER_RATING_BATCH_CAP = 10;

// Post-OT customer-rating auto-send is OFF by default — the rating UX is
// deferred (see README "Known TODOs"). The cron was shipped active without a
// gate, so it kept WhatsApping customers a "¿cómo lo calificas?" prompt. This
// gate makes the deferral real: only the literal "true" re-enables it.
export function customerRatingEnabled(): boolean {
  return process.env.ENABLE_CUSTOMER_RATING?.trim().toLowerCase() === "true";
}

const log = createLogger("sync");

export interface MirrorResult {
  table: string;
  rows_seen: number;
  rows_upserted: number;
  duration_ms: number;
  error?: string;
}

export interface MirrorAllResult {
  started_at: string;
  finished_at: string;
  total_ms: number;
  per_table: MirrorResult[];
  ok: boolean;
}

export class SyncWorker {
  private supabase: ServerClient;
  private appsheet: AppSheetReadClient;
  // Single-flight: a pending refresh of "all" — extend as needed for per-table.
  private inflightAll: Promise<MirrorAllResult> | null = null;

  constructor(params: { supabase?: ServerClient; appsheet: AppSheetReadClient }) {
    this.supabase = params.supabase ?? createServerClient();
    this.appsheet = params.appsheet;
  }

  async refreshAll(): Promise<MirrorAllResult> {
    if (this.inflightAll) {
      log.debug("refreshAll: joining in-flight refresh");
      return this.inflightAll;
    }
    this.inflightAll = this._refreshAllInner().finally(() => {
      this.inflightAll = null;
    });
    return this.inflightAll;
  }

  private async _refreshAllInner(): Promise<MirrorAllResult> {
    const startedAt = new Date();
    log.info("refresh start");
    const results: MirrorResult[] = [];
    // Order doesn't strictly matter; OTs last so counts & joins have fresh técnicos/clientes.
    results.push(await this.mirrorTecnicos());
    results.push(await this.mirrorClientes());
    results.push(await this.mirrorArquitectos());
    results.push(await this.mirrorActividades());
    results.push(await this.mirrorContactos());
    results.push(await this.mirrorOts());
    results.push(await this.mirrorCostosEjecucion());
    // Post-mirror: enqueue customer rating WhatsApps for OTs that just
    // transitioned to "Terminado" (per AppSheet). Failures here must never
    // fail the sync — log and continue.
    try {
      await this.enqueueCustomerRatingRequests();
    } catch (e) {
      log.error("enqueueCustomerRatingRequests failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    const finishedAt = new Date();
    const allOk = results.every((r) => !r.error);
    const totalMs = finishedAt.getTime() - startedAt.getTime();
    log.info("refresh done", {
      ok: allOk,
      total_ms: totalMs,
      per_table: results.map((r) => `${r.table}:${r.rows_upserted}/${r.rows_seen}`).join(" "),
    });
    return {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      total_ms: totalMs,
      per_table: results,
      ok: allOk,
    };
  }

  private async mirrorOts(): Promise<MirrorResult> {
    return this.mirrorGeneric<AppSheetOT>({
      tableName: MIRROR_TABLES.ORDENES,
      mirror: "ots_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
        ciudad: stringOrNull(row.Ciudad),
        especialidad:
          stringOrNull(row.Categoria) ??
          stringOrNull(row.Subcategoria) ??
          null,
        estado: stringOrNull(row.Estado),
      }),
    });
  }

  private async mirrorTecnicos(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.TECNICOS,
      mirror: "tecnicos_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorClientes(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.CLIENTES,
      mirror: "clientes_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorArquitectos(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.ARQUITECTOS,
      mirror: "arquitectos_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorActividades(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.ACTIVIDADES,
      mirror: "actividades_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorCostosEjecucion(): Promise<MirrorResult> {
    return this.mirrorGeneric<AppSheetCosto>({
      tableName: MIRROR_TABLES.COSTOS,
      mirror: "costos_ejecucion_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
        ot_id: stringOrNull(row.ID_Orden),
        estado: stringOrNull(row.ESTADO),
        fecha_gasto: appsheetDate(row.Fecha_Gasto),
        valor_gasto: appsheetNumeric(row.Valor_Gasto),
        categoria: stringOrNull(row.Categoria),
      }),
    });
  }

  async snapshotOtsDaily(): Promise<{ snapshot_date: string; rows_written: number; error?: string }> {
    const snapshotDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const { data: ots, error: fetchError } = await this.supabase
      .from("ots_mirror")
      .select("row_id, estado, ciudad, data");
    if (fetchError) {
      log.error("snapshot fetch failed", { error: fetchError.message });
      return { snapshot_date: snapshotDate, rows_written: 0, error: fetchError.message };
    }
    if (!ots || ots.length === 0) {
      return { snapshot_date: snapshotDate, rows_written: 0 };
    }

    const rows = ots.map((o) => {
      const d = o.data as Record<string, unknown> | null;
      const cliente =
        d && typeof d.ID_Cliente === "string" && d.ID_Cliente.trim() !== ""
          ? d.ID_Cliente.trim()
          : null;
      return {
        snapshot_date: snapshotDate,
        row_id: o.row_id,
        estado: o.estado,
        cliente,
        ciudad: o.ciudad,
        data: o.data as Json,
      };
    });

    let written = 0;
    for (const b of chunk(rows, 500)) {
      const { error } = await this.supabase
        // @ts-expect-error — table introduced in migration 018; not yet in generated Database types
        .from("ots_daily_snapshot")
        // @ts-expect-error — row shape matches migration 018; gen-types regen pending
        .upsert(b, { onConflict: "snapshot_date,row_id" });
      if (error) {
        log.error("snapshot upsert failed", { error: error.message });
        return { snapshot_date: snapshotDate, rows_written: written, error: error.message };
      }
      written += b.length;
    }
    log.info("daily snapshot ok", { snapshot_date: snapshotDate, rows_written: written });
    return { snapshot_date: snapshotDate, rows_written: written };
  }

  private async mirrorContactos(): Promise<MirrorResult> {
    return this.mirrorGeneric<AppSheetContacto>({
      tableName: MIRROR_TABLES.CONTACTOS,
      mirror: "contactos_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
        id_contacto: stringOrNull(row.ID_Contacto),
        telefono: stringOrNull(row.Telefono),
      }),
    });
  }

  // Find OTs that just flipped to "Terminado" (no prior customer_rating_requested
  // eventos row) and enqueue a WhatsApp from Toño asking the customer for stars
  // + an optional comment. Idempotent: a successful enqueue writes an eventos
  // row that suppresses the next run.
  //
  // Customer phone resolution: ot.data.Contacto_Asignado is an AppSheet Row ID
  // pointing at the CONTACTOS table; we look it up in contactos_mirror by
  // row_id (the AppSheet Row ID is the PK on contactos_mirror).
  //
  // Worker name comes from the latest tecnico_registered eventos meta — same
  // source identify_user uses. Falls back to "el técnico" if missing.
  private async enqueueCustomerRatingRequests(): Promise<void> {
    if (!customerRatingEnabled()) return;

    const { data: terminados, error } = await this.supabase
      .from("ots_mirror")
      .select("row_id, data")
      .eq("estado", "Terminado")
      .limit(100);
    if (error) {
      log.error("ots_mirror Terminado query failed", { error: error.message });
      return;
    }
    if (!terminados || terminados.length === 0) return;

    const otIds = terminados.map((o) => o.row_id);
    const { data: existingEvents } = await this.supabase
      .from("eventos")
      .select("entity_id")
      .eq("type", "customer_rating_requested")
      .in("entity_id", otIds);
    const alreadyRequested = new Set(
      (existingEvents ?? []).map((e) => e.entity_id).filter((v): v is string => !!v)
    );

    const toProcess = terminados
      .filter((o) => !alreadyRequested.has(o.row_id))
      .slice(0, CUSTOMER_RATING_BATCH_CAP);

    if (toProcess.length === 0) return;
    log.info("customer rating: candidates to process", { n: toProcess.length });

    for (const ot of toProcess) {
      await this.enqueueOneCustomerRating(ot.row_id, ot.data as Json);
    }
  }

  private async enqueueOneCustomerRating(otId: string, data: Json): Promise<void> {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      log.warn("customer rating: ot data missing/invalid", { ot_id: otId });
      return;
    }
    const d = data as Record<string, unknown>;
    const contactoRef =
      typeof d.Contacto_Asignado === "string" ? d.Contacto_Asignado.trim() : "";
    if (!contactoRef) {
      log.warn("customer rating: no Contacto_Asignado, skipping", { ot_id: otId });
      return;
    }

    // Lookup by row_id first (AppSheet Row ID is the most likely match).
    let telefono: string | null = null;
    {
      const { data: c } = await this.supabase
        .from("contactos_mirror")
        .select("telefono")
        .eq("row_id", contactoRef)
        .maybeSingle();
      telefono = c?.telefono ?? null;
    }
    if (!telefono) {
      const { data: c } = await this.supabase
        .from("contactos_mirror")
        .select("telefono")
        .eq("id_contacto", contactoRef)
        .maybeSingle();
      telefono = c?.telefono ?? null;
    }
    if (!telefono) {
      log.warn("customer rating: contacto phone not found", {
        ot_id: otId,
        contacto_ref: contactoRef,
      });
      return;
    }

    const phone = normalizePhone(telefono);
    if (!phone) {
      log.warn("customer rating: phone failed to normalize", {
        ot_id: otId,
        raw: telefono,
      });
      return;
    }

    let tecnicoId: string | null = null;
    let tecnicoFirstName = "el técnico";
    {
      const { data: post } = await this.supabase
        .from("postulaciones")
        .select("tecnico_id")
        .eq("ot_id", otId)
        .eq("state", "asignado")
        .order("decided_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (post?.tecnico_id) {
        tecnicoId = post.tecnico_id;
        const { data: regEvent } = await this.supabase
          .from("eventos")
          .select("meta")
          .eq("type", "tecnico_registered")
          .eq("entity_id", post.tecnico_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const meta = regEvent?.meta;
        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
          const m = meta as Record<string, unknown>;
          if (typeof m.nombre === "string" && m.nombre.trim().length > 0) {
            tecnicoFirstName = m.nombre.trim().split(/\s+/)[0] ?? "el técnico";
          }
        }
      }
    }

    const body =
      `Hola, soy Toño de Redin. ${tecnicoFirstName} terminó el trabajo de mantenimiento. ` +
      `¿Cómo lo calificas del 1 al 5? Si quieres, cuéntame en una frase qué tal.`;

    const meta: Json = {
      type: "customer_rating_request",
      ot_id: otId,
      tecnico_id: tecnicoId,
    };

    const { error: enqErr } = await this.supabase.from("outbound_messages").insert({
      phone,
      body,
      channel: "whatsapp",
      kind: "text",
      meta,
    });
    if (enqErr) {
      log.error("customer rating: enqueue failed", {
        ot_id: otId,
        error: enqErr.message,
      });
      return;
    }

    const { error: evErr } = await this.supabase.from("eventos").insert({
      type: "customer_rating_requested",
      entity_id: otId,
      actor: "system:sync",
      meta: { phone, tecnico_id: tecnicoId } as Json,
    });
    if (evErr) {
      // The outbound is already queued — drop a warning, don't retry the
      // enqueue. Worst case: another cron run sends a duplicate. We accept.
      log.error("customer rating: dedup event insert failed", {
        ot_id: otId,
        error: evErr.message,
      });
    }

    log.info("customer rating: enqueued", {
      ot_id: otId,
      tecnico_id: tecnicoId,
      phone,
    });
  }

  private async mirrorGeneric<T extends Record<string, unknown>>(params: {
    tableName: string;
    mirror:
      | "ots_mirror"
      | "tecnicos_mirror"
      | "clientes_mirror"
      | "arquitectos_mirror"
      | "actividades_mirror"
      | "contactos_mirror"
      | "costos_ejecucion_mirror";
    extract: (row: T) => {
      row_id: string;
      data: Json;
      ciudad?: string | null;
      especialidad?: string | null;
      estado?: string | null;
      id_contacto?: string | null;
      telefono?: string | null;
      ot_id?: string | null;
      fecha_gasto?: string | null;
      valor_gasto?: number | null;
      categoria?: string | null;
    };
  }): Promise<MirrorResult> {
    const start = Date.now();
    try {
      const rows = await this.appsheet.find<T>(params.tableName);
      const now = new Date().toISOString();
      const batches = chunk(
        rows
          .map(params.extract)
          .filter((r) => !!r.row_id)
          .map((r) => ({ ...r, synced_at: now })),
        500
      );
      let upserted = 0;
      for (const b of batches) {
        const { error } = await this.supabase
          // @ts-expect-error — costos_ejecucion_mirror added in migration 017; gen-types regen pending
          .from(params.mirror)
          // @ts-expect-error — Supabase typing gets cranky about union of mirror row shapes
          .upsert(b, { onConflict: "row_id" });
        if (error) {
          log.error(`mirror upsert failed for ${params.mirror}`, { error: error.message });
          return {
            table: params.tableName,
            rows_seen: rows.length,
            rows_upserted: upserted,
            duration_ms: Date.now() - start,
            error: error.message,
          };
        }
        upserted += b.length;
      }
      return {
        table: params.tableName,
        rows_seen: rows.length,
        rows_upserted: upserted,
        duration_ms: Date.now() - start,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`mirror failed for ${params.tableName}`, { error: msg });
      return {
        table: params.tableName,
        rows_seen: 0,
        rows_upserted: 0,
        duration_ms: Date.now() - start,
        error: msg,
      };
    }
  }
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
