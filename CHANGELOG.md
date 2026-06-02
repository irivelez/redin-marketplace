# Changelog

A running, date-led log of what shipped to production. Newest first.
Append a few lines whenever something meaningful goes live — no version numbers
or release ceremony at this stage; `main` is always the deployed truth.

## 2026-06-02 — Redin financial KPI dashboard + new Railway account 📊

Shipped the private financial-reference dashboard and migrated production to a
fresh Railway account (deploys now from `irivelez/redin-marketplace`).

**Shipped (KPI/Estado financiero):**
- New `/publico/estado/[token]` page — HMAC-SHA256 token-gated (whitelist
  `redin-2026`), 7 server-rendered panels with recharts: hero P&L, monthly
  trend, per-client P&L, cartera aging, cost integrity, volume by city, perdidas.
- `sync` now mirrors AppSheet `Costos_Ejecucion` (1,034 rows) into
  `costos_ejecucion_mirror`, plus a 23:59 COT daily `ots_daily_snapshot`.
- Migrations 017–020: cost mirror, daily OT snapshot, 8 KPI views, and a
  `pg_cron` daily hero-KPI snapshot at 23:59 COT.
- Playwright e2e suite for the route (4 tests, green vs prod).

**Infra:**
- All 4 services (tono, manos, sync, dashboard) redeployed to the new Railway
  account; auto-deploy wired to `irivelez/redin-marketplace` @ `main`.
- Toño re-paired (`+573224347117`), live and serving traffic.

## 2026-05-29 — first release for real blue-collar workers 🚀

Toño (worker-facing WhatsApp agent) is live in production for real blue-collar
workers — this is the milestone v1.

**Live in production (Railway):**
- **Toño** — worker agent, WhatsApp `+573224347117`. Registration + screening,
  cédula identity gate, candidate dossier with recommendation, document intake.
  Claude Sonnet 4.5 + extended thinking.
- **Manos** — architect agent, WhatsApp `+573222392959`. Builds the OT *alcance*
  (scope) from text + voice + photos and produces a PDF.
- **sync** — AppSheet → Supabase mirror (read-only into AppSheet).
- **dashboard** — public OT board, HR pipeline, contract flow, técnico self-service.

**Shipped this cycle (Manos scope upgrade):**
- Manos now *sees* the architect's photos (Sonnet 4.5 + thinking + native vision),
  so the scope reflects what's in the images — plus a `view_photo(n)` tool to
  re-examine a prior photo.
- The alcance PDF embeds the photos under a "REGISTRO FOTOGRÁFICO" section.
- Fixed: link/PDF now deliver to LID-mode WhatsApp accounts (real session JID,
  not a phone-reconstructed one).
- Fixed: Toño no longer auto-sends the post-OT "rate 1–5" prompt (gated off).
- Security: photo paths validated fail-closed (no LLM-supplied path traversal).
