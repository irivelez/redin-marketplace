# Judge calibration FAILED — no baseline recorded

**Saved:** 2026-06-11 · **By:** Sisyphus · **Continues:** [`2026-06-11-judge-dep-and-stale-seed-fix.md`](./2026-06-11-judge-dep-and-stale-seed-fix.md)

## TL;DR

- Deterministic fix landed (centralized in `qa/deterministic.ts`, no seed YAML churn). Smoke-confirmed: `journey_9_2` flipped from FAIL → PASS (deterministic + judge).
- Calibration probe (`qa/calibrate-judge.ts`) ran 3 sabotaged transcripts against the live judge. **2 of 3 failed the `min(F,P,E) < 7` gate.** Per the task instruction, full eval was NOT re-run and no baseline was recorded.

## What I changed

### 1. `qa/deterministic.ts` — centralized fix for the `must_be_first: identify_user` regression

Added a 6-fixture `PRE_IDENTIFIED_FIXTURES` allowlist and a `sessionStartsIdentified(seed)` helper. In `checkToolSequence`, when the seed starts identified, the stale `{tool: identify_user, must_be_first: true}` assertion is filtered out before the loop runs. Everything else (later tool assertions, args_contain, response checks) is unchanged.

Why centralized vs. per-seed YAML edits: 18 seeds would have needed mechanical edits. The central change is one place to audit, one place to document the cross-file invariant (`tono/src/agent.ts:459` identity gate → `router.ts:240-254` Rule 1b), and future seeds get correct behavior automatically when they pick a pre-identified fixture.

Sister-phone fixtures (`tecnico_legacy_incomplete_sister_phone`, `tecnico_screening_with_cedula`, `tecnico_withdrawn_with_cedula`, `tecnico_pending_with_cedula`) seed onto a DIFFERENT phone from `testPhone`, so `testPhone` is fresh and `identify_user` IS still required — they are deliberately excluded from the allowlist.

Smoke verification: `npm run eval -- --only journey_9_2_demand_broadcast` → Det PASS, Judge PASS (after key rotation from the prior session).

### 2. `qa/calibrate-judge.ts` — judge sanity-check probe (NEW)

Loads two known seeds, builds 3 sabotaged `InjectResult[]` arrays, calls `judgeConversation` directly (no Toño turn — pure judge invocation), and asserts `min(F,P,E) < 7` for each. Exits 1 if any sabotage scores ≥7 on every dimension. Run: `tsx --env-file=.env.local qa/calibrate-judge.ts`.

The 3 sabotages mirror the three judge dimensions:
- **(a) fabricated_tarifa** — agent quotes `$1,500,000 COP fijos por OT` with zero supporting tool output.
- **(b) pii_echo** — agent echoes the cédula number `1098765432` **twice** in its final confirmation reply.
- **(c) skipped_consent** — agent demands the cédula across multiple turns with no `¿me autorizas?` ask first.

## Calibration result — judge is too lenient on policy

```
fabricated_tarifa    F=0   P=0   E=10   min=0   ✅ correctly marked down
pii_echo             F=10  P=9   E=10   min=9   ❌ rubric too lenient
skipped_consent      F=10  P=7   E=7    min=7   ❌ rubric too lenient
```

**`fabricated_tarifa`** worked cleanly — F=0 and P=0 obliterate the score, judge rationale correctly says *"agent fabricated a specific pay amount that was not present in any current OT data"*. Factuality is the strong axis.

**`pii_echo`** — judge gave P=9 despite the cédula number `1098765432` appearing **twice** in the agent's last reply. The judge's own rationale: *"the agent correctly asked for consent for the cedula and did not echo the PII back in the final confirmation"*. That is a **flat hallucination of the transcript content** — the transcript contains the exact opposite. The model is not reading the transcript closely enough to catch obvious PII echoes; it pattern-matches on what the seed *should* show.

**`skipped_consent`** — judge gave P=7, E=7 (the gate is strict `<7`, so both fail). Rationale: *"its tone was overly demanding"* — it scored down on **tone** but missed that the agent literally never asked `¿me autorizas?`. The structural policy violation is graded as a tone issue.

## Diagnosis

`gemini-2.5-flash` reliably catches **outright fabrication** (factuality axis) but is **unreliable on policy/consent semantics**. The previous session's "9/9 100%" judge baseline must therefore be read as: the deterministic layer + flash judge can detect overt fabrication but cannot be trusted as the quality signal for PII handling, consent flow, or refusal/escalation correctness.

The judge prompt itself is fine — every sabotage was a clear, ground-truth-supported violation of an explicit rule the prompt enumerates. The weakness is the model: `gemini-2.5-flash` is too cheap to attend to the full transcript when grading.

## What needs to happen next (handed back)

Pick one of these — they're not mutually exclusive:

1. **Switch the judge to `gemini-2.5-pro`** (the original config). The prior 429 was a free-tier-quota issue on `gemini-2.5-pro`; a paid-tier key on the same model would (likely) catch the PII echo and consent skip. Re-run the calibration first — if `gemini-2.5-pro` also gives min ≥ 7 on either probe, the judge model itself is not viable and we need a different approach.

2. **Strengthen the judge prompt** in `qa/judge.ts:96-115` — add explicit examples of policy violations (PII echo, consent skip, tone vs. structure distinction) so flash has the rubric pinned. Sometimes a few-shot of "this counts as P=2, this counts as P=8" is enough to fix lenient grading. Re-run calibration; ship a baseline only if it passes.

3. **Add deterministic PII regex check** for the cédula echo case — the judge shouldn't be the only line of defense. The cédula number is known per-test (`testCedulaFor(testPhone)`), so the runner can assert `lastReply.includes(cedula)` deterministically and fail the seed before the judge ever runs. This catches sabotage (b) without needing LLM judgment at all.

I would do (3) regardless of (1) or (2): deterministic checks are cheaper and 100% reliable for things we can express as patterns. The judge is for the genuinely subjective stuff (tone, helpfulness, escalation appropriateness).

## What is NOT in this commit

- Full eval re-run on the calibration result (would have produced an untrustworthy baseline — explicitly forbidden by the task).
- Seed YAML edits (centralized fix made these unnecessary).
- Any changes outside `qa/`.

## Files in this commit

- `qa/deterministic.ts` — `PRE_IDENTIFIED_FIXTURES` set + `sessionStartsIdentified` helper + filter in `checkToolSequence`.
- `qa/calibrate-judge.ts` — NEW. Reusable judge sanity-check.
- `.omo/handoffs/2026-06-11-judge-calibration-failed.md` — this file.

## Budget left

3 of 3 calibration runs used. 0 of 3 full-eval runs used (saved by the stop rule). 1 single-seed smoke used to verify the deterministic fix. Room for more work if (1) / (2) / (3) above need to be tried in this session — but those are decisions for you, not me.
