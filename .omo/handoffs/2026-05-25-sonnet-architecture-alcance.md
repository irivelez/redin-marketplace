# Session Handoff — Sonnet Swap + Architecture Decision (Alcance Loop)

**Saved:** 2026-05-25 ~21:30 PT · **By:** Sisyphus orchestrator · **Status:** mid-green-line test, ready for new session pickup

This handoff **supersedes** `.omo/handoffs/2026-05-25-screening-patches-and-fresh-test.md`. Read this whole file first — it captures **everything verified in this session** and locks the architecture for the alcance loop.

---

## 0. TL;DR for the new session

1. **Toño now runs on Claude Sonnet 4.5** (env-overridable; one-line revert to Haiku 4.5 if needed). Live, verified working on Phone A at 04:11 UTC.
2. **AppSheet write permission is FULL** — verified: text + binary PDF (base64 data URL) both write successfully to `Alcance_OT` on TEST OT.
3. **AppSheet REMAINS the main system for tracking OTs** — Jose's universe stays canonical for OT lifecycle. Supabase is source of truth for marketplace data (alcance, técnicos, postulaciones). The projector mirrors alcance from Supabase back to AppSheet so Jose's team has centralized visibility.
4. **Architectural decision PENDING for next session**: what TYPE should `Alcance_OT` be in AppSheet? Options to evaluate:
   - **A. Durable link** (text-typed field with a permanent or long-lived URL to the Supabase PDF) — simpler, but Supabase signed URLs expire; need a permanent auth-gated route (e.g., `/api/alcance/[ot_id]` in dashboard) OR public bucket access
   - **B. Real PDF upload** (file-typed field — what we PROVED works via the TEST OT) — Jose's UI shows downloadable widget natively, but requires Drive folder sharing for HR users
   - **Defer this decision to next session.** For now: ship the architect feedback loop (Track A.3) which is independent of the AppSheet field-type question.
5. **Track A reduced to ONE shippable change**: Manos sends architect both a link + PDF document attachment after `finalize_alcance`. ~30 min.
6. **Gap A (alcance PDF on HR Preselect) was already shipped before today** — TESTING.md was stale. Code at [page.tsx:192-245] + [offer-replies.ts handlePreselectionIntent] + [agent.ts:359].
7. **v1.1 deferred items** (post-pilot): migrate worker delivery from PDF to PNG job card, embed photos in Manos PDF, Spanish TTS voice note fallback, dashboard PDF inline viewer for HR.

---

## 1. What was VERIFIED this session (with concrete evidence)

### 1.1 Sonnet 4.5 swap — LIVE and working

| Check | Evidence |
|---|---|
| Source edit persisted | [`tono/src/llm.ts:41-46`](../../tono/src/llm.ts) + [`manos/src/llm.ts:47-49`](../../manos/src/llm.ts) — env-overridable with `claude-haiku-4-5` fallback |
| .env.local has env vars | `TONO_MODEL=claude-sonnet-4-5` + `MANOS_MODEL=claude-sonnet-4-5` |
| Toño dev restarted with new env | tsx-watch restart at 2026-05-26 03:54:31 UTC, "Toño is online" |
| API + key authorized for Sonnet | curl test returned `200 OK, model=claude-sonnet-4-5-20250929, reply=OK` |
| Real Sonnet turn fired | eventos `llm_call` at 2026-05-26 04:11:08 + 04:11:12, `meta.model=claude-sonnet-4-5`, called `read_pending_ots` for Phone A |
| Cost per turn (Sonnet w/ thinking) | ~$0.13/turn (41,828 input + 533 output tokens). $10/day cap = ~77 turns/day |

**Revert recipe**: `sed -i 's/claude-sonnet-4-5/claude-haiku-4-5/' .env.local` + restart Toño. Code default falls back automatically.

### 1.2 AppSheet write permission — FULL

| Test | Result |
|---|---|
| Read OT directly from AppSheet API | ✅ 200 OK |
| Write text to `Alcance_OT` on TEST OT | ✅ 200 OK, persisted, re-readable |
| Upload base64 PDF (`data:application/pdf;base64,...`) to `Alcance_OT` | ✅ 200 OK, AppSheet transformed value to file ref `Ordenes_Trabajo_Files_/c8e6a844.Alcance_OT.044143.pdf` |
| AppSheet UI rendered file widget | ✅ Visible in detail view (Irina confirmed via screenshot) |
| AppSheet UI lets user download the file | ⚠️ Drive permission issue — file ref is there but UI can't fetch bytes. NOT a code issue. Jose needs to share the AppSheet backing Drive folder with HR users. |
| TEST OT restored to clean state | ✅ `Alcance_OT = ''` final |

