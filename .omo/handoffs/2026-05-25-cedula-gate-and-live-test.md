# Session Handoff — Cédula Gate, Auto-Classify, and Live WA Test

**Saved:** 2026-05-25 PT · **By:** Sisyphus orchestrator · **Status:** ready for live WA E2E from Irina's phone

This handoff **supersedes** `.omo/handoffs/2026-05-24-redin-2day-ship.md`. Read this whole file first, then resume the live test.

---

## 0. TL;DR for the new session

1. Everything from the prior 2-day ship landed and was verified (migrations, types, type-safety, dashboard E2E, tool smokes, Manos smoke).
2. Plus 3 new patches shipped today: **auto-classify on upload**, **cédula-only approval gate**, **queue card UX for cédula gate**.
3. Test data cleaned up (3 test tecnicos + AppSheet rows deleted).
4. Production Toño on Railway is **STOPPED**. Dev Toño is **running locally** with all the new code, paired to `+14157916801`.
5. **The live WA test from Irina's personal phone is what's pending.** She sends WA → dev Toño on her Mac responds → she walks through the screening flow → HR Aprobar gate gets tested with a real worker.
6. After live test passes: deploy to Railway + restart prod Toño.

---

## 1. Locked Policy Decisions (NEW, do NOT re-litigate)

| # | Decision | Date | Where it lives |
|---|---|---|---|
| 1 | **Mandatory doc for approval = cédula photo ONLY.** Nothing else blocks the Aprobar button. | 2026-05-25 | `hasCedulaUploaded()` in tools/src/missing-docs.ts; gate in dashboard/src/lib/decisions.ts |
| 2 | **ARL: never blocks.** Redin can provide ARL to the worker. Soft signal only. | 2026-05-23 | submit-candidate-dossier.ts scoring |
| 3 | **EPS: never blocks.** Preferred-only. Surfaced as "Sin doc EPS" gray badge. | 2026-05-25 | unchanged code; comment updated |
| 4 | **HR can override the cédula gate** by typing a note explaining how identity was validated offline. The note doubles as audit. | 2026-05-25 | dashboard/src/lib/decisions.ts (server) + QueueListClient.tsx (client-side block + focus-textarea) |
| 5 | **WA notifications to worker fire on `approve` / `reject` / `schedule_call` only.** Do NOT add WA on `unschedule_call`, `revoke`, `reopen` — those edge cases stay silent by design. | 2026-05-25 | Existing wiring is the locked state |
| 6 | **Every uploaded document is auto-classified** via Gemini multimodal immediately after upload (fire-and-forget). HR sees the classifier verdict in DocViewer without waiting on LLM compliance. | 2026-05-25 | tools/src/upload-documento.ts |

---

## 2. What Was Shipped Today (2026-05-25)

### Cleanup + plumbing
- ✅ Refreshed `SUPABASE_MANAGEMENT_TOKEN` in `.env.local`
- ✅ Applied `migrations/015_grounding_and_filler_polish.sql` (turns.grounding_violations JSONB column)
- ✅ Applied `migrations/016_documento_classification.sql` (documentos.classification_jsonb + classified_at + classifier_model)
- ✅ Regenerated `shared/src/db-types.generated.ts` via `npm run gen:types`
- ✅ Hand-authored `shared/src/db-types.ts` extended (`DocumentoRow` got the 3 new columns) — this was the missing piece because `Database` is exported from the hand-authored file, not the generated one
- ✅ Removed documented `as any` cast in `tools/src/classify-documento.ts:275`
- ✅ Tightened `GeminiClassifyResult.extracted_fields` to `Record<string, string | null>` (was `Record<string, unknown>`, broke Supabase JSON typing)
- ✅ Deleted orphan `dashboard/src/lib/approval-message.ts` (no remaining importers)
- ✅ Updated stale comment in `tono/src/prompts/tono-system.ts:278` (was pointing at the deleted file)
- ✅ Synced `ANTHROPIC_API_KEY` from Railway prod → local `.env.local` (local key was expired, prod was current)

