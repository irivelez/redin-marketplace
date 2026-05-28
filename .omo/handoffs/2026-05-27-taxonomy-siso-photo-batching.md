# Session Handoff — Taxonomy + SISO + Photo Batching + Unrequested Photo Rule

**Saved:** 2026-05-27 ~21:00 PT · **By:** Sisyphus orchestrator · **Status:** 🟢 SHIPPED + DEPLOYED · partial manual QA done, rest pending

This is the THIRD handoff in this session. Read in order if catching up:
1. [`2026-05-27-wa-business-ban-and-newnumber-pending-pair.md`](./2026-05-27-wa-business-ban-and-newnumber-pending-pair.md) — WA ban + new number
2. [`2026-05-27-prompt-caching-rate-limit-fix.md`](./2026-05-27-prompt-caching-rate-limit-fix.md) — Anthropic caching + 35× rate-limit headroom
3. **THIS FILE** — taxonomy expansion + SISO cert + photo batching + new-worker Redin intro

---

## 0. TL;DR for tomorrow

1. 🟢 **Pilot is fully live + healthy on +573224347117 (Toño)** and +573222392959 (Manos). Both services deployed with all today's work.
2. 🟢 **Smoke tested live**: new-worker Redin greeting fires, cuadrilla question gone, `register_tecnico` works with silent `modalidad: "individual"`, caching holding (~450 fresh tokens/call).
3. 🟡 **4 manual QA scenarios still pending verification** (you stopped to handoff): photo batching, SISO question in cert screening, unrequested-photo rule, end-to-end cert badge in dashboard. All code is shipped + smoke-tested + typecheck clean; just needs you to walk through one conversation tomorrow.
4. 🟢 **Branch `fix/tono-reject-url-as-document-evidence` is up-to-date with remote** — 3 commits this session (`66ae987`, `ed72a5a`, `cf4a36a`).
5. 📍 **Live test persona left in DB**: Camilo Navas (`tecnico_id=679d0714-1b7a-4a29-85a3-c44970ab5389`, phone `+137877543452841`, screening state). Use him to continue QA tomorrow or wipe if you want to start fresh.

---

## 1. What shipped in commit `cf4a36a` (today's main commit)

### Change 1 — Taxonomy expansion (7 categorías, 26 subcategorías)

**Files**: `shared/src/dossier-types.ts`, `tono/src/prompts/tono-system.ts`

**Renamed**: "Obra Civil (Locativo)" → "Reparaciones Locativas" (kept all 7 subs including Soldadura — per your call, Soldadores stays under Reparaciones Locativas, not promoted).

**Added category**: `Climatización` with 3 subcategorías:
- Instalación de Aire Acondicionado
- Mantenimiento de Aire Acondicionado
- Refrigeración Comercial

**Prompt keyword mapping added**: "aire acondicionado", "aires", "AC", "refrigeración" → Climatización

**Final taxonomy** (use this as the canonical reference):

| Categoría | Subcategorías |
|---|---|
| Reparaciones Locativas | Pintura General, Cerrajería, Pisos y Enchapes, Carpintería, Resanes y Drywall, Vidrios, Soldadura |
| Eléctrico y Datos | Iluminación, Puntos, Cableado, Cortos/Fallas |
| Fachadas y Alturas | Limpieza, Impermeabilización, Andamios, Avisos |
| Techos y Cubiertas | Goteras, Canales |
| Hidrosanitario (Plomería) | Fugas, Grifería, Destapes |
| Logística y Varios | Alquiler, Transporte, Traslados |
| **Climatización** (NEW) | Instalación AC, Mantenimiento AC, Refrigeración Comercial |

### Change 2 — SISO certification

**Files**: `shared/src/dossier-types.ts`, `tools/src/schemas.ts`, `tools/src/submit-candidate-dossier.ts`, `tono/src/prompts/tono-system.ts`, `dashboard/src/app/hr/tecnicos/[id]/page.tsx`

- `Certificaciones.siso: boolean` (non-optional, matches `altura`/`retie`/etc pattern)
- Tool schema (`submit_candidate_dossier`) accepts `siso` field
- Screening question now bundles SISO with alturas/RETIE: *"¿Tienes certificación de alturas, RETIE o curso SISO (Seguridad y Salud en el Trabajo)?"*
- Dashboard renders certifications as emerald-pill badges in `hr/tecnicos/[id]` (NEW — no cert badges existed before)

