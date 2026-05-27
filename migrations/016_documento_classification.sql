-- 016 — Document classifier columns.
--
-- Adds the persistence layer for classify_documento tool results:
--   classification_jsonb  — full Gemini response (classified_type, confidence,
--                           extracted_fields, discrepancies, model, classified_at)
--   classified_at         — timestamp of last classification attempt
--   classifier_model      — model ID used (e.g. gemini-2.5-flash-preview-05-20)
--
-- Index filters to only rows that have been classified (partial index keeps it
-- small — unclassified rows, which are the majority during ramp-up, are skipped).
--
-- Idempotent: all DDL guarded by IF NOT EXISTS.

alter table documentos
  add column if not exists classification_jsonb jsonb;

alter table documentos
  add column if not exists classified_at timestamptz;

alter table documentos
  add column if not exists classifier_model text;

create index if not exists idx_documentos_classified
  on documentos (classified_at desc)
  where classification_jsonb is not null;

comment on column documentos.classification_jsonb is
  'Full result from classify_documento (Gemini 2.5 Flash multimodal). Fields: classified_type, confidence, matches_expected, extracted_fields, discrepancies, model, classified_at. Written by the classify_documento tool immediately after upload.';

comment on column documentos.classified_at is
  'Timestamp of the last successful classify_documento call. NULL = never classified.';

comment on column documentos.classifier_model is
  'Gemini model ID used for the last classification (e.g. gemini-2.5-flash-preview-05-20).';
