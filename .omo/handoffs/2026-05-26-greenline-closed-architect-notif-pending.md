# Session Handoff — Green-line CLOSED + Architect Notif Story Locked

**Saved:** 2026-05-26 ~23:30 PT · **By:** Sisyphus orchestrator · **Status:** v1 happy-path proven in real WA; 3 stories blocked on Irina/Jose input

This handoff is a **delta** on [`2026-05-26-s08-code-complete-gated-on-irina.md`](./2026-05-26-s08-code-complete-gated-on-irina.md) and [`2026-05-25-sonnet-architecture-alcance.md`](./2026-05-25-sonnet-architecture-alcance.md). Read those for architecture context. Everything in the prior architecture-locked decisions still holds.

---

## 0. TL;DR for tomorrow

0. **🚀 PRODUCTION SHIPPED + VERIFIED 2026-05-26.** Marketplace v1 is LIVE for HR. URL: https://dashboard-mp-production-1ef3.up.railway.app · Toño WA: +14157916801.
   - **Deploy:** Toño deployed via `railway up --service tono-mp` from local working tree (~06:55 UTC). `TONO_MODEL=claude-sonnet-4-5` set on Railway before deploy. `Toño is online \| number_env=+14157916801` at 06:55:03 UTC confirmed in `railway logs --service tono-mp`. Sync-mp + dashboard-mp were already running; not redeployed.
   - **Auth verified:** Supabase Auth `site_url` + `uri_allow_list` correct for prod URL. `irina.andreav@gmail.com` confirmed account, last sign-in 2026-05-25 20:36 UTC. Magic-link path works.
   - **End-to-end verified by Irina post-deploy:** prod dashboard reachable, prod Toño responsive on +14157916801, full HR flow exercisable. v1 thin loop = SHIPPABLE TO REAL USERS.
   - **Manos-mp NOT redeployed** — still pre-S08 code. Separate ship gated on S08 live smoke.
1. **🟢 Green-line v1 CLOSED in real WhatsApp.** Camilo4 conversation (`data/test-results/May25-camilo4-tono/_chat.txt`) shows full happy-path: hola → list 2 OTs → "el primera" → preselect → alcance PDF → "acepto" → contract PDF. Marketplace v1 thin loop proven end-to-end with Sonnet 4.5.
2. **S08 (Manos architect feedback) — code complete + DB-smoke green.** Still owes one live WA smoke from a real architect phone. Status in prd.json: `code_complete_pending_live_smoke`.
3. **S09 (AppSheet Alcance_OT field type) — still pending.** Decision needs Irina + ideally Jose.
4. **NEW S10 (architect auto-prompt on state-4 transition).** Replaces the "HR clicks button" workaround with a system-owned trigger. Two paths documented (real-time AppSheet webhook vs daily Bogota cron). Path choice depends on Jose's answers to 3 questions in PRD §9.9.
5. **NEW S11 (delete HR nudge-architect button).** Blocked by S10. Confirmed visible bug today: button shows on OTs with ✓ alcance + sent contract (pipeline/page.tsx:436 hardcodes `showNudgeButton=true`).
6. **Production dashboard is LIVE**: https://dashboard-mp-production-1ef3.up.railway.app — HTTP 200 verified this session.
7. **Production Toño is STOPPED** (per prior handoff §5 — unverified today, needs confirmation before sharing dashboard URL with HR).

---

## 1. What got LOCKED this session

### 1.1 Green-line v1 closed (Camilo4)

Real WA conversation evidence at `/Users/irina/AI-driven-OS/autonomous/redin/marketplace/data/test-results/May25-camilo4-tono/`:
- `_chat.txt` — full thread, 5/25/26 23:11-23:15 UTC
- `00000007-Alcance_OT_Ht6UBQ8N.pdf` — alcance PDF delivered to worker on Preseleccionar (Gap A)
- `00000011-contrato-7d8fc0f7.pdf` — contract PDF delivered on Generar contrato

Flow verified in production Sonnet + Supabase:
1. ✅ Camilo: "Hola" → Toño: lists 2 Yopal OTs
2. ✅ Camilo: "el primera" → Toño: "quedaste postulado" + creates postulación
3. ✅ HR Preseleccionar → text + PDF delivered (Gap A — already-shipped path)
4. ✅ Camilo: "Acepto" → pre-LLM short-circuit confirms
5. ✅ HR Generar contrato → contract PDF delivered

