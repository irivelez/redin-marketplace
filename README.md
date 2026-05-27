# Redin Marketplace — v1 (Thin Full Loop)

Monorepo (npm workspaces) for the Redin marketplace:

- `shared/` — Supabase client, DB types, logger, env, phone helpers.
- `tools/` — the 9-tool contract (Toño's capabilities, reused by dashboard chat).
- `tono/` — Toño WhatsApp agent (Baileys + Gemini 2.5 Flash, multi-session).
- `sync/` — AppSheet → Supabase mirror worker (cron + on-demand).
- `dashboard/` — Next.js 14 app: public OT board, HR pipeline, HR contract flow, técnico self-service, embedded chat.
- `scripts/` — migration runner, Supabase type gen, **Phase 0 smoke**.

## Quick start (local)

```bash
cd /Users/irina/AI-driven-OS/autonomous/redin/marketplace

# 1. Install
npm install

# 2. Phase 0 smoke — seeds, exercises every tool, cleans up
npm run smoke

# 3. Pair Toño's WhatsApp (required ONCE — Irina scans QR)
npm run tono:pair

# 4. Run everything
npm run dev
```

## Environment

All credentials live in `marketplace/.env.local` (gitignored). Required:

| Var | Purpose |
| --- | --- |
| `SUPABASE_URL` | `https://foerbjhnwbxfauajkbld.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (browser-safe) |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (server-only, bypasses RLS) |
| `SUPABASE_MANAGEMENT_TOKEN` | `sbp_…` (for Management API migrations) |
| `SUPABASE_PROJECT_REF` | `foerbjhnwbxfauajkbld` |
| `DATABASE_URL` | Direct Postgres connection (optional; used only if we add CLI flows) |
| `WA_NUMBER` | `+573224347117` (Toño's provisioned WhatsApp number — Colombian) |
| `APPSHEET_APP_ID` | Copied from `agent/.env` — Jose's prod AppSheet |
| `APPSHEET_ACCESS_KEY` | Copied from `agent/.env` |
| `GEMINI_API_KEY` | Copied from `agent/.env` |
| `TELEGRAM_BOT_TOKEN` | Reused from v1 architect bot; optional — escalations log-only without it |
| `HR_TELEGRAM_CHAT_ID` | HR person's Telegram chat id; optional |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Only if you want to run dashboard with different public URL |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run smoke` | Phase 0 smoke against real Supabase. Seeds fake data, runs all 9 tools, cleans up. |
| `npm run tono:pair` | Starts Baileys in pairing mode, prints QR. Run ONCE to authorize Toño's WA number. |
| `npm run tono:dev` | Starts Toño in watch mode. |
| `npm run sync:once` | Runs one AppSheet→Supabase mirror refresh and exits. |
| `npm run sync:dev` | Starts sync worker with 15-min cron. |
| `npm run dashboard:dev` | Starts Next.js dev server on :3000. |
| `npm run dev` | All three services in parallel (tono + sync + dashboard). |
| `npm run migrate -- migrations/XXX.sql` | Apply a SQL migration via Management API. |
| `npm run gen:types` | Regenerate Supabase types via `supabase gen types`. |
| `npm run typecheck` | TypeScript check across all workspaces. |

## Hard constraints

- **Zero writes to AppSheet.** Read-only. Enforced by `AppSheetReadClient` having no `edit`/`add`.
- **Secrets only in `.env.local`.** Never in code, never committed.
- **Multi-session**: per-phone async mutex ensures 20+ concurrent WA conversations don't interleave state.
- **TypeScript strict + noUncheckedIndexedAccess** across every workspace.
- **Blue-collar UX rules** (stay in WA, "tú" register, LLM not state-machine) encoded in `tono/src/prompts/tono-system.ts`.

## Deploy notes (for Irina)

Three Railway services, shared `.env` copy:

- **tono**: needs a persistent volume mounted at `/data` (Baileys auth). Set `TONO_DATA_DIR=/data`.
- **sync**: stateless, Node service.
- **dashboard**: Next.js, Node service.

Do NOT push to GitHub or deploy from this branch yet — left to Irina.

## Known TODOs (deferred from v1)

- ZapSign e-signature integration (v2). Today: draft PDF + offline sign + manual upload.
- Twilio phone OTP for técnico auth in dashboard. Today: magic-link email for HR only.
- Cédula OCR / auto doc validation (HR validates manually).
- Post-OT rating flow (table exists, UX deferred).
- Supabase Auth ↔ tecnicos_extended linking (manual cross-reference via `tecnico_linked_to_auth` event).

## Source of truth

- PRD: `/Users/irina/AI-driven-OS/autonomous/redin/PRD.md`
- Schema: `migrations/001_init.sql` (applied)
- UX rules: memory `feedback_blue_collar_ux.md`
- Stack: memory `feedback_tecnico_platform_stack.md`