### 1.3 Gap A (alcance PDF on HR Preselect) — already shipped

TESTING.md `§Gap A — Send alcance PDF on preselect (~2h)` is **already implemented**. Verified:

- [`dashboard/src/app/hr/shortlist/[ot_id]/page.tsx:192-245`](../../dashboard/src/app/hr/shortlist/[ot_id]/page.tsx) — decide() server action with `state === "preseleccionado"` branch fetches `ots_extended.alcance_pdf_path`, enqueues text via `enqueueWhatsApp`, enqueues PDF via `enqueueWhatsAppDocument`
- [`tono/src/offer-replies.ts`](../../tono/src/offer-replies.ts) — `handlePreselectionIntent()` with STRICT_ACCEPT_RE vs LOOSE_ACCEPT_RE distinction, `loadRecentPreselection` 14-day lookback with idempotency, full audit + Telegram pings on rejection
- [`tono/src/agent.ts:359`](../../tono/src/agent.ts) — `tryMatchOfferReply` called pre-LLM

When HR clicks Preseleccionar:
1. Worker receives text: `"Buenas — quedaste preseleccionado para "{trabajo}". Te paso el alcance del trabajo en el documento adjunto. Revísalo bien: si te interesa, responde "acepto"; si no, responde "paso"."`
2. Worker receives PDF as **native WhatsApp document** (via Baileys `sendDocument`) with caption `"Alcance del trabajo — OT {short_id}"`
3. Worker replies "acepto" → pre-LLM intercept confirms → short reply, no second LLM call

### 1.4 Phone A green-line state

| Step | When | Status |
|---|---|---|
| Screening | 2026-05-26 01:31-32 UTC | ✅ dossier submitted, `tono_recommendation=recommend_approve`, confidence 0.85 |
| HR approval | 01:35:25 UTC (irina.andreav@gmail.com) | ✅ `candidate_state=approved`, `agreed_with_tono=true` |
| Approval push | 01:35:27 UTC | ✅ `approval_push_sent` to phone with ciudad=Yopal, 2 OTs |
| AppSheet projection (tecnico) | 01:35:59 UTC | ✅ `appsheet_added` to TECNICOS as `r9Cvu0hAdB46E_qxziYd19` (name="Camilo Andrade") |
| Returning conversation | 02:46 → 03:03 UTC | ✅ `complete_legacy_profile` x2, then `read_pending_ots` |
| First Sonnet turn | 04:11:08 UTC | ✅ Camilo received list of 2 Yopal OTs |
| Create postulación | — | ⏸️ Pending — Camilo needs to say "me interesa la X" |
| HR Preselect | — | ⏸️ |
| HR Generar contrato | — | ⏸️ |

**Camilo Andrade** = `tecnico_id 868ad622-9312-4729-a853-5c9aa7fd25c2`, phone `+137877543452841`, ciudad Yopal, approved.

### 1.5 The 2 alcance OTs Camilo can pick from (both have alcance already)

| ot_row_id | AppSheet Descripcion | Valor (real) | alcance_jsonb.summary | PDF in Storage | AppSheet Alcance_OT |
|---|---|---|---|---|---|
| `Ht6UBQ8NmNacSb0Hgnd66Q` | Garantia cubierta Yopal interrapidisimo | $330,000 | "Pintura de fachada del edificio comercial; ~120m² preparación + 2 manos esmalte..." | ✅ 2,859 bytes | ❌ EMPTY (dead-lettered) |
| `1BtTtVebo55GQzxYoaWgv6` | OC 57832 - Interrapidisimo Racol Yopal - Reparación de muro | $179,640 | (same as above) | ✅ 2,864 bytes | ✅ 196 chars (text only — broken render) |

Both share the SAME alcance_jsonb (architect tested with same script on both). Worker sees the alcance summary regardless of AppSheet state because Toño reads from Supabase.

---

## 2. What's BROKEN today (and the planned fix)

### 2.1 Projector writes text to a File column (architectural mismatch)

**File**: [`sync/src/projector.ts buildAlcanceOtValue`](../../sync/src/projector.ts) (around line 154-162) → currently outputs `"[Pintura] | Pintura de fachada... | PDF: path"` as plain text.

**AppSheet's reality**: `Alcance_OT` is typed as **File/PDF** (confirmed via Irina's screenshot — shows PDF widget icon, not a text field).

**Result**: AppSheet API accepts the text (200 OK), data layer stores it, but UI shows broken/empty file widget because the string isn't a valid file reference.

