# Session Handoff — WA Business Ban + New Number Wired, Pairing Pending

**Saved:** 2026-05-27 ~14:55 PT · **By:** Sisyphus orchestrator · **Status:** Toño OFFLINE — banned account parked, new number wired but unpaired

This handoff is a **delta** on [`2026-05-26-greenline-closed-architect-notif-pending.md`](./2026-05-26-greenline-closed-architect-notif-pending.md) and [`2026-05-26-tono-number-swap-and-lid-loop.md`](./2026-05-26-tono-number-swap-and-lid-loop.md). Read those for the LID self-loop incident root cause and prior architectural decisions.

---

## 0. TL;DR for tomorrow

1. 🔴 **`+573105751757` BANNED by WhatsApp Business** on 2026-05-27 — likely flagged from the 2026-05-26 LID self-loop incident (3 min of self-replies until Anthropic credit drained). All linked devices forcibly logged out (`statusCode=401 loggedOut=true`).
2. 🟡 **Recovery in progress — Plan B chosen** (run in parallel to WA appeal): wire a new number `+573224347117` (WA Business). Code + env all updated and committed. **Pairing not yet done** — Irina's phone was unavailable to scan the QR today.
3. 🟢 **All commits clean + pushed** to `irinavelezk/fix/tono-reject-url-as-document-evidence`. Today's session shipped 11 commits total (9 from the codebase-status review + 2 for the number swap and pair scripts).
4. ⚠️ **Dashboard-mp still serving OLD bundle with `+573105751757` baked into `wa.me` links** — anyone hitting the landing page or `/aplicar/*` clicks through to the banned WA account and sees the "esta cuenta no puede usar WhatsApp" ban screen. **One-line fix tomorrow:** `railway up --service dashboard-mp` (Railway env vars are already updated — just need to rebuild the Next.js bundle with the new `NEXT_PUBLIC_WA_NUMBER`).
5. 🟢 **Manos + dashboard-mp (server) + sync-mp all healthy.** Only `tono-mp` is impaired. Architect flow on `+573222392959` (Manos) is independent and untouched.

---

## 1. What happened today (chronological)

### 1.1 Codebase status review + 9 commits
User asked to review codebase state. Mapped 40+ uncommitted files to their deployment status, categorized into 9 atomic commits:

```
bea5db4 chore: PRD stories S08-S11 + diagnostic scripts + handoffs + smoke:manos
75ab6e5 feat(dashboard): HR document viewer + decide buttons + qualification queue v2
5577cbc feat(tools+manos): S08 architect feedback loop + classify-documento + doc polish
dc59a6a feat(tono): identity-gate + grounding-gate + approval-push-replies + routing hardening
1c59451 feat(db): migrations 015 grounding + 016 documento classification
d648dfc feat(model): swap Toño + Manos to Claude Sonnet 4.5 (env-overridable)
7c04126 fix(wa): LID self-loop guard for both Toño + Manos (2026-05-26 incident)
5199b4c feat(infra): swap Toño WhatsApp number to Colombian +573105751757
696dbe7 chore: gitignore .omo/run-continuation, .playwright-mcp, qa-*.png
```

All confirmed to NOT affect prod (Railway uses `railway up` from local tree, not GitHub auto-deploy). Typecheck green. Pushed to `irinavelezk/fix/tono-reject-url-as-document-evidence`.

### 1.2 DB cleanup for live test
User wanted to talk to Toño from her phone. Deleted test data:
- Camilo Andrade (`868ad622-...`) full cascade: 2 contratos, 2 postulaciones, 2 documentos, 1 candidate_decision, 160 messages, 8 eventos, 72 outbound_messages, 11 sessions (5 Camilo + 6 orphan test), 2 storage JPGs
- Preserved: 9 legacy AppSheet workers, Jose Luis Capacho Santafe, real customer rating sessions
- AppSheet `TECNICOS` row for Camilo (`r9Cvu0hAdB46E_qxziYd19`) left orphaned per "only projector writes to AppSheet" hard don't

### 1.3 Live test attempt → reveals the ban
User wrote to `+573105751757` from her phone. No reply. Diagnosis:
- Railway tono-mp creds.json showed `me.id=14157916801:3@s.whatsapp.net` (OLD US identity) — but `me.name="Irina"` clearly her account
- 0 inbound messages in last 10 min from DB
- Decision: re-pair Tono to current state

