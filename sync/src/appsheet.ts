// AppSheet client for the marketplace.
// Read methods: find / findWithSchemaCheck (Stream A).
// Write methods: addTecnico / deleteTecnico / findTecnicoByName (Stream B —
//   ONLY for the TECNICOS reverse-projection per onboarding contracts §8.
//   AppSheet schema for OTs/Customers/Architects/Activities stays read-only).

export interface AppSheetConfig {
  appId: string;
  accessKey: string;
  baseUrl?: string;
}

export class AppSheetReadClient {
  private appId: string;
  private accessKey: string;
  private baseUrl: string;

  constructor(config: AppSheetConfig) {
    this.appId = config.appId;
    this.accessKey = config.accessKey;
    this.baseUrl = config.baseUrl ?? "https://api.appsheet.com";
  }

  private url(table: string): string {
    return `${this.baseUrl}/api/v2/apps/${this.appId}/tables/${encodeURIComponent(table)}/Action`;
  }

  async find<T = Record<string, string>>(
    table: string,
    opts?: { selector?: string }
  ): Promise<T[]> {
    const properties: Record<string, unknown> = { Locale: "en-US" };
    if (opts?.selector) properties.Selector = opts.selector;

    const res = await fetch(this.url(table), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({ Action: "Find", Properties: properties, Rows: [] }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `AppSheet ${table} Find failed: ${res.status} ${body.substring(0, 200)}`
      );
    }
    const text = await res.text();
    if (!text) return [];
    try {
      return JSON.parse(text) as T[];
    } catch (e) {
      throw new Error(`AppSheet ${table} returned non-JSON: ${text.substring(0, 200)}`);
    }
  }

  /**
   * Read a table without hardcoding its schema.
   *
   * Two guardrails before consumers map the rows:
   *   1. Every column in `requiredWriteColumns` must appear on at least one
   *      row. If any required column is missing from EVERY row, throws —
   *      the caller refuses to proceed (writing partial data is worse than
   *      stopping). This is the load-bearing check for any code that will
   *      later write to AppSheet.
   *   2. Any column outside `knownColumns` is collected into `unknown_columns`
   *      so the caller can log eventos{type:'appsheet_schema_drift'} once.
   *      Does NOT throw — the system adapts.
   *
   * Returned rows are unfiltered: all columns the API sent through.
   *
   * Used by scripts/import-legacy-tecnicos.ts to bootstrap pre-approved
   * técnicos. Future projector code (Stream B) should use this same helper
   * before issuing any Add/Edit so a silent AppSheet schema change can't
   * land partial writes in production.
   */
  async findWithSchemaCheck<T extends Record<string, unknown> = Record<string, string>>(
    table: string,
    options: {
      requiredWriteColumns: readonly string[];
      knownColumns?: readonly string[];
      selector?: string;
    }
  ): Promise<{ rows: T[]; unknown_columns: string[] }> {
    const rows = await this.find<T>(
      table,
      options.selector ? { selector: options.selector } : undefined
    );

    // An empty result is a query miss (filter matched nothing, or table is
    // empty), not schema drift. The required-columns guardrail is meaningful
    // only with at least one row to inspect; running it on an empty array
    // throws unconditionally because rows.some() returns false vacuously.
    if (rows.length === 0) {
      return { rows: [], unknown_columns: [] };
    }

    for (const required of options.requiredWriteColumns) {
      const present = rows.some((r) =>
        Object.prototype.hasOwnProperty.call(r, required)
      );
      if (!present) {
        throw new Error(
          `AppSheet ${table} schema drift: required column "${required}" is missing from every row. ` +
            `Refusing to proceed. Inspect the AppSheet table configuration.`
        );
      }
    }

    const unknown: string[] = [];
    if (options.knownColumns && options.knownColumns.length > 0) {
      const knownSet = new Set(options.knownColumns);
      const seen = new Set<string>();
      for (const r of rows) {
        for (const k of Object.keys(r)) {
          if (!knownSet.has(k)) seen.add(k);
        }
      }
      unknown.push(...seen);
    }

    return { rows, unknown_columns: unknown };
  }

  // ===========================================================================
  // Write methods — TECNICOS reverse-projection only.
  // ===========================================================================

