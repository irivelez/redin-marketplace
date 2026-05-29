# Session Handoff — Toño v1 SHIPPED + verified end-to-end + 2 latent bugs tracked

**Saved:** 2026-05-28 ~15:45 PT · **By:** Sisyphus orchestrator · **Status:** 🟢 To\u00f1o v1 working in production · 🟡 2 known bugs filed (S12, S13)

Continues from [`2026-05-28-pr10-fixes-classify-latency-toc.md`](./2026-05-28-pr10-fixes-classify-latency-toc.md). Read in order if catching up.

---

## 0. TL;DR for next session

1. 🟢 **[PR #10](https://github.com/irinavelezk/redin-marketplace/pull/10) MERGED** at 2026-05-28T22:11:48Z. Merge commit `98aefea971d2b47df8ac0d3156df6802f8955a15`. Railway auto-deployed `dashboard-mp` + `tono-mp` from new `main` tip.
2. 🟢 **Toño v1 verified end-to-end on Irina's phone** (`+137877543452841`, 14:45–15:37 PT). Full happy path closed the loop: registration → cédula photos → screening → approval → 3 OTs offered → "3" → postulación → preselect → contract PDF delivered. Transcript at [`data/test-results-tono/May28-irina-tono/_chat.txt`](../../data/test-results-tono/May28-irina-tono/_chat.txt).
3. 🟢 **TOC swap CONFIRMED live in production.** Approval push lines 61-65 of Irina's transcript show all 3 Bogotá OTs WITHOUT `— $X.XXX.XXX` segment (silent omission because all 3 have TOC=0). This was the Bug #1 from Juan's earlier test on the same day. Now resolved.
4. 🟡 **Bug #2 reproduced** — duplicate-question pattern still fires in production. Line 21-22 of Irina's transcript: "mándame dos fotos de tu cédula" sent twice at 15:27:04 + 15:27:15 (11s apart). Same pattern Juan saw at 14:48 PT. Code-path analysis proves it's NOT in the agent loop (single-emission guaranteed); root cause is WhatsApp/Baileys re-delivering user input with different `msg.key.id` defeating dedup. Tracked as **S12** in prd.json with fix sketch.
5. 🟡 **Grounding gate noise** confirmed from Juan's session — flagged user's own nombre (Juan/Pablo) + domain terms (RETIE, SISO, ARL, EPS) as ungrounded. Log-only so no user impact, but hides real hallucinations. Tracked as **S13** in prd.json.
6. 🟢 **3 test personas cleaned today** — Juan Pablo Gómez Hurtado (post-his-test), Irina Vélez López (post-her-test), Camila Florez (partial-screening leftover). All cascade-deleted from Supabase + AppSheet. Phones `+137877543452841` and `+77824840962292` at 0 sessions / 0 outbound.
7. 🟢 **prd.json updated** with S12 + S13 entries (this commit). Total stories now 13.

---

## 1. PR #10 final outcome

| | |
|---|---|
| **Title** | feat(pilot): catch-up — model swap + caching + WA number + taxonomy + SISO + photo batching + S08 + HR doc viewer |
| **Merged at** | 2026-05-28T22:11:48Z |
| **Merge commit** | `98aefea971d2b47df8ac0d3156df6802f8955a15` |
| **Method** | `--merge` (22 commits preserved) |
| **Build** | Railway auto-deployed (validated via successful live test minutes later) |

---

## 2. Live test #2 — Irina Vélez López ([`data/test-results-tono/May28-irina-tono/_chat.txt`](../../data/test-results-tono/May28-irina-tono/_chat.txt))

**Phone:** `+137877543452841` · **Cédula:** `1098665443` · **Especialidad:** albañilería · **Ciudad:** Bogotá

| Phase | Time (PT) | Result |
|---|---|---|
| Cold start | 15:20:31 → 15:20:51 | Redin-branded greeting ✅ |
| Nombre + ciudad | 15:24:09 → 15:24:22 | Captured correctly ✅ |
| Especialidad | 15:24:44 → 15:24:59 | "albañilería" mapped ✅ |
| Contact phone | 15:25:47 → 15:26:08 | 10-digit validation passed ✅ |
| Cédula number | 15:26:50 → 15:27:04 | Asked for photos ✅ — **DUPLICATE EMISSION at 15:27:15** ⚠️ Bug #2 |
| Cédula photos (2) | 15:27:18 → 15:27:40 | Photo batching captured both ✅ |
| Screening (años, lugar, certificaciones, herramientas, ARL/EPS) | 15:31:47 → 15:34:08 | Bundled questions worked ✅ |
| Submit dossier | 15:34:18 → 15:34:49 | "Perfil en revisión" ✅ |
| HR approval push | 15:35:29 | **3 OTs WITHOUT price labels** ✅ (TOC=0 → silent omission) |
| Postulation "3" | 15:36:07 → 15:36:11 | TELEPORT BUSINESS postulada ✅ |
| HR preselect | 15:36:39 | "Quedaste preseleccionado…" ✅ |
| Contract sent | 15:37:19 → 15:37:30 | Contract PDF delivered as WA attachment ✅ |

**Single transcript-visible defect: duplicate question at 15:27:04 + 15:27:15.** Everything else clean.

---

## 3. Bug #1 (VE leak) — RESOLVED, evidence

**Approval push body (lines 61-65 of transcript):**

```
Hay 3 trabajos para ti:
1. Limpieza de fachadas 2026 I - 0058 - PRADO VERANIEGO · Bogotá
2. Limpieza de fachadas 2026 I - 4777 - AVENIDA PEPE SIERRA · Bogotá
3. Limpieza de fachadas 2026 I - 0011 - TELEPORT BUSINESS · Bogotá
```

**No `— $X.XXX.XXX` segment.** Compare to Juan's transcript on same day where the SAME 3 OTs showed `— $ 1.287.305`, `— $ 483.856`, `— $ 475.104` (Valor_Estimado). Toño now correctly reads `Total_Orden_Calculado`, returns `{label: null}` when TOC=0, and the `valorPart` branch in [`dashboard/src/lib/decisions.ts:154`](../../dashboard/src/lib/decisions.ts#L154) skips the dash + value. **Spec realized exactly.**

---

## 4. Bug #2 (duplicate question) — STILL PRESENT, tracked as S12

**Evidence in two consecutive live tests on the same day:**

| Test | Phone | Pattern |
|---|---|---|
| Juan Pablo | `+137877543452841` | DB-confirmed two distinct `outbound_messages` rows at 14:48:38 + 14:48:47 UTC. First: "Listo, 6 años. ¿Dónde has trabajado antes?…". Second: "Dale, pero te preguntaba otra cosa. ¿Dónde has trabajado antes?…" (9s apart, different wording, same question). |
| Irina | `+137877543452841` (fresh) | Transcript-confirmed same text at 15:27:04 + 15:27:15 PT (11s apart, exact duplicate of "mándame dos fotos de tu cédula"). |

**Root-cause analysis (verified by code reading, not speculation):**
- [`tono/src/whatsapp.ts::handleIncoming:254`](../../tono/src/whatsapp.ts#L254): dedup uses `seenMessageIds` Set keyed by `msg.key.id` ONLY
- [`tono/src/whatsapp.ts::flushBatch:367-390`](../../tono/src/whatsapp.ts#L367-L390): IDEMPOTENT (deletes entry from `pending` BEFORE awaiting `onMessage`, so second timer firing is no-op)
- [`tono/src/runner.ts::onMessage:64-75`](../../tono/src/runner.ts#L64-L75): single `sendAgentReply` per turn
- [`tono/src/agent.ts::handleMessage`](../../tono/src/agent.ts#L317): returns ONE reply per call
- [`tono/src/llm.ts::runTurn:509-521`](../../tono/src/llm.ts#L509-L521): returns ONE reply when `toolUseBlocks.length === 0`

**Conclusion:** Code path guarantees `one inbound → one outbound`. So duplicates can ONLY come from upstream — WhatsApp/Baileys delivering the same user input twice with different `msg.key.id` (e.g., `notify` event + `append` from history-sync), bypassing the dedup.

**S12 fix sketch (in prd.json):** add a secondary `recentTextByPhone: Map<phone, {text, at}>` dedup in `handleIncoming` BEFORE the existing `seenMessageIds` check. If same phone+text within 3000ms → drop with `log.warn`. Text-only (media excluded — same caption may legitimately repeat). Window short enough that intentional "sí sí" isn't blocked.

---

## 5. Bug #3 (grounding noise) — tracked as S13

3 `grounding_violation_logged` eventos in Juan's session (4-minute span):

| Time (UTC) | Tokens flagged as "ungrounded" |
|---|---|
| 21:47:05 | **Juan**, **Pablo** (user's own just-registered name) |
| 21:49:29 | **RETIE**, **SISO**, **Seguridad**, **Salud**, **Trabajo** (Colombian construction-industry safety certifications) |
| 21:50:17 | **ARL**, **EPS** (Colombian payroll/insurance abbreviations) |

**Two fixes needed:**
1. `GroundedFacts` passed at [`tono/src/agent.ts:803`](../../tono/src/agent.ts#L803) must include worker's `nombre` (and its parts) from `session_identity` / `register_tecnico` tool result
2. [`tono/src/grounding-gate.ts`](../../tono/src/grounding-gate.ts) gains `DOMAIN_TERMS_WHITELIST`: `{'RETIE', 'SISO', 'ARL', 'EPS', 'COP', 'IVA', 'NIT', 'RUT', 'Seguridad', 'Salud', 'Trabajo', 'Redin'}` filtered before reporting violations

**S13 BLOCKS v1.1 promotion of `TONO_GROUNDING_ENFORCE=true`** — until false positives are eliminated, enforce mode would silence legitimate Toño replies that contain the worker's own name or normal domain vocabulary.

---

## 6. Test persona cleanups today

| Persona | tecnico_id | Phone | Cleanup script | Final state |
|---|---|---|---|---|
| Juan Pablo Gómez Hurtado | `fdfc378f-c6df-47d4-8c01-7cd576327289` | `+137877543452841` | `cleanup-tecnico.ts 1098665433 Juan --confirm` | DB + AppSheet `5iqfh0s_rC4NM3ZZqRA44c` ✅ gone |
| Irina Vélez López | `e99a9273-842f-...` | `+137877543452841` | `cleanup-tecnico.ts 1098665443 Irina --confirm` | DB + AppSheet `vg2GQZ289c4BA7IBri3WQ8` ✅ gone |
| Camila Florez | `434328f1-3fc0-4f75-8cc4-c7c4e0694e2b` | `+77824840962292` | Inline tmp script (cedula=NULL, no AppSheet) | DB ✅ gone |

Both phones at: `sessions=0, outbound=0`, no `tecnicos_extended` row, no AppSheet entry. **Fresh and ready for next iteration of testing.**

---

## 7. prd.json updates (this commit)

### S12 — Duplicate-question bug — secondary dedup on phone+text+recent-window
- **Category:** `bug-tono-agent`
- **Files:** `tono/src/whatsapp.ts`
- **Evidence:** transcripts in `data/test-results-tono/May28-juanpablo-tono.txt` + `data/test-results-tono/May28-irina-tono/_chat.txt`
- **Status:** `open`

### S13 — Grounding gate facts whitelist — absorb just-registered nombre + domain terms
- **Category:** `bug-tono-grounding`
- **Files:** `tono/src/grounding-gate.ts`, `tono/src/agent.ts`
- **Evidence:** 3 grounding_violation_logged eventos in session `8a6e5342-bd7b-49bf-b8e1-996e73b9d054`
- **Status:** `open` · **Blocks v1.1:** `TONO_GROUNDING_ENFORCE=true` flip

---

## 8. Critical paths

- **PRD:** `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **PRD stories tracker:** [`prd.json`](../../prd.json) (13 stories: S01–S13)
- **Main HEAD:** `98aefea971d2b47df8ac0d3156df6802f8955a15` (PR #10 merge)
- **Toño WA:** `+573224347117` (Railway `tono-mp`)
- **Manos WA:** `+573222392959` (Railway `manos-mp`)
- **Dashboard:** https://dashboard-mp-production-1ef3.up.railway.app
- **HR pipeline:** https://dashboard-mp-production-1ef3.up.railway.app/hr/pipeline
- **Test phones:** `+137877543452841`, `+33887895953632`, `+77824840962292` (all clean, ready for `hola`)
- **Today's transcripts:** [`data/test-results-tono/`](../../data/test-results-tono/) — Juan (text) + Irina (text + 2 photos + contract PDF)

---

## 9. Decisions log (delta on prior handoffs)

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-28 | Silent omission of TOC when 0 stays as the price strategy | Confirmed in 2nd live test (Irina): worker-facing message is clean without prices; UX feedback if it arrives can flip to fallback later (Hybrid TOC→VE or "por confirmar"). Verified ~83% of state-4 OTs currently have TOC=0, so most workers will see no price label; acceptable for v1 pilot. |
| 2026-05-28 | Bug #2 (duplicate Q) tracked but NOT shipped a fix in this session | Code-path analysis showed agent code guarantees single-emission per turn; root cause is upstream (WhatsApp/Baileys retransmission with different msg.key.id). Fix is a 10-line dedup in whatsapp.ts but needs its own re-test cycle. Deferred to S12. |
| 2026-05-28 | Bug #3 (grounding noise) tracked but NOT shipped a fix | Gate is log-only — no user impact. Real cleanup requires both a facts-whitelist and a nombre-propagation fix; small-surface but needs its own re-test. Deferred to S13. |
| 2026-05-28 | PR #10 merged with `--merge` strategy (not `--squash`) | Preserves 22-commit history for bisect-ability. Catch-up nature of PR makes a single squash commit lose useful granularity. |

---

## 10. Known issues + watch-outs

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | S12 (duplicate question) ships to all workers until fixed | Medium UX | Workers see Toño re-asking the same question 9-11s after the first. Confusing but doesn't break the loop — both tests completed successfully despite this. Fix is small but unverified. |
| 2 | S13 (grounding noise) hides real hallucinations under false positives | Medium observability | While gate is log-only this is just noise in `eventos`. Becomes BLOCKING when promoting to enforce mode in v1.1. |
| 3 | Most state-4 OTs (~83%) have TOC=0 → no price shown to workers | Medium-by-design | Per Irina's silent-omission rule. Watch for workers asking "cuánto paga?" — no current fallback prompt in Toño. |
| 4 | classify_documento failure surface | Medium | Auto-classify is fire-and-forget; failures only log warn. HR's DocViewer surfaces `classification_jsonb` when present; absence means manual review. |
| 5 | `data->>Titulo` returns "undefined" for all OTs in my probe | Low | Cosmetic — the actual Titulo lives under a different key in AppSheet. Doesn't affect the loop; would surface if any UI tries to display OT title from `data->>Titulo`. |

---

## 11. Why this handoff exists

Irina is moving to a new session in a fresh context. This handoff is the bridge — the next Sisyphus instance reading this should:

1. **NOT re-investigate PR #10** — it's MERGED, prod is on main HEAD `98aefea`.
2. **NOT re-investigate Bug #1 (VE leak)** — RESOLVED + verified live in Irina's 15:35 PT approval push.
3. **WHEN ready to tackle S12** — minimal patch in `tono/src/whatsapp.ts::handleIncoming` per prd.json#S12 acceptance criteria. Re-test on phone A.
4. **WHEN ready to tackle S13** — patch `grounding-gate.ts` + `agent.ts` per prd.json#S13. Watch for new eventos.
5. **WHEN doing live tests** — both phones (`+137877543452841` and `+77824840962292`) are clean. Cleanup helpers: [`scripts/cleanup-tecnico.ts`](../../scripts/cleanup-tecnico.ts) for workers with cédula; for cédula=NULL workers use the one-shot pattern shown in [`scripts/cleanup-test-personas-2026-05-28.ts`](../../scripts/cleanup-test-personas-2026-05-28.ts).
6. **WHEN reading session evidence** — full transcripts at [`data/test-results-tono/May28-juanpablo-tono.txt`](../../data/test-results-tono/May28-juanpablo-tono.txt) (failed test → diagnosed deploy gap) and [`data/test-results-tono/May28-irina-tono/_chat.txt`](../../data/test-results-tono/May28-irina-tono/_chat.txt) (successful e2e).

---

**Toño v1 is live. End-to-end loop validated. Two latent bugs filed with full evidence + fix sketches. Next session has 100% context to pick up S12 or S13.**
