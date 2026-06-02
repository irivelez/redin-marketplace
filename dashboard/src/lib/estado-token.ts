// HMAC-signed tokens for the private financial-reference page at
// /publico/estado/[token]. Same crypto pattern as public-token.ts but
// NAMESPACED via the literal "estado:" prefix on the HMAC input, so an
// OT-public token cannot be replayed against /publico/estado and vice-versa.
//
// Properties:
//   - Deterministic: same id → same token. Share without tracking issuance.
//   - Forgery-resistant: no secret, no valid token.
//   - Bulk-revocable: rotate SUPABASE_SECRET_KEY → all old tokens dead.
//   - Whitelist-gated: only ids in KNOWN_ESTADO_IDS are honored. Hard cap on
//     the URL surface — there's exactly one report to publish today.

import "server-only";
import crypto from "node:crypto";

// Allowed report identifiers. Adding a new viewer means appending an id here.
export const KNOWN_ESTADO_IDS = ["redin-2026"] as const;
export type EstadoId = (typeof KNOWN_ESTADO_IDS)[number];

function secret(): string {
  const k = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!k) throw new Error("SUPABASE_SECRET_KEY required for estado-token signing");
  return k;
}

function sign(id: string): string {
  // Namespace via prefix — same secret as public-token.ts but disjoint message-space.
  return crypto
    .createHmac("sha256", secret())
    .update("estado:" + id)
    .digest("base64url")
    .slice(0, 16);
}

export function signEstadoToken(id: EstadoId): string {
  return `${encodeURIComponent(id)}.${sign(id)}`;
}

// Returns the verified id (only if it's in the whitelist) or null.
export function verifyEstadoToken(token: string): EstadoId | null {
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;

  let id: string;
  try {
    id = decodeURIComponent(token.slice(0, idx));
  } catch {
    return null;
  }
  if (!id) return null;
  if (!(KNOWN_ESTADO_IDS as readonly string[]).includes(id)) return null;

  const presented = token.slice(idx + 1);
  let expected: string;
  try {
    expected = sign(id);
  } catch {
    return null;
  }

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? (id as EstadoId) : null;
}
