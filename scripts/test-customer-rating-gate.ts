// Gate for the post-OT customer-rating auto-send. The rating UX is deferred,
// so the cron MUST NOT send the prompt unless explicitly enabled. Only the
// literal "true" turns it on; everything else (unset, "false", "1") = OFF.

import assert from "node:assert/strict";
import { customerRatingEnabled } from "../sync/src/mirror";

delete process.env.ENABLE_CUSTOMER_RATING;
assert.equal(customerRatingEnabled(), false, "unset must be OFF (UX deferred)");

process.env.ENABLE_CUSTOMER_RATING = "true";
assert.equal(customerRatingEnabled(), true, "'true' enables");

process.env.ENABLE_CUSTOMER_RATING = "TRUE";
assert.equal(customerRatingEnabled(), true, "'TRUE' enables (case-insensitive)");

process.env.ENABLE_CUSTOMER_RATING = "false";
assert.equal(customerRatingEnabled(), false, "'false' stays OFF");

process.env.ENABLE_CUSTOMER_RATING = "1";
assert.equal(customerRatingEnabled(), false, "only literal 'true' enables");

console.log("PASS: customer rating gate");