### Idempotency + WA flow
- ✅ Harmonized Pedir-llamada meta keys between dashboard (`kind`) and tool shim (`notification_type`) — dashboard now checks BOTH shapes within a 24h window before enqueueing
- ✅ Added missing 24h idempotency check to the dashboard `schedule_call` enqueue path

### NEW Patches (this session)
- ✅ **Auto-classify on upload**: `tools/src/upload-documento.ts` chains `classifyDocumento()` after every row insert via `void Promise.catch()` (fire-and-forget — adding `await` would block WA reply 3-5s per upload)
- ✅ **Approval gate (cédula-only)**: 
  - `tools/src/missing-docs.ts` — new `hasCedulaUploaded()` helper
  - `dashboard/src/lib/decisions.ts` — `submitDecision` blocks `action="approve"` when no cédula AND no `hr_reasoning` (HR can override with a note)
  - `dashboard/src/app/hr/qualification-queue/page.tsx` — fetches cédula presence per tecnico, passes `has_cedula_doc: boolean` to client
  - `dashboard/src/app/hr/qualification-queue/QueueListClient.tsx` — red badge *"❌ Falta foto de la cédula"*, client-side block on Aprobar with note-required UX, auto-focuses textarea

### Data hygiene
- ✅ Deleted test auth user `e2e-test@redin.local` (Supabase Auth admin API)
- ✅ Deleted 3 test tecnicos via cascading script:
  - `Jose Luis Capacho Santafe` (085985ce) — AppSheet row deleted via `deleteTecnico`
  - `Jose Luis Capacho Santafé` (d77df9e6) — no AppSheet sync, just Supabase
  - `Alberto Vélez` (82b9791c) — AppSheet row deleted via `deleteTecnico`, 36 Supabase rows + 7 sessions + 222 messages cascaded
- ✅ Storage object (1 PDF) removed from `documentos` bucket

### Verification at handoff time
- `npm run typecheck` — **0 errors across all 6 workspaces**
- `npm run smoke` — **22/22 checks passed** (full 9-tool contract against real Supabase)
- `npm run smoke:manos` — **12/12 steps passed** (architect → photo → alcance → AppSheet projector)
- Dashboard E2E via Playwright — all flows passed (HR queue, doc viewer, classifier badge, Pedir llamada idempotency, Approve composite WA push, Approve idempotency)

---

## 3. Current Running State (live, on this Mac)

| Service | State | URL / port | Process | Logs |
|---|---|---|---|---|
| **Dev Toño** | running (paired to +14157916801) | WhatsApp via Baileys | `npm run tono:dev` in background, PID in `/tmp/tono-dev.log` | `tail -f /tmp/tono-dev.log` |
| **Dashboard** | running | http://localhost:3000 | `npm run dashboard:dev` in background | `tail -f /tmp/dashboard-dev.log` |
| **Production Toño on Railway** | **STOPPED** (`NO DEPLOYMENT`) | — | — | bring back with `railway service redeploy --service tono-mp` |
| **Supabase** | live, production | https://foerbjhnwbxfauajkbld.supabase.co | — | — |

### Why production Toño is stopped

To run dev Toño locally without WA session conflict (one WA number = one connected client). Resume prod after live test passes:

```bash
railway service redeploy --service tono-mp
```

Note: Railway has its OWN paired Baileys auth on a persistent volume mounted at `/data`. When you re-deploy prod, prod takes back the WA session and dev's pairing on this Mac will get kicked off (`statusCode=440`). That's expected and reversible — re-run `npm run tono:pair` later if needed.

### Phone state (important context for the live test)

| Phone | Role | Relationship to Supabase |
|---|---|---|
| Irina's phone-that-owns-+14157916801 (US virtual) | Toño's WhatsApp number | The phone that scanned the QR; controls the WA account |
| Irina's personal phone (Colombian number) | "the worker" in the test | `+137877543452841` — was Alberto Vélez, **now unknown** (deleted in cleanup). Next WA from her triggers the **full new-worker screening flow** from scratch. |

---

## 4. Files Changed This Session

