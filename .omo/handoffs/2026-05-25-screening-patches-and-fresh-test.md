# Session Handoff — Screening Patches + Fresh Live Test

**Saved:** 2026-05-25 14:16 PT · **By:** Sisyphus orchestrator · **Status:** ready for live WA test from Irina's Phone A (+137877543452841)

This handoff **supersedes** `.omo/handoffs/2026-05-25-cedula-gate-and-live-test.md`. Read this whole file first, then resume.

---

## 0. TL;DR for the new session

1. All services up locally; Railway prod (`tono-mp`, `manos-mp`) is **stopped** so dev WhatsApp sessions don't conflict.
2. **9 patches shipped today** beyond the cédula-gate handoff: warm prompt restoration, proactive `trabajos_previos` ask, cédula both-sides + photo-quality REGLA, "RRHH" → "nuestra área de talento humano", EPS auto-downgrade REMOVED, outbound delivery race fix (Tono + Manos), context window 24 → 80, inbound dedup by `msg.key.id`.
3. **DB clean slate**: no Phone A residue (last test wiped per Irina's request).
4. **Live test is pending**: Irina sends "hola" from Phone A → screening → HR approve → Manos generates alcance for a Yopal OT → returning worker → postulación → HR sends contract draft.
5. **Two named deferrals** for v1.1 (out of scope today, do NOT ship now): (a) self-critique pass before `submit_candidate_dossier`, (b) `collected_so_far` summary block that survives context truncation.

---

## 1. Locked Policy Decisions (carried forward + new)

Carried from `.omo/handoffs/2026-05-25-cedula-gate-and-live-test.md` §1 — still in force:

| # | Decision | Where it lives |
|---|---|---|
| 1 | Mandatory doc for approval = cédula photo ONLY | `hasCedulaUploaded()` in tools/src/missing-docs.ts; gate in dashboard/src/lib/decisions.ts |
| 2 | ARL: never blocks. Soft signal only. | submit-candidate-dossier.ts |
| 3 | **EPS: never blocks.** Preferred-only. | submit-candidate-dossier.ts — **auto-downgrade REMOVED today (this session)** |
| 4 | HR can override the cédula gate by typing a note | decisions.ts + QueueListClient.tsx |
| 5 | WA notifications fire on `approve` / `reject` / `schedule_call` only | unchanged |
| 6 | Every uploaded document is auto-classified via Gemini multimodal | upload-documento.ts (fire-and-forget) |

New this session:

| # | Decision | Date | Where |
|---|---|---|---|
| 7 | **Cédula = both sides** (front + back), each photo uploaded separately, prompt template now hard-codes the request | 2026-05-25 | tono-system.ts §"Foto de la cédula" |
| 8 | **Photo-quality REGLA** applies to every doc request (ARL/EPS/cert_estudios/cert_trabajos_previos): clear, well-lit, complete, no reflections. Toño asks for a repeat ONCE if quality is bad, then accepts and flags in `tono_reasoning`. | 2026-05-25 | tono-system.ts §"REGLA DE CALIDAD DE FOTO" |
| 9 | **Trabajos previos / referencias is now a REGLA — Toño asks proactively every screening** | 2026-05-25 | tono-system.ts §screening checklist |
| 10 | **"RRHH" replaced with "nuestra área de talento humano"** in all user-facing copy and LLM-visible prompts/schemas | 2026-05-25 | tono-system.ts, schemas.ts, find-legacy-by-name.ts |

---

## 2. Patches shipped this session (2026-05-25 ~13:00–14:15 PT)

### Outbound delivery resilience (fixes the cold-greeting bug from the previous handoff)

- ✅ **`tono/src/runner.ts`** — replaced direct `wa.sendText(jid, result.reply)` with new `sendAgentReply(supabase, wa, …)` helper. Persists to `outbound_messages` BEFORE attempting Baileys send; on success marks `sent`; on failure leaves row pending for the drainer to retry on reconnect. No more silent message loss during 440 reconnect storms.
- ✅ **`tono/src/outbound.ts`** — added the `sendAgentReply` helper. Updates `lastSentAt` map after a successful direct send so the drainer's 10s rate limiter doesn't burst against HR-triggered messages.
- ✅ **Same pattern mirrored in `manos/src/runner.ts` + `manos/src/outbound.ts`** with `channel: "manos"` tag to keep Manos's drainer separate from Toño's.

### Warmth restoration in Toño's prompt

- ✅ **`tono/src/prompts/tono-system.ts` line ~80 (voice rules)** — expanded with explicit list of OK acknowledgments ("Listo", "Dale", "Perfecto", "Bueno", "Excelente", "Mira casi termino", "Sin problema"). Distinguished real warmth from banned corporate filler.
- ✅ **Line ~81 (emoji rule)** — replaced "cuentagotas" wording with "UNO en el saludo de bienvenida está bien". Kills the over-cautious zero-emoji interpretation.
- ✅ **Line ~340-348 (CASE B opener)** — opener template now hard-codes the warm pattern:

  > "Qué más. Soy Toño, de Redin. 🔨\n\nTe ayudo a conectarte con trabajo de mantenimiento — instalaciones, reparaciones, todo eso. ¿Cuál es tu nombre completo y en qué ciudad estás?"

- ✅ **Line ~76 (tú-register rule)** — added "nunca 'vos'" to kill rioplatense drift observed in early test.

### Proactive screening additions

- ✅ **`tono-system.ts` §"Calificación del perfil"** — added Trabajos previos / referencias as a **REGLA — pregunta SIEMPRE**:

  > "¿Dónde has trabajado antes? Cuéntame brevemente — alguna empresa, obra o proyecto que recuerdes, y si tienes constancia o referencia, mejor."

  Follow-up for `cert_trabajos_previos` upload if worker mentions something concrete.

### Cédula both sides + photo quality

- ✅ **`tono-system.ts` §"Foto de la cédula"** — request both sides explicitly, with quality guidance inline. After first photo, "Recibí la primera. Ahora mándame la otra cara, por favor." After second, "Listo, recibí las dos. Sigamos."
- ✅ **`tono-system.ts` §"REGLA DE CALIDAD DE FOTO"** — new top-level rule applying to every doc request. Toño asks for repeat ONCE if quality is bad, then accepts and flags in `tono_reasoning`.
- ✅ Each per-doc template (ARL, EPS, cert_estudios, cert_trabajos_previos) updated with quality reminder.

### EPS auto-downgrade removal (fixes "estado EPS desconocido" bug)

- ✅ **`tools/src/submit-candidate-dossier.ts` lines ~294-320** — REMOVED both branches (`epsDeclaredNoDoc` and `epsUnknownNoDoc`) that stomped on Toño's `recommend_approve` with misleading "[Auto-downgrade: estado EPS desconocido …]" prefix. Per locked decision #3, EPS never blocks.
- ✅ Replaced with accurate gap entries: `"Sin EPS declarada — Redin puede orientar al técnico"`, `"EPS declarada sin documento — Redin puede pedir el carné en validación"`, etc.
- ✅ ARL gaps also normalized to descriptive wording.

### "RRHH" → "nuestra área de talento humano"

- ✅ **`tono/src/prompts/tono-system.ts`** — 24 occurrences replaced + 3 sentence-starts capitalized
- ✅ **`tools/src/schemas.ts`** — 6 occurrences (tool descriptions visible to the LLM)
- ✅ **`tools/src/find-legacy-by-name.ts`** — 1 occurrence (user-facing string)
- ✅ Skipped intentionally: `sync/src/proactive-followup.ts` (code comment only), `TESTING.md` (internal docs), `.claude/worktrees/*` (other branches)

### Context window + inbound dedup (fixes Carlos amnesia + duplicate-reply bugs)

- ✅ **`tono/src/session.ts` line 11** — `CONTEXT_WINDOW: 24 → 80`. Carlos's 22-turn screening dropped cédula intake out of the window; bumping covers ~26 turns. Mirrored in `manos/src/session.ts`.
- ✅ **`tono/src/whatsapp.ts` handleIncoming** — added `seenMessageIds: Set<string>` (bounded at 500). Baileys redeliveries (network glitch / `append` after missed `notify`) are now no-op. Same fix in `manos/src/whatsapp.ts`.

### Env / infra fixes

- ✅ **`.env.local`** — added `GROQ_API_KEY` (from Railway `manos-mp`) + `MANOS_WA_NUMBER=+573222392959`. Fixed prior concatenation corruption between ANTHROPIC_API_KEY and GROQ_API_KEY.
- ✅ **Railway `manos-mp` stopped** so local Manos can claim the WA session at +573222392959.

### DB hygiene

- ✅ Deleted orphan session `9b5312fb-...` from the 440-storm incident (2 turns + 1 session row)
- ✅ Deleted test worker "Andrés Pérez" (full cascade: 7 eventos, 1 dossier, 1 documento, 1 session, 1 tecnico)
- ✅ Deleted test worker "Carlos Pérez" (full cascade: 5 eventos, 2 documentos, 1 session w/ 22 turns, 38 outbound, 1 tecnico)

---

## 3. Current running state (live, on this Mac)

| Service | State | Connection | Log |
|---|---|---|---|
| **Dev Toño** | running | WhatsApp @ +14157916801 | `tail -f /tmp/tono-dev.log` |
| **Dev Manos** | running | WhatsApp @ +573222392959 | `tail -f /tmp/manos-dev.log` |
| **Dev Sync** | running | cron */15 + projector 60s | `tail -f /tmp/sync-dev.log` |
| **Dashboard** | running | http://localhost:3000 | `tail -f /tmp/dashboard-dev.log` |
| **Supabase** | live, production | https://foerbjhnwbxfauajkbld.supabase.co | — |
| **Railway `tono-mp`** | **STOPPED** | bring back with `railway service redeploy --service tono-mp` | — |
| **Railway `manos-mp`** | **STOPPED** | bring back with `railway service redeploy --service manos-mp` | — |

**Process expectation**: 3 tsx --watch trees (Tono + Manos + Sync), 9 marketplace runner processes (3 per tree). Plus 1 `next dev`.

### Phone state for the test

| Phone | Role | Status |
|---|---|---|
| +14157916801 (US virtual) | Toño's WhatsApp number | the phone that scanned the QR; controls the WA account |
| +573222392959 (Colombian) | Manos's WhatsApp number | paired May 14; the phone Irina uses AS the architect |
| **+137877543452841 (Irina's personal Colombian)** | **the worker in the test** | **unknown to system — fresh new-worker screening on next "hola"** |

---

## 4. Pre-flight data sanity (the test plan depends on these)

- **34 OTs in state 4** (offerable to approved workers) across cities including Bogotá (10), Pasto (3), Neiva (3), Yopal (2), Popayán (2), Yumbo, Villavicencio, Manizales, etc.
- **3 OTs already have alcance** (Manos-generated scope) in `ots_extended`:
  - `1BtTtVebo55GQzxYoaWgv6` — Yopal (Pintura)
  - `Ht6UBQ8NmNacSb0Hgnd66Q` — Yopal (Pintura)
  - `LK4cgHD0DlytRsCBwx8zKZ` — Popayán (Eléctrico)
- **Recommended worker ciudad for test**: Yopal or Popayán. Either guarantees there's an alcance-ready OT visible after HR approval.

---

## 5. Files changed this session

```
M tono/src/runner.ts                          # sendAgentReply for outbound resilience
M tono/src/outbound.ts                        # sendAgentReply helper + lastSentAt update
M tono/src/whatsapp.ts                        # seenMessageIds dedup
M tono/src/session.ts                         # CONTEXT_WINDOW 24 -> 80 + docs
M tono/src/prompts/tono-system.ts             # warmth, trabajos_previos, cédula both sides,
                                              # photo quality, EPS prompt rules, RRHH replace,
                                              # nunca "vos"
M tools/src/submit-candidate-dossier.ts       # EPS auto-downgrade removed + accurate gaps
M tools/src/schemas.ts                        # RRHH replace
M tools/src/find-legacy-by-name.ts            # RRHH replace
M manos/src/runner.ts                         # sendAgentReply for outbound resilience
M manos/src/outbound.ts                       # sendAgentReply helper (channel="manos")
M manos/src/whatsapp.ts                       # seenMessageIds dedup
M manos/src/session.ts                        # CONTEXT_WINDOW 24 -> 80

A .omo/handoffs/2026-05-25-screening-patches-and-fresh-test.md   # this file
```

Untracked (still on disk from previous handoff session): see prior handoff §7.

---

## 6. The Test Plan That's Pending (resume here)

### Green-line definition (per Irina, this session):
> "An approved blue collar asks Toño for new jobs, Toño provides the suitable options with the scope already in OTs in state 4, the blue collar accepts or rejects, and HR makes the final decision by hitting the button to send the contract draft. That's the green line."

**Test finish:** HR clicks "Generar y enviar contrato" → worker's phone receives the contract PDF on WhatsApp.

### Phases:

| # | Phase | Phone | What happens | Watch in |
|---|---|---|---|---|
| 1 | New worker screening | Phone A (+137877543452841) | "hola" → 22-ish turns → submit_candidate_dossier → `pending` | tono log + Supabase tecnicos_extended |
| 2 | HR approves | dashboard | open `/hr/qualification-queue` → click into Phone A → DocViewer shows cédula photos w/ classification → click Aprobar (cédula present → no gate fires) → composite WA push with matching OTs | dashboard E2E |
| 3 | Manos generates alcance | Architect phone → Manos (+573222392959) | WA Manos with voice/photo describing scope for an OT in Yopal → Manos finalizes → projector writes Alcance_OT to AppSheet | manos log + sync log + AppSheet |
| 4 | Returning worker | Phone A | "¿hay trabajo?" → Toño in returning mode → read_pending_ots → shows OTs with scope → worker says "me interesa OT X" → create_postulacion | tono log + Supabase postulaciones |
| 5 | Multi-worker concurrency | Phone B (TBD) | second worker screens in parallel — verify per-phone mutex + no state bleed | tono log |
| 6 | HR sends contract (FINISH) | dashboard | HR picks Phone A in shortlist → `/hr/contratos/[id]` → "Generar y enviar" → PDF rendered + sent to worker on WA | dashboard + tono outbound drainer + Phone A WhatsApp |

### What success looks like

- Warm opener with 🔨 lands on Phone A
- Toño asks ONE question per turn (no bundling)
- Toño asks proactively about trabajos previos (e.g., "¿Dónde has trabajado antes?")
- Cédula request asks for BOTH SIDES with photo-quality guidance
- After turn 22+, Toño DOES NOT re-ask for cédula or photos (CONTEXT_WINDOW=80 in effect)
- If WhatsApp redelivers a message, Toño does NOT reply twice (dedup in effect)
- `tono_reasoning` does NOT start with `[Auto-downgrade: estado EPS desconocido …]` (EPS downgrade removed)
- Toño uses "nuestra área de talento humano" instead of "RRHH"
- Composite WA push lands on Phone A with matching Yopal/Popayán OTs
- Manos alcance ends up readable in worker's `read_pending_ots` response
- Final contract PDF arrives on Phone A as a WhatsApp document

---

## 7. Resume Playbook for a fresh terminal session

```bash
# 1. Verify location
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace
pwd

# 2. Read this handoff, then check service health
curl -sS -o /dev/null -w "Dashboard: %{http_code}\n" http://localhost:3000
ps -eo pid,etime,command | grep "marketplace.*src/runner.ts" | grep -v grep | wc -l   # expect 9

# 3. Check each service log
tail -3 /tmp/tono-dev.log
tail -3 /tmp/manos-dev.log
tail -3 /tmp/sync-dev.log

# 4. If any service died, restart it:
#    pkill -9 -f "tono.*runner.ts" ; sleep 2 ; nohup npm run tono:dev  > /tmp/tono-dev.log  2>&1 & disown
#    pkill -9 -f "manos.*runner.ts" ; sleep 2 ; nohup npm run manos:dev > /tmp/manos-dev.log 2>&1 & disown
#    pkill -9 -f "sync.*runner.ts"  ; sleep 2 ; nohup npm run sync:dev  > /tmp/sync-dev.log  2>&1 & disown

# 5. Sanity check Supabase Mgmt token still valid
set -a && source .env.local && set +a
curl -sS -w "%{http_code}\n" -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF" -o /dev/null   # expect 200

# 6. Confirm Phone A is clean
curl -sS "$SUPABASE_URL/rest/v1/tecnicos_extended?phone=eq.%2B137877543452841&select=tecnico_id" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
# expected: []

# 7. Watch logs in two tabs:
tail -f /tmp/tono-dev.log  | grep -E "^20[0-9]{2}-"
tail -f /tmp/manos-dev.log | grep -E "^20[0-9]{2}-"

# 8. Open dashboard, log in:
#    http://localhost:3000/login → magic-link to irina.andreav@gmail.com

# 9. Have Irina send "hola" from Phone A. Resume the test from §6.
```

### If Tono drops messages / hits a 440 storm AGAIN

This SHOULD be fixed now (outbound resilience patch). But if it recurs, the chain is:

```bash
# Confirm Railway prod tono-mp is still stopped (otherwise it steals the session)
railway service tono-mp && railway logs --service tono-mp 2>&1 | tail -5   # last line should be "Stopping Container"

# If Railway prod is somehow running:
railway down --service tono-mp -y   # OR: stop in Railway dashboard

# Restart local Tono cleanly
pkill -9 -f "tono.*runner.ts" ; sleep 2
nohup npm run tono:dev > /tmp/tono-dev.log 2>&1 & disown
```

### Cleanup script (wipe a worker between tests)

```bash
set -a && source .env.local && set +a
TID="<tecnico_id from tecnicos_extended>"
PHONE_ENC="%2B<digits-only-phone>"

for T in postulaciones eventos qualification_calls tecnico_evaluations \
         candidate_dossiers candidate_decisions hr_notes contratos documentos ; do
  if [ "$T" = "eventos" ]; then COL="entity_id"; else COL="tecnico_id"; fi
  curl -sS -X DELETE "$SUPABASE_URL/rest/v1/$T?$COL=eq.$TID" \
    -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
    -H "Prefer: return=representation" >/dev/null
done

curl -sS -X DELETE "$SUPABASE_URL/rest/v1/sessions?phone=eq.$PHONE_ENC" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" >/dev/null

curl -sS -X DELETE "$SUPABASE_URL/rest/v1/outbound_messages?phone=eq.$PHONE_ENC" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" >/dev/null

curl -sS -X DELETE "$SUPABASE_URL/rest/v1/tecnicos_extended?tecnico_id=eq.$TID" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" >/dev/null

echo "  done — verify with select queries"
```

---

## 8. Deferred (v1.1, do NOT ship today)

These were identified as high-leverage upgrades but are explicitly out of scope for today's ship:

| # | Item | Why deferred | Estimated cost |
|---|---|---|---|
| 1 | **Self-critique pass before `submit_candidate_dossier`** | Catches contradictions like the one Carlos's dossier had (Toño's reasoning said "no EPS" but the handler text said "estado desconocido"). One extra Haiku call: "review this dossier vs the conversation; flag inconsistencies." | ~2h, +$0.001/turn |
| 2 | **`collected_so_far` summary block in per-turn context** | Survives CONTEXT_WINDOW truncation. The 80-message bump covers ~26 turns; a screening with many tool retries could still exceed. Right structural fix is a summary injected every turn. | ~3h |
| 3 | **Flip grounding gate from log-only to enforce + retry** | PRD §22 calls for `grounded=true` to actually block hallucinated specifics. Today it just records to `turns.grounding_violations`. When violated, replay LLM with the violation as feedback. | ~1h |
| 4 | **Gap A — Alcance PDF on HR preselect** | Already documented in `TESTING.md §4.2`. Worker would receive alcance PDF + offer text when HR clicks "preseleccionar". Not blocking today's green-line because worker sees alcance via `read_pending_ots` BEFORE postulating. | ~1-2h |
| 5 | **Gap B — Contract signing via WA** | Worker replies "firmo" → state machine flips to `firmado` → postulación → `asignado`. Today's green-line stops at "contract draft sent"; signing flow is v1.1. | ~1 day |
| 6 | **Audit other handlers for over-aggressive determinism** | EPS auto-downgrade is fixed. Same pattern could exist elsewhere — anywhere a handler stomps on `tono_recommendation` / `tono_reasoning` is a smell. | ~1h audit |

---

## 9. Hard Don'ts (carry-over + new)

From prior handoff (still active):
- DO NOT touch the contract HITL gate
- DO NOT delete `ot_offers` / "Enviar oferta" UI
- DO NOT add Excel parsing in v1
- DO NOT change Manos's architecture
- DO NOT use `as any` / `@ts-ignore` / `@ts-expect-error`
- DO NOT write tests (per redin-builder agent description)
- DO NOT push to GitHub or deploy without Irina's call
- DO NOT make ARL or EPS mandatory for approval. Only cédula photo blocks.
- DO NOT add WA notifications to `unschedule_call` / `revoke` / `reopen`
- DO NOT await `classifyDocumento` inside `upload_documento`. Fire-and-forget is intentional.

New for this session:
- **DO NOT revert any of today's 9 patches** — each fixes a named live-test bug. List in §2.
- **DO NOT reintroduce the EPS auto-downgrade** — locked decision #3 (2026-05-25): EPS never blocks.
- **DO NOT shrink `CONTEXT_WINDOW` back to 24** — it was a Gemini-era spec; Haiku 4.5 handles 80 message-rows easily and screening reliability requires it. If token budget becomes a concern, ship `collected_so_far` summary (§8 deferred #2) instead of cutting the window.
- **DO NOT remove the `sendAgentReply` enqueue-first pattern** — direct `wa.sendText()` loses messages during Baileys reconnect storms. The pattern is documented at length inside `tono/src/outbound.ts` and `manos/src/outbound.ts`.

---

## 10. Critical context (paths)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **About Irina**: `/Users/irina/AI-driven-OS/about_me/` (read on demand only)
- **Prior handoff**: `.omo/handoffs/2026-05-25-cedula-gate-and-live-test.md`
- **Older handoff**: `.omo/handoffs/2026-05-24-redin-2day-ship.md`
- **HR dashboard design**: `docs/design/hr-dashboard-research.md`
- **Conversations from this session**: `data/test-results/May25-Andres-Tono/_chat.txt`, `data/test-results/May25-Carlos-Tono/_chat.txt`, `data/test-results/may25-chat-tono.txt` (morning warm-style reference)
- **Tono system prompt (the file Irina tunes most)**: `tono/src/prompts/tono-system.ts`
- **The 9-tool contract dispatcher**: `tools/src/index.ts`
- **HR dashboard queue**: `dashboard/src/app/hr/qualification-queue/`
- **Contract send flow**: `dashboard/src/app/hr/contratos/[id]/actions.ts`

---

## 11. Final note

The architecture is solid. Today's bugs were all in deterministic wrappers being too aggressive (EPS auto-downgrade), context being too tight (CONTEXT_WINDOW=24), or delivery missing safety nets (no enqueue-before-send, no inbound dedup). Haiku 4.5 itself was reasoning correctly — it just needed a bigger window to remember, and gates that didn't override it.

The green-line is ready to fire. Worker → HR approve → Manos alcance → returning worker postulates → HR contract send. Yopal is the recommended ciudad — 2 alcance-ready OTs already there.

When the test passes: commit the 12 modified files with a single message ("feat: screening warmth + cédula both-sides + EPS downgrade removal + outbound resilience + context window 80 + inbound dedup"), then `railway service redeploy --service tono-mp` and `--service manos-mp`.

Buena suerte.