**Marketplace v1 thin loop = SHIPPABLE.** The remaining stories below are refinements on top of a working baseline.

### 1.2 S08 — code complete, DB-smoke green

Files (uncommitted):
- [`tools/src/manos/finalize-alcance.ts`](../../tools/src/manos/finalize-alcance.ts) +143 lines (`enqueueArchitectAlcancePreview` helper)
- [`manos/src/prompts/manos-system.ts`](../../manos/src/prompts/manos-system.ts) +10 lines (Después de finalize_alcance section)
- [`scripts/smoke-s08-finalize-preview.ts`](../../scripts/smoke-s08-finalize-preview.ts) — reusable regression smoke

DB-smoke evidence in prior handoff §1.2 + prd.json S08 `progress_2026_05_26.db_layer_smoke`. Live WA smoke still owed (BLOCKED — see §3 below).

### 1.3 S10 + S11 — new stories captured

Architect-notification refactor:
- **S10**: Auto-prompt on state-4 OT transition. Two paths documented in PRD §9.9 + prd.json. Webhook preferred, cron is fallback.
- **S11**: Kill HR `NudgeArchitectButton` + API route + pipeline page usages. Blocked by S10.

Reasoning captured in PRD.md §9.9 (architecture decision) + prd.json S10 acceptance criteria (implementation detail).

---

## 2. Open questions FOR JOSE (needed before S10 path is picked)

Lift these verbatim into your next conversation with Jose:

1. **Does your AppSheet plan support Bots / Automation?** This is a paid feature (Core plan and above). If yes → we ship the real-time webhook. If no → we ship a daily Bogota-time cron in our sync workspace.

2. **Who flips an OT's `Estado` to "4. Coordinar – Listo para ejecutar" today?** Your ops team manually, an architect, or an existing AppSheet automation? Knowing the trigger source matters for testing — we want to verify the bot fires correctly the first time it's exercised.

3. **Are you available to add one bot in your AppSheet editor (~10 min one-time setup)?** Steps would be: Bots → New Bot → Event = data change on `Ordenes_Trabajo` with condition `[Estado] starts with "4."` → Task = Call a webhook → URL `https://dashboard-mp-production-1ef3.up.railway.app/api/appsheet-hooks/ot-state-4` (endpoint not built yet) + HMAC header. We'd supply the shared secret + exact format.

**If 1 = no OR 3 = no → fallback path (daily cron) ships. Nothing about your AppSheet changes.**

---

## 3. Open questions FOR IRINA (blocking implementation work)

1. **S08 live WA smoke** — three options:
   - **A.** Stop Railway `manos-mp` → restart local Manos → smoke from a real architect phone (Cristian Capacho, Jose Luis Capacho, etc.). Real delivery to real architect = use the TEST OT `LK4cgHD0DlytRsCBwx8zKZ` to keep it harmless.
   - **B.** Deploy S08 to Railway directly via `railway up --service manos-mp`, smoke on prod Manos. Reuses the deploy mechanism that worked for tono-mp tonight.
   - **C.** Skip live smoke — trust code+DB+pattern-reuse evidence. Move on.

2. **S09 Alcance_OT field type** — Option A (durable link via dashboard route) vs Option B (PDF base64 upload). Recommendation in prior handoff §6 Track B.1 is Option A. Needs your call (ideally with Jose because UX impact on his AppSheet).

3. ~~**Deploy current state of Toño/dashboard to share with HR**~~ — ✅ **DONE 2026-05-26.** Tono-mp deployed via `railway up` from local working tree. Verified in prod by Irina.

---

## 4. Deploy / publish for HR — ✅ DONE this session

User said "ship today, not tomorrow". We did. Final state:

