# Session Handoff — Orphaned contracts + 4 test personas cleaned · FK CASCADE gap identified, V2

**Saved:** 2026-05-29 · **By:** Sisyphus orchestrator · **Status:** 🟢 Test data clean · 🟡 Root-cause FK gap deferred to v2

Continues from [`2026-05-28-tono-v1-shipped.md`](./2026-05-28-tono-v1-shipped.md). Read in order if catching up.

---

## 0. TL;DR for next session

1. 🟢 **2 orphaned contracts deleted** — TELEPORT BUSINESS (Irina's 28/5 test) + "OT de prueba- no eliminar" (earlier test). Both showed "(sin nombre)" in HR Contratos because the workers were cleaned but contracts have no FK CASCADE. Cleaned via new [`scripts/cleanup-orphaned-contratos.ts`](../../scripts/cleanup-orphaned-contratos.ts). `contratos` table is now **0 rows**.
2. 🟢 **4 test personas deleted from /hr/tecnicos** — Juan José Capacho, Jose Luis Capacho (approved by `hr:irina.andreav@gmail.com` 28/5 22:35), QA 95f0, QA 6630. Cleaned via new [`scripts/cleanup-test-personas-2026-05-29.ts`](../../scripts/cleanup-test-personas-2026-05-29.ts). Jose Luis's AppSheet row (`NOJlcb9iBv4ZY-_JZuqIC1`) deleted from `Tecnicos` table too.
3. 🟢 **All cleanup verified live against prod Supabase.** Re-run dry-runs report `Resolved 0/4` and `Total contratos in table: 0`.
4. 🟡 **Root cause identified, deferred to V2.** `contratos`, `postulaciones`, `documentos` have no FK CASCADE from `tecnicos_extended`. The old [`scripts/cleanup-tecnico.ts`](../../scripts/cleanup-tecnico.ts) leaves contratos rows + Storage files + documentos Storage files (`incoming/{phone}/*`) orphaned on every test cleanup. **User confirmed: leave fix for v2.**
5. 🟢 **2 new cleanup scripts uncommitted** in workspace (see §6). User did NOT request commit.
6. 🟢 **`npm run typecheck` clean** across all 6 workspaces.

---

## 1. What got cleaned today

### Wave 1: 2 orphaned contracts

| Contract ID | OT | Sent (UTC) | Owner | Storage | Eventos |
|---|---|---|---|---|---|
| `e9d9e41c…` | RVASjRfoFP4tmqEfoUdjB0 (TELEPORT BUSINESS) | 2026-05-28T22:37:21 | tecnico_id `e99a9273…` (Irina, deleted yesterday) | 1 draft.pdf | 2 events |
| `e9ea8902…` | xkaG046PcMKoPczqZNaJFU (OT de prueba- no eliminar) | 2026-05-28T19:48:12 | tecnico_id `46cc65e1…` (deleted earlier) | 1 draft.pdf | 2 events |

Both removed per-contract in FK-safe order: Storage `contratos/{id}/*` → `outbound_messages` by attachment_path → `eventos` by entity_id → `contratos` row. Verified `Remaining contratos rows: 0`.

### Wave 2: 4 test personas

| Persona | tecnico_id | WA phone | State | DB cruft | Storage docs | AppSheet |
|---|---|---|---|---|---|---|
| Juan José Capacho | `0f6d784b…` | `+243279866110061` | pending | 1 dossier, 2 docs, 15 turns, 6 events, 2 sessions, 19 outbound | 2 jpgs `incoming/+243279866110061/*` | — |
| Jose Luis Capacho | `ac0d14af…` | `+33887895953632` | approved | 1 dossier, 1 decision, 2 docs, 17 turns, 11 events, 2 sessions, 22 outbound | 2 jpgs `incoming/+33887895953632/*` | row `NOJlcb9iBv4ZY-_JZuqIC1` deleted |
| QA 95f0 | `95f0ad3c…` | `+5700196413681` | screening | 0 (bare row only) | — | — |
| QA 6630 | `6630645b…` | `+5700096413681` | screening | 0 (bare row only) | — | — |

All 4 verified `gone` after cascade.

---

## 2. New scripts (uncommitted in workspace)

### [`scripts/cleanup-orphaned-contratos.ts`](../../scripts/cleanup-orphaned-contratos.ts)
- **Purpose**: Reusable. Finds any `contratos` row whose `tecnico_id` no longer exists in `tecnicos_extended`. Lists Storage files + audit refs. Gated by `--confirm`.
- **Safety**: Classifies LIVE vs ORPHAN; refuses to touch LIVE contracts. If any contract has a real owner, prints `KEEP` and proceeds with the rest.
- **Cascade per orphan**: Storage `contratos/{id}/*` → `outbound_messages` LIKE `{id}/%` → `eventos` `entity_id={id}` → `contratos` row.
- **Run**:
  ```bash
  npx tsx --env-file=.env.local scripts/cleanup-orphaned-contratos.ts            # dry-run
  npx tsx --env-file=.env.local scripts/cleanup-orphaned-contratos.ts --confirm  # execute
  ```

### [`scripts/cleanup-test-personas-2026-05-29.ts`](../../scripts/cleanup-test-personas-2026-05-29.ts)
- **Purpose**: One-shot. Cleans the specific 4 personas from 2026-05-29 screenshot. Hardcoded TARGETS by phone + expected name substring.
- **Safety**: Per-target name-substring match; SAFETY ABORT on mismatch.
- **Closes 2 gaps in `cleanup-tecnico.ts`**:
  - Cleans `contratos` rows + their Storage files
  - Cleans `documentos` Storage files by reading `documentos.storage_path` (correct layout is `incoming/{phone}/{uuid}.jpg`, NOT `{tecnico_id}/*` — important for future scripts)
- **Calls AppSheet delete** when `appsheet_row_id` is present.
- **Run**:
  ```bash
  npx tsx --env-file=.env.local scripts/cleanup-test-personas-2026-05-29.ts            # dry-run
  npx tsx --env-file=.env.local scripts/cleanup-test-personas-2026-05-29.ts --confirm  # execute
  ```

Both files are `?? untracked` in `git status`. User did NOT ask to commit. Next session: either commit them as `chore(scripts): cleanup helpers — orphan contratos + 2026-05-29 personas` or leave as ad-hoc.

---

## 3. Root-cause finding (V2 backlog candidate, NOT shipped)

The reason cleanup keeps leaving orphans is a **missing FK CASCADE** on three child tables:

| Table | FK to tecnicos_extended | Cascade? | Symptom |
|---|---|---|---|
| `contratos` | text column, **no FK declared** | No | Contracts left behind → "(sin nombre)" in HR Contratos UI |
| `postulaciones` | text column, **no FK declared** | No | Should be checked next time — likely same orphan risk |
| `documentos` | text column, **no FK declared** | No | DB rows survive cascade, Storage files at `incoming/{phone}/*` always orphan |

Compared to the tables that DO have FK CASCADE and clean up automatically:
- `candidate_dossiers`, `candidate_decisions`, `hr_notes`, `ot_offers`, `qualification_calls`, `tecnico_evaluations`

**User decision (2026-05-29)**: Leave for V2. Two paths whichever session tackles it:

1. **Migration** — `ALTER TABLE contratos / postulaciones / documentos ADD CONSTRAINT … FK … ON DELETE CASCADE` + a corresponding Storage cleanup helper. Permanent fix. Risk: deleting a real worker who had a signed contract loses audit trail; might prefer SET NULL on contratos.
2. **Promote cleanup-test-personas-2026-05-29.ts logic into cleanup-tecnico.ts** — adds contratos + documentos-storage cleanup to the canonical script. Manual but safer.

Files to consult when ready: [`migrations/001_init.sql:56-67`](../../migrations/001_init.sql#L56-L67) (contratos schema), the explore agent's full surface map in this session's transcript (bg_e8c4e9e8 result).

---

## 4. Critical paths (no changes from yesterday unless noted)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **PRD stories tracker**: [`prd.json`](../../prd.json) (13 stories, S01–S13 — **unchanged from 2026-05-28**)
- **Main HEAD**: `98aefea` (PR #10 merge, 2026-05-28) — Railway auto-deploys from this
- **Current branch**: `fix/tono-reject-url-as-document-evidence` — post-merge work branch; today's 2 cleanup scripts are uncommitted here
- **Toño WA**: `+573224347117` (Railway `tono-mp`)
- **Manos WA**: `+573222392959` (Railway `manos-mp`)
- **Dashboard**: https://dashboard-mp-production-1ef3.up.railway.app
- **HR pipeline**: https://dashboard-mp-production-1ef3.up.railway.app/hr/pipeline
- **HR contratos**: https://dashboard-mp-production-1ef3.up.railway.app/hr/contratos (now Todos 0)
- **HR técnicos**: https://dashboard-mp-production-1ef3.up.railway.app/hr/tecnicos (now empty of test rows)

---

## 5. Test phones state

| Phone | Last assigned | Now |
|---|---|---|
| `+137877543452841` | Irina's 28/5 test (cleaned 28/5) | Clean (also re-tested today: row had been deleted) |
| `+243279866110061` | Juan José Capacho test | **Clean (today)** |
| `+33887895953632` | Jose Luis Capacho test | **Clean (today)** |
| `+5700196413681` | QA 95f0 | **Clean (today)** |
| `+5700096413681` | QA 6630 | **Clean (today)** |
| `+33887895953632` | (note: same phone Jose Luis Capacho was using in cleanup-test-personas-2026-05-28; he registered AGAIN on 28/5 ≈22:35 post-cleanup with a fresh tecnico_id `ac0d14af…`) | Clean (today) |

All phones above are at `sessions=0`, `outbound=0`, no `tecnicos_extended` row. Ready for re-test.

---

## 6. Decisions log (delta on prior handoffs)

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-29 | Clean 2 orphan contracts + 4 test personas immediately | User direct request; surface was clear from prior session's explore agent map + visual confirmation via dashboard screenshots |
| 2026-05-29 | Build new keyed-by-phone cleanup script rather than extending cleanup-tecnico.ts | Screenshot only gave phones (no cedulas, no UUIDs); script is ad-hoc one-shot for today's specific 4 personas; reusable pattern emerges later |
| 2026-05-29 | FK CASCADE migration deferred to V2 | User said "leave for V2" when offered. Pilot stability > schema cleanup. |
| 2026-05-29 | Did NOT commit new scripts | User asked to save handoff, not commit. Per global rule "commit only when explicitly requested." |

---

## 7. Known issues + watch-outs (unchanged from 2026-05-28 unless noted)

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | **S12** (duplicate question) ships to all workers until fixed | Medium UX | Unchanged. Workers see Toño re-asking 9-11s later. Code path proven single-emission; root cause is upstream Baileys retransmission with different `msg.key.id`. Fix sketch in prd.json. |
| 2 | **S13** (grounding noise) hides real hallucinations under false positives | Medium observability | Unchanged. Gate is log-only — no user impact yet. Becomes BLOCKING when promoting to enforce mode. |
| 3 | Most state-4 OTs (~83%) have TOC=0 → no price shown to workers | Medium-by-design | Unchanged. Watch for "cuánto paga?" — no fallback prompt. |
| 4 | classify_documento failure surface | Medium | Unchanged. Fire-and-forget; failures log warn only. |
| 5 | `data->>Titulo` returns "undefined" for all OTs in probe | Low | Unchanged. Cosmetic. |
| 6 | **NEW**: FK CASCADE missing on `contratos`, `postulaciones`, `documentos` | Low operational | Manual cleanup needed for every test session until V2. Two new scripts cover the pattern. |
| 7 | **NEW**: documentos Storage layout is `incoming/{phone}/*` not `{tecnico_id}/*` | Info | Important when writing future cleanup scripts. The naive `{tecnico_id}/*` `.list()` returns empty even when files exist. |

---

## 8. Why this handoff exists

Irina is moving to a new session in a fresh context. This handoff is the bridge — the next Sisyphus instance reading this should:

1. **NOT re-run any cleanup** — `contratos`=0, 4 test personas gone, prod state matches user's expectation as of 2026-05-29.
2. **READ this handoff first** if asked about test personas, orphan contracts, or FK cascade gaps.
3. **DO NOT speculate** that S08/S09/S10/S11 changed — they didn't this session. Same status as 2026-05-28-tono-v1-shipped.md.
4. **TWO uncommitted scripts in workspace** — `cleanup-orphaned-contratos.ts` + `cleanup-test-personas-2026-05-29.ts`. Decision to commit deferred to user.
5. **WHEN tackling S12** (duplicate-question dedup) — same fix sketch as before in prd.json#S12. Re-test on `+137877543452841` (clean).
6. **WHEN tackling S13** (grounding whitelist) — same fix sketch as before in prd.json#S13.
7. **WHEN test cleanup happens again** — use [`cleanup-test-personas-2026-05-29.ts`](../../scripts/cleanup-test-personas-2026-05-29.ts) as the new pattern (closes contratos + documentos-storage gaps). Or just adopt it into `cleanup-tecnico.ts` permanently (low-priority v2 task).
8. **WHEN considering FK migration** — see §3 above for trade-offs. User explicitly deferred this to V2.

---

**Test data clean. Pilot ready for next iteration.**
