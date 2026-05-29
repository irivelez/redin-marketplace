// Unit test for preferredJid helper (Wave 1 RED → Wave 2 GREEN).
//
// Background:
//   On LID-mode WhatsApp accounts the real remoteJid is "<id>@lid", not
//   "<phone>@s.whatsapp.net". The outbound drainer was reconstructing the
//   recipient JID from row.phone via jidFromPhone(...), which produced a dead
//   address for LID accounts → link/PDF never arrived (Baileys reported
//   "sent" but the message went nowhere). Fix: capture the real inbound JID
//   on the session row's meta JSON and have the drainer prefer it.
//
// This script asserts the pure helper:
//   preferredJid(metaJid, phone) →
//     - returns metaJid verbatim when it is a string containing "@"
//     - falls back to jidFromPhone(phone) otherwise (undefined, non-string,
//       or string without "@")
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/test-manos-outbound-jid.ts
//
// No real Supabase / Baileys — pure unit test.

import assert from "node:assert/strict";
import { jidFromPhone } from "@redin/shared";
import { preferredJid } from "../manos/src/outbound";

function main(): void {
  // 1. LID JID stored on session meta → returned verbatim.
  const lid = "999999@lid";
  assert.equal(
    preferredJid(lid, "+137877543452841"),
    lid,
    "LID meta jid must be returned verbatim (bug repro: drainer used to clobber it via jidFromPhone)"
  );

  // 2. No meta jid → fall back to jidFromPhone (classic @s.whatsapp.net).
  const phone = "+573001112233";
  assert.equal(
    preferredJid(undefined, phone),
    jidFromPhone(phone),
    "undefined meta jid must fall back to jidFromPhone(phone)"
  );

  // 3. Malformed meta jid (no "@") → fall back to jidFromPhone.
  assert.equal(
    preferredJid("not-a-jid", phone),
    jidFromPhone(phone),
    "string without '@' must NOT be trusted as a jid; fall back to jidFromPhone"
  );

  // 4. Bonus: non-string meta (number, object, null) → fallback.
  assert.equal(
    preferredJid(null, phone),
    jidFromPhone(phone),
    "null meta jid must fall back to jidFromPhone"
  );
  assert.equal(
    preferredJid(12345, phone),
    jidFromPhone(phone),
    "non-string meta jid must fall back to jidFromPhone"
  );
  assert.equal(
    preferredJid({ jid: "999@lid" }, phone),
    jidFromPhone(phone),
    "object meta jid must fall back to jidFromPhone (caller must pre-extract .jid)"
  );

  // 5. classic @s.whatsapp.net meta jid → returned verbatim (still has '@').
  const classic = "573001112233@s.whatsapp.net";
  assert.equal(
    preferredJid(classic, phone),
    classic,
    "classic meta jid must also be returned verbatim"
  );

  console.log("OK preferredJid 6/6");
}

main();
