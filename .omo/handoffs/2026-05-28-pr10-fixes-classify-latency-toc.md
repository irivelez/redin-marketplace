# Session Handoff — PR #10 Self-Review + Three Bug Chain + Latency + TOC Swap

**Saved:** 2026-05-28 ~14:30 PT · **By:** Sisyphus orchestrator · **Status:** 🟢 ALL CODE FIXES SHIPPED · ⏳ Fresh WA test pending Irina

Continues from [`2026-05-27-taxonomy-siso-photo-batching.md`](./2026-05-27-taxonomy-siso-photo-batching.md). Read in order if catching up.

---

## 0. TL;DR for next session

1. 🟢 **[PR #10](https://github.com/irinavelezk/redin-marketplace/pull/10) is open and `MERGEABLE: CLEAN`**. Contains the 17-commit catch-up plus 5 new commits from today (security, classify_documento, latency, TOC). Ready to merge whenever Irina confirms the next test passes.
2. 🟢 **Three production bugs in `classify_documento` fixed** — feature had never persisted a single classification since launch (`5577cbc` 2026-05-23). Now working end-to-end (verified against Julian's 3 documents pre-cleanup).
3. 🟢 **Security IDOR fix shipped** — `classify_documento` had cross-worker PII leak via missing ownership check + extracted_fields in LLM-facing return. Patched at three layers (router gate, ownership check, narrowed contract).
4. 🟢 **Latency reduced** — `TONO_THINKING_BUDGET` default `2000 → 1024`. Expected ~9-10s avg per turn (was 12.6s on Julian).
5. 🟢 **Worker-facing valor switched to `Total_Orden_Calculado`** — read_pending_ots tool + HR approval push + public landing + HR pipeline + HR shortlist. Silent omission when TOC=0.
6. 🟢 **3 test personas fully cleaned** — Camilo Navas, Jose Luis Capacho Santafe (twice — re-created post-first-cleanup), Julian Cartago López. All cascade-deleted from DB + AppSheet. Both test phones at 0 sessions / 0 outbound.
7. ⏳ **Fresh WA test from Irina pending** — phones `+137877543452841` and `+33887895953632` are ready for clean Toño pairing. Either will fire the new-worker Redin greeting on next `hola`.

---

## 1. PR #10 commit list (since `2026-05-27`)

Branch: `fix/tono-reject-url-as-document-evidence`. Now 22 commits ahead of `main` (17 catch-up + 1 merge + 4 today's fixes + 1 verifier script).

| Commit | What |
|---|---|
| `cccd8ab` | fix(security): classify_documento ownership gate + drop PII from LLM return + .env.example sync + Camilo/Jose Luis cleanup script |
| `6a1ceb5` | fix(classify): three-bug chain — empty oneof, expired snapshot, fileData URI |
| `7ac5831` | perf(tono): drop default TONO_THINKING_BUDGET 2000 → 1024 |
| `e6eb46a` | feat(scripts): verify-tono-session — one-shot post-test verifier |
| `f2eb8a9` | feat(worker): worker-facing valor switches to Total_Orden_Calculado |
| `c2e20a5` | feat(dashboard): public landing + HR pages show Total_Orden_Calculado |

---

## 2. The classify_documento three-bug chain (fully diagnosed + fixed)

Feature never persisted a single classification in production since `5577cbc` (2026-05-23). Surfaced by Julian's test: 3 documents uploaded, 0 classified, 0 `document_classified` eventos. Live diagnosis via [`scripts/diag-classify.ts`](../scripts/diag-classify.ts) found:

| Bug | Error | Fix |
|---|---|---|
| 1. SDK 400 from empty oneof | `400 — required oneof field 'data' must have one initialized field` | Removed `{ inlineData: undefined as never }` hack line |
| 2. Expired model snapshot | `404 — models/gemini-2.5-flash-preview-05-20 is not found` | Switched default to `gemini-2.5-flash`, env-overridable via `GEMINI_CLASSIFIER_MODEL` |
| 3. Gemini fileData URI doesn't accept Supabase signed URLs | `classifier_timeout` after 5s | Switched to `inlineData` with base64 bytes from `supabase.storage.download()`. Bumped TIMEOUT_MS 5000→10000 |

**Verification (live, against Julian's pre-cleanup documents):**
- 4ccc600b cédula front → classified=cedula conf=0.95 ✅
- 84647f64 cédula back → classified=cedula conf=0.98 (extracted cedula + nombre) ✅
- 753a31b5 Marval site → classified=unreadable conf=0 (worker uploaded a building photo as cert_trabajos_previos — correctly rejected) ✅

All 3 persisted to `documentos.classification_jsonb` + emitted `document_classified` events.

---

## 3. Security IDOR fix (was the #1 blocker in the 5-agent review)

`classify_documento` accepted `documento_id` from the LLM, had no ownership check, was not in `AUTH_GATED_TOOLS`, and returned `extracted_fields` with PII (cédula number, EPS/ARL provider names, fechas). Habeas Data Ley 1581 exposure.

Three-layer fix:
- `tools/src/context.ts`: added `session_tecnico_id?: string | null` to `ToolContext`
- `tono/src/agent.ts:402` (routedDispatch): injects `turnSession.tecnico_id` into `enrichedCtx` before each `dispatchTool` call (so the live post-identify_user value reaches the tool, not the pre-turn snapshot)
- `tools/src/classify-documento.ts`: ownership check — returns `forbidden` when `ctx.session_tecnico_id !== doc.tecnico_id`. Skips check when `session_tecnico_id` is absent (smoke / dashboard-direct paths preserved)
- `tono/src/router.ts:79`: added `classify_documento` to `AUTH_GATED_TOOLS`
- `tools/src/types.ts` + `classify-documento.ts`: dropped `extracted_fields` and `classification_jsonb_path` from `ClassifyDocumentoOutput`. Full payload still persists to `documentos.classification_jsonb` for HR's DocViewer

**Regression test:** [`scripts/test-classify-ownership-2026-05-28.ts`](../scripts/test-classify-ownership-2026-05-28.ts) — 3 cases, all PASS:
- CASE 1: worker B → A's doc → blocked with code=forbidden ✅
- CASE 2: no session_tecnico_id (smoke path) → bypasses gate ✅
- CASE 3: worker A → own doc → passes gate ✅

---

## 4. Latency optimization

Julian's test showed 12.6s avg turn latency (Sonnet 4.5 + thinking budget 2000). Irina flagged it as too slow.

Lowered `TONO_THINKING_BUDGET` default `2000 → 1024` (Anthropic minimum). Expected ~9-10s avg per turn while keeping extended thinking mode active (still benefits from Gap A.3 edge-case handling).

Env-overridable via `TONO_THINKING_BUDGET` — bump to 2000-4000 if specific scenarios need more reasoning headroom. `.env.example` documents the tradeoff.

Levers if 9-10s is still too slow next test:
- `TONO_THINKING_ENABLED=false` → drops to ~6-8s but loses Gap A.3 benefits
- `TONO_MODEL=claude-haiku-4-5` → drops to ~4-6s, much cheaper, but noticeable dossier-quality regression

---

## 5. Total_Orden_Calculado swap (worker-facing)

Per Irina: workers should see the **final calculated total**, not the initial estimate. When TOC is 0 or missing (typical for fresh state-4 OTs that haven't been priced yet), the price is **omitted entirely** — no `$0`, no `por confirmar`, just silence.

**WORKER-facing surfaces switched:**
- `tools/src/read-pending-ots.ts:47` (Toño WA tool) — `Valor_Estimado` → `Total_Orden_Calculado`. Field name kept as `valor_estimado` in the API to avoid rippling the contract.
- `dashboard/src/lib/decisions.ts:135` (HR approval push — Toño's "Felicidades, hay X trabajos" message) — now uses `otTotalOrdenCalculado()`.
- `dashboard/src/app/page.tsx:41` (public landing) — inline `valorLabelFrom` now reads TOC. Existing `{valorLabel && (...)}` UI silently omits when null.

**HR-only pages — NEW TOC display added:**
- `dashboard/src/app/hr/pipeline/page.tsx:443` — TOC pill next to ciudad/especialidad on each OT card.
- `dashboard/src/app/hr/shortlist/[ot_id]/page.tsx:473` — same TOC pill on the OT header card.

**HR-INTERNAL surfaces UNCHANGED** (still show `Valor_Estimado` only):
- `/hr/contratos`, `/hr/contratos/[id]` — contract-context, not OT-pricing
- `/hr/tecnicos/[id]` — worker-context

**Manos architect tool** (`tools/src/manos/list-my-pending-ots.ts`) UNCHANGED — different audience, different need (architects want initial estimate to scope work).

**Real-data caveat:** ~5/8 sampled state-4 OTs have `Total_Orden_Calculado = 0` (including the Cali test OT `xkaG046P "OT de prueba- no eliminar"`). For those, Toño will offer the job with no price label.

---

## 6. Test persona cleanup (3 personas, all gone)

Worktree had stale test data from prior sessions. Sequential cleanup:

| Persona | tecnico_id | Phone | Final cleanup |
|---|---|---|---|
| Camilo Navas | `679d0714-1b7a-4a29-85a3-c44970ab5389` | `+137877543452841` | 2026-05-28 19:27 PT (one-off script — cedula was NULL) |
| Jose Luis Capacho Santafe (v1) | `1631104c-a5fa-4580-9d86-9b774afcf860` | `+33887895953632` | 2026-05-28 19:27 PT (one-off script) |
| Jose Luis Capacho Santafe (v2 — re-created after v1 cleanup) | `c733cd5f-9bae-4a02-9605-9d8246ecf4ea` | `+33887895953632` | 2026-05-28 ~14:00 PT (cleanup-tecnico.ts cedula 88034262, **+AppSheet**) |
| Julian Cartago López | `46cc65e1-89f3-4405-8273-742c4f2d875c` | `+137877543452841` | 2026-05-28 ~14:00 PT (cleanup-tecnico.ts cedula 1098665433, **+AppSheet**) |

Both phones now at: `sessions=0, outbound=0`, no `tecnicos_extended` row, no AppSheet entry.

**Scripts:**
- [`scripts/cleanup-tecnico.ts`](../scripts/cleanup-tecnico.ts) — production-grade, requires `<cedula> <expected-name-substring> --confirm`. Includes AppSheet delete when `appsheet_row_id` is present.
- [`scripts/cleanup-test-personas-2026-05-28.ts`](../scripts/cleanup-test-personas-2026-05-28.ts) — one-off for the two personas with cedula=NULL.

---

## 7. New tools for next session

### `scripts/verify-tono-session.ts` — post-test verifier
```bash
npx tsx --env-file=.env.local scripts/verify-tono-session.ts <phone>
```
Prints worker identity + candidate_state, turn latency stats (avg/min/max + tokens + model), per-document classification with match badge, dossier (reco + confidence + ciudad + subs count + certs), outbound dedup, concerning eventos count. Read-only. Use this instead of running 4-5 inline DB queries.

### `scripts/diag-classify.ts` — classifier diagnosis
```bash
npx tsx --env-file=.env.local scripts/diag-classify.ts <documento_id>
```
Direct invocation of `classify_documento` for a single document. Bypasses LLM and routing. Use when classification fails to surface the actual error (vs the fire-and-forget catch that swallows everything).

### `scripts/test-classify-ownership-2026-05-28.ts` — security regression
```bash
npx tsx --env-file=.env.local scripts/test-classify-ownership-2026-05-28.ts
```
3-case ownership check test. Should always pass; if it doesn't, the IDOR fix regressed.

---

## 8. Live verification done in this session

### npm run smoke (Phase 0 tool contracts)
22/22 PASS — ran multiple times across the session, always green.

### npm run typecheck
Clean across all 6 workspaces after every change.

### dashboard build
Clean Next.js production build after security + TOC changes.

### classify_documento end-to-end
[`diag-classify.ts`](../scripts/diag-classify.ts) on Julian's 3 docs — 3/3 successful classification + DB persistence + evento emission.

### Security IDOR
[`test-classify-ownership-2026-05-28.ts`](../scripts/test-classify-ownership-2026-05-28.ts) — 3/3 cases pass (block / bypass / allow).

### Cleanup
Both test phones verified at 0 sessions, 0 outbound, no tecnico, no AppSheet entry.

---

## 9. Fresh WA test plan (Irina, next session)

When Railway picks up `c2e20a5` (latest tip, ~60s after push):

1. **Send `hola`** from either test phone (`+137877543452841` recommended — was Julian's).
2. Verify the new-worker Redin greeting fires.
3. Walk through registration → cédula photos → screening (with SISO bundled question) → submit → wait for HR approval → postulation → preselection → contract.
4. Specifically watch for:
   - Photo batching: send 3+ photos rapid-fire, all should hit `documentos`
   - Cédula classification: HR's DocViewer should now show classified_type, matches_expected, confidence (was empty before)
   - Latency: turns should average ~9-10s (was 12.6s with budget 2000)
   - Toño offers OT: should show TOC if non-zero, omit price if zero
   - HR pipeline / shortlist: should show TOC pill next to ciudad

5. **After the test, send the phone number to the next-session Sisyphus** — they'll run the verifier and give a clean read.

### Test OT for offering
- `xkaG046P` "OT de prueba- no eliminar" in Cali — TOC=0, so Toño will offer it with NO price label.
- If you want a non-zero price in the test, edit `Total_Orden_Calculado` on that OT in AppSheet before the test. Alternatively wait for Toño to find another state-4 OT in Cali (none in test data currently with non-zero TOC).

---

## 10. Critical paths

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **PR #10**: https://github.com/irinavelezk/redin-marketplace/pull/10 (MERGEABLE: CLEAN, 22 commits ahead of main)
- **Branch**: `fix/tono-reject-url-as-document-evidence`, tip `c2e20a5`
- **Toño WA**: `+573224347117` (railway tono-mp)
- **Manos WA**: `+573222392959` (railway manos-mp)
- **Dashboard**: https://dashboard-mp-production-1ef3.up.railway.app
- **HR pipeline**: https://dashboard-mp-production-1ef3.up.railway.app/hr/pipeline
- **Test phones**: `+137877543452841`, `+33887895953632` (both clean, ready for `hola`)
- **Test OT**: `xkaG046P` "OT de prueba- no eliminar" Cali (TOC=0)

---

## 11. Decisions log (delta on prior handoffs)

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-28 | classify_documento auto-invoke from upload_documento.ts kept as fire-and-forget (`.catch(warn)`) | Latency-critical path (Gemini ~3-5s would block WA reply). Failure isolation > observability. Risk acknowledged: failures only log warn, no HR escalation. Filed as Oracle MAJOR finding; tolerated for pilot. |
| 2026-05-28 | classify_documento ownership check skips when `session_tecnico_id` is absent | Preserves smoke-test path (no session backing) without needing per-test plumbing. Trade-off acknowledged: a future caller that builds ToolContext WITHOUT session_tecnico_id will bypass the gate. Mitigation: ToolContext.session_tecnico_id is documented; routedDispatch is the only LLM-facing entry. |
| 2026-05-28 | TONO_THINKING_BUDGET default 2000 → 1024 | Julian's test showed 12.6s avg latency. Irina flagged too slow. 1024 is Anthropic's minimum — still keeps thinking mode active, ~2-3s/turn faster. Env-overridable for future tuning. |
| 2026-05-28 | TOC swap: worker-facing surfaces switch to Total_Orden_Calculado, HR-internal pages keep Valor_Estimado (initially) then ADD TOC pills alongside | Per Irina explicitly. Workers see truthful final amount when known, omit when 0. HR sees both numbers. Manos (architects) unchanged — different audience. |
| 2026-05-28 | GEMINI_CLASSIFIER_MODEL added as env knob (default gemini-2.5-flash) | Avoid single-point-of-failure on snapshot deprecation (just bit us — preview-05-20 expired). Matches the TONO_MODEL pattern. |

---

## 12. Known issues + watch-outs

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | classify_documento failures only log warn — no HR escalation, no dashboard surface for discrepancies | Medium | Filed as Oracle context-mining finding. Workaround: HR's DocViewer renders classification_jsonb when present; absence means manual review. Future: wire `documento_classification_failed` evento + dashboard widget. |
| 2 | Fresh state-4 OTs with TOC=0 are offered to workers with no price | Medium-by-design | Per Irina's silent-omission rule. Workers may ask "cuánto paga?" — Toño doesn't have a fallback prompt yet. Watch for this in the fresh test. |
| 3 | `dashboard/src/app/hr/pipeline/page.tsx` has `showNudgeButton = true` hardcoded at line 436 | Pre-existing | S11 cleanup blocked by S10 per PRD. Don't fix in isolation. |
| 4 | TOC pill on HR pages calls `otTotalOrdenCalculado(ot.data)` twice (label + render) | Cosmetic | Negligible (pure function, no IO). Could extract to const at top of map. Not worth touching. |
| 5 | If Manos-side session somehow calls classify_documento with mismatched arq_row_id, no ownership check fires | Theoretical | session_tecnico_id is for Toño's flow. Manos has its own session table. Currently no Manos code path invokes classify_documento, so this is dormant. Worth a comment if we later wire Manos to classify architect-uploaded docs. |

---

## 13. PRD stories status (delta on prior handoffs)

| Story | Status | Notes |
|---|---|---|
| S01-S07 | `open` | Untouched. Eval/observability backbone. Not pilot-blocking. |
| **S08** Manos architect feedback loop | `code_complete_pending_live_smoke` | Unchanged. Still needs live WA delivery proof from a real architect phone. |
| **S09** AppSheet Alcance_OT field type | `decision_pending` | Unchanged. Needs Irina + Jose decision. |
| **S10** Architect auto-prompt on state-4 | `decision_pending` | Unchanged. Needs Jose answers on AppSheet bot config. |
| **S11** Remove HR "pedir alcance" button | `blocked_by_s10` | Unchanged. Ships with S10. |

---

## 14. Files changed today (across 5 commits + this handoff)

| Commit | Files | Lines |
|---|---|---|
| `cccd8ab` security | 8 files | +244 / −7 |
| `6a1ceb5` classify | 3 files | +58 / −19 |
| `7ac5831` latency | 2 files | +10 / −6 |
| `e6eb46a` verifier | 1 file | +147 |
| `f2eb8a9` worker TOC | 3 files | +35 / −5 |
| `c2e20a5` dashboard TOC | 3 files | +17 / −8 |

Plus this handoff: 1 file, ~250 lines.

**Total session: 6 commits, ~20 files modified, +500 / -45 lines net (excluding the handoff doc).**

---

## 15. Why this handoff exists

Irina is moving to a new session to do the fresh WA test in a clean context. This handoff is the bridge — the next Sisyphus instance reading this should:

1. **NOT re-investigate** the 17-commit catch-up — that's in PR #10, [original analysis here](./2026-05-27-taxonomy-siso-photo-batching.md).
2. **NOT re-do the 5-agent review** — passed conditionally, blockers were security + env-example, both fixed.
3. **WAIT for Irina** to run the fresh WA test.
4. **When Irina returns with a phone number**, run [`scripts/verify-tono-session.ts <phone>`](../scripts/verify-tono-session.ts) and give the clean read.
5. **If the test surfaces a defect**, diagnose + fix on the branch (no need to merge first).
6. **When test passes**, merge PR #10 via `gh pr merge 10 --merge` (preserves the 22 commits as a coherent block) or `--squash` (collapses to one).
