"use client";

// DocViewer — displays all uploaded documents for a tecnico, grouped by tipo.
// Renders signed URLs for images (inline) and PDFs (object embed). Shows
// classifier verdict when classification_jsonb is present. HR can validate
// each doc with a single button click.
//
// Props come from the server component (page.tsx) which has already:
//   - Generated Supabase signed URLs (TTL 600s)
//   - Fetched classification_jsonb from the documentos table
//   - Grouped docs by tipo label
//
// This component is purely presentational + one form submit per doc.

import { validateDocumento } from "@/lib/documentos-actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassificationJsonb {
  classified_type?: string | null;
  confidence?: number | null;
  matches_expected?: boolean | null;
  extracted_fields?: Record<string, string | null> | null;
  error?: string | null;
}

export interface DocViewerItem {
  id: string;
  tecnico_id: string;
  tipo: string;
  tipo_label: string;
  storage_path: string;
  uploaded_at: string;
  validated_by: string | null;
  validated_at: string | null;
  signed_url: string | null;
  classification_jsonb: ClassificationJsonb | null;
}

export interface DocViewerGroup {
  label: string;
  docs: DocViewerItem[];
}

interface DocViewerProps {
  groups: DocViewerGroup[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO");
}

function extFromPath(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

function isImage(path: string): boolean {
  return ["jpg", "jpeg", "png", "webp"].includes(extFromPath(path));
}

function isPdf(path: string): boolean {
  return extFromPath(path) === "pdf";
}

const EXTRACTED_FIELD_LABELS: Record<string, string> = {
  nombre: "Nombre",
  cedula: "Cédula",
  fecha_emision: "Emisión",
  fecha_vencimiento: "Vencimiento",
  eps_nombre: "EPS",
  arl_nombre: "ARL",
};

// ---------------------------------------------------------------------------
// ClassifierBadge
// ---------------------------------------------------------------------------

function ClassifierBadge({
  classification,
}: {
  classification: ClassificationJsonb;
}): JSX.Element | null {
  const { classified_type, confidence, matches_expected } = classification;
  if (!classified_type) return null;

  const confStr =
    typeof confidence === "number" ? ` (${confidence.toFixed(2)})` : "";

  let badgeClass: string;
  let icon: string;
  if (matches_expected === true) {
    badgeClass = "bg-emerald-100 text-emerald-800 border-emerald-300";
    icon = "✓";
  } else if (matches_expected === false) {
    badgeClass = "bg-amber-100 text-amber-800 border-amber-300";
    icon = "⚠";
  } else {
    badgeClass = "bg-slate-100 text-slate-600 border-slate-200";
    icon = "~";
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}
      title={matches_expected === true
        ? "El clasificador confirma que el tipo coincide con lo declarado"
        : matches_expected === false
        ? "El clasificador detecta una discrepancia con el tipo declarado"
        : "El clasificador no pudo determinar si coincide"}
    >
      {icon} Toño leyó: {classified_type}
      {confStr}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ExtractedFields
// ---------------------------------------------------------------------------

function ExtractedFields({
  fields,
}: {
  fields: Record<string, string | null>;
}): JSX.Element | null {
  const entries = Object.entries(fields).filter(
    ([k, v]) => v != null && v !== "" && EXTRACTED_FIELD_LABELS[k]
  );
  if (entries.length === 0) return null;

  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
      {entries.map(([k, v]) => (
        <div key={k} className="flex flex-col">
          <dt className="text-slate-400 uppercase tracking-wide text-[10px]">
            {EXTRACTED_FIELD_LABELS[k]}
          </dt>
          <dd className="text-slate-700 font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// DocCard
// ---------------------------------------------------------------------------

function DocCard({ doc }: { doc: DocViewerItem }): JSX.Element {
  const isValidated = !!doc.validated_at;
  const filename = doc.storage_path.split("/").pop() ?? doc.storage_path;

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden shadow-sm">
      {/* Card header */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-slate-900 text-sm leading-tight">
            {doc.tipo_label}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            subido {fmt(doc.uploaded_at)} ·{" "}
            <span className="font-mono text-slate-400 truncate block max-w-[220px]">
              {filename}
            </span>
          </div>
        </div>

        {/* Validation status pill */}
        {isValidated ? (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap">
            ✓ Validado
          </span>
        ) : (
          <span className="shrink-0 inline-flex items-center rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-0.5 text-[11px] whitespace-nowrap">
            Sin validar
          </span>
        )}
      </div>

      {/* Classifier verdict */}
      {doc.classification_jsonb && (
        <div className="px-4 pt-3 pb-0 space-y-1.5">
          <ClassifierBadge classification={doc.classification_jsonb} />
          {doc.classification_jsonb.extracted_fields && (
            <ExtractedFields fields={doc.classification_jsonb.extracted_fields} />
          )}
          {doc.classification_jsonb.error && (
            <div className="text-[11px] text-rose-600">
              Error clasificador: {doc.classification_jsonb.error}
            </div>
          )}
        </div>
      )}

      {/* Document body */}
      <div className="px-4 py-3">
        {doc.signed_url ? (
          isImage(doc.storage_path) ? (
            <img
              src={doc.signed_url}
              alt={`Documento ${doc.tipo_label} subido el ${fmt(doc.uploaded_at)}`}
              className="max-w-full max-h-96 rounded border border-slate-200 object-contain bg-slate-50"
              loading="lazy"
            />
          ) : isPdf(doc.storage_path) ? (
            <object
              data={doc.signed_url}
              type="application/pdf"
              className="w-full h-96 border border-slate-200 rounded bg-slate-50"
              aria-label={`PDF: ${doc.tipo_label}`}
            >
              <a
                href={doc.signed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-amber-700 underline underline-offset-2 hover:text-amber-900"
              >
                Abrir PDF en nueva pestaña
              </a>
            </object>
          ) : (
            <a
              href={doc.signed_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-amber-700 underline underline-offset-2 hover:text-amber-900"
              aria-label={`Descargar archivo ${doc.tipo_label}`}
            >
              Descargar archivo
            </a>
          )
        ) : (
          <div className="text-sm text-slate-400 italic">
            URL de visualización no disponible (el archivo puede no existir en storage).
          </div>
        )}
      </div>

      {/* Card footer — validate button or validated-by info */}
      <div className="px-4 pb-3 pt-0">
        {isValidated ? (
          <div className="text-[11px] text-emerald-700">
            ✓ Validado por {doc.validated_by} el {fmt(doc.validated_at)}
          </div>
        ) : (
          <form action={validateDocumento}>
            <input type="hidden" name="documento_id" value={doc.id} />
            <input type="hidden" name="tecnico_id" value={doc.tecnico_id} />
            <button
              type="submit"
              aria-label={`Validar documento ${doc.tipo_label}`}
              className="text-xs bg-slate-700 hover:bg-slate-800 text-white rounded-md px-3 py-1.5 transition-colors"
            >
              Validar
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DocViewer (exported)
// ---------------------------------------------------------------------------

export function DocViewer({ groups }: DocViewerProps): JSX.Element {
  const totalDocs = groups.reduce((sum, g) => sum + g.docs.length, 0);

  if (totalDocs === 0) {
    return (
      <div className="card p-4 text-sm text-slate-500">
        Este técnico aún no ha subido documentos.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2 font-medium">
            {group.label}
            <span className="ml-1.5 text-slate-400 normal-case">
              ({group.docs.length})
            </span>
          </div>
          <div className="space-y-3">
            {group.docs.map((doc) => (
              <DocCard key={doc.id} doc={doc} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
