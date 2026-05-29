// White-box, no-DB proof that with the gate OFF the rating enqueuer touches
// NOTHING: inject a Supabase stub whose .from() throws. If the guard works,
// .from() is never reached and the method returns cleanly.

import assert from "node:assert/strict";
import { SyncWorker } from "../sync/src/mirror";
import { AppSheetReadClient } from "../sync/src/appsheet";
import type { ServerClient } from "@redin/shared";

delete process.env.ENABLE_CUSTOMER_RATING;

const throwingSupabase = {
  from() {
    throw new Error("DB touched while customer rating is disabled");
  },
} as unknown as ServerClient;

const worker = new SyncWorker({
  supabase: throwingSupabase,
  appsheet: new AppSheetReadClient({ appId: "x", accessKey: "y" }),
});

await (worker as unknown as { enqueueCustomerRatingRequests(): Promise<void> })
  .enqueueCustomerRatingRequests();

console.log("PASS: gate OFF → enqueuer made zero DB calls, sent nothing");

process.env.ENABLE_CUSTOMER_RATING = "true";
await assert.rejects(
  (worker as unknown as { enqueueCustomerRatingRequests(): Promise<void> })
    .enqueueCustomerRatingRequests(),
  /DB touched/,
  "gate ON must reach the DB (proves the guard, not a dead method)"
);
console.log("PASS: gate ON → enqueuer reaches the DB (guard is real, not dead code)");