### 1.4 Pairing attempt → exposes the ban
- Transferred existing local +57 creds (May 26 pair) to Railway via Supabase Storage courier
- Forced container restart via SIGTERM to PID 1
- Result: `statusCode=401 loggedOut=true` + `logged out — delete the auth dir and re-pair`
- Tried code-based pairing (`scripts/pair-with-code.ts`) — generated 3 codes (QBSK-5WPS → AGQG-E6GB → 41BS-V9YA)
- Phone showed: **"Esta cuenta no puede usar WhatsApp — Desde: 27 de mayo de 2026"** (WhatsApp Business ban screen)

### 1.5 Plan B — new number wired (NOT YET PAIRED)
User decided to wire `+573224347117` (WA Business) AND submit ban appeal in parallel. Executed:

| Action | Status |
|---|---|
| Update `.env.local` `WA_NUMBER` + `NEXT_PUBLIC_WA_NUMBER` | ✅ Done |
| Update `.env.example`, `README.md`, `wa-link.ts`, `jose-invite.ts` | ✅ Done + committed (54dacd1) |
| Update Railway tono-mp `WA_NUMBER` | ✅ Done (verified via `railway variables`) |
| Update Railway dashboard-mp `WA_NUMBER` + `NEXT_PUBLIC_WA_NUMBER` | ✅ Done (verified) |
| Wipe local `data/tono-wa-auth/` | ✅ Done (banned snapshot at `/tmp/tono-wa-auth.snapshot-1779916865`) |
| Park Railway banned auth at `/data/tono-wa-auth.banned-571` for forensics | ✅ Done |
| Pair Toño to new number | ❌ **NOT DONE — Irina's phone was unavailable to scan QR** |
| Transfer creds to Railway tono-mp | ❌ Pending pair |
| Force tono-mp restart with new auth | ❌ Pending |
| `railway up --service dashboard-mp` (bake new `NEXT_PUBLIC_WA_NUMBER` into bundle) | ❌ **NEEDED — see §3 risk below** |
| Submit appeal for `+573105751757` ban | ⚠️ Up to Irina (3-min phone action) |

---

## 2. Current state — services

| Service | State | Notes |
|---|---|---|
| **dashboard-mp** | 🟢 200 OK but stale bundle | Env vars updated to `+573224347117`, but **deployed bundle still has `+573105751757` baked into landing page + `/aplicar/*` wa.me links**. Anyone visiting → ban screen. |
| **tono-mp** | 🔴 OFFLINE | Banned account auth parked. Container is on the new env (`WA_NUMBER=+573224347117`) but `/data/tono-wa-auth/` is empty → boots, fails to load auth, restarts. Mostly harmless, burns container minutes. |
| **manos-mp** | 🟢 Online on `+573222392959` | Architect flow works. Still pre-S08 code per prior handoffs. |
| **sync-mp** | 🟢 Healthy | 15-min cron pulling AppSheet → Supabase. |
| **Supabase** | 🟢 Healthy | DB cleaned of test users. 10 real técnicos remain. |

---

## 3. CRITICAL — Risk if not addressed before workers visit dashboard

The dashboard-mp bundle was last built before `NEXT_PUBLIC_WA_NUMBER` was updated. The wa.me links on:
- Landing page (e.g., `https://dashboard-mp-production-1ef3.up.railway.app/`)
- `/aplicar/*` worker application page

…all still point to `wa.me/573105751757` — the BANNED account. Anyone clicking → sees "Esta cuenta no puede usar WhatsApp" ban screen. **Brand damage.**

**The fix is one command:**
```bash
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace
railway up --service dashboard-mp --detach
# wait ~90s for rebuild + redeploy
curl -sS https://dashboard-mp-production-1ef3.up.railway.app | grep -oE 'wa\.me/[0-9]+'
# expect: wa.me/573224347117
```

**Tradeoff:** After redeploy, workers who write to `+573224347117` get NO REPLY (Tono not paired yet). But "no reply" is less brand-damaging than "this account is banned". If pairing happens within a few hours after redeploy, Tono will pick up the queued messages via WhatsApp's history sync.

**My recommendation:** Run `railway up --service dashboard-mp --detach` as the **first action tomorrow morning** before doing anything else. ~2 minutes. Then pair Tono.

---

## 4. Action plan for next session (priority order)