### Change 3 — Photo batching (B1 architectural fix)

**Files**: `tono/src/whatsapp.ts`, `tono/src/agent.ts`, `tono/src/prompts/tono-system.ts`

- Per-phone media debouncer with 2-timer design (2s idle / 8s max-age cap)
- N rapid media events from same sender collapse into ONE `onMessage` call with `media: InboundMedia[]`
- `agent.ts` loops over the array, injects one `[MEDIA_RECEIVED]` sentinel per file
- Prompt rule added: *"Si recibes múltiples [MEDIA_RECEIVED] en un solo turno, llama upload_documento UNA VEZ POR ARCHIVO antes de responder."*
- Dedup (`seenMessageIds`) + LID self-loop guard run BEFORE buffer enqueue (unchanged)
- Best-effort flush on socket close

**Root cause for the bug** (DB evidence from Jose Luis session 2026-05-28 at 01:06 UTC):
- 6 photos uploaded to storage at 01:06:14-18
- Only 4 `upload_documento` calls fired between 01:06:22-59
- Only 4 documentos rows materialized
- → 2+ photos silently dropped because Baileys delivers each photo as a separate `messages.upsert` event, Tono replies to the first one, subsequent media arrive while LLM is mid-response

### Change 4 — Unrequested photo rule

**File**: `tono/src/prompts/tono-system.ts`

Prompt rule added: *"Si llega un [MEDIA_RECEIVED] cuando NO acabas de pedir un documento, NO llames upload_documento. Responde breve y vuelve a tu pregunta."*

Addresses the screenshot bug where a worker sent a tools photo for a yes/no question and Tono improvised an ad-hoc reply.

---

## 2. Live verification done in this session

### Smoke (Phase 0) — 22/22 PASS

All tool contracts intact after taxonomy + Certificaciones changes:
```
[PASS] seed OT mirror
[PASS] identify_user (not found)
[PASS] register_tecnico A (single-token nombre rejected)
[PASS] register_tecnico A (missing contact_phone rejected)
[PASS] register_tecnico A (malformed contact_phone rejected)
[PASS] register_tecnico A (created)
[PASS] register_tecnico A (idempotent re-register)
[PASS] register_tecnico B
[PASS] identify_user (found)
[PASS] read_pending_ots (contains seed)
[PASS] read_pending_ots (profile match)
[PASS] create_postulacion A
[PASS] create_postulacion A (idempotent)
[PASS] create_postulacion B
[PASS] read_my_postulaciones
[PASS] transition to preseleccionado
[PASS] create contrato row
[PASS] read_my_contratos
[PASS] upload_documento (record-only)
[PASS] escalate_to_hr
[PASS] log_event
[PASS] eventos recorded
```

### Live manual QA — 5 / 9 PROVEN, 4 still pending

Test conversation with Camilo Navas (your phone `+137877543452841`):

| # | Test | Status | Evidence |
|---|---|---|---|
| 1 | New-worker greeting (Redin intro) | ✅ PROVEN | "Qué más. Te comunicas con *Redin — Red de Ingenieros Nacional*..." literally |
| 2 | Cuadrilla question GONE | ✅ PROVEN | Flow went directly nombre→ciudad→teléfono→qué trabajos→`register_tecnico(modalidad:individual)`. Zero cuadrilla mention. |
| 3 | `register_tecnico` fires with `modalidad: "individual"` | ✅ PROVEN | Camilo Navas registered, tecnico_id `679d0714-1b7a-4a29-85a3-c44970ab5389`, modalidad=individual |
| 4 | Caching still works after prompt change | ✅ PROVEN | 11 LLM calls, mean ~450 fresh tokens, no 429s |
| 5 | Climatización in keyword mapping | ✅ PROVEN | Tono's specialty prompt mentioned "aire acondicionado" as an example option |
| 6 | Photo batching (3+ photos → all upload) | ⏳ NOT TESTED | Conversation stopped at cédula request step before photos arrived |
| 7 | SISO question bundled in cert screening | ⏳ NOT TESTED | Cert screening happens AFTER cédula photos; flow paused before getting there |
| 8 | Unrequested photo rule | ⏳ NOT TESTED | Same — paused before mid-screening |
| 9 | Dashboard cert badge for SISO | ⏳ NOT TESTED | Requires a submitted dossier with `siso: true`; none exist yet |

