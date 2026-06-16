import crypto from "node:crypto";

// HMAC-signed, deterministic, DB-free public token for an OT. The token is
// `<urlencoded-ot_id>.<sig>` where sig is the first 16 base64url chars of
// HMAC-SHA256(ot_id) keyed by the given secret (SUPABASE_SECRET_KEY in prod).
//
// Canonical here in @redin/shared so BOTH the sync projector (which signs the
// link it writes into AppSheet's Alcance_OT) and the dashboard route (which
// verifies the link) use identical logic — no drift, no two copies of crypto.
//
// Deterministic ⇒ the same ot_id always yields the same token (re-shareable).
// Forgery-resistant ⇒ no valid token without the secret. Bulk-revocable ⇒
// rotating the secret invalidates every previously-issued link at once.

function sign(otId: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(otId)
    .digest("base64url")
    .slice(0, 16);
}

export function signOtPublicToken(otId: string, secret: string): string {
  if (!otId) throw new Error("signOtPublicToken: otId required");
  if (!secret) throw new Error("signOtPublicToken: secret required");
  return `${encodeURIComponent(otId)}.${sign(otId, secret)}`;
}

export function verifyOtPublicToken(
  token: string,
  secret: string
): string | null {
  if (!token || !secret) return null;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  let otId: string;
  try {
    otId = decodeURIComponent(token.slice(0, idx));
  } catch {
    return null;
  }
  if (!otId) return null;
  const presented = token.slice(idx + 1);
  const expected = sign(otId, secret);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? otId : null;
}
