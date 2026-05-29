# Handoff — Manos Sonnet 4.5 + native photo vision + embedded-photo PDF · DEPLOYED to prod (v1)

**Saved:** 2026-05-29 · **By:** Sisyphus (Agent A) · **Status:** 🟢 Merged to `main` (`11b9271`) + all 4 Railway services live · 🟢 Live-confirmed (PDF delivered to WhatsApp)

This is the **first deployed version** of the upgraded Manos (architect scope agent). Supersedes the local-only / Haiku Manos.

---

## 0. TL;DR

1. **Original ask:** the alcance report/PDF must **include the architect's photos**. ✅ Done — `finalize_alcance` downloads each photo and embeds it as an `<Image>` in a "REGISTRO FOTOGRÁFICO" section.
2. **Root issue found + fixed:** Manos was **blind to photos** (they reached the LLM as a URL string; Claude can't fetch URLs). Now Manos runs **Claude Sonnet 4.5 + extended thinking** and **sees the photos natively**, so the scope reflects what's in them.
3. **Delivery bug found + fixed (LID):** the outbound drainer addressed the link/PDF by reconstructing `<phone>@s.whatsapp.net`, which is wrong for LID-mode WhatsApp accounts → never delivered. Fixed: drainer now sends to the **real JID** captured on the session (`session.meta.jid`).
4. **Shipped to prod:** merged `manos/sonnet-vision` → `main` = `11b9271`, pushed to `irinavelezk/main`. All 4 Railway services (`manos-mp`, `tono-mp`, `sync-mp`, `dashboard-mp`) deployed `11b9271` = SUCCESS.
5. **`manos-mp` was DELETED on Railway** — recreated from scratch (see §3). It connected to `+573222392959` reusing the orphaned volume's auth (no re-pair needed) and is **online**.
6. **Review gate:** `review-work` 5-agent gate → **UNCONDITIONAL PASS** (security HIGH finding remediated).

---

## 1. What shipped (architecture)

- **Model:** `MANOS_MODEL=claude-sonnet-4-5` (env-overridable; `claude-haiku-4-5` reverts). [`manos/src/llm.ts`](../../manos/src/llm.ts)
- **Extended thinking ON by default** (`MANOS_THINKING_ENABLED`, budget 1024, `max_tokens = budget + 2048`, `temperature` omitted on the thinking path per Anthropic constraint). Mirrors `tono/src/llm.ts`. Owner explicitly wanted a smart agent — Haiku was rejected.
- **Hybrid vision:**
  - Native image block on the **arrival turn** (signed-URL source) in `toAnthropicMessages` — agent sees pixels when the photo lands.
  - **Persisted Spanish caption** ([`manos/src/describe-photo.ts`](../../manos/src/describe-photo.ts), Haiku) woven into history = cheap **cross-turn memory** (scope set turns later still reflects the photo).
  - **`view_photo(n)` tool** ([`tools/src/manos/view-photo.ts`](../../tools/src/manos/view-photo.ts)) — re-attaches a prior photo natively (image block inside `tool_result.content`, verified accepted by Sonnet 4.5).
- **PDF embeds photos:** [`tools/src/manos/finalize-alcance.ts`](../../tools/src/manos/finalize-alcance.ts) `resolveAlcancePhotos` downloads bytes by storage object path → base64 data URI → `<Image>`.
- **LID delivery fix:** [`manos/src/agent.ts`](../../manos/src/agent.ts) persists the real inbound JID to `sessions.meta.jid` (merge, after cédula gate, before LLM turn); [`manos/src/outbound.ts`](../../manos/src/outbound.ts) drainer resolves `preferredJid(sessionMetaJid ?? rowMetaJid, phone)` (falls back to `jidFromPhone`). `preferredJid` is unit-tested.
- **Security (fail-closed photo paths):** `attach_photos` / `view_photo` / `finalize` reject any path not matching `incoming/<phone>/<uuid>.<ext>` (rejects `..`, leading `/`); blocks LLM-supplied path traversal / cross-bucket reads. [`tools/src/manos/attach-photos.ts`](../../tools/src/manos/attach-photos.ts) `isValidPhotoEntry`.
- **stripVisibleThinking** ported from Tono (belt-and-suspenders so `<thinking>` tags never reach an architect).

## 2. Commits (on `main` via merge `11b9271`)

```
7cea650 feat(manos): embed photos in alcance PDF + Haiku vision caption
394c909 test(manos): TDD harness for Sonnet 4.5 + hybrid vision upgrade
180564a feat(manos/llm): native image block on current-turn user message
17c5e0b feat(manos): view_photo tool — native re-attach of prior architect photos
961c250 feat(manos): swap default model Haiku 4.5 → Sonnet 4.5
862bca8 feat(manos/agent): thread architect imageUrls into Sonnet as native image blocks
f31b986 feat(manos/prompt): teach view_photo + native arrival-turn vision
32cd361 chore(scripts): smoke-manos-sonnet-vision — Wave 5 manual QA harness
8da6928 feat(manos): enable extended thinking (default ON) for scope-building judgment
c2c3406 fix(security): manos photo paths — fail-closed at LLM input + storage edges
1285250 feat(manos/llm): port stripVisibleThinking + 2048 max_tokens fallback + MANOS_MAX_TOKENS
c5534ca docs(manos): RUNBOOK — Sonnet 4.5 default, thinking ON, 5 tools
016923c chore(scripts): smoke S3 — assert view_photo result_ok + retarget pending OT
e56c4d5 fix(manos/outbound): preferredJid — drainer delivers to real @lid jid
707620f fix(manos/agent): persist real inbound jid into sessions.meta post-cédula
11b9271 merge(manos): Sonnet 4.5 + native photo vision + view_photo + embedded-photo PDF + LID delivery fix
```

## 3. Railway deploy state (prod)

Project `redin-marketplace` / env `production`. All on `11b9271` = SUCCESS:

| Service | ID | Notes |
|---|---|---|
| `manos-mp` | `6476b013-3532-4964-af74-2df673a871d5` | **Recreated this session** (was deleted). Online on `+573222392959`. |
| `tono-mp` | `e881045b-…` | Online `+573224347117` (verified merge didn't break it). |
| `sync-mp` | `351286f1-…` | — |
| `dashboard-mp` | `ef24d8e2-…` | — |

**`manos-mp` recreation recipe** (if it ever needs rebuilding):
- `railway add --service manos-mp --repo irinavelezk/redin-marketplace`
- Env: `RAILWAY_DOCKERFILE_PATH=manos/Dockerfile`, `MANOS_WA_NUMBER=+573222392959`, `MANOS_MODEL=claude-sonnet-4-5`, `MANOS_DATA_DIR=/data` + secrets copied from `tono-mp` (`ANTHROPIC_API_KEY`, `SUPABASE_URL/PUBLISHABLE_KEY/SECRET_KEY`, `TELEGRAM_BOT_TOKEN`) + **`GROQ_API_KEY`** (Manos needs it for voice; tono-mp does NOT have it — pull from `.env.local`).
- Volume: reattach `manos-mp-volume` (mount `/data`) — holds the Baileys auth; reattaching avoided a re-pair.
- Deploy target is `irinavelezk/main` (NOTE: `origin`/`irivelez` remote is **DEAD** — repo not found).

## 4. Verification evidence

- `review-work` gate: 5 agents (goal, QA, code, security, context) → all PASS; security HIGH (H1: LLM-supplied photo paths trusted) remediated to fail-closed → **re-review UNCONDITIONAL PASS**.
- Tests (tsx + node:assert): `test-manos-llm-config`, `test-manos-llm-messages` (incl. 3-iteration tool_use/tool_result pairing regression), `test-manos-view-photo` (incl. path-validation), `test-manos-outbound-jid` (preferredJid). All GREEN. `npm run typecheck` exit 0 across 6 workspaces. Prod's own `test-customer-rating-*` still pass (no regression).
- Live: scope built correctly from text+voice+photos; `finalize_alcance:ok`; **PDF delivered to WhatsApp (owner-confirmed)**. `manos-mp` `Manos is online | +573222392959`.

## 5. Test inputs (for re-testing on prod number `+573222392959`)

- Architect: **Jose Luis Capacho Santafé**, cédula **`88034262`**, ARQ row `3Ueb6rlyBC9l2LNRF09D2x`.
- Test OT: **#859 Cali — "OT de prueba- no eliminar"** (`xkaG046PcMKoPczqZNaJFU`), state-4. (#720 Popayán `LK4cgHD0DlytRsCBwx8zKZ` already has alcance.)
- Flow: `hola` → `88034262` → `¿qué OTs tengo?` → OT #859 → photo + voice → confirm → `genera el alcance`. Expect: confirmation + link + PDF whose photo page shows the sent photo.
- ⚠️ Hits **prod Supabase** — use the test OT, not a real customer's.

## 6. Adjacent context

- **Toño rating-prompt bug is ALREADY fixed on prod** — `d3d99b7 fix(sync): gate post-OT customer-rating auto-send behind ENABLE_CUSTOMER_RATING (default OFF)` (PR #11). That separate front is done; nothing pending.
- Worktree `/Users/irina/AI-driven-OS/autonomous/redin/marketplace-tono` (branch `tono/disable-rating-autosend`) is now **redundant** (its fix already merged via PR #11) — safe to `git worktree remove`.

## 7. Open / follow-up (non-blocking)

1. **Revoke the Railway account token** shared in chat this session (Railway → Account → Tokens).
2. **Stale docs:** `README.md` + `PRD.md §18` still say Toño uses Gemini 2.5 Flash — it's been Claude (now Sonnet 4.5 + thinking) for a while. Worth a docs pass (not Manos-specific).
3. Edge re-examined and CLEARED: "brand-new architect's first finalize uses old JID" is NOT a real gap — `agent.ts` persists the JID at the start of every WhatsApp turn, before `finalize` runs.
4. Cost note: Sonnet + thinking + native vision ≈ ~3× Haiku per turn (~$0.05–0.10 per alcance). Knobs: `MANOS_THINKING_ENABLED=0`, `MANOS_MODEL=claude-haiku-4-5`.
5. Local Manos dev server (used for testing) is **stopped**. `manos/sonnet-vision` branch is merged (can be deleted).
