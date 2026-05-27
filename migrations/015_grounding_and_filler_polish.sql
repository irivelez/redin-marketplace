-- 015 — Grounding violations column + filler-reply evento types
--
-- Additive only. NULL columns, no defaults that break existing rows.
-- Companion to the grounding-gate.ts (A2) implementation in tono/.
--
-- Idempotent. Every DDL guarded by IF NOT EXISTS.

-- ============================================================================
-- 1. turns.grounding_violations — nullable JSONB
-- ============================================================================
-- Written by agent.ts after checkGrounding() finds specific-entity violations
-- in the LLM reply (numbers ≥3 digits, proper nouns, placa-like patterns,
-- foreign country names not present in tool outputs or identity context).
--
-- Shape: [{token, kind, reason}, ...]  (GroundingViolation[] from grounding-gate.ts)
-- NULL when no violations (the common case — never filled for clean turns).

alter table turns
  add column if not exists grounding_violations jsonb;

comment on column turns.grounding_violations is
  'Grounding violations detected by grounding-gate.ts post-LLM check. NULL = clean. Shape: [{token, kind:"number"|"proper_noun"|"placa"|"country_name", reason}]. Populated in log-only mode; reply replaced only when TONO_GROUNDING_ENFORCE=true.';

-- Partial index — only covers rows that actually have violations (small slice).
-- Supports: SELECT * FROM turns WHERE grounding_violations IS NOT NULL ORDER BY started_at DESC
create index if not exists idx_turns_grounding_violations
  on turns (started_at desc)
  where grounding_violations is not null;

-- ============================================================================
-- 2. New evento types — comment only (eventos.type is free-text, no enum)
-- ============================================================================
-- grounding_blocked          — reply was replaced by safe fallback (TONO_GROUNDING_ENFORCE=true)
-- grounding_violation_logged — violations detected but reply was NOT replaced (log-only mode)
-- empty_reply_no_tools       — LLM returned empty text with no successful tool call;
--                             substituted "Un momento, déjame mirar eso." instead of "Perfecto, anotado"
comment on table eventos is
  'Append-only audit log. Known type values (not exhaustive — free-text field):
   tecnico_registered, tecnico_legacy_bootstrap, manos_cedula_verified,
   manos_cedula_rejected, cost_kill_switch_triggered, refused, city_off_canonical,
   grounding_blocked, grounding_violation_logged, empty_reply_no_tools.';