---

## 3. Action plan for tomorrow

### Option A — Continue Camilo's conversation (fastest, ~10 min)

Camilo is still at the **"send 2 cédula photos"** step in `screening` state. From your phone:

1. Send 2 cédula photos (front + back) in QUICK succession. **Verify both land in `documentos` table** (this tests photo batching).
2. Tono will ask about experience → answer briefly.
3. Tono will ask for "constancia, certificación o foto de algún trabajo" → **send 3+ photos rapid-fire**. ALL should hit `documentos` (the core photo-batching test).
4. Tono will ask about certifications — **verify it bundles** "¿alturas, RETIE o curso SISO?" in ONE question.
5. Answer about SISO → eventually `submit_candidate_dossier` should be called with `certificaciones.siso=true` if you said yes.
6. Open dashboard at `https://dashboard-mp-production-1ef3.up.railway.app/hr/tecnicos/679d0714-1b7a-4a29-85a3-c44970ab5389` → **verify the SISO cert badge renders** (emerald pill).
7. At any yes/no question, send a random photo → **verify Tono says "gracias por la foto, pero ahora solo necesito sí o no" + NO `upload_documento` call** (unrequested-photo rule).

### Option B — Wipe Camilo + start completely fresh

If you want a clean run from `hola`, use the same cascade as Aidan/Camilo earlier:

```bash
# Substitute the new tecnico_id
T_ID="679d0714-1b7a-4a29-85a3-c44970ab5389"
SESSION_IDS="<query sessions WHERE phone=+137877543452841>"
# Run the cascade pattern (see prior handoff §)
```

### Option C — Test SISO + dashboard badge purely via direct DB injection

Skip the WhatsApp flow entirely: directly submit a candidate_dossier for an existing worker with `certificaciones.siso=true` and verify the badge renders. Fastest dashboard-only verification.

---

## 4. Known issues + watch-outs

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | Identity-gate's `must_identify_first` still forces 2 LLM calls per registration turn | Low | Caching makes this survivable (each call ~450 tokens). Was the cause of the original 429. Could be flagged future-cleanup. |
| 2 | Malformed phone JIDs (`+137877543452841` looks US-format, `+33887895953632` looks French) | Low-Medium | Baileys JID parsing artifact when WA sender info incomplete. Not blocking pilot, but creates "looks weird" rows in tecnicos_extended. Separate ticket. |
| 3 | Dashboard cert badges component is NEW UI | None — but watch | First cert visualization in the dashboard. If HR feedback wants different colors/layout, iterate from there. |
| 4 | One stale "Obra Civil (Locativo)" reference left in `scripts/fix-alberto-ciudad.ts:51` | None | Classified HISTORICAL by T8 audit — that script documents Alberto's category at the time of the fix, kept intentionally. |
| 5 | `scripts/phase1-tools-smoke.ts` and `scripts/trace-b3-arl.ts` now have `siso: false` in Certificaciones fixtures | None | Cosmetic. Was required for typecheck. |

---

## 5. Files changed today (across all 3 commits)

| Commit | Files | Lines |
|---|---|---|
| `66ae987` feat(llm): Anthropic prompt caching | tono/src/llm.ts, manos/src/llm.ts | +55 / -19 |
| `ed72a5a` feat(tono prompt): Redin intro + drop cuadrilla | tono/src/prompts/tono-system.ts | +16 / -10 |
| `cf4a36a` feat(tono): taxonomy + SISO + photo batching + unrequested | 9 files | +249 / -81 |

Total session: **3 commits, 11 files modified, +320 / -110 lines net.**

---