  /**
   * Find AppSheet TECNICOS rows by exact-match Selector on Nombre de Tecnico.
   * Backbone of find-then-Add idempotency (§8.4): the projector calls this
   * before issuing Add to absorb any manual AppSheet adds and prevent
   * duplicate rows.
   *
   * Returns:
   *   - 0 rows: name not found; projector proceeds to Add.
   *   - 1 row:  name found; projector captures Row ID without Add.
   *   - >1 rows: ambiguous; projector escalates to Telegram + leaves
   *     appsheet_sync_pending=true. HR resolves manually.
   *
   * Reuses findWithSchemaCheck so a silent AppSheet schema change throws
   * before partial writes can land.
   */
  async findTecnicoByName(
    name: string
  ): Promise<AppSheetTecnicoRow[]> {
    if (!name || !name.trim()) return [];
    // AppSheet selector syntax: Filter(<Table>, [Col] = "<value>"). Escape
    // double quotes in the name so an apostrophe-laden name doesn't break parsing.
    const escaped = name.replace(/"/g, '""');
    const selector = `Filter(Tecnicos, [Nombre de Tecnico] = "${escaped}")`;
    const { rows } = await this.findWithSchemaCheck<AppSheetTecnicoRow>(
      "Tecnicos",
      {
        requiredWriteColumns: ["Nombre de Tecnico"],
        knownColumns: APPSHEET_TECNICOS_KNOWN_COLUMNS,
        selector,
      }
    );
    return rows;
  }

  /**
   * Add a new TECNICOS row. Returns the response row including the
   * server-assigned Row ID. Throws on non-2xx or missing Row ID.
   *
   * AppSheet's response shape varies — sometimes a top-level array, sometimes
   * `{Rows: [...]}`. We probe both and fail loud if neither yields a Row ID.
   */
  async addTecnico(row: {
    "Nombre de Tecnico": string;
    Telefono?: string;
    EMAIL?: string;
  }): Promise<AppSheetTecnicoRow> {
    const res = await fetch(this.url("Tecnicos"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({
        Action: "Add",
        Properties: { Locale: "en-US" },
        Rows: [row],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `AppSheet Tecnicos Add failed: ${res.status} ${body.substring(0, 200)}`
      );
    }
    const text = await res.text();
    if (!text) throw new Error("AppSheet Tecnicos Add returned empty body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `AppSheet Tecnicos Add returned non-JSON: ${text.substring(0, 200)}`
      );
    }
    const candidates: AppSheetTecnicoRow[] = Array.isArray(parsed)
      ? (parsed as AppSheetTecnicoRow[])
      : Array.isArray((parsed as { Rows?: unknown }).Rows)
        ? ((parsed as { Rows: AppSheetTecnicoRow[] }).Rows)
        : [];
    const first = candidates[0];
    if (!first || !first["Row ID"]) {
      throw new Error(
        `AppSheet Tecnicos Add response missing Row ID: ${text.substring(0, 200)}`
      );
    }
    return first;
  }

  /**
   * Delete a TECNICOS row, identified by both Row ID and the expected
   * Nombre de Tecnico. Per §8.3, re-deleting a now-gone row is a no-op
   * success.
   *
   * SAFETY DESIGN. The TECNICOS table's row-key field is "Nombre de Tecnico"
   * (not "Row ID") — AppSheet's Delete uses the key to identify rows, so
   * sending only Row ID returns 400. To keep this from accidentally deleting
   * the wrong worker, the method runs a pre-flight Find by Row ID and
   * verifies the AppSheet row's current Nombre de Tecnico matches the
   * expectedNombre passed by the caller. Mismatch → throw, do not delete.
   * This catches:
   *   - Row ID and nombre got out of sync between our DB and AppSheet
   *     (someone manually renamed the AppSheet row)
   *   - Stale appsheet_row_id pointing at a different worker now
   *   - Two AppSheet rows sharing the same Row ID (shouldn't happen, but
   *     would be ambiguous; we abort)
   *
   * Required: caller MUST pass the worker's nombre. The projector pulls it
   * via the same select that loads appsheet_row_id, so this is free.
   */
  async deleteTecnico(
    rowId: string,
    expectedNombre: string
  ): Promise<{ deleted: true; alreadyGone: boolean }> {
    if (!rowId) throw new Error("deleteTecnico: rowId required");
    if (!expectedNombre) {
      throw new Error("deleteTecnico: expectedNombre required for safety");
    }

    // Pre-flight: confirm the AppSheet row still has the name we expect.
    // Filter by Row ID exact match; AppSheet returns 0 or 1 rows.
    const escapedId = rowId.replace(/"/g, '\\"');
    const matching = await this.find<AppSheetTecnicoRow>("Tecnicos", {
      selector: `Filter(Tecnicos, [Row ID] = "${escapedId}")`,
    });
    if (matching.length === 0) {
      // Row already gone (manual cleanup, prior delete, or appsheet_row_id
      // pointed at a row that no longer exists). Treat as success.
      return { deleted: true, alreadyGone: true };
    }
    if (matching.length > 1) {
      throw new Error(
        `AppSheet Tecnicos integrity: ${matching.length} rows match Row ID ${rowId}; refusing to delete`
      );
    }
    const actualNombre = matching[0]?.["Nombre de Tecnico"];
    if (actualNombre !== expectedNombre) {
      throw new Error(
        `AppSheet Tecnicos integrity: row ${rowId} has nombre "${actualNombre ?? "(empty)"}", expected "${expectedNombre}". Refusing to delete (manual reconciliation required).`
      );
    }

    // Send Delete with both fields. AppSheet matches by the key column
    // (Nombre de Tecnico); Row ID is included for the API logs.
    const res = await fetch(this.url("Tecnicos"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({
        Action: "Delete",
        Properties: { Locale: "en-US" },
        Rows: [{ "Nombre de Tecnico": expectedNombre, "Row ID": rowId }],
      }),
    });
    if (res.status === 404) return { deleted: true, alreadyGone: true };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `AppSheet Tecnicos Delete failed: ${res.status} ${body.substring(0, 200)}`
      );
    }
    return { deleted: true, alreadyGone: false };
  }

  /**
   * Edit a TECNICOS row, identified by Row ID + expected Nombre de Tecnico.
   * Used for soft-delete (set Estado_Redin = "Revocado") and any future
   * field updates the projector wants to push.
   *
   * Same safety belt as deleteTecnico: pre-flights a Find by Row ID and
   * refuses to edit unless the AppSheet row's current Nombre de Tecnico
   * equals the expectedNombre. This is the policy guardrail behind "we
   * never delete anyone in production" — the worst case on drift is
   * "edit refused, manual reconciliation needed", never "wrong worker
   * mutated".
   *
   * `fields` carries any TECNICOS columns the caller wants to set (e.g.,
   * { "Estado_Redin": "Revocado" }). The Nombre de Tecnico key is added
   * automatically — callers should NOT pass it in `fields`.
   */
  async editTecnico(
    rowId: string,
    expectedNombre: string,
    fields: Record<string, string>
  ): Promise<{ edited: true; alreadyGone: boolean }> {
    if (!rowId) throw new Error("editTecnico: rowId required");
    if (!expectedNombre) {
      throw new Error("editTecnico: expectedNombre required for safety");
    }
    if (Object.keys(fields).length === 0) {
      throw new Error("editTecnico: at least one field required");
    }
    if ("Nombre de Tecnico" in fields) {
      throw new Error(
        "editTecnico: refuse to mutate the Nombre de Tecnico key field; would break identity"
      );
    }

    const escapedId = rowId.replace(/"/g, '\\"');
    const matching = await this.find<AppSheetTecnicoRow>("Tecnicos", {
      selector: `Filter(Tecnicos, [Row ID] = "${escapedId}")`,
    });
    if (matching.length === 0) {
      // Row gone in AppSheet (manual cleanup, prior delete). Nothing to
      // edit — caller should treat as a soft-success and clear pending flags.
      return { edited: true, alreadyGone: true };
    }
    if (matching.length > 1) {
      throw new Error(
        `AppSheet Tecnicos integrity: ${matching.length} rows match Row ID ${rowId}; refusing to edit`
      );
    }
    const actualNombre = matching[0]?.["Nombre de Tecnico"];
    if (actualNombre !== expectedNombre) {
      throw new Error(
        `AppSheet Tecnicos integrity: row ${rowId} has nombre "${actualNombre ?? "(empty)"}", expected "${expectedNombre}". Refusing to edit (manual reconciliation required).`
      );
    }

    const res = await fetch(this.url("Tecnicos"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({
        Action: "Edit",
        Properties: { Locale: "en-US" },
        Rows: [
          { "Nombre de Tecnico": expectedNombre, "Row ID": rowId, ...fields },
        ],
      }),
    });
    if (res.status === 404) return { edited: true, alreadyGone: true };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `AppSheet Tecnicos Edit failed: ${res.status} ${body.substring(0, 200)}`
      );
    }
    return { edited: true, alreadyGone: false };
  }

