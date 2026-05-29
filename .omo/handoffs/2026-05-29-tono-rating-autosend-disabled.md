# Status — Toño post-OT customer-rating auto-send DISABLED (deployed + merged)

**Saved:** 2026-05-29 · **By:** Sisyphus (agent B fork) · **Status:** 🟢 Live in prod · 🟢 Merged to main

---

## TL;DR

Toño was WhatsApping customers a post-OT rating prompt ("¿Cómo lo calificas del 1 al 5?") even though the rating UX is deferred to v2. Root cause: the `sync` cron's `enqueueCustomerRatingRequests()` shipped **active with no gate**. Fixed by gating it OFF by default. **Deployed to production and merged to main.** No change to Toño's conversational behaviour.

## Root cause

- `sync/src/mirror.ts` → `enqueueCustomerRatingRequests()` runs every ~15 min (cron in `sync/src/runner.ts`) and enqueues a `customer_rating_request` outbound for every OT in `Terminado` lacking a `customer_rating_requested` dedup event.
- There was **no feature flag**. README claimed "UX deferred" but the sender was fully live.
- Confirmed in prod: messages sent to 2 customers (Alizon Prieto — duplicated; Nicolás Cali).

## Fix shipped

- Added `customerRatingEnabled()` in `sync/src/mirror.ts` — returns true **only** when `ENABLE_CUSTOMER_RATING=true` (literal). Default **OFF**.
- `enqueueCustomerRatingRequests()` short-circuits when the gate is off.
- Scope: `sync/` only. **Toño's agent, tools, prompts, LLM unchanged.**
- The rating flow remains in code — set `ENABLE_CUSTOMER_RATING=true` on `sync-mp` to re-enable in v2.

## Verification

- RED→GREEN unit test: `scripts/test-customer-rating-gate.ts` (default OFF, only `true` enables).
- White-box no-send proof: `scripts/test-customer-rating-no-send.ts` (gate OFF → enqueuer makes zero DB calls; gate ON → reaches DB, proving it's not dead code).
- `npm run typecheck` clean across all 6 workspaces.

## Deployment

- **Live now.** Deployed directly to the `sync-mp` production service via `railway up --service sync-mp` (deployment status `SUCCESS`). `ENABLE_CUSTOMER_RATING` is NOT set on `sync-mp` → gate defaults OFF.
- **Merged to main:** PR #11 → `irinavelezk/main` @ `c2737a0` (commit `d3d99b7`). This makes the fix durable so a future git-based redeploy won't revert it.
- Repo note: `origin` remote (`irivelez/redin-marketplace`) is **dead** ("Repository not found"). Canonical repo = **`irinavelezk/redin-marketplace`**, default branch `main`, Railway auto-deploys from it. Consider removing the stale `origin` remote.

## Stopgap applied (reversible)

Before deploy, backfilled `customer_rating_requested` dedup events for all 51 current `Terminado` OTs (actor `system:rating-killswitch`, `meta.backfilled=true`) so the old live code would skip them. Post-deploy this is belt-and-suspenders. To reverse later: delete `eventos` where `actor='system:rating-killswitch'`.

## Post-deploy check

- `customer_rating_request` outbound created since deploy: **0**. Pending: **0**.

## ⚠️ Before re-enabling rating in v2 (pre-existing bug)

`enqueueOneCustomerRating()` writes the `customer_rating_requested` dedup event **after** the `outbound_messages` row. A failed event insert or racing cron double-sends (the duplicate seen in prod). Fix the write-ordering (event first) or add a unique index on `eventos (type, entity_id)` before flipping `ENABLE_CUSTOMER_RATING=true`.

## Action items for Irina

1. **Rotate the Railway token** used for this deploy (`6b226c3a-…`) — it was pasted in chat.
2. (Optional) Remove the dead `origin` remote: `git remote remove origin`.
3. v2: fix the duplicate-send dedup ordering before re-enabling rating.