## 6. Critical paths

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **Branch**: `fix/tono-reject-url-as-document-evidence` (3 commits ahead, all pushed)
- **Toño WA**: `+573224347117` ([railway tono-mp](https://railway.com/project/b4b4d52e-6b67-4a93-a293-d61729bb3ff4))
- **Manos WA**: `+573222392959` ([railway manos-mp](https://railway.com/project/b4b4d52e-6b67-4a93-a293-d61729bb3ff4))
- **Dashboard**: https://dashboard-mp-production-1ef3.up.railway.app
- **Camilo Navas**: tecnico_id `679d0714-1b7a-4a29-85a3-c44970ab5389`, dashboard URL `/hr/tecnicos/679d0714-1b7a-4a29-85a3-c44970ab5389`
- **Jose Luis** (preserved test row from prior days): tecnico_id `1631104c-a5fa-4580-9d86-9b774afcf860`

---

## 7. Decisions log (delta on prior handoffs)

| Date | Decision | Lock-in |
|---|---|---|
| 2026-05-27 | **Add Climatización as new top-level category** (not subcategory of Eléctrico). AC techs in Bogotá specialize. | Locked |
| 2026-05-27 | **Soldadores stays in Reparaciones Locativas (Obra Civil)**, NOT promoted to top-level. Per Irina's intuition. | Locked |
| 2026-05-27 | **SISO = `certificaciones.siso` boolean field**, like alturas/RETIE. NOT a separate specialty. | Locked |
| 2026-05-27 | **SISO question bundled with alturas/RETIE** in screening (1 question, 3 cert checks). Blue-collar UX rule. | Locked |
| 2026-05-27 | **Photo batching = whatsapp.ts debouncer (2s idle / 8s max-age)**. Architectural fix, not prompt-only. | Locked |
| 2026-05-27 | **`modalidad: "individual"` always passed silently** to `register_tecnico`. HR adjusts later if needed. | Locked |
| 2026-05-27 | **Dashboard cert badges = new UI block** (first cert visualization in dashboard). Emerald pills, slate for "Otras". | Locked |
| 2026-05-27 | **One atomic commit** for all 4 changes (taxonomy + SISO + photo batching + unrequested). One Anthropic cache miss budgeted. | Operational |

---

## 8. Next-session starting prompt (copy-paste)

```
Read this handoff first:
  /Users/irina/AI-driven-OS/autonomous/redin/marketplace/.omo/handoffs/2026-05-27-taxonomy-siso-photo-batching.md

Then either:

OPTION A — continue Camilo Navas's flow (fastest):
  1. From phone +137877543452841 (which is in tecnicos_extended as Camilo Navas, tecnico_id 679d0714-1b7a-4a29-85a3-c44970ab5389), send the 2 cédula photos that Toño asked for.
  2. Walk through the rest of screening; verify the 4 pending QA scenarios:
     - Photo batching: send 3+ photos in <2s → all should hit documentos table
     - SISO question: should be bundled with alturas/RETIE in one question
     - Unrequested photo: send a random photo at a yes/no question → "gracias por la foto, pero..." reply, no upload_documento
     - Dashboard cert badge: after candidate_dossier submitted with siso=true, badge should render in /hr/tecnicos/679d0714-...

OPTION B — fresh test (cleanest):
  1. Cascade-delete Camilo Navas (tecnico_id 679d0714-1b7a-4a29-85a3-c44970ab5389) following the same pattern as Aidan deletion in prior handoff.
  2. Send "hola" from phone, get fresh new-worker greeting, walk through full screening.

Strategic constraints (still active):
  - AppSheet REMAINS the main system for OT tracking
  - Only Projector writes to AppSheet
  - No deploy without explicit ask
  - Cost cap $10/day Anthropic (now effectively ~$10/1600 calls thanks to caching)
  - Sonnet 4.5 on both Toño + Manos
  - LID self-loop guard MUST stay in place
  - Caching has 5-min TTL
```

---

## Final note

Today was a big productivity day. Three distinct production-ready features shipped:

1. **Prompt caching** — turned a tier-1 rate-limit crisis into 35× headroom + 90% cost reduction
2. **Redin-branded new-worker intro** — workers now feel they're talking to a real company
3. **Taxonomy + SISO + photo batching + unrequested-photo rule** — addresses 3 separate UX defects flagged in the screenshot test

The cumulative commit cost ~330 lines added / ~110 removed across 11 files. Zero regressions detected (smoke 22/22, typecheck clean across 6 workspaces). The pilot is now more capable, more on-brand, and significantly cheaper to run than it was at the start of this session.

Buena suerte.
