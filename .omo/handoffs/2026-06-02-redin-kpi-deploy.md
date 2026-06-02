# Handoff — Redin financial KPI dashboard SHIPPED to production (new Railway account)

**Saved:** 2026-06-02 · **By:** Sisyphus (ultrawork) · **Status:** 🟢 Deployed + verified end-to-end on prod

Deploys a pre-existing, uncommitted KPI/financial-reference feature (authored 2026-05-29) to the **new** Railway account, from the `irivelez/redin-marketplace` repo (the only repo now; `irinavelezk` decommissioned).

---

## 0. TL;DR

1. 🟢 **`/publico/estado/[token]`** is live — token-gated (HMAC-SHA256, whitelist `redin-2026`) 7-panel financial dashboard (hero P&L, monthly trend, client P&L, cartera aging, cost integrity, volume by city, perdidas). recharts.
2. 🟢 **4 migrations applied to prod Supabase** (017 costos mirror, 018 daily OT snapshot, 019 8 KPI views, 020 pg_cron hero-snapshot @ 23:59 COT). All idempotent.
3. 🟢 **sync** now mirrors AppSheet `Costos_Ejecucion` → `costos_ejecucion_mirror` (**1034 rows** live) + a 23:59 COT `ots_daily_snapshot`.
4. 🟢 **All 5 scenarios PASS** (S1 migrations+views, S2 e2e 4/4 vs prod, S3 invalid→404, S4 sync 1034/1034 ok=true, S5 regression — tono serving live traffic, routes unchanged).
5. 🟢 **5 commits pushed** to `irivelez/main` (`1c1afc4` HEAD). Railway auto-deployed sync+dashboard SUCCESS.

---

## 1. What shipped (commits on irivelez/main)

```
1c1afc4 docs(changelog): 2026-06-02 KPI dashboard + new Railway account
277d04b docs(handoff): test data cleanup notes (2026-05-29)
acaf034 feat(dashboard): public /publico/estado/[token] KPI financial reference
c716bf9 feat(sync): mirror costos_ejecucion + 23:59 COT ots_daily snapshot
c4d35f9 feat(db): KPI mirrors + snapshots + views for /publico/estado
```

- **DB**: migrations/017–020 + `scripts/verify-redin-kpi.ts`
- **sync**: `mirror.ts` (mirrorCostosEjecucion + snapshotOtsDaily + appsheetDate/Numeric), `runner.ts` (23:59 COT cron), `appsheet.ts` (MIRROR_TABLES.COSTOS + AppSheetCosto READ type — no new AppSheet writes)
- **dashboard**: `/publico/estado/[token]/` page + 13 components, `lib/{estado-token,kpi-queries,format-cop,timeline}.ts`, `playwright.config.ts`, `tests/e2e/estado.spec.ts`, `scripts/gen-estado-token.ts`. recharts ^2.15.4 runtime dep.
- **.gitignore**: added `**/test-results/` + `**/__screenshots__/` (Playwright artifacts).

**One test fix during deploy:** `estado.spec.ts` had 2 stale hero-label assertions (`"Costo (conservador)"`→`"Costo (líneas)"`, `"Cartera por cobrar"`→`"Cartera"`). Component copy is source of truth; fixed test to match. RED→GREEN captured.

---

## 2. How to use the dashboard

Mint a token (whitelist id = `redin-2026`):
```bash
set -a; source .env.local; set +a
DASHBOARD_BASE_URL=https://dashboard-production-e08af.up.railway.app npx tsx scripts/gen-estado-token.ts redin-2026
```
→ URL: `https://dashboard-production-e08af.up.railway.app/publico/estado/redin-2026.<sig>`
Share privately (no listing). Invalid token → 404.

Verify KPI data anytime: `npx tsx --env-file=.env.local scripts/verify-redin-kpi.ts`

---

## 3. Prod state (verified 2026-06-02)

- KPI: lifetime revenue **$1.87B COP**, conservative margin **78.6%**, 768 OTs, cartera $161M (65 outstanding).
- `costos_ejecucion_mirror`: 1034 rows (988 aprobado / 44 pendiente / 2 rechazado).
- `ots_daily_snapshot`: backfilled (2026-05-28: 761, 2026-06-01: 768). pg_cron `redin-kpi-hero-daily` registered, fires 23:59 COT.
- Railway: all 4 services SUCCESS on `irivelez/redin-marketplace`. Dashboard https://dashboard-production-e08af.up.railway.app
- Toño live + serving real WA traffic. **Manos still UNPAIRED** (QR-waiting — pre-existing, not from this deploy; pair when ready, same flow as Toño).

---

## 4. Follow-ups (non-blocking)

1. **Drop `@ts-expect-error` markers** (4 in `sync/src/mirror.ts`, 2 in `dashboard/src/lib/kpi-queries.ts`) after `npm run gen:types` regenerates Supabase types to include the new tables/views. Cosmetic; typecheck+build already pass with them.
2. **Pair Manos** (`+573222392959`) when ready — same QR flow used for Toño.
3. First `pg_cron` hero snapshot fires 23:59 COT today — confirm a row lands in `redin_kpi_hero_daily` tomorrow.
