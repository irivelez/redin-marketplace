# Eval infra repair — @google/genai dep + post-approval-gate fixtures

**Saved:** 2026-06-11 · **By:** Sisyphus · **Scope:** `qa/` only — no production code touched.

## What I changed

1. **Added `@google/genai` to root `package.json` devDependencies** (via `npm install -D`). `qa/judge.ts` imports it dynamically; previously absent so every judge call threw on import. `npm run typecheck` green.

1b. **Switched judge model from `gemini-2.5-pro` to `gemini-2.5-flash`** in `qa/judge.ts` (one-line change at the `models.generateContent` call). Per user instruction after the pro-tier quota-exhausted result.

2. **Updated two base fixtures in `qa/fixtures.ts`** to model the post-approval state these journeys actually test:
   - `seedTecnicoRegisteredBogotaElectrico` — now sets `candidate_state="approved" + profile_complete=true + cedula=testCedulaFor(testPhone)`.
   - `seedTecnicoRegisteredCaliPlomero` — same shape.
   - Cascades to `tecnico_with_pending_postulacion` and `tecnico_with_signed_contract` (both extend the Bogotá fixture).
   - The fixture *name* still says "registered"; an approved técnico **is** registered, so the semantics are consistent. Inline comment in the file references `router.ts APPROVAL_GATED_TOOLS` so future readers see why these flags are set.

3. **Updated seed descriptions** for `journey_9_2 / 9_3 / 9_4 / 9_5 / 9_6` and `refusal_1 / refusal_6` to document the fixture choice (default option (a): post-approval). Per-seed description block now spells out why the fixture is approved, not in screening.

## Verification I ran

### `npm run typecheck` → clean across all workspaces (post-dep + post-edit).

### Judge smoke (item #2) → **FAILED — Gemini project-level access, NOT dep**

Two attempts after the dep was installed:

**Attempt 1 — judge on `gemini-2.5-pro` (the original config):**
- Deterministic: PASS (1/1).
- Judge: HTTP 429 RESOURCE_EXHAUSTED. Free-tier quota = 0 for `gemini-2.5-pro`.

**Attempt 2 — judge switched to `gemini-2.5-flash` per user instruction:**
- Deterministic: PASS (1/1).
- Judge: HTTP 403 PERMISSION_DENIED — `"Your project has been denied access. Please contact support."`

So the `GEMINI_API_KEY` in `.env.local` works for the production document-classification path (which also calls `gemini-2.5-flash` per `tools/src/classify-documento.ts:28`), but the same key, against the same model, from this worktree, is rejected with 403 PERMISSION_DENIED. Likely causes (un-investigated, all out of scope for this session per "do not debug Gemini infra beyond the dep"):
- Local `.env.local` key is stale / different from the prod env-set key, OR
- The Google Cloud / AI Studio project tied to this key has been region-restricted or revoked, OR
- Per-key application restrictions deny direct REST calls (only Vertex-mediated ones are allowed).

**To unblock the judge — pick one:**
1. Confirm `.env.local` `GEMINI_API_KEY` matches the prod Railway env, then re-run.
2. Mint a fresh AI Studio key with no project restrictions, drop into `.env.local`, re-run.
3. Switch the judge to Vertex AI client + service-account auth (largest change).

### Full eval (item #4) → ran, see `qa/reports/EVAL-2026-06-11-1404.md`

- Deterministic: 9/32 pass, 23 fail.
- Judge: 0/0 (every call errored on the same quota).
- Coverage gate: BLOCKED.

**Headline:** fixture fix worked structurally (identity gate now logs `candidate_state=approved is_legacy_incomplete=false` for the affected seeds; `read_pending_ots` and `create_postulacion` are no longer refused), **but** it exposed a second-order problem the original diagnosis didn't anticipate — see next section.

## The newly-uncovered problem (scope-stopped per budget rule)

> "If >5 seeds need fixture changes beyond 9_2–9_6 + 2 refusals, STOP and report scope before editing."

Approved-fixture workers hit the identity-gate pre-resolution path in `tono/src/agent.ts:457-492`. The gate pre-loads `tecnico_id` and `candidate_state` into `turnSession` **before** the LLM turn, the agent enters `routingMode = "returning"`, and the system prompt for returning workers does not push `identify_user` because identity is already known. The router's Rule 1b (`tono/src/router.ts:240-254`) only fires when `session.tecnico_id === null`, which it isn't, so the LLM correctly skips the call.

