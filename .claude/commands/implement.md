# /implement — smallest verified change (Change-Step-2)

Implement the smallest change that achieves the outcome below. No
refactoring beyond what is strictly required.

## Outcome + confirmed cause

$ARGUMENTS

## Protocol

1. RESTATE before coding: CURRENT behavior (observable, today) →
   TARGET behavior (observable, after). Parallel structure. If the
   input above doesn't give you a confirmed root cause, STOP and ask —
   do not guess; /diagnose comes first.

2. DECLARE SCOPE before coding: list files you MAY edit and files you
   MUST NOT touch. Anything another concern owns (other agent's
   surface, matching, sync, KPI views) is MUST-NOT unless the outcome
   requires it.

3. WRITE VERIFICATION BEFORE CODE: name the exact commands and the
   exact expected outputs. A smoke script per change class
   (scripts/smoke-*.ts) is the house pattern.

4. INVESTIGATION BUDGET: if verification fails, max 3 diagnose attempts,
   then STOP and report findings + hypothesis, even unconfirmed. Never
   loop blind.

## Gates (all green before commit — no exceptions)

- npm run typecheck (all workspaces)
- npm run smoke (Phase 0, 22 checks)
- npx tsx --env-file=.env.local qa/seeds/validate.ts (schema + coverage)
- Your new/updated smoke script passes
- If you changed a prompt: affected qa/seeds updated, never deleted

## House rules (Redin marketplace)

- "Las herramientas mandan": deterministic behavior lives in tool
  returns (suggested_reply/next_action), not LLM discretion. If your
  fix makes the LLM "try harder", it's wrong — move it into code.
- User-facing Spanish: es-CO, tú register, jefe-de-obra voice ("Qué
  más", "Dale", "Listo", "Sigamos"). Zero legalese, zero corporate.
- AppSheet read-only. Secrets only in .env.local. No `as any`,
  no @ts-ignore.
- Media failures use the [MEDIA_FAILED: kind=… reason=…] sentinel +
  immediate worker-facing fallback message pattern.
- New risky behavior ships behind a default-on env flag for no-code
  revert (TONO_*/MANOS_* naming).

## Done = commit (do NOT push)

One story = one commit. Message: what changed, why, gates that ran,
revert path. Flag any scope deviation explicitly — deviations flagged
honestly are acceptable; silent ones are not.