### Step 0 — WhatsApp Business ban appeal (Irina, 3 min on her phone)
On the phone showing the ban screen for `+573105751757`:
- Tap **"Solicitar revisión"** at the bottom
- Suggested appeal text (paste-ready):
  > Tono es un asistente automatizado para conectar técnicos de mantenimiento con trabajos en Bogotá. La actividad inusual del 26 de mayo fue causada por un bug que provocó que el bot respondiera a sus propios mensajes en bucle por 3 minutos. Ya enviamos la corrección. Agradecemos la revisión y restauración del acceso.
- Most reviews complete within 24h. If approved, we have both numbers available (rotate freely).

### Step 1 — Redeploy dashboard-mp (~2 min)
```bash
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace
railway up --service dashboard-mp --detach
sleep 90
curl -sS https://dashboard-mp-production-1ef3.up.railway.app | grep -oE 'wa\.me/[0-9]+'
```
Stops the "ban screen on visitors" risk immediately.

### Step 2 — Pair Toño to `+573224347117` via QR (~5 min)
**Prereq:** Phone with the `+573224347117` SIM available, WA Business already registered to that SIM.

```bash
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace
# Confirm clean state
pkill -9 -f "tono.*runner|pair-with" 2>/dev/null
ls data/tono-wa-auth/ | wc -l  # expect 0 (or wipe: rm -rf data/tono-wa-auth && mkdir -p data/tono-wa-auth)

# Launch QR pair (saves PNG to /tmp/tono-pair-qr.png + opens in Preview)
nohup npx tsx --env-file=.env.local scripts/pair-with-qr.ts > /tmp/pair-qr.log 2>&1 &
echo $! > /tmp/pair-qr.pid
sleep 10
open /tmp/tono-pair-qr.png
cat /tmp/pair-qr.log
```

On the phone:
1. WhatsApp Business → Settings → Linked Devices → Link a device
2. Scan the QR shown in Preview

Watch for success:
```bash
tail -f /tmp/pair-qr.log
# expect: ✓ Paired successfully.
#         me.id = 573224347117:N@s.whatsapp.net
#         me.name= Antonio Red de Ingenieros
```

### Step 3 — Transfer creds to Railway tono-mp (~3 min)
Reuse the Supabase Storage courier pattern from this session:
```bash
set -a; source .env.local; set +a

# Tarball local auth
tar czf /tmp/tono-auth.tar.gz -C data/ tono-wa-auth/

# Upload to Supabase Storage
UPLOAD_PATH="transfers/tono-auth-$(date +%s).tar.gz"
curl -sS -X POST "$SUPABASE_URL/storage/v1/object/documentos/$UPLOAD_PATH" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @/tmp/tono-auth.tar.gz

# Mint 1h signed URL
SIGNED=$(curl -sS -X POST "$SUPABASE_URL/storage/v1/object/sign/documentos/$UPLOAD_PATH" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" -d '{"expiresIn": 3600}')
SIGNED_PATH=$(echo "$SIGNED" | python3 -c "import sys,json; print(json.load(sys.stdin)['signedURL'])")
FULL_URL="$SUPABASE_URL/storage/v1$SIGNED_PATH"

# SSH into Railway: wipe banned dir + fetch + extract
railway ssh --service tono-mp "node -e '
(async () => {
  const fs = require(\"fs\");
  const { execSync } = require(\"child_process\");
  const res = await fetch(\"'$FULL_URL'\");
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(\"/tmp/tono-auth.tar.gz\", buf);
  execSync(\"rm -rf /data/tono-wa-auth\");
  execSync(\"tar xzf /tmp/tono-auth.tar.gz -C /data/\");
  const c = JSON.parse(fs.readFileSync(\"/data/tono-wa-auth/creds.json\", \"utf-8\"));
  console.log(\"creds me.id:\", c.me?.id);
  if (!c.me?.id?.startsWith(\"573224347117\")) {
    console.error(\"❌ ABORT: wrong number\"); process.exit(1);
  }
  console.log(\"✓ Colombian +57 creds in place on Railway\");
})().catch(e => { console.error(e.message); process.exit(1); });
'"
```

### Step 4 — Restart Railway tono-mp to load new creds (~30s)
```bash
railway ssh --service tono-mp "kill -TERM 1"
sleep 25
railway logs --service tono-mp --deployment 2>&1 | tail -5
# expect: Toño is online | number_env=+573224347117
#         (NOT: statusCode=401 loggedOut=true)
```