  /**
   * Edit an Ordenes_Trabajo row in AppSheet, identified by Row ID.
   *
   * Safety belt: pre-flights a Find by Row ID and verifies that the
   * AppSheet row's ID_Orden (or Numero_Orden) matches `expectedIdOrden`
   * before writing. On mismatch, throws — callers should treat this as
   * "manual reconciliation needed" and leave the Supabase outbox pending.
   *
   * Special case: if AppSheet returns an error body containing "column"
   * and "not found" (case-insensitive), this function returns
   * {edited: false, columnMissing: true} so the projector can leave
   * appsheet_alcance_pending=true without crashing.
   * (Estado_Redin precedent — same pattern as editTecnico revoke path.)
   *
   * `fields` carries OT columns to set (e.g., {Alcance_OT: "..."}).
   * The Row ID key is added automatically.
   */
  async editOT(
    rowId: string,
    expectedIdOrden: string,
    fields: Record<string, string>
  ): Promise<{ edited: boolean; alreadyGone: boolean; columnMissing: boolean }> {
    if (!rowId) throw new Error("editOT: rowId required");
    if (!expectedIdOrden) {
      throw new Error("editOT: expectedIdOrden required for safety");
    }
    if (Object.keys(fields).length === 0) {
      throw new Error("editOT: at least one field required");
    }

    const escapedId = rowId.replace(/"/g, '\\"');
    const matching = await this.find<AppSheetOT>("Ordenes_Trabajo", {
      selector: `Filter(Ordenes_Trabajo, [Row ID] = "${escapedId}")`,
    });

    if (matching.length === 0) {
      return { edited: true, alreadyGone: true, columnMissing: false };
    }
    if (matching.length > 1) {
      throw new Error(
        `AppSheet OT integrity: ${matching.length} rows match Row ID ${rowId}; refusing to edit`
      );
    }
    const actualIdOrden = matching[0]?.["ID_Orden"] ?? matching[0]?.["Numero_Orden"];
    if (actualIdOrden !== expectedIdOrden) {
      throw new Error(
        `AppSheet OT integrity: row ${rowId} has ID_Orden "${actualIdOrden ?? "(empty)"}", ` +
          `expected "${expectedIdOrden}". Refusing to edit (manual reconciliation required).`
      );
    }

    const res = await fetch(this.url("Ordenes_Trabajo"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({
        Action: "Edit",
        Properties: { Locale: "en-US" },
        Rows: [{ ID_Orden: expectedIdOrden, ...fields }],
      }),
    });

    if (res.status === 404) return { edited: true, alreadyGone: true, columnMissing: false };

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Detect AppSheet "column not found" error — no crash, leave outbox pending.
      const isColumnMissing =
        body.toLowerCase().includes("column") &&
        (body.toLowerCase().includes("not found") ||
          body.toLowerCase().includes("doesn't exist") ||
          body.toLowerCase().includes("does not exist") ||
          body.toLowerCase().includes("unknown"));
      if (isColumnMissing) {
        return { edited: false, alreadyGone: false, columnMissing: true };
      }
      throw new Error(
        `AppSheet Ordenes_Trabajo Edit failed: ${res.status} ${body.substring(0, 200)}`
      );
    }
    return { edited: true, alreadyGone: false, columnMissing: false };
  }
}

