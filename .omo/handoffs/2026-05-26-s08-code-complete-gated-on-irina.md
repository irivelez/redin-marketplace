# Session Handoff — S08 Code Complete, Gated on Irina

**Saved:** 2026-05-26 ~22:50 PT · **By:** Sisyphus orchestrator · **Status:** S08 code+DB verified, awaiting live WA smoke + S09 decision

This handoff is a **delta** on top of [`.omo/handoffs/2026-05-25-sonnet-architecture-alcance.md`](./2026-05-25-sonnet-architecture-alcance.md) — read that first for full architectural context, Sonnet swap, AppSheet write findings, and the locked-in agent contracts. Everything in §3 Architecture Decisions LOCKED still holds.

---

## 0. TL;DR

1. **S08 (Track A.1) — Manos architect feedback loop — CODE COMPLETE.** Two files changed + a reusable smoke script. Typecheck clean. DB-layer smoke proves `outbound_messages` rows land with the exact shape the Manos drainer expects.
2. **NOT MARKED `done` in prd.json yet.** Marked `code_complete_pending_live_smoke`. Live WhatsApp delivery proof (the S08 acceptance criteria) requires Irina action.
3. **S09 (Track B.1) — Alcance_OT field type — UNDECIDED.** Recommendation: Option A (durable link via dashboard route). Final call needs Irina (per Hard Don't).
4. **Nothing committed.** S08 ships in its own commit once live smoke passes; S09 in a separate commit after decision.

---

## 1. S08 — what shipped (code only, uncommitted)

### Files changed

| File | Change | Why |
|---|---|---|
| [`tools/src/manos/finalize-alcance.ts`](../../tools/src/manos/finalize-alcance.ts) | +143 lines: added `enqueueArchitectAlcancePreview()` helper called from the success path after PDF upload + ots_extended update. Also added `descripcion` + `otBriefTitle` extraction from ots_mirror.data. | Architect was blind after finalize. Now they get a text-with-link + native WA document attachment in the same Manos thread. Non-fatal: preview failures log a warning, alcance still returns `ok`. |
| [`manos/src/prompts/manos-system.ts`](../../manos/src/prompts/manos-system.ts) | +10 lines: new `## Después de finalize_alcance` section | Tells the LLM the link+PDF send is automatic and its reply should be a short confirmation only ("Listo, te mandé el alcance…"). Prevents the LLM from pasting the URL itself (duplicate clutter). |
| [`scripts/smoke-s08-finalize-preview.ts`](../../scripts/smoke-s08-finalize-preview.ts) | NEW (~155 lines) | Reusable regression smoke. Uses fake phone `+19999999900` so cannot deliver to a real architect even if Manos drainer is alive. Creates test session, invokes finalizeAlcance, asserts 2 outbound rows with correct shape, cleans up. |
| [`prd.json`](../../prd.json) | S08 entry: added `progress_2026_05_26` block + changed status to `code_complete_pending_live_smoke` | Honest state tracking — not falsely marked done. |

### Phone routing model

`enqueueArchitectAlcancePreview` resolves the architect's phone via `ctx.session_id → sessions.phone` (channel-checked: only `channel='manos'` proceeds). This is correct because:
- The architect is talking to Manos from a specific phone in this session
- The reply must go back to THAT phone, not whatever's registered in `arquitectos_mirror.Telefono`
- Confirmed `ctx.session_id` is populated at `manos/src/agent.ts:81-89`

### Message shape (what lands in outbound_messages)

Both rows are `channel='manos'` so the Manos drainer at [`manos/src/outbound.ts:32-95`](../../manos/src/outbound.ts) picks them up. No drainer changes needed — it already handles `kind='document'` (contract PDF flow uses the same path).

**Text row:**
```json
{
  "channel": "manos",
  "kind": "text",
  "body": "Listo. Ya quedó el alcance para \"<descripcion or 'OT <idOrden>'>\".\n\nLo puedes abrir aquí:\n<24h signed URL>\n\nTambién te lo paso como documento. Si algo está mal, dime y lo regeneramos.",
  "meta": { "kind": "manos_alcance_preview_link", "ot_row_id": "...", "arq_row_id": "..." }
}
```

**Document row:**
```json
{
  "channel": "manos",
  "kind": "document",
  "body": "Alcance OT <idOrden>",
  "attachment_path": "<ot_row_id>/alcance.pdf",
  "attachment_bucket": "alcance-photos",
  "attachment_filename": "Alcance_OT_<idOrden>.pdf",
  "meta": { "kind": "manos_alcance_preview_doc", "ot_row_id": "...", "arq_row_id": "..." }
}
```

Note: `idOrden` comes from `ots_mirror.data.ID_Orden` (always a string in prod, hex-slug like `9f79d8c7`). Falls back to first 8 chars of `ot_row_id` if missing.

### Verification done

| Check | Evidence |
|---|---|
| TypeScript | `npm run typecheck` PASSED across all 6 workspaces (shared, tools, tono, manos, sync, dashboard) |
| DB-layer smoke | `npx tsx --env-file=.env.local scripts/smoke-s08-finalize-preview.ts` PASSED. Target OT `LK4cgHD0DlytRsCBwx8zKZ` ("TEST TONO — DO NOT EXECUTE"). 2 rows landed with correct shape; cleanup successful. Side effect: created the missing `alcance.pdf` for LK4 in `alcance-photos` bucket (non-destructive, was null). |
| Drainer reuse | Manos outbound drainer unchanged — same code path that ships contract PDFs in production. `attachment_bucket='alcance-photos'` is explicit on our rows (drainer's fallback default is also `'alcance-photos'`, defined in outbound.ts:63). |

### Verification STILL OWED (the S08 done bar)

Per prd.json S08 acceptance criteria lines 173-176, S08 is not done until:
> Within 5s in same WA thread: receive text message with link AND a PDF document attachment

That requires the Manos service to be live + reachable on Baileys, then a real architect (whose number is in `arquitectos_mirror`) finalizes an alcance. **Cannot be done by me** because:
- Local Manos is still 440-looping (Railway `manos-mp` owns the WA session per prior handoff §5)
- Stopping Railway services + deploying are Hard Don'ts without Irina's explicit call

---

## 2. S09 — decision still pending

Per prior handoff §6 Track B.1 — both Option A (durable link) and Option B (PDF base64 upload) proven viable on TEST OT. Recommendation from this session is **Option A** for these reasons:

1. **Risk isn't on us.** Option B requires Jose to share AppSheet's Drive folder with HR Google accounts (per prior handoff §2.5 — the actual blocker for AppSheet UI download today). If he doesn't, we ship code that's only half-useful.
2. **Iterative-edit story.** S08 enables architects to re-finalize after preview. With Option A, the same link always serves the latest PDF — re-finalize propagates transparently. Option B creates a new file ref each time (snapshot semantics).
3. **Auth is solvable.** Public-by-`ot_row_id` is acceptable — the row_id is a 22-char UUID-ish slug, not enumerable, and alcance content has no PII. Treat it like Notion's "anyone with link" model.
4. **Smaller blast radius.** Route lives in dashboard; if it breaks, dashboard team owns it, not Jose's universe.

**Counter-case for Option B:** if Jose explicitly wants native AppSheet file widgets (no browser switch on mobile) AND will fix Drive perms in the same window, B becomes attractive.

**Implementation skeleton if Option A (NOT YET WRITTEN):**
- `dashboard/src/app/api/alcance/[ot_id]/route.ts` — fetches `ots_extended.alcance_pdf_path` for the given `ot_id`, streams bytes from `alcance-photos` bucket via service-role client, returns `application/pdf` with `Content-Disposition: inline; filename="Alcance_OT_<id>.pdf"`. Public route (no auth on PDF retrieval) — `ot_row_id` is the access token.
- `sync/src/projector.ts buildAlcanceOtValue` — replace current text-with-PDF-path with `${DASHBOARD_URL}/api/alcance/${otRowId}`. Need `DASHBOARD_URL` env var (probably already set for other dashboard links).
- Re-queue 3 OTs: `UPDATE ots_extended SET appsheet_alcance_pending=true, appsheet_alcance_sync_attempts=0, appsheet_alcance_last_error=null WHERE ot_row_id IN ('Ht6UBQ8NmNacSb0Hgnd66Q', '1BtTtVebo55GQzxYoaWgv6', 'LK4cgHD0DlytRsCBwx8zKZ')`.
- Verify in AppSheet UI: open each OT, click the Alcance_OT link, PDF loads in browser.

**Rollback plan if Option A breaks:**
- Revert the commit
- `UPDATE ots_extended SET appsheet_alcance_pending=true...` to re-queue with the previous format (text-with-PDF-path)

---

## 3. Action plan when Irina is back

### Step 1 — Live WA smoke for S08 (~5 min once Manos is live)

```bash
# Option A: reclaim WA session for local dev
# 1. Open Railway dashboard → stop service `manos-mp` → wait 30s
# 2. Start local Manos:
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace
pkill -9 -f "manos.*runner" 2>/dev/null; sleep 2
nohup npm run manos:dev > /tmp/manos-dev.log 2>&1 & disown
sleep 10
tail -20 /tmp/manos-dev.log    # look for "Manos is online" (no 440)

# 3. From a real architect's WhatsApp (must be in arquitectos_mirror):
#    a. Send "hola" to +573222392959
#    b. Cédula response (10 digits)
#    c. "qué OTs tengo"
#    d. Pick an OT, send a photo + voice describing scope
#    e. Confirm → finalize

# 4. Within 5s, the architect should receive:
#    - A text message with a 24h signed URL
#    - A PDF document attachment (native WA inline preview)

# 5. Verify in logs:
tail -50 /tmp/manos-dev.log | grep "alcance preview\|sent.*kind=document\|sent.*kind=text"

# 6. Verify in DB:
set -a && source .env.local && set +a
curl -sS "$SUPABASE_URL/rest/v1/outbound_messages?meta-%3E%3Ekind=in.(manos_alcance_preview_link,manos_alcance_preview_doc)&select=id,kind,status,meta,sent_at&order=created_at.desc&limit=5" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
# Expected: 2 rows with status='sent', sent_at populated
```

### Step 2 — Mark S08 done + commit (after live smoke passes)

```bash
# Update prd.json S08:
#   - status: "done"
#   - add to progress_2026_05_26: live_wa_smoke: {ran: ..., result: "PASS", evidence: "..."}

# Then commit S08 alone:
git add tools/src/manos/finalize-alcance.ts \
        manos/src/prompts/manos-system.ts \
        scripts/smoke-s08-finalize-preview.ts \
        prd.json
git commit -m "S08: Manos architect feedback loop — send link + PDF after finalize

After finalize_alcance succeeds, enqueue 2 outbound_messages rows that the
Manos drainer ships to the architect in the same WA thread: a text with a
24h signed URL, and the PDF as a native WA document attachment. Architect
no longer flies blind after the conversation ends.

Phone routing via sessions.id (channel='manos'). Non-fatal: preview failures
log warn, alcance still returns ok. Drainer unchanged (reuses contract PDF path).

Verification: scripts/smoke-s08-finalize-preview.ts + live WA smoke from
real architect phone (link + PDF both arrived <5s)."
```

### Step 3 — S09 decision + implement (separate commit)

- Pick A or B with reasoning written in the prior handoff §10 Decisions log
- Implement (skeleton for Option A in §2 above)
- Re-queue 3 OTs, verify in AppSheet UI
- Commit separately with rollback plan in the commit body

### Step 4 — Resume green-line (Phone A / Camilo)

Per prior handoff §1.4 + §6 Track B:
- Camilo is approved, `tecnico_id 868ad622-9312-4729-a853-5c9aa7fd25c2`, phone `+137877543452841`, ciudad Yopal, has seen 2 Yopal OTs
- Send "me interesa la primera" → `create_postulacion`
- Dashboard `/hr/shortlist/<ot_id>` → Preseleccionar → Gap A delivers text + PDF
- Phone A: "acepto" → pre-LLM short-circuit confirms
- Dashboard `/hr/contratos/[id]` → Generar y enviar → contract PDF
- GREEN LINE CLOSED

---

## 4. State carryover (still true from prior handoff)

- **Sonnet 4.5** still loaded: `.env.local` has `TONO_MODEL=claude-sonnet-4-5` + `MANOS_MODEL=claude-sonnet-4-5`. Confirmed via `grep TONO_MODEL\|MANOS_MODEL .env.local` this session.
- **Dev services state:** Dashboard ✅ 200, Toño ✅ on Sonnet (last llm_call 04:11 UTC yesterday), Sync ✅ running 15min cron. Manos 🔴 stopped (440-loop).
- **Phone A state:** unchanged from prior handoff §1.4. Camilo Andrade approved, waiting on "me interesa la primera".
- **Architecture locks (prior handoff §3) all still hold:** AppSheet = main OT tracking, Supabase = marketplace data, Projector = only writer to AppSheet, etc.

---

## 5. Don't list (carry-over only — no new entries)

All Hard Don'ts from prior handoff §8 still active. Specifically reaffirmed this session:
- **No unilateral S09 decision.**
- **No Manos restart without Irina's call** (would compete with Railway).
- **No commits without explicit ask** (S08 staged but uncommitted).
- **No `as any` / `@ts-ignore`** — typecheck clean without escape hatches.

---

## 6. Files touched this session

```
M tools/src/manos/finalize-alcance.ts    # +143 lines: enqueueArchitectAlcancePreview helper
M manos/src/prompts/manos-system.ts       # +10 lines: ## Después de finalize_alcance
M prd.json                                # S08 progress block + status update
A scripts/smoke-s08-finalize-preview.ts   # NEW reusable smoke
A .omo/handoffs/2026-05-26-s08-code-complete-gated-on-irina.md  # this file
```

No other code touched. Pre-existing uncommitted work in dashboard/, tono/, manos/outbound.ts, etc. is from prior sessions/agents and was left strictly alone per "NEVER REVERT WORK YOU DID NOT MAKE".

---

## 7. Cost note

This session used Sonnet 4.5 with thinking-on. Estimated <10 turns total. Well under the $10/day cap.