This breaks **every** seed whose deterministic assertion includes `tool.must_be_first: identify_user` for an already-known phone. Affected seeds in this run: `journey_9_2`, `journey_9_3`, `journey_9_4`, `journey_9_6`, `journey_9_7`, `refusal_1` through `refusal_6`, `redteam_01`, `03`, `05`, `06`, `08`, `09`, `10` — far past the ">5 seeds beyond 9_2–9_6 + 2 refusals" budget.

**The agent behavior is correct.** The assertion is stale: it predates the identity-gate pre-resolution that turns returning workers into a single-turn flow. Two ways to fix, both outside this session's scope:

1. Relax `tool.must_be_first: identify_user` to `tool.first_must_be_in: [identify_user, read_pending_ots, read_my_postulaciones]` (or scope it conditionally to first-touch seeds).
2. Split each affected journey into two seeds: a first-touch seed (no fixture, must call identify_user) and a returning seed (approved fixture, skips identify_user).

Either change touches the deterministic checker (`qa/deterministic.ts`) or 16+ seed YAMLs — both well beyond "stale seeds only".

## Non-journey/non-refusal failures observed in this run (not in scope)

- `journey_9_1_registration`: deterministic FAIL on `response_does_not_contain: "LLAMAR"`. The reply *did* pass this assertion in the earlier `EVAL-2026-06-11-1231.md` smoke. LLM non-determinism — the system prompt has a `LLAMAR` callback option that surfaces in some greetings but not others. Pre-existing flakiness; ignore for this session.
- `test_c`, `test_d`, `test_f`, `test_g` (onboarding stream): pre-existing screening failures unrelated to my change; `test_e` passes.

## Bonus check (item #5) — group-JID filter

**Yes**, group JIDs are filtered. [`tono/src/whatsapp.ts:313`](file:///Users/irina/AI-driven-OS/autonomous/redin/marketplace/tono/src/whatsapp.ts#L313):

```ts
if (!jid || jid.endsWith("@g.us")) return; // skip groups in v1
```

The prod incident with `+120363424571968232` (a group's own JID being treated as a phone) is consistent with either: (a) a message arriving with `remoteJid` not ending in `@g.us` because the WhatsApp client serialized it under a different format (e.g. `@lid`), or (b) the LID self-loop guard at lines 280-292 misclassifying. Both are reachable code paths but not investigable in this 5-minute budget. Not fixed in this session.

## Files touched

- `package.json` + `package-lock.json` — root: added `@google/genai` devDependency.
- `qa/judge.ts` — judge model: `gemini-2.5-pro` → `gemini-2.5-flash`.
- `qa/fixtures.ts` — two fixture functions updated to set approved state.
- `qa/seeds/journeys/journey_9_2_demand_broadcast.yaml` — description.
- `qa/seeds/journeys/journey_9_3_pull_apply.yaml` — description.
- `qa/seeds/journeys/journey_9_4_shortlist_notify.yaml` — description.
- `qa/seeds/journeys/journey_9_5_contract.yaml` — description.
- `qa/seeds/journeys/journey_9_6_status_check.yaml` — description.
- `qa/seeds/refusals/refusal_1_fabricated_tarifa.yaml` — description.
- `qa/seeds/refusals/refusal_6_anti_injection_tool_data.yaml` — description.
- `qa/reports/EVAL-2026-06-11-1336.md` — single-seed judge smoke output.
- `qa/reports/EVAL-2026-06-11-1404.md` — full eval output (the "first real judge run" was not produceable due to quota).

## What still needs to happen for a real judge baseline

1. **Fix Gemini access for the `GEMINI_API_KEY` in local `.env.local`** — the model switch to `gemini-2.5-flash` was made this session, but the project-level 403 PERMISSION_DENIED is unresolved. Most likely: sync `.env.local` to the prod Railway key, OR mint a fresh AI Studio key without project restrictions. Try `--only journey_9_1_registration` after either fix; expected: a real F=N P=N E=N verdict from Gemini.
2. **Relax or split the `tool.must_be_first: identify_user` assertion in `qa/deterministic.ts`** so returning-worker seeds aren't penalized for correct agent behavior (identity gate pre-resolves `tecnico_id` for known phones → LLM correctly skips `identify_user` in returning mode). 16+ seeds are blocked on this; full list in the "newly-uncovered problem" section above.
3. Re-run `npm run eval`. That run will be the first real judge baseline.
