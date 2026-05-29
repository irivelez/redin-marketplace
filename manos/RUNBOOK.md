# Manos — Railway Ops Runbook

Manos is a separate WhatsApp agent service for architects (identity via cédula, Groq Whisper audio, Claude vision for photos, AppSheet writeback). It runs independently of Toño — different Railway service, different WA number, different Baileys volume.

## Prerequisites

- `railway` CLI v4+ linked to project `redin-marketplace` (irinavelezk@gmail.com)
- You are in the repo root: `cd marketplace`
- Migration 012 applied to Supabase (see `migrations/012_manos_alcance.sql`)
- A dedicated WhatsApp number SIM/phone for Manos (NOT the Toño number)
- GROQ_API_KEY ready (https://console.groq.com — create a new key or reuse)

---

## Step 1 — Apply migration 012

Run `migrations/012_manos_alcance.sql` in the Supabase SQL editor (or `psql`).
It is idempotent — safe to re-run.

Things it creates:
- `ots_extended` table (alcance_jsonb, photo_paths[], AppSheet outbox columns)
- Expression index on `lower(data->>'Cedula')` for architect lookup
- Supabase Storage bucket `alcance-photos` (private, service-role only)
- RLS policy `alcance_photos_service_role_only`
- `sessions.meta jsonb` column (add if not exists)

---

## Step 2 — Create the Railway service

```bash
# Link to the project first if not already
railway link

# Create the new service
railway service create manos-mp

# Set the Dockerfile path (required for monorepo)
railway variables --service manos-mp --set "RAILWAY_DOCKERFILE_PATH=manos/Dockerfile" --skip-deploys
```

---

## Step 3 — Add and mount the volume

The volume stores Baileys session creds — it MUST survive redeployments.

```bash
# Create volume (CLI v4 quirk: use this form, not `railway volume add --service`)
railway volume add --service manos-mp --mount-path /data

# If that fails with "panics on --service flag", link to the service first then:
railway link --service manos-mp
railway volume add --mount-path /data
```

The volume will appear as `manos-data` in the Railway dashboard.

---

## Step 4 — Set environment variables

All vars for `manos-mp`. Use `--skip-deploys` until you're ready to deploy.

```bash
# Required — same Supabase project as all other services
railway variables --service manos-mp --set "SUPABASE_URL=<your-supabase-url>" --skip-deploys
railway variables --service manos-mp --set "SUPABASE_SECRET_KEY=<service-role-key>" --skip-deploys

# Required
railway variables --service manos-mp --set "ANTHROPIC_API_KEY=<key>" --skip-deploys
railway variables --service manos-mp --set "GROQ_API_KEY=<key>" --skip-deploys

# Volume path — MUST match the mount path above
railway variables --service manos-mp --set "MANOS_DATA_DIR=/data" --skip-deploys

# Telegram escalation (optional but recommended — cédula rejections alert here)
railway variables --service manos-mp --set "TELEGRAM_BOT_TOKEN=<token>" --skip-deploys
railway variables --service manos-mp --set "HR_TELEGRAM_CHAT_ID=<chat-id>" --skip-deploys

# Informational only (not enforced by code, but useful in logs)
railway variables --service manos-mp --set "MANOS_WA_NUMBER=+57XXXXXXXXXX" --skip-deploys
```

Note: `railway variables --set` WITHOUT `--skip-deploys` triggers a full rebuild. Always use `--skip-deploys` when setting multiple vars in sequence; deploy manually at the end.

---

## Step 5 — Pair the WhatsApp number (local)

Baileys requires a one-time QR scan to save session credentials. Do this locally first — Railway containers have no terminal for QR display.

```bash
# From the repo root
npm run manos:pair
```

This starts Baileys in pair-only mode, prints a QR code in the terminal, and exits after a successful connection. Creds are saved to `data/manos-wa-auth/` (relative to repo root, created automatically).

Scan the QR with the dedicated Manos WhatsApp phone (go to WA Settings → Linked Devices → Link a Device).

---

## Step 6 — Transfer creds to the Railway volume

The volume is mounted at `/data` on manos-mp. Transfer the local creds via base64 over SSH.

```bash
# From the repo root (after running manos:pair successfully)
B64=$(cd data && tar -czf - manos-wa-auth | base64 | tr -d '\n')
railway ssh --service manos-mp "rm -rf /data/manos-wa-auth && echo '$B64' | base64 -d | tar -xzf - -C /data"
```

Verify the transfer:
```bash
railway ssh --service manos-mp "ls /data/manos-wa-auth/"
# Expected: creds.json  + several session-*.json files (~30 files total)
```

---

## Step 7 — Deploy

```bash
# Deploy from your local working tree (NOT git push — Railway autodeploy may not trigger)
railway up --service manos-mp --detach

# Watch logs
railway logs --service manos-mp --tail
```

Expected startup log sequence:
```
manos:runner  Manos runner started ...
manos:wa      connected to WhatsApp { authDir: '/data/manos-wa-auth' }
manos:runner  Manos is online { number_env: '+57XXXXXXXXXX' }
```

If you see the QR code printed in the logs instead, the volume creds were not transferred correctly. Re-run Step 6 then restart:

```bash
railway service restart --service manos-mp --yes
```

---

## Step 8 — Smoke test

Send a WhatsApp message to the Manos number from any phone:

1. Send any text → expect: "Hola, soy Manos, el asistente de Redin para arquitectos. Para empezar, mándame tu cédula, por favor."
2. Reply with a real architect cédula from arquitectos_mirror → expect: "Perfecto, ¡listo <nombre>! ¿Con qué OT empezamos?"
3. Send an unknown cédula → expect: "No encontré esa cédula..." + Telegram alert fires

Check events in Supabase:
```sql
select type, created_at, meta
from eventos
where type in ('manos_cedula_verified', 'manos_cedula_rejected')
order by created_at desc
limit 10;
```

---

## Re-pairing (if logged out)

If the Railway logs show "logged out", the creds are invalid. Re-pair from scratch:

```bash
# Delete stale local creds
rm -rf data/manos-wa-auth/

# Re-pair (scan QR again with the Manos phone)
npm run manos:pair

# Transfer new creds to volume
B64=$(cd data && tar -czf - manos-wa-auth | base64 | tr -d '\n')
railway ssh --service manos-mp "rm -rf /data/manos-wa-auth && echo '$B64' | base64 -d | tar -xzf - -C /data"

# Restart service
railway service restart --service manos-mp --yes
```

---

## Redeploying code changes

Railway autodeploy via `git push` is not reliably wired. Always use `railway up`:

```bash
# From repo root (deploys current working tree — no git push needed)
railway up --service manos-mp --detach
```

`railway redeploy` only redeploys the CACHED snapshot — it does NOT pick up new code. Always use `railway up`.

---

## Key env vars summary

| Var | Required | Notes |
|-----|----------|-------|
| `SUPABASE_URL` | Yes | Same as all services |
| `SUPABASE_SECRET_KEY` | Yes | Service-role key |
| `ANTHROPIC_API_KEY` | Yes | Claude Sonnet 4.5 by default (override via `MANOS_MODEL`) |
| `MANOS_MODEL` | No | Anthropic model id. Default `claude-sonnet-4-5`. Set to `claude-haiku-4-5` to revert. |
| `MANOS_THINKING_ENABLED` | No | Extended thinking. Default ON. Set to `0` / `false` to revert to single-pass. |
| `MANOS_THINKING_BUDGET` | No | Hidden-reasoning budget (>=1024). Default 1024. |
| `MANOS_MAX_TOKENS` | No | Override max_tokens. Default `THINKING_BUDGET + 2048` (thinking on) / `2048` (off). |
| `GROQ_API_KEY` | Yes | Whisper transcription |
| `MANOS_DATA_DIR` | Yes | Must be `/data` (volume mount) |
| `TELEGRAM_BOT_TOKEN` | No | Cédula rejection alerts |
| `HR_TELEGRAM_CHAT_ID` | No | Same chat as Toño escalations |
| `MANOS_WA_NUMBER` | No | Informational only (in logs) |
| `RAILWAY_DOCKERFILE_PATH` | Yes | `manos/Dockerfile` |

---

## AppSheet writeback (alcance outbox)

`sync-mp` now also drains the alcance outbox (`ots_extended.appsheet_alcance_pending`). No separate deploy needed — sync-mp picks it up automatically on next deploy or restart.

If AppSheet's `Ordenes_Trabajo` table does not have an `Alcance_OT` column yet, the projector will log an error but will NOT crash — it leaves `appsheet_alcance_pending=true` and retries up to 5 times total. Add the column in AppSheet first, then the next sync tick will succeed.

---

## Architecture quick-ref

```
Manos WA number
       ↓ (Baileys WebSocket)
  manos-mp service
       ↓ runCedulaGate() — pre-LLM, cédula verified against arquitectos_mirror
       ↓ transcribeAudio() — Groq Whisper for voice notes
       ↓ handleManosMessage() — Claude Sonnet 4.5 (extended thinking ON) + 5 tools
       ↓ tools: list_my_pending_ots, attach_photos, set_alcance_ot, finalize_alcance, view_photo
       ↓ ots_extended (Supabase) ← source of truth for alcance state
       ↓ appsheet_alcance_pending=true → sync-mp outbox drains → AppSheet editOT()
```