// AppSheet TECNICOS row shape — the verified column schema (live API
// 2026-05-07). Loose typing because AppSheet may add columns silently;
// findWithSchemaCheck flags drift via unknown_columns.
export interface AppSheetTecnicoRow extends Record<string, string | undefined> {
  _RowNumber?: string;
  "Row ID"?: string;
  "Nombre de Tecnico"?: string;
  Telefono?: string;
  EMAIL?: string;
  Popularidad_Tecnico?: string;
  "Related DETALLE DE ACTIVIDADESs"?: string;
}

const APPSHEET_TECNICOS_KNOWN_COLUMNS = [
  "_RowNumber",
  "Row ID",
  "Nombre de Tecnico",
  "Telefono",
  "EMAIL",
  "Popularidad_Tecnico",
  "Related DETALLE DE ACTIVIDADESs",
] as const;

export const MIRROR_TABLES = {
  TECNICOS: "Tecnicos",
  ORDENES: "Ordenes_Trabajo",
  CLIENTES: "Clientes",
  ARQUITECTOS: "Arquitecto",
  ACTIVIDADES: "Detalle de Actividades",
  CONTACTOS: "CONTACTOS",
  COSTOS: "Costos_Ejecucion",
} as const;

// AppSheet Costos_Ejecucion row shape. One row per contractor expense line
// (materiales, mano de obra, viáticos). 1,007 rows live as of 2026-05-29,
// 100% linked to OTs via ID_Orden. ESTADO ∈ {APROBADO, PENDIENTE, RECHAZADO};
// only APROBADO counts toward Redin cost in the conservative headline P&L.
export interface AppSheetCosto extends Record<string, string | undefined> {
  "Row ID"?: string;
  ID_Costo?: string;
  ID_Orden?: string;
  Fecha_Gasto?: string;
  Categoria?: string;
  ID_Detalle?: string;
  Valor_Gasto?: string;
  Evidencia?: string;
  ESTADO?: string;
  Numero_Consecutivo?: string;
  Nombre_Visual_Anticipo?: string;
}

// Narrow views of the AppSheet rows we care about. Keep loose — AppSheet
// silently adds/renames columns; we store the full row in `data` jsonb and
// only extract what we filter/sort by.
export interface AppSheetOT extends Record<string, string | undefined> {
  "Row ID"?: string;
  ID_Orden?: string;
  Ciudad?: string;
  Categoria?: string;
  Subcategoria?: string;
  Estado?: string;
  Descripcion?: string;
  Fecha_Creacion?: string;
  Numero_Orden?: string;
}