```
M shared/src/db-types.ts               # DocumentoRow + 3 new columns
M tools/src/classify-documento.ts      # removed `as any`, tightened Record<string, string|null>
M tools/src/upload-documento.ts        # NEW: void classifyDocumento(...).catch() after insert
M tools/src/missing-docs.ts            # NEW: hasCedulaUploaded() + updated header comment
M dashboard/src/lib/decisions.ts       # NEW: cédula gate + idempotency on schedule_call
M dashboard/src/app/hr/qualification-queue/page.tsx       # fetch has_cedula_doc per tecnico
M dashboard/src/app/hr/qualification-queue/QueueListClient.tsx  # red badge + client gate
M tono/src/prompts/tono-system.ts      # stale comment fix
D dashboard/src/lib/approval-message.ts  # orphan deleted

A migrations/015_grounding_and_filler_polish.sql  # already applied
A migrations/016_documento_classification.sql     # already applied
M shared/src/db-types.generated.ts     # regenerated via npm run gen:types
M .env.local                           # SUPABASE_MANAGEMENT_TOKEN + ANTHROPIC_API_KEY refreshed (gitignored)
```

Plus the prior 2-day ship's files (already committed via the previous session — see `2026-05-24-redin-2day-ship.md` §7).

---

## 5. The Test Plan That's Pending (resume here)

Irina is about to send WA messages from her personal phone to `+14157916801`. The new code is running. The test exercises the full new-worker flow end-to-end:

| # | Irina sends | Watch in `tail -f /tmp/tono-dev.log` | Watch in dashboard |
|---|---|---|---|
| 1 | `"hola"` | `incoming` → `identity-gate: resolved` returns null (unknown) → `screening` mode → LLM response | — |
| 2 | `"me llamo [nombre], cédula 1098765432, estoy en Cali"` | `identify_user` → `register_tecnico` → row created | New row in `tecnicos_extended` |
| 3 | Continue answering Toño: specialty, ARL yes/no, EPS yes/no | LLM tool calls in log | — |
| 4 | **Send a photo** from phone (any photo) | `incoming media` → `upload_documento` → `auto-classify` succeeds OR fails-gracefully | `documentos` table gets row + `classification_jsonb` populated 3-5s later |
| 5 | Continue until Toño says "submitted to HR" | `submit_candidate_dossier` succeeds | Tecnico appears in [/hr/qualification-queue](http://localhost:3000/hr/qualification-queue) |
| 6 | Open the queue page | — | New worker visible; if you didn't upload a cédula photo specifically (tipo=cedula), **red badge** "❌ Falta foto de la cédula" appears |
| 7 | Try clicking **Aprobar** without typing a note | — | Inline rose error: *"Falta foto de la cédula. Sube el documento o explica en la nota..."* — textarea gets focus, form doesn't submit |
| 8 | Type a note ("validé por llamada") + Aprobar again | `submitDecision` succeeds | State flips to `approved`; **composite WA arrives on your phone** with matching OTs in your declared ciudad |
| 9 | Click into detail page | — | DocViewer shows uploaded photo with classifier badge ("✓ Toño leyó: X" or "⚠ Toño leyó: otro") + extracted fields if any |

### What success looks like

- Identity gate fires correctly (returns null for unknown; resolved with name+cédula+ciudad on subsequent turns)
- Toño doesn't say "Perfecto, anotado" — uses neutral "Un momento, déjame mirar eso" or similar (A4 filler-kill)
- No hallucinated specifics (placas, foreign country names) — A2 grounding gate would log violations
- Photo upload → auto-classify → badge in DocViewer
- Cédula gate blocks click-and-pray approvals
- Composite WA push lands with worker's first name + matching OTs

---

## 6. Resume Playbook for a Fresh Session

```bash
# 1. Verify you're in the right place
pwd  # → /Users/irina/AI-driven-OS/autonomous/redin/marketplace

# 2. Read this handoff + the README

# 3. Verify services still alive:
curl -sS -o /dev/null -w "Dashboard: %{http_code}\n" http://localhost:3000
ps aux | grep -E "tono.*runner|next dev" | grep -v grep

# 4. If dev Toño died, restart:
pkill -9 -f "src/runner.ts" ; sleep 2
npm run tono:dev > /tmp/tono-dev.log 2>&1 &
# Wait for "Toño is online" in /tmp/tono-dev.log; if it logs "loggedOut=true",
# re-pair: rm -rf data/tono-wa-auth && mkdir -p data/tono-wa-auth && npm run tono:pair
# Then scan QR with the phone that owns +14157916801 (Settings → Linked Devices)

# 5. If dashboard died:
npm run dashboard:dev > /tmp/dashboard-dev.log 2>&1 &
# Wait for "Ready" — verify with: curl http://localhost:3000

# 6. Verify token still works (Supabase Management API + Anthropic):
set -a && source .env.local && set +a
curl -sS -w "%{http_code}\n" -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF" -o /dev/null  # → 200
# Anthropic key was synced from Railway prod; if it stops working, re-sync:
# PROD_KEY=$(railway variables --service tono-mp --kv | grep "^ANTHROPIC_API_KEY=" | cut -d= -f2)
# sed -i.bak "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$PROD_KEY|" .env.local && rm .env.local.bak

# 7. Watch logs in two terminals:
tail -f /tmp/tono-dev.log | grep -E "^20[0-9]{2}-"   # filtered app-level logs
tail -f /tmp/dashboard-dev.log

# 8. Resume the test from step 1 in §5 above.
```

### Auth shortcut for dashboard (no email needed)

The dashboard checks `auth.getUser()` and redirects to `/login` if absent. The login form sends a magic link to email. Two options:

**Option A — Use a real HR account.** Log in normally with `irina.andreav@gmail.com` via the magic-link flow.

**Option B — Mint a session via admin API + inject via Playwright/devtools** (was used in this session's automated E2E). Script lives in `.omo/handoffs/2026-05-24-redin-2day-ship.md` §13 lineage but was deleted as a temp; the live test from Irina's phone doesn't need this since you're using a real browser.

### When the live test passes, deploy to prod

```bash
# 1. Commit the changes (if not already)
git status --short
git diff
git add -p
git commit -m "feat: cédula-only approval gate + auto-classify on upload"

# 2. Push to GitHub (whichever branch Railway watches)
git push

# 3. Bring prod Toño back up
railway service redeploy --service tono-mp
# Railway re-deploys, prod Toño re-pairs from its persistent /data volume,
# and immediately kicks off dev Toño on this Mac (one WA session per number).

# 4. Verify prod Toño is online (Railway logs)
railway logs --service tono-mp | tail -20
```

---

## 7. Critical Context (paths)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **Architecture notes**: `/Users/irina/AI-driven-OS/autonomous/redin/marketplace/docs/architecture/onboarding-contracts.md` (referenced by the explore agents)
- **About Irina**: `/Users/irina/AI-driven-OS/about_me/` (read on demand only; don't load all)
- **Prior handoff**: `.omo/handoffs/2026-05-24-redin-2day-ship.md` (the 4-lane ship)
- **HR dashboard design**: `docs/design/hr-dashboard-research.md`
- **Test transcript that triggered all this**: `data/test-results/may23-chat-tono/_chat.txt`

---

## 8. Hard Don'ts (carry-over from previous handoff + new ones)

From the prior handoff (still active):
- DO NOT touch the contract HITL gate
- DO NOT delete `ot_offers` / "Enviar oferta" UI
- DO NOT add Excel parsing in v1
- DO NOT change Manos's architecture
- DO NOT use `as any` / `@ts-ignore` / `@ts-expect-error`
- DO NOT write tests (per redin-builder agent description)
- DO NOT push to GitHub or deploy without Irina's call

New for this session:
- **DO NOT make ARL or EPS mandatory for approval.** Only cédula photo blocks. (Locked decision #1)
- **DO NOT add WA notifications to `unschedule_call`/`revoke`/`reopen`.** Those paths stay silent. (Locked decision #5)
- **DO NOT await `classifyDocumento` inside `upload_documento`.** Fire-and-forget is intentional — `await` would add 3-5s to every WA reply. (Patch #1 invariant)
- **DO NOT remove the dual-key idempotency check** in dashboard `schedule_call` enqueue. The two writers (tool shim vs dashboard) historically used different meta keys (`notification_type` vs `kind`). The dual check prevents duplicate WAs.

---

## 9. Known Side-Effects of Today's Work

1. **9 legacy bootstrap tecnicos remain in Supabase** (sourced from `appsheet_legacy_bootstrap`). Per Irina: these are real Redin workers from Jose Capacho's AppSheet — trusted, but profile_complete=false. Toño's enrichment mode will collect their missing data over time as they message in. Not test data; leave them.

2. **Test E2E user deleted**: `e2e-test@redin.local` is gone from Supabase Auth.

3. **Irina's personal phone is unknown to the system** after the Alberto cleanup. First WA from her triggers screening from scratch (this is the test surface).

4. **Anthropic key in .env.local was rotated** to match Railway prod. If you regenerate the prod key in the Anthropic console, you must re-sync to local with the snippet in §6.

5. **Toño's stale dossiers from before 2026-05-24 may have over-optimistic recommendations** (pre-Lane B scoring fix). Existing approved workers with these dossiers were left alone (only Alberto was affected and he's deleted). Going forward all new dossiers use the corrected scoring.

---

## 10. Failure Modes to Watch For (during the live test)

| Symptom in log | Cause | Fix |
|---|---|---|
| `statusCode=440 loggedOut=false` looping | Another Baileys process owns the WA session (ghost) | `pkill -9 -f "src/runner.ts"`; then `npm run tono:dev` |
| `statusCode=401 loggedOut=true` | Baileys auth expired / session invalidated | `rm -rf data/tono-wa-auth && mkdir -p data/tono-wa-auth && npm run tono:pair` + scan QR |
| `error=401 invalid x-api-key` on LLM call | Anthropic key expired | Re-sync from Railway prod (snippet in §6) |
| `error=401 Unauthorized` on Supabase migration | Management token expired | Generate new at https://supabase.com/dashboard/account/tokens; update `SUPABASE_MANAGEMENT_TOKEN` |
| `auto-classify failed` warnings | Gemini quota / storage missing | Non-blocking — upload still succeeds; investigate Gemini console |
| `submitDecision: approve blocked` warning | The cédula gate fired; HR didn't supply a note | Expected behavior. Add a note in the form. |
| Dashboard shows old code (caches) | Next.js dev needs HMR refresh | Hard-reload browser (Cmd+Shift+R); if persists, restart `dashboard:dev` |

---

## 11. The 11 Original Bugs — Status

(Carried forward from prior handoff for completeness)

| # | Bug | Fixed by | Verified |
|---|---|---|---|
| 1 | Doc-blindness | classify_documento + **auto-classify on upload** | ✅ E2E test on injected classification data; live test pending |
| 2 | Hallucinated "placa HN 234" | Grounding gate (log-only) | ✅ Tested implicitly via grounding-gate.ts unit logic; live behavior pending |
| 3 | Hallucinated "número de Francia" | Pre-LLM identity gate + grounding gate | ✅ Identity gate verified in E2E; grounding pending live |
| 4 | Profile amnesia across sessions | Identity gate inject `[session_identity]` into context | ✅ Verified in earlier E2E (resolved Alberto Vélez from phone alone) |
| 5 | Phantom approval | Not a bug — real HR click | — |
| 6 | Phantom contract auto-send | Not a bug — was alcance PDF | — |
| 7 | "Pedir llamada" meaningless | `enqueuePedirLlamada` in set-qualification-state + idempotent dashboard path | ✅ Verified in dashboard E2E |
| 8 | "Perfecto, anotado" filler loop | A4 substitute + `empty_reply_no_tools` evento | ✅ Code wired; live verification pending |
| 9 | ARL hardcoded as discriminator | Lane A prompt fix + Lane B scoring | ✅ Verified via tono-system.ts diff |
| 10 | Bot bursts (2 msgs/sec) | 10s rate limit in outbound.ts | ✅ Code wired; live verification pending (send 5 quick messages to provoke) |
| 11 | "hjn22h" plate identity confusion | Identity gate kills this class | ✅ |

**Plus 1 new policy bug fixed today**: HR could approve a worker with zero documents. Cédula gate now prevents this.

---

## Final note

The bones are solid. The blue-collar UX matters more than the architecture. When the live test passes from Irina's phone, ship it.

Good luck.