| Service | Railway URL | Status |
|---|---|---|
| dashboard-mp | https://dashboard-mp-production-1ef3.up.railway.app | ✅ Live (running pre-existing deploy from ~5/22) |
| tono-mp | https://tono-mp-production.up.railway.app | ✅ **Deployed tonight via `railway up`** — Sonnet 4.5, Toño is online @ 06:55:03 UTC |
| sync-mp | https://sync-mp-production.up.railway.app | ✅ Live, healthy 15-min cron (verified) |
| manos-mp | https://manos-mp-production.up.railway.app | ⚠️ Live but **pre-S08 code** (separate ship gated on S08 live smoke) |

**Deploy mechanism used**: `railway up --service tono-mp --detach` — packages local working tree as a tarball (respects `.gitignore` so `.env.local`, `node_modules`, `**/data/baileys_*` excluded) and uploads to Railway. Build runs remotely (~90s), new container starts. Persistent /data volume held the Baileys auth files so WA session resumed without QR re-pair.

**⚠️ CRITICAL — code-in-prod is NOT in git history**: tono-mp's deployed code is the local working tree as of 2026-05-26 06:53 UTC, which includes ~30 uncommitted files (Sonnet swap, S08 work in tools/, prompt fixes, identity-gate, grounding-gate, approval-push-replies, etc.) on top of the `fix/tono-reject-url-as-document-evidence` branch at commit `b3f4cfa`. **If we need to roll back, "rolling back to main" deploys an OLDER, WORSE Toño** (main doesn't have Sonnet swap, doesn't have green-line refinements). Roll-forward instead: re-run `railway up --service tono-mp` from a known-good working tree.

**Followup TODO (any future session)**: review the uncommitted work, commit to `main` in logical batches so git history reflects what's actually live in prod. NOT urgent — production works. But the audit gap matters for any future "what version is deployed" question.

**Auth verified**: Supabase Auth `site_url` + `uri_allow_list` correctly include the production URL. Magic-link enabled. Irina's `irina.andreav@gmail.com` already a confirmed user (3 total: irina, jose.capacho@redin.com.co, crislogarrido16@gmail.com). HR sign-in works.

**Local dev still running** (will 440-loop on WA since prod owns the session). Cleanup whenever:
```bash
pkill -f "tono.*runner"
# Local sync + dashboard can keep running, don't conflict with prod
```

---

## 5. Action plan for tomorrow's session (priority order)

### Step 1 — Coordinate with Jose (15 min, async)

Send Jose the 3 questions from §2 above. Continue with other work while waiting on his reply. His answers determine S10's path.

### Step 2 — Pick the easiest unblock

While waiting on Jose, in priority order:

~~**a. Toño/dashboard deploy for HR.**~~ ✅ DONE 2026-05-26. See §4.

**a. Commit the uncommitted prod work to git** (~30 min, see §4 audit-gap note). Optional but real: the deployed Toño code isn't in git history. Reviewing + committing the ~30 dirty files in logical batches (Sonnet swap, identity-gate, grounding-gate, approval-push-replies, Gap A.7 dashboard, S08, etc.) closes the audit gap. Skip if not blocking — production works regardless.

**b. S08 live WA smoke + commit.** Easiest path now: `railway up --service manos-mp` to deploy S08 to prod Manos (same mechanism as tono-mp tonight), then smoke from a real architect phone against TEST OT `LK4cgHD0DlytRsCBwx8zKZ`. 5-10 min. Mark S08 done in prd.json.

**c. S09 decision + ship.** Pick Option A vs B. Implement projector change. Re-queue 3 OTs. Verify in AppSheet UI. Separate commit.

### Step 3 — After Jose responds: ship S10 + S11

- If Jose answers YES to webhook path: build `dashboard/src/app/api/appsheet-hooks/ot-state-4/route.ts` + migration 017 for `scheduled_at` + drainer gate.
- If Jose answers NO: build `sync/src/architect-daily-prompt.ts` + cron in `sync/src/runner.ts` + migration 017.
- Either way: dry-run smoke first, eyeball architect list + messages, then live.
- Same commit as S11 (delete HR button + API + pipeline usages).

---

## 6. Files modified TODAY (uncommitted)