**Fix** (Track A #1, ~30 min):
```typescript
// Before (current):
const alcanceValue = buildAlcanceOtValue(alcanceJson, pdfPath);  // returns text

// After:
const pdfBytes = await downloadPdfFromStorage(deps.supa, pdfPath);  // signed-URL or direct
const base64 = Buffer.from(pdfBytes).toString('base64');
const alcanceValue = `data:application/pdf;base64,${base64}`;
await deps.appsheet.editOT(otRowId, idOrden, { Alcance_OT: alcanceValue });
```

Proven works on TEST OT — AppSheet returned `Ordenes_Trabajo_Files_/c8e6a844.Alcance_OT.044143.pdf` as the stored value, UI rendered the file widget.

### 2.2 2 OTs are dead-lettered from old projector bug

- `Ht6UBQ8NmNacSb0Hgnd66Q`: 5 attempts all failed 2026-05-23 21:59-22:03 with "ID_Orden value is missing" → `appsheet_alcance_dead_letter` → permanently abandoned
- The bug was fixed mid-stream (Lane D handoff §5: "removed Row ID from Edit body") but OT1 was already dead by then
- OT2 succeeded on attempt 6 + a re-finalization

**Fix** (Track A #2, 1 SQL):
```sql
UPDATE ots_extended 
SET appsheet_alcance_pending = true,
    appsheet_alcance_sync_attempts = 0,
    appsheet_alcance_last_error = null
WHERE ot_row_id = 'Ht6UBQ8NmNacSb0Hgnd66Q';
-- Optionally add the TEST OT and OT2 to force re-projection with new PDF format
```

### 2.3 Architect has no feedback loop after Manos finalize

[`manos/src/prompts/manos-system.ts`](../../manos/src/prompts/manos-system.ts) instructs the LLM to call `finalize_alcance` but **never tells it to send the resulting PDF URL back to the architect**. Architect finishes the conversation blind — has to open AppSheet later.

**Fix** (Track A #3, ~15 min): add to manos-system.ts:
```
Después de llamar finalize_alcance, SIEMPRE manda al arquitecto un mensaje 
con el enlace del PDF generado:

  "Listo. Alcance generado. Aquí está el documento que viste:
   {{pdf_url}}
   
   Si algo está mal, dime y lo regeneramos. Si está bien, ya quedó 
   listo en AppSheet para que el técnico lo reciba."
```

The tool already returns `pdf_url` in the response. Just need to instruct the LLM to use it.

### 2.4 Photos NOT embedded in PDF

[`tools/src/manos/finalize-alcance.ts:283-292`](../../tools/src/manos/finalize-alcance.ts) just renders `"N foto(s) almacenada(s) en el sistema"` as text. The architect's actual photos are in `ots_extended.photo_paths[]` but never passed to `@react-pdf/renderer` as `<Image>` elements.

**Why PDFs are 2,864 bytes**: pure text, no binary image data. A real PDF with one photo would be 50-300KB.

**Fix** (v1.1 — NOT for today): modify `generateAlcancePdf` to accept photo URLs, fetch them async, render as `<Image src={url}>`. ~2hr including testing PDF size + WA delivery.

### 2.5 AppSheet UI download blocker (NOT a code issue)

Even when the file ref is properly stored, Irina couldn't download the PDF from AppSheet UI. Two probable causes:

1. **View mode**: she was in Form/Edit view (with `X` to remove). Detail view should render filename as clickable download link.
2. **Drive folder permission**: the AppSheet app's backing Google Drive folder isn't shared with HR Google accounts. Files uploaded via API live there; UI users need read permission.

**Fix**: not code. Jose needs to:
1. Open AppSheet app → Settings → Data → Source → confirm backing Drive folder
2. Share that folder with HR users' Google accounts (or "Anyone with link can view")

---

## 3. Architecture decisions LOCKED

### 3.1 AppSheet remains main OT tracking system. Supabase owns marketplace data.

**Each system owns what it's best at:**

| System | Owns | Why |
|---|---|---|
| **AppSheet (Ordenes_Trabajo)** | OT lifecycle: identity, customer, status (Estado), billing (Valor_Estimado, Valor_Facturado), dates, architect assignment | Jose's existing operations. Battle-tested. Centralized OT visibility. |
| **Supabase (marketplace)** | Marketplace data: técnicos, postulaciones, contratos, dossiers, sessions, alcance content + PDF bytes | New surface. Owns the data Jose's AppSheet doesn't model. |
| **Projector (sync-mp)** | Bidirectional sync: AppSheet → Supabase (read-only mirror, 15min cron) AND Supabase → AppSheet (write-back of alcance + new técnicos) | Keeps Jose's universe centralized without dual data entry. |

**Alcance data flow:**

```
ARCHITECT (Manos WA: voice + photos + text)
    ↓
[Manos agent + tools]
    ↓
    ├──→ Supabase Storage
    │     ├─ alcance-photos/incoming/{phone}/{uuid}.jpg     (raw photos)
    │     └─ alcance-photos/{ot_row_id}/alcance.pdf         (rendered alcance PDF — immutable per finalize)
    │
    └──→ Supabase ots_extended                              ← SOURCE OF TRUTH for alcance content
          ├─ alcance_jsonb       (structured: especialidad, summary, conditions, value_estimate)
          ├─ alcance_pdf_path    (relative path in alcance-photos)
          ├─ photo_paths[]       (signed URLs to raw photos)
          └─ appsheet_alcance_pending = true                (outbox trigger for Jose-side mirror)
    │
    ├──→ Toño reads via read_pending_ots (LEFT JOIN ots_extended)
    │      ↓ sends to worker via Gap A on Preseleccionar (text + PDF as native WA document)
    │
    ├──→ Dashboard /hr/shortlist reads directly
    │      ↓ HR uses for ranking + Preseleccionar action
    │
    ├──→ Manos sends back to architect (NEW Track A.3): link + PDF document attachment
    │      ↓ architect closes the loop in same WhatsApp thread (phone OR laptop via link)
    │
    └──→ Projector (sync-mp) writes back to AppSheet.Alcance_OT
          ↓ FIELD TYPE PENDING DECISION (next session — see §6 Track A "AppSheet field type"):
          ↓   Option A: durable link (text-typed column with permanent URL)
          ↓   Option B: PDF file upload (file-typed column, proven works on TEST OT)
          ↓
          AppSheet Ordenes_Trabajo (Jose's universe)
              ↓ Jose / arquitectos / HR see alcance from AppSheet UI as well
```

**The architect can see the alcance from any of FOUR surfaces:**
1. WhatsApp with Manos (after Track A.3 — immediate feedback loop)
2. AppSheet UI (after next session's field-type decision + projector update)
3. Dashboard (HR shortlist page — already reads from Supabase)
4. Direct Supabase Storage URL (signed, for debugging)

### 3.2 The agent contracts (one job each)

| Agent | Reads | Writes | Does NOT write |
|---|---|---|---|
| **Manos** | arquitectos_mirror, ots_mirror, ots_extended | Supabase Storage, ots_extended, eventos | AppSheet (ever) |
| **Projector (sync-mp)** | ots_extended (outbox), Supabase Storage | AppSheet.Ordenes_Trabajo.Alcance_OT (base64 PDF) | Anything else |
| **Toño** | ots_mirror, ots_extended, tecnicos_extended, dossier, postulaciones | postulaciones, sessions, messages, eventos, outbound_messages | AppSheet (ever) |
| **Dashboard HR flow** | everything in Supabase | candidate_decisions, postulaciones, contratos, outbound_messages | AppSheet (ever) |

**Only the Projector writes to AppSheet. Nothing else. Ever.**

### 3.3 Format for worker delivery: PDF today, PNG card v1.1

**Today**: Native WhatsApp document attachment via Baileys `sendDocument`. Caption + PDF inline.

**v1.1** (per librarian evidence, scored 9.3/10 vs PDF 5.4/10):
- Migrate to server-rendered PNG job card via `@vercel/og` (Satori)
- 1200×630px, 80-150KB, instant inline preview, no parse failure on cheap Android
- Add Spanish TTS voice note fallback (60-90s) for low-literacy workers
- Optionally embed photos in PDF for HR archival (separate from worker delivery)

---

## 4. Files modified this session

```
M tono/src/llm.ts           # MODEL → env-overridable (TONO_MODEL, default haiku-4-5)
M manos/src/llm.ts          # MODEL → env-overridable (MANOS_MODEL, default haiku-4-5)
M .env.local                # TONO_MODEL=claude-sonnet-4-5 + MANOS_MODEL=claude-sonnet-4-5

A .omo/handoffs/2026-05-25-sonnet-architecture-alcance.md  # this file
```

No tool/dashboard/projector code touched. The 3 immediate fixes (Track A) are pre-approved-pending, NOT yet shipped.

---

## 5. Current running state (live, on this Mac)

| Service | State | Connection | Log |
|---|---|---|---|
| **Dev Toño** | ✅ running on Sonnet 4.5 | WhatsApp @ +14157916801 | `tail -f /tmp/tono-dev.log` |
| **Dev Manos** | 🔴 stopped (440 loop from Railway prod owning session) | — | `tail -f /tmp/manos-dev.log` |
| **Dev Sync** | ✅ running | cron */15 + projector 60s | `tail -f /tmp/sync-dev.log` |
| **Dashboard** | ✅ running | http://localhost:3000 | `tail -f /tmp/dashboard-dev.log` |
| **Supabase** | ✅ live | https://foerbjhnwbxfauajkbld.supabase.co | — |
| **Railway `tono-mp`** | 🔴 STOPPED (per prior handoff) | — | — |
| **Railway `manos-mp`** | ⚠️ Likely RUNNING (steals the WA session — Irina to verify) | — | — |

---

## 6. Action plan for next session (in priority order)

### Track A — Single shippable change for next session (~30 min)

**A.1 Manos architect feedback loop — send link + PDF document to architect after finalize** (~30 min)

**Problem**: Architect finishes the Manos conversation blind. They never see what was generated. Fix: in the same Manos WhatsApp thread, send (a) a short text with a signed URL link AND (b) the PDF as a native WhatsApp document attachment.

**Why BOTH (link + document)**:
- **Link**: works on laptop (open in browser), easy to forward, can be opened on bigger screen for detailed review
- **PDF document**: native WA inline preview, lives in chat history forever, works on cheap Android, no link parsing weirdness
- Architect picks whichever surface they're on; both come in the same flow

**Files to change**:

1. [`tools/src/manos/finalize-alcance.ts`](../../tools/src/manos/finalize-alcance.ts) — after PDF upload + ots_extended update, mint a signed URL (24h-7d) and insert TWO outbound_messages rows (text with link + PDF document):

```typescript
// After PDF is in Storage + ots_extended row updated:

// 1. Mint signed URL for the alcance PDF (24h expiry — architect will open within minutes)
const { data: signed } = await ctx.supabase.storage
  .from("alcance-photos")
  .createSignedUrl(`${otRowId}/alcance.pdf`, 86400);  // 24h
const pdfLink = signed?.signedUrl ?? null;

// 2. Architect's phone is the current session phone
const architectPhone = session.phone;  // already known from session

// 3. Text message with link (works on laptop + phone, easy to forward)
const linkBody = pdfLink
  ? `Listo. Ya quedó el alcance para "${otBriefTitle}".\n\nLo puedes ver aquí:\n${pdfLink}\n\nSi algo está mal, dime y lo regeneramos.`
  : `Listo. Ya quedó el alcance para "${otBriefTitle}". Te lo paso como documento.`;
await ctx.supabase.from("outbound_messages").insert({
  phone: architectPhone,
  channel: "manos",
  kind: "text",
  body: linkBody,
  meta: { kind: "manos_alcance_preview_link", ot_row_id: otRowId, arq_row_id }
});

// 4. PDF document attachment (native WA inline preview, durable in chat history)
await ctx.supabase.from("outbound_messages").insert({
  phone: architectPhone,
  channel: "manos",
  kind: "document",
  body: `Alcance OT ${otRowId.slice(0, 8)}`,  // caption above the document
  attachment_path: `${otRowId}/alcance.pdf`,
  attachment_bucket: "alcance-photos",
  attachment_filename: `Alcance_OT_${otRowId.slice(0,8)}.pdf`,
  meta: { kind: "manos_alcance_preview_doc", ot_row_id: otRowId, arq_row_id }
});
```

The Manos outbound drainer at [`manos/src/outbound.ts:32-95`](../../manos/src/outbound.ts) already polls `outbound_messages` where `channel="manos"` for `kind=text` and `kind=document` and sends via Baileys. Infrastructure is in place.

2. [`manos/src/prompts/manos-system.ts`](../../manos/src/prompts/manos-system.ts) — tell the LLM the link + PDF send is automatic:

```
Cuando llamas finalize_alcance, el sistema envía automáticamente al arquitecto:
  1. Un mensaje con el enlace al PDF (para abrir en el laptop o navegador)
  2. El PDF como documento adjunto en WhatsApp

Tu respuesta debe ser una confirmación corta:
"Listo. Ya quedó. Te mandé el alcance — lo puedes abrir desde el enlace o desde el documento adjunto que te llega. Si algo está mal, dime y lo regeneramos."

NO pongas el enlace tú mismo — el sistema ya lo envía. Solo confirma que está listo.
```

**Test**: smoke from architect test phone → cédula → list OTs → photo + voice → finalize → verify in Manos WA thread that (a) the link message arrives, (b) the PDF document attachment arrives within ~5s and is openable inline, (c) clicking the link opens the PDF in browser.

---

### Track B — Architectural decision DEFERRED (must decide next session before shipping)

**B.1 AppSheet `Alcance_OT` field type — link vs file upload**

We proved BOTH approaches work via the TEST OT this session:
- Text writes succeed (`Alcance_OT = "any string"` persists)
- Base64 PDF upload succeeds (AppSheet transforms `data:application/pdf;base64,...` into a file reference, UI shows downloadable widget)

The choice depends on this decision (next session, with Jose):

| Approach | Pro | Con | When to use |
|---|---|---|---|
| **Durable LINK in text-typed column** | Always serves latest PDF (re-finalize → same link). Easy to share/forward. Works on any device. | Signed URLs expire (max ~7 days). Need permanent auth-gated route OR public bucket. May break if URL format changes. | If we can stand up a permanent route like `/api/alcance/[ot_id]` in dashboard that streams the latest PDF from Supabase Storage with auth. |
| **PDF FILE upload to file-typed column** | Native AppSheet widget. Jose's mobile/web app downloads it without setup. Survives forever. | File is a snapshot — re-finalize creates a NEW file (need to delete old). Requires base64 upload via projector. AppSheet UI needs Drive folder sharing for HR users. | If durable link isn't viable OR Jose's team prefers native AppSheet file widget. |

**Next session**:
1. Pick ONE approach (likely durable link via dashboard route — more flexible, no Drive permission dance)
2. Implement projector change accordingly
3. Re-queue 2-3 OTs to back-fill (`Ht6UBQ8NmNacSb0Hgnd66Q`, `1BtTtVebo55GQzxYoaWgv6`, `LK4cgHD0DlytRsCBwx8zKZ`)
4. Verify in AppSheet UI with Jose: he can open the alcance from any OT

### Track B — Continue green-line test (Camilo / Phone A)

The user has Phone A approved + ready to postulate. To complete the green-line:

1. **Irina sends from Phone A**: `"me interesa la primera"` (or similar) → Toño calls `create_postulacion` → first Sonnet-powered tool call
2. **Irina in dashboard**: `/hr/shortlist/Ht6UBQ8NmNacSb0Hgnd66Q` (or whichever OT she picked) → click Preseleccionar → Gap A delivers text + PDF to Phone A
3. **Irina from Phone A**: reply `"acepto"` → pre-LLM short-circuit confirms preselection
4. **Irina in dashboard**: `/hr/contratos/[id]` → Generar y enviar → contract PDF delivered to Phone A
5. **GREEN LINE CLOSED.**

### Track C — Manos restart (low priority)

The Railway `manos-mp` service likely came back online and is now owning the +573222392959 WA session, blocking local dev Manos from connecting (440 loop). Two ways forward:

- **Quick**: Irina opens Railway dashboard → stop `manos-mp` service → local dev Manos can claim the session
- **Or**: Just deploy to Railway directly — for production use, prod is fine

Manos is NOT required for tonight's green-line completion (Yopal OTs already have alcance from prior tests).

### Track D — v1.1 deferreds (next sprint)

| # | Item | Effort | Why deferred |
|---|---|---|---|
| 1 | Drive permissions: share AppSheet backing folder with HR Google accounts | Jose action | Required for AppSheet UI download to work, but not blocking system flow |
| 2 | Embed photos in Manos PDF (`<Image src={signed_url}>`) | 2h | Useful for HR archival; current text-only is enough for worker decision |
| 3 | Migrate worker delivery: PDF → PNG job card (@vercel/og) | 4h | 9.3/10 vs 5.4/10 UX score; ship after pilot validates volume |
| 4 | Spanish TTS voice note fallback | 4h | 6-10× engagement for low-literacy; nice-to-have for v1 pilot |
| 5 | Self-critique pass before submit_candidate_dossier | 2h | From prior handoff §8 deferred #1 |
| 6 | `collected_so_far` summary block (survives context truncation) | 3h | From prior handoff §8 deferred #2 |
| 7 | Flip grounding gate from log-only to enforce | 1h | From prior handoff §8 deferred #3 |
| 8 | Gap B — WA contract signing (`firmo` handler + Ley 527 audit) | 1 day | Stops at "contract PDF sent" per green-line |
| 9 | Audit other handlers for over-aggressive determinism | 1h | From prior handoff §8 deferred #6 |

---

## 7. Resume Playbook for a fresh terminal session

```bash
# 1. Verify location
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace
pwd

# 2. Read this handoff in full

# 3. Verify services
curl -sS -o /dev/null -w "Dashboard: %{http_code}\n" http://localhost:3000  # expect 200
ps -eo pid,etime,command | grep "marketplace.*src/runner" | grep -v grep | wc -l
# expect 9 (3 per tree × 3 services: tono + sync + dashboard). Manos is dead per Track C.

# 4. Tail logs
tail -3 /tmp/tono-dev.log
tail -3 /tmp/sync-dev.log
tail -3 /tmp/dashboard-dev.log

# 5. Confirm Sonnet is loaded
grep "TONO_MODEL\|MANOS_MODEL" .env.local
# Expected:
#   TONO_MODEL=claude-sonnet-4-5
#   MANOS_MODEL=claude-sonnet-4-5

# 6. Verify Phone A current state
set -a && source .env.local && set +a
curl -sS "$SUPABASE_URL/rest/v1/tecnicos_extended?phone=eq.%2B137877543452841&select=tecnico_id,nombre,candidate_state,profile_complete" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
# Expected: tecnico_id 868ad622-..., nombre 'Camilo Andrade', candidate_state 'approved', profile_complete true

# 7. Most recent llm_call event — should show model=claude-sonnet-4-5
curl -sS "$SUPABASE_URL/rest/v1/eventos?type=eq.llm_call&actor=eq.agent&select=created_at,meta&order=created_at.desc&limit=1" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
# Look for meta.model = "claude-sonnet-4-5"

# 8. Tail logs in two terminals during testing
tail -f /tmp/tono-dev.log  | grep -E "^20[0-9]{2}-"
tail -f /tmp/dashboard-dev.log

# 9. If green-line continuation: have Irina send next message from Phone A
```

### If Toño hits a session issue

```bash
# Confirm Railway prod tono-mp is still stopped
# (if it came back, it'll steal the WA session and dev will 440-loop)
railway service tono-mp 2>&1 | head -3

# Clean restart
pkill -9 -f "tono.*runner" ; sleep 2
nohup npm run tono:dev > /tmp/tono-dev.log 2>&1 & disown
sleep 8
tail -5 /tmp/tono-dev.log
# Look for "Toño is online"
```

---

## 8. Hard Don'ts (carry-over + new)

From prior handoffs (still active):
- DO NOT touch the contract HITL gate
- DO NOT delete `ot_offers` / "Enviar oferta" UI
- DO NOT add Excel parsing in v1
- DO NOT change Manos's architecture
- DO NOT use `as any` / `@ts-ignore` / `@ts-expect-error`
- DO NOT write tests (per redin-builder agent description)
- DO NOT push to GitHub or deploy without Irina's call
- DO NOT make ARL or EPS mandatory for approval. Only cédula photo blocks.
- DO NOT add WA notifications to `unschedule_call`/`revoke`/`reopen`
- DO NOT await `classifyDocumento` inside `upload_documento`
- DO NOT shrink `CONTEXT_WINDOW` back to 24
- DO NOT remove the `sendAgentReply` enqueue-first pattern

New for this session:
- **DO NOT have any agent OTHER than the Projector write to AppSheet.** Manos writes to Supabase. Toño never writes to AppSheet. Dashboard never writes to AppSheet (it enqueues outbound_messages and updates Supabase tables). Only `sync/src/projector.ts` writes to AppSheet (Alcance_OT + new TECNICOS rows).
- **DO NOT revert `MODEL` to a hardcoded constant.** Env-overridable is intentional — one-line revert path from Sonnet to Haiku if cost or behavior issue.
- **DO NOT delete the `data:application/pdf;base64,...` pattern from the toolkit.** Even if we go with the link approach for Alcance_OT, base64 upload is proven and may be needed for other file columns (contract signed PDFs, etc.).
- **DO NOT make a unilateral decision on Alcance_OT field type.** The link-vs-upload trade-off has product implications (Jose's mobile UX, HR Drive permissions, link durability). Decide WITH Jose in the next session before changing the projector.
- **DO NOT ship Manos architect feedback (Track A.1) and Alcance_OT field type change (Track B.1) in the same commit.** Track A is safe + reversible. Track B affects Jose's universe — needs a separate, more careful ship with rollback plan.

---

## 9. Critical context (paths)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md` (§7 = no-writes-to-AppSheet rule)
- **About Irina**: `/Users/irina/AI-driven-OS/about_me/` (read on demand only)
- **Prior handoffs** (chronological):
  - `.omo/handoffs/2026-05-24-redin-2day-ship.md`
  - `.omo/handoffs/2026-05-25-cedula-gate-and-live-test.md`
  - `.omo/handoffs/2026-05-25-screening-patches-and-fresh-test.md`
  - **THIS FILE** (`.omo/handoffs/2026-05-25-sonnet-architecture-alcance.md`)
- **TESTING.md**: `/Users/irina/AI-driven-OS/autonomous/redin/marketplace/TESTING.md` — stage 0-8 launch plan. **Gap A section is stale (already implemented)**.
- **HR dashboard design**: `docs/design/hr-dashboard-research.md`
- **Real chat test results**: `data/test-results/May25-*` (multiple architect + worker conversations)

---

## 10. Decisions log

| Date | Decision | Lock-in |
|---|---|---|
| 2026-05-25 | Sonnet 4.5 for Toño + Manos, env-overridable | Active in .env.local |
| 2026-05-25 | **AppSheet REMAINS the main system for tracking OTs** — Jose's universe stays canonical for OT lifecycle, billing, customer info, status | Architectural |
| 2026-05-25 | **Supabase owns marketplace data** (alcance, técnicos, postulaciones, contracts) — source of truth for what Jose's AppSheet doesn't model | Architectural |
| 2026-05-25 | **Projector mirrors alcance Supabase → AppSheet** so Jose's team has centralized OT visibility (intentional divergence from PRD §7 "no writeback v1" — Manos design required it) | Active, projector code in `sync/src/projector.ts` |
| 2026-05-25 | AppSheet write permission VERIFIED — text + base64 PDF both work via API on TEST OT | Empirical, captured in §1.2 |
| 2026-05-25 | **`Alcance_OT` field type — DEFERRED to next session** (durable link vs file upload — both viable) | Decision pending, see §6 Track B.1 |
| 2026-05-25 | Worker delivery format = PDF today (Gap A), PNG card v1.1 | Track A keeps PDF, Track D migrates |
| 2026-05-25 | **Manos must send both link + PDF document to architect after finalize** (Track A.1) | Pending implementation |
| 2026-05-25 | Drive sharing for AppSheet UI downloads = Jose's operational fix | Only needed if we go with file-upload approach for `Alcance_OT` |

---

## 11. Next-session starting prompt (copy-paste this to begin)

```
Read the latest handoff in full before doing anything else:
  /Users/irina/AI-driven-OS/autonomous/redin/marketplace/.omo/handoffs/2026-05-25-sonnet-architecture-alcance.md

Goal for this session:
  1. Verify dev services are alive (handoff §7 Resume Playbook). If Toño crashed
     or Manos still 440-loops, restart cleanly before anything else.
  2. Ship Track A.1 (handoff §6): Manos sends architect both a link + PDF
     document attachment via WhatsApp after finalize_alcance. ~30 min.
     - Edit tools/src/manos/finalize-alcance.ts to insert the two
       outbound_messages rows (sketch is in the handoff)
     - Edit manos/src/prompts/manos-system.ts to tell the LLM the send is
       automatic and its reply is just a short confirmation
     - npm run typecheck across both workspaces
     - Smoke test from a real architect test phone — finalize an alcance,
       verify link + PDF both arrive in WA within 5s
  3. THEN make the Alcance_OT field-type decision (handoff §6 Track B.1)
     with Irina. Two options proven viable:
        A. Durable link in text column (needs dashboard route /api/alcance/[ot_id])
        B. PDF file upload (proven works via base64; needs Drive share for HR)
     Pick ONE with reasoning. Implement projector change. Re-queue 3 OTs
     listed in handoff §1.5. Verify in AppSheet UI.
  4. ONLY THEN continue or restart green-line test from Phone A. Phone A
     state per handoff §1.4: approved Camilo Andrade, has seen Yopal OTs,
     pending postulación.

Do NOT touch:
  - The model swap (Sonnet 4.5 is locked and working)
  - The grounding gate (log-only is locked)
  - The CONTEXT_WINDOW=80 setting
  - The sendAgentReply enqueue-first pattern
  - Anything in the handoff §8 don't list

Strategic constraints:
  - AppSheet REMAINS the main system for OT tracking. Don't propose
    deprecating the writeback.
  - Track A.1 ships in its own commit. Track B.1 ships separately with
    rollback plan.
  - Cost cap is $10/day. Sonnet uses ~$0.13/turn (thinking enabled). Monitor
    daily_llm_cost throughout the session.

If anything is unclear after reading the handoff, ASK before implementing.
The user has been generous with diagnosis time this session — implementation
sessions should be high-confidence + decisive.
```

---

## Final note

The architecture is **clear**: AppSheet remains Jose's main OT tracking system, Supabase owns marketplace data, Projector mirrors alcance Supabase→AppSheet for centralized visibility. The remaining open question (Alcance_OT field type — link vs file) is best decided WITH Jose at the next session start.

Track A.1 (architect feedback) is independent of that decision and should ship first — fixes the worst current UX gap (architect blind after finalize).

Tonight's green-line test works on current code. Phone A's Camilo is approved and waiting for "me interesa la primera" to proceed. The test does NOT depend on Track A.1 or B.1.

Buena suerte.
