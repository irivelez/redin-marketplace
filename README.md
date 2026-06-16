# Redin — agentic marketplace for Colombian field services

> A **[Deltanova](https://deltanova.co) S.A.S.** product. Deltanova integrates AI agentic
> systems into real LATAM business operations — built from San Francisco, for Colombia first.
> Redin is Deltanova's first design-partner deployment: a production-grade, **agent-native**
> marketplace that matches blue-collar maestros (técnicos) to field-service work orders (OTs)
> entirely over WhatsApp.

**Status: live in production.** Real blue-collar workers are onboarding through it today.
Two Claude-powered WhatsApp agents run the loop; a Next.js dashboard gives HR the controls.

---

## What Redin does

A maestro never leaves WhatsApp. They text Redin, get registered and screened, see the
work orders that fit them, apply, and receive their contract — all in Spanish, in the "tú"
register, conversationally. On the other side, an architect agent turns a site visit (text +
voice notes + photos) into a structured *alcance* (scope) PDF. HR watches and steers the
pipeline from a dashboard; the rest is driven by agents.

| Surface | Who it serves | What it is |
|---|---|---|
| **Toño** | Técnicos (workers) | WhatsApp agent — registration, cédula identity gate, screening, candidate dossier + recommendation, job matching, application, contract delivery. |
| **Manos** | Architects | WhatsApp agent — builds the OT *alcance* from text + voice + photos (native vision) and produces an embedded-photo PDF, delivered as a link **and** a WhatsApp document. |
| **Dashboard** | HR / public / técnicos | Next.js app — public OT board, HR pipeline, contract flow, técnico self-service, embedded chat. |
| **Sync** | The system | AppSheet → Supabase mirror (read-only into AppSheet) keeping marketplace state fresh. |

This is **light-touch agentic** by design: the agents drive the *conversation* autonomously;
HR still drives marketplace state transitions. Closing the gap to a fully autonomous
marketplace operator (proactive matching, follow-ups, supply-gap outreach) is the v2 frontier.

---

## Architecture

Monorepo via npm workspaces:

- `shared/` — Supabase client, DB types, logger, env, phone helpers.
- `tools/` — the **9-tool contract** (Toño's typed capabilities; reused by the dashboard chat and by Manos).
- `tono/` — Toño WhatsApp agent (Baileys, multi-session, **Claude Sonnet 4.5 + extended thinking**).
- `manos/` — Manos architect agent (Baileys, **Claude Sonnet 4.5 + thinking + native photo vision**).
- `sync/` — AppSheet → Supabase mirror worker (15-min cron + on-demand).
- `dashboard/` — Next.js 14: public OT board, HR pipeline, HR contract flow, técnico self-service, embedded chat.
- `qa/` — eval harness: deterministic checks + Gemini 2.5 Pro LLM-as-judge + coverage gates.
- `scripts/` — migration runner, Supabase type gen, Phase 0 smoke, cleanup helpers.

### Production discipline (the part that makes this a *product*, not a chatbot)

- **Typed tool schemas** + a **ReAct loop** with a hard iteration cap.
- **Router enforces policy, not the prompt**: identify-first, session-bound `tecnico_id`
  (LLM-supplied IDs are discarded), max-tool-calls cap, result truncation.
- **`<data source="…">` wrapping** of all user- and AppSheet-origin content — instructions
  inside data blocks are treated as data, never commands (prompt-injection defense).
- **Refusals + escalations logged to `eventos`** *before* the refusal text fires.
- **`prompt_sha` versioning** on every LLM call; **`llm_call` events** traced per round-trip.
- **Grounding gate** flags ungrounded specific-numbers / proper-nouns (log-only today).
- **Eval-driven**: `npm run eval` gates on 100% journey/refusal/red-team coverage + ≥90% judge pass.
- **Multi-session safety**: per-phone async mutex so 20+ concurrent WA conversations don't interleave state.

---

## Quick start (local)

```bash
# from the repo root
# 1. Install
npm install

# 2. Phase 0 smoke — seeds, exercises every tool, cleans up
npm run smoke

# 3. Pair Toño's WhatsApp (required ONCE — scan the QR)
npm run tono:pair

# 4. Run everything
npm run dev
```

## Environment

All credentials live in `marketplace/.env.local` (gitignored). Required:

| Var | Purpose |
| --- | --- |
| `SUPABASE_URL` | `https://<your-project-ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (browser-safe) |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (server-only, bypasses RLS) |
| `SUPABASE_MANAGEMENT_TOKEN` | `sbp_…` (for Management API migrations) |
| `SUPABASE_PROJECT_REF` | Your Supabase project ref |
| `DATABASE_URL` | Direct Postgres connection (optional; used only if we add CLI flows) |
| `ANTHROPIC_API_KEY` | Claude Sonnet 4.5 — powers both Toño and Manos |
| `WA_NUMBER` | Toño's provisioned WhatsApp number (E.164, e.g. `+57…`) |
| `MANOS_WA_NUMBER` | Manos' provisioned WhatsApp number (E.164) |
| `GROQ_API_KEY` | Voice-note transcription (Manos) |
| `APPSHEET_APP_ID` | Jose's prod AppSheet |
| `APPSHEET_ACCESS_KEY` | AppSheet API key |
| `GEMINI_API_KEY` | Eval LLM-as-judge (Gemini 2.5 Pro) + document classification |
| `TELEGRAM_BOT_TOKEN` | Architect/HR escalations; optional — escalations log-only without it |
| `HR_TELEGRAM_CHAT_ID` | HR person's Telegram chat id; optional |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Only if you want to run the dashboard with a different public URL |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run smoke` | Phase 0 smoke against real Supabase. Seeds fake data, runs all 9 tools, cleans up. |
| `npm run eval` | Eval harness — deterministic checks + Gemini 2.5 Pro judge + coverage gates. Exits non-zero on any gate fail. |
| `npm run tono:pair` | Starts Baileys in pairing mode, prints QR. Run ONCE to authorize Toño's WA number. |
| `npm run tono:dev` | Starts Toño in watch mode. |
| `npm run sync:once` | Runs one AppSheet→Supabase mirror refresh and exits. |
| `npm run sync:dev` | Starts sync worker with 15-min cron. |
| `npm run dashboard:dev` | Starts Next.js dev server on :3000. |
| `npm run dev` | tono + sync + dashboard in parallel. |
| `npm run migrate -- migrations/XXX.sql` | Apply a SQL migration via Management API. |
| `npm run gen:types` | Regenerate Supabase types via `supabase gen types`. |
| `npm run typecheck` | TypeScript check across all workspaces. |

## Hard constraints

- **Tightly-scoped AppSheet writes only.** On `Ordenes_Trabajo` the sole write is the alcance
  writeback (`sync` → `editOT`), which sets **only the `Alcance_OT` column** — it never writes
  `ID_Orden`, `Numero_Orden` (the consecutive), or any other field, and never Adds or Deletes OT
  rows. The other intentional write is the **TECNICOS reverse-projection** (`addTecnico` to add an
  approved worker to Jose's roster; `editTecnico` to soft-revoke via `Estado_Redin`). Nothing
  writes to `Clientes`, `Arquitecto`, or `Costos_Ejecucion`.
- **Secrets only in `.env.local`.** Never in code, never committed.
- **Multi-session**: per-phone async mutex ensures concurrent WA conversations don't interleave state.
- **TypeScript strict + `noUncheckedIndexedAccess`** across every workspace.
- **Blue-collar UX rules** (stay in WhatsApp, "tú" register, LLM-driven not state-machine)
  encoded in `tono/src/prompts/tono-system.ts`.

## Deploy

Four Railway services (project `redin-marketplace`, env `production`), shared `.env`:

- **tono** — needs a persistent volume mounted at `/data` (Baileys auth). Set `TONO_DATA_DIR=/data`.
- **manos** — same volume requirement. `MANOS_DATA_DIR=/data`, `MANOS_MODEL=claude-sonnet-4-5`.
- **sync** — stateless Node service.
- **dashboard** — Next.js Node service (the public-facing web app).

## Roadmap to fully-autonomous (v2)

- Proactive triggers: auto-match new OTs to técnicos, 24h follow-ups, supply-gap outreach.
- ZapSign e-signature integration (today: draft PDF + offline sign + manual upload).
- Twilio phone OTP for técnico auth in the dashboard (today: magic-link email for HR only).
- Cédula OCR / auto doc validation (today: HR validates manually).
- Post-OT customer rating flow (gated OFF behind `ENABLE_CUSTOMER_RATING`; fix dedup ordering before re-enabling).
- FK CASCADE on `contratos` / `postulaciones` / `documentos` so test cleanup stops orphaning rows + storage.

## Source of truth

- Story tracker: [`prd.json`](./prd.json) — open stories + acceptance criteria
- Schema: [`migrations/001_init.sql`](./migrations/001_init.sql) (applied; later migrations in [`migrations/`](./migrations/))
- Session handoffs: [`.omo/handoffs/`](./.omo/handoffs/) — newest first, the running context log
- Shipped log: [`CHANGELOG.md`](./CHANGELOG.md)
- Full PRD (kept alongside the repo, not committed): `redin/PRD.md` in the project root

---

*Redin is operated by Deltanova S.A.S. as a live design-partner pilot. It launched publicly
with known rough edges — the working artifact is the point.*