```
M tools/src/manos/finalize-alcance.ts                                   # S08
M manos/src/prompts/manos-system.ts                                      # S08
M prd.json                                                               # S08 progress + S10 + S11 added
M /Users/irina/AI-driven-OS/autonomous/redin/PRD.md                      # §9.9 added
A scripts/smoke-s08-finalize-preview.ts                                  # S08 regression smoke
A .omo/handoffs/2026-05-26-s08-code-complete-gated-on-irina.md           # prior handoff
A .omo/handoffs/2026-05-26-greenline-closed-architect-notif-pending.md   # this file
```

NOT touched (pre-existing uncommitted work from prior sessions):
- ~30 modified files in dashboard/, tono/, manos/, sync/, tools/, shared/
- ~15 untracked files (scripts/, migrations/015-016, .omo/, .playwright-mcp/, qa-*.png)
- Per "NEVER REVERT WORK YOU DID NOT MAKE", left strictly alone.

---

## 7. Hard Don'ts (carry-over + reaffirmed)

All prior handoff §8 entries still active. Reaffirmed this session:

- **No unilateral S09 decision.** Hard Don't — needs Irina + Jose.
- **No unilateral S10 path choice.** Same — waits on Jose's 3 answers.
- **No commits without explicit ask.** Today's work staged but uncommitted.
- **No `as any` / `@ts-ignore`** — typecheck stayed clean without escape hatches.
- **No deploy to Railway without explicit go.** Even though we have permission to do it tomorrow, every step (commit, push, service restart) needs the user's confirmation, not just an initial yes.
- **HR is observability only for alcance status.** Encoded in §9.9. Future agents: do NOT add HR-side action buttons for alcance flows.

---

## 8. Decisions log (delta on prior handoff §10)

| Date | Decision | Lock-in |
|---|---|---|
| 2026-05-26 | **Green-line v1 marketplace closed in real WA** — Camilo4 conversation evidence. Sonnet 4.5 in production posture. | Empirical |
| 2026-05-26 | **Architect notification is system-owned, not HR-owned.** HR dashboard is observability for alcance status (✓ pill). Trigger lives in AppSheet state transition (webhook) or daily Bogota cron (fallback). | Architectural — encoded in PRD §9.9 |
| 2026-05-26 | **Path A (real-time AppSheet webhook) preferred over Path B (daily cron)** — pending Jose's 3 answers on plan/availability. Off-hours risk mitigated via `scheduled_at` column + drainer time-window gate. | Architectural pref, decision_pending |
| 2026-05-26 | **HR `pedir alcance al arquitecto` button is deprecated** — to be deleted in S11 once S10 ships. Bug confirmed: button shows on OTs with ✓ alcance + sent contract (pipeline/page.tsx:436). | Cleanup queued, blocked by S10 |
| 2026-05-26 | **S08 verification bar = code+typecheck+DB-smoke+pattern-reuse evidence MINIMUM, live WA smoke OWED** — Irina to decide between Option A/B/C in §3 | Quality bar |
| 2026-05-26 | **`outbound_messages.scheduled_at` column to be added in migration 017** as part of S10 (any path). Enables humane delivery windows for all future scheduled outbound. | Schema |

---

## 9. Critical paths (for fresh context)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md` (§7 Writeback Exceptions, §9.8 Alcance creation, **§9.9 Architect prompt on state-4 transition** — added today)
- **prd.json**: `/Users/irina/AI-driven-OS/autonomous/redin/marketplace/prd.json` (9 stories — S08 code-complete, S09 + S10 decision_pending, S11 blocked_by_s10)
- **Live dashboard**: https://dashboard-mp-production-1ef3.up.railway.app
- **Test results**: `data/test-results/May25-camilo4-tono/` (green-line evidence)
- **Architecture context**: `.omo/handoffs/2026-05-25-sonnet-architecture-alcance.md` (still authoritative)
- **S08 progress detail**: `.omo/handoffs/2026-05-26-s08-code-complete-gated-on-irina.md`

---

## 10. Note on session focus tomorrow

Three threads compete:
- **Ship for users** (deploy to Railway) — highest immediate value
- **Close S08** (live smoke + commit) — close-out work
- **Architect notif** (S10 + S11) — gated on Jose's reply

Recommend: kick off Jose-coordination first (async), then deploy while waiting, then close S08, then S09, then S10+S11 once Jose responds. Don't try to interleave too many threads in one focused work block.