### Step 5 — Smoke test (~3 min)
From a **different WhatsApp account** (NOT the one signed in as `+573224347117`):
- DM `hola` to `+57 322 434 7117`
- Within ~10s should see Toño reply asking for nombre + ciudad

If reply comes through:
- ✅ END-TO-END VERIFIED on new number
- Resume the green-line work (the actual goal that started this saga)

If no reply within 30s:
- Check `railway logs --service tono-mp --deployment | tail -20` for inbound event
- Check DB: `messages` table for new row in last 1 min
- If inbound logged but no reply → Toño's `register_tecnico` tool-call defect from session a510dbab (need separate diagnosis)

### Step 6 — Commit + push
```bash
git push irinavelezk fix/tono-reject-url-as-document-evidence
```

### Step 7 — Cleanup banned forensics (only after appeal is decided)
- If WA approves appeal: keep `/data/tono-wa-auth.banned-571` and `/tmp/tono-wa-auth.snapshot-1779916865` indefinitely (in case you want to restore +57 later)
- If WA denies appeal: `railway ssh --service tono-mp "rm -rf /data/tono-wa-auth.banned-571"` + `rm /tmp/tono-wa-auth.snapshot-1779916865*`

---

## 5. The defect I flagged earlier (still standing)

Session `a510dbab` from earlier today (`+172404651368635`) showed Toño collecting `nombre + ciudad + especialidades + cuadrilla` over 14 turns but **never calling `register_tecnico`**. Every `llm_call` event had `tool_calls: []`. The phone never landed in `tecnicos_extended`.

This is a real bug, not a network issue. When Step 5 above works, you'll likely hit the same defect on the first registration. To diagnose:
- Fire `task(subagent_type="oracle", load_skills=[])` with the full session messages + system prompt to diagnose why Sonnet 4.5 isn't using tools
- Likely cause: tool definitions in `tools/src/schemas.ts` don't match what Sonnet expects, OR the system prompt's "REGLA CRÍTICA" sections over-constrain tool invocation, OR Anthropic's tool-use API on Sonnet 4.5 requires a flag we're not passing
- Don't deep-fix in the smoke test session; capture evidence + diagnose separately

---

## 6. Files modified today

```
Committed (pushed to irinavelezk/fix/tono-reject-url-as-document-evidence):
  696dbe7 .gitignore                                # +3 lines: .omo/run-continuation, .playwright-mcp, qa-*.png
  5199b4c .env.example, README.md, dashboard/src/lib/wa-link.ts, tono/src/prompts/jose-invite.ts
  7c04126 tono/src/whatsapp.ts, manos/src/whatsapp.ts       # +89 lines: LID self-loop guard
  d648dfc tono/src/llm.ts, manos/src/llm.ts                 # +9 lines: Sonnet swap (env-overridable)
  1c59451 migrations/015_*.sql, migrations/016_*.sql, shared/src/db-types*.ts, shared/src/dossier-types.ts
  dc59a6a 12 files in tono/src/ + tools/src/                # +1294 lines: identity/grounding/approval gates
  5577cbc 11 files in tools/src/ + manos/src/               # +705 lines: S08 + classify-documento
  75ab6e5 8 files in dashboard/src/ + sync/src/appsheet.ts  # +834 lines: HR doc viewer + queue v2
  bea5db4 10 scripts + 7 handoffs + prd.json + package.json # +many: stories + diagnostics
  54dacd1 .env.example, README.md, dashboard/src/lib/wa-link.ts, tono/src/prompts/jose-invite.ts
                                                            # +5/-5: number swap to +573224347117
  2822ce2 scripts/pair-with-code.ts, scripts/pair-with-qr.ts
                                                            # +187 lines: pairing utility scripts

Not committed (handoff doc):
  .omo/handoffs/2026-05-27-wa-business-ban-and-newnumber-pending-pair.md  # this file
```

---

## 7. Hard Don'ts (carry-over + new)

All prior handoff don'ts still active. New ones this session:

- **DO NOT keep retrying pair on a banned account.** Every retry strengthens the fraud signal. We saw this with the `statusCode=408` cycle on `+573105751757`. If the first pair attempt to `+573224347117` fails, WAIT 5+ minutes before retrying — and inspect WHY (maybe the SIM isn't actually registered as WA Business).
- **DO NOT request a pairing code via the script more than 2x in 10 min.** Multiple rapid code requests look like bot-evasion to WA's anti-spam. The QR-based flow is safer for this reason.
- **DO NOT redeploy tono-mp with `railway up` until pairing succeeds locally.** A redeploy with empty auth dir = same 401-loop pattern. Pair → verify locally → transfer to Railway → restart.
- **DO NOT proceed to live test before Step 1 (dashboard redeploy).** The wa.me ban-screen problem is the highest-visibility issue and the fastest to fix.

---

## 8. Decisions log (delta on prior handoff)

| Date | Decision | Lock-in |
|---|---|---|
| 2026-05-27 | **WhatsApp Business banned `+573105751757`** — almost certainly traceable to 2026-05-26 LID self-loop. Confirmed via phone ban screen showing date and "WhatsApp Business Terms of Service" violation. | Empirical |
| 2026-05-27 | **Wire `+573224347117` as Toño's new number** (also WA Business, per Irina's call) + submit appeal for old number in parallel. Two-track recovery. | Strategy |
| 2026-05-27 | **Keep using WA Business app for the new number** — Irina argument: "previously worked fine with US number on WA Business + Baileys". Counter-argument considered (regular WA has looser anti-spam) but deferred. | Pragmatic |
| 2026-05-27 | **QR-based pair preferred over code-based** for the new number, per Irina ("safest"). Code-based scripts retained as utility for future. | Operational |
| 2026-05-27 | **Long-term migration to WhatsApp Cloud API (Meta-blessed)** noted as the real fix for ban-risk, deferred to post-pilot (1-2 weeks of work). | Roadmap |

---

## 9. Critical paths (for fresh context)

- **PRD**: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- **prd.json**: marketplace/prd.json (9 stories — S08 code_complete_pending_live_smoke, S09 + S10 decision_pending, S11 blocked_by_s10)
- **Live dashboard**: https://dashboard-mp-production-1ef3.up.railway.app (⚠️ stale bundle until Step 1)
- **Prior handoffs** (chronological):
  - `.omo/handoffs/2026-05-26-greenline-closed-architect-notif-pending.md`
  - `.omo/handoffs/2026-05-26-tono-number-swap-and-lid-loop.md`
  - **THIS FILE** (`.omo/handoffs/2026-05-27-wa-business-ban-and-newnumber-pending-pair.md`)
- **Banned forensics**:
  - Local snapshot: `/tmp/tono-wa-auth.snapshot-1779916865/`
  - Railway: `/data/tono-wa-auth.banned-571/` (via railway ssh)
- **Pair scripts**:
  - `scripts/pair-with-qr.ts` (RECOMMENDED — QR PNG output)
  - `scripts/pair-with-code.ts` (8-digit code fallback)

---

## 10. Next-session starting prompt (copy-paste)

```
Read this handoff in full BEFORE doing anything:
  /Users/irina/AI-driven-OS/autonomous/redin/marketplace/.omo/handoffs/2026-05-27-wa-business-ban-and-newnumber-pending-pair.md

Then follow §4 Action Plan in priority order:
  Step 0: Irina submits WA ban appeal (3 min on her phone) — parallel
  Step 1: railway up --service dashboard-mp --detach  — fixes wa.me link ban-screen
  Step 2: scripts/pair-with-qr.ts — pair Toño to +573224347117
  Step 3: Supabase Storage courier — transfer creds to Railway tono-mp
  Step 4: Restart tono-mp via SIGTERM, verify "Toño is online"
  Step 5: Smoke test from a different WA account
  Step 6: git push irinavelezk fix/tono-reject-url-as-document-evidence
  Step 7: Cleanup banned forensics (only after appeal decision)

Then resume the green-line live test on the new number.

Strategic constraints (still active):
  - AppSheet REMAINS the main system for OT tracking
  - Only Projector writes to AppSheet
  - No deploy without explicit ask
  - Cost cap $10/day Anthropic
  - Sonnet 4.5 on both Toño + Manos
  - LID self-loop guard MUST stay in place (the incident that started all this)

Verify §5 register_tecnico defect during smoke test. If it reproduces, fire
an Oracle consultation with the full session evidence before touching code.
```

---

## Final note

The pilot is one pair-scan + one redeploy away from being live again. The codebase is in the cleanest state it's been in weeks: 11 commits, typecheck green, all the May LID + Sonnet + Gap A work properly recorded in git history. The ban is unfortunate but recoverable, and the appeal process gives us optionality.

When you come back: start with the dashboard redeploy (Step 1) — that one command stops the brand-damage clock. Everything else can wait until you have the phone available for the QR scan.

Buena suerte.
