// Unit test for the view_photo Manos tool (Wave 1 RED → Wave 2 GREEN).
//
// Asserts:
//   1. Valid n=1 on a 3-photo OT → ok with image_url derived from the
//      stored path (signed URL minted via storage.createSignedUrl).
//   2. n=0 / n=4 → err code "photo_not_found".
//   3. Ownership rejection (verifyOtOwnership says OT belongs to a
//      different arq_row_id) → err code "not_your_ot".
//   4. Storage path extraction works for BOTH formats stored historically
//      in photo_paths: a bare object path and a signed-URL string.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/test-manos-view-photo.ts
//
// No real Supabase calls — pure unit test with a stub ServerClient.

import assert from "node:assert/strict";
import { createLogger } from "@redin/shared";
import type { ToolContext } from "@redin/tools";

// Track what createSignedUrl was called with so we can assert on it.
interface SignedUrlCall {
  bucket: string;
  path: string;
  expiresIn: number;
}

function makeStub(opts: {
  otRowId: string;
  otOwnerArqRowId: string;
  estado: string;
  photoPaths: string[];
}): { ctx: ToolContext; signedCalls: SignedUrlCall[] } {
  const signedCalls: SignedUrlCall[] = [];

  // Chainable .select().eq()... that resolves on .maybeSingle().
  const makeQuery = (
    table: string
  ): {
    select: (cols?: string) => unknown;
  } => {
    const state: { table: string; eqKey?: string; eqVal?: string } = { table };
    const chain: Record<string, unknown> = {
      select(_cols?: string) {
        return chain;
      },
      eq(key: string, val: string) {
        state.eqKey = key;
        state.eqVal = val;
        return chain;
      },
      async maybeSingle() {
        if (table === "ots_mirror" && state.eqKey === "row_id") {
          if (state.eqVal !== opts.otRowId) {
            return { data: null, error: null };
          }
          return {
            data: {
              row_id: opts.otRowId,
              estado: opts.estado,
              data: { ID_Arquitecto: opts.otOwnerArqRowId },
            },
            error: null,
          };
        }
        if (table === "ots_extended" && state.eqKey === "ot_row_id") {
          if (state.eqVal !== opts.otRowId) {
            return { data: null, error: null };
          }
          return { data: { photo_paths: opts.photoPaths }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return chain as { select: (cols?: string) => unknown };
  };

  const supabase = {
    from(table: string): unknown {
      if (table === "eventos") {
        return { insert: async () => ({ error: null }) };
      }
      return makeQuery(table);
    },
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrl(path: string, expiresIn: number) {
            signedCalls.push({ bucket, path, expiresIn });
            return {
              data: { signedUrl: `https://signed.example/${bucket}/${path}?sig=stub` },
              error: null,
            };
          },
        };
      },
    },
  };

  const ctx: ToolContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger: createLogger("test-view-photo"),
    defaultActor: "system",
  };
  return { ctx, signedCalls };
}

async function main(): Promise<void> {
  const toolsMod = await import("@redin/tools/manos");
  const viewPhoto = (toolsMod as unknown as {
    viewPhoto?: (
      ctx: ToolContext,
      args: Record<string, unknown>
    ) => Promise<{ ok: boolean; data?: unknown; code?: string; error?: string }>;
  }).viewPhoto;
  assert.ok(
    typeof viewPhoto === "function",
    "@redin/tools/manos must export `viewPhoto`"
  );

  const OWNER = "arq-owner-1";
  const OT = "ot-row-1";
  // Mix bare object paths and signed-URL strings — both must reduce to the
  // same object key under alcance-photos/.
  const photoPaths = [
    "incoming/+573200000001/photo-1.jpg",
    "https://foerbjhnwbxfauajkbld.supabase.co/storage/v1/object/sign/alcance-photos/incoming/+573200000001/photo-2.jpg?token=abc",
    "incoming/+573200000001/photo-3.jpg",
  ];

  // --- Case 1: valid n=1 → ok with signed URL ---
  {
    const { ctx, signedCalls } = makeStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      photoPaths,
    });
    const res = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 1 });
    assert.equal(res.ok, true, `n=1 must succeed (got ${JSON.stringify(res)})`);
    const data = (res.data ?? {}) as { image_url?: string; n?: number };
    assert.ok(
      typeof data.image_url === "string" && data.image_url.length > 0,
      "n=1 must return image_url"
    );
    assert.equal(data.n, 1);
    assert.equal(signedCalls.length, 1, "exactly one createSignedUrl call");
    assert.equal(signedCalls[0]!.bucket, "alcance-photos");
    assert.equal(
      signedCalls[0]!.path,
      "incoming/+573200000001/photo-1.jpg",
      `bare path must pass through unchanged (got '${signedCalls[0]!.path}')`
    );
    assert.equal(signedCalls[0]!.expiresIn, 3600);
    console.log("✅ Case 1: n=1 returns fresh signed URL");
  }

  // --- Case 2: valid n=2 against a signed-URL entry — path is normalized ---
  {
    const { ctx, signedCalls } = makeStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      photoPaths,
    });
    const res = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 2 });
    assert.equal(res.ok, true, `n=2 must succeed (got ${JSON.stringify(res)})`);
    assert.equal(
      signedCalls[0]!.path,
      "incoming/+573200000001/photo-2.jpg",
      "signed-URL entry must be normalized to bare object path (strip prefix + ?query)"
    );
    console.log("✅ Case 2: signed-URL entries normalize to object path");
  }

  // --- Case 3: out-of-range n → photo_not_found ---
  {
    const { ctx } = makeStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      photoPaths,
    });
    const tooBig = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 99 });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.code, "photo_not_found", "n=99 must err code photo_not_found");

    const zero = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 0 });
    assert.equal(zero.ok, false);
    assert.equal(zero.code, "photo_not_found", "n=0 must err code photo_not_found");
    console.log("✅ Case 3: out-of-range n → photo_not_found");
  }

  // --- Case 4: ownership rejection ---
  {
    const { ctx } = makeStub({
      otRowId: OT,
      otOwnerArqRowId: "arq-other-1",
      estado: "4. Coordinar – Listo para ejecutar",
      photoPaths,
    });
    const res = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.code, "not_your_ot", "wrong arq_row_id must err code not_your_ot");
    console.log("✅ Case 4: ownership rejection");
  }

  // --- Case 5: view-photo path-validation — stored '../secret.jpg' rejected ---
  {
    const { ctx } = makeStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      photoPaths: ["incoming/../secret.jpg"],
    });
    const res = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 1 });
    assert.equal(res.ok, false, "stored '..' path must be rejected");
    assert.equal(
      res.code,
      "invalid_photo_path",
      `expected invalid_photo_path (got '${res.code}')`
    );
    console.log("✅ Case 5: view_photo rejects stored '..' traversal");
  }

  // --- Case 6: view-photo path-validation — bare 'secret/key.jpg' rejected (no incoming/ prefix) ---
  {
    const { ctx } = makeStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      photoPaths: ["secret/key.jpg"],
    });
    const res = await viewPhoto!(ctx, { arq_row_id: OWNER, ot_row_id: OT, n: 1 });
    assert.equal(res.ok, false, "stored 'secret/key.jpg' must be rejected");
    assert.equal(
      res.code,
      "invalid_photo_path",
      `expected invalid_photo_path (got '${res.code}')`
    );
    console.log("✅ Case 6: view_photo rejects stored path without incoming/ prefix");
  }

  await runAttachPhotosTests();

  console.log("\n✅ ALL view_photo + attach_photos ASSERTIONS PASSED");
}

// ---------------------------------------------------------------------------
// attach_photos — input-gate validation (security fix).
// LLM-supplied photo_urls must be either an https Supabase signed URL for the
// alcance-photos bucket OR a bare incoming/<phone>/<uuid>.<ext> object key.
// Anything else (traversal, arbitrary-bucket keys) → invalid_photo_url.
// ---------------------------------------------------------------------------
function makeAttachStub(opts: {
  otRowId: string;
  otOwnerArqRowId: string;
  estado: string;
  sessionPhone?: string;
  sessionId?: string;
}): { ctx: ToolContext; upserts: { table: string; row: Record<string, unknown> }[] } {
  const upserts: { table: string; row: Record<string, unknown> }[] = [];

  const makeQuery = (table: string): { select: (cols?: string) => unknown } => {
    const state: { eqKey?: string; eqVal?: string } = {};
    const chain: Record<string, unknown> = {
      select(_cols?: string) {
        return chain;
      },
      eq(key: string, val: string) {
        state.eqKey = key;
        state.eqVal = val;
        return chain;
      },
      async maybeSingle() {
        if (table === "ots_mirror" && state.eqKey === "row_id") {
          if (state.eqVal !== opts.otRowId) return { data: null, error: null };
          return {
            data: {
              row_id: opts.otRowId,
              estado: opts.estado,
              data: { ID_Arquitecto: opts.otOwnerArqRowId },
            },
            error: null,
          };
        }
        if (table === "ots_extended" && state.eqKey === "ot_row_id") {
          return { data: { photo_paths: [] }, error: null };
        }
        if (table === "sessions" && state.eqKey === "id") {
          if (state.eqVal !== opts.sessionId) return { data: null, error: null };
          return { data: { phone: opts.sessionPhone ?? null }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return chain as { select: (cols?: string) => unknown };
  };

  const supabase = {
    from(table: string): unknown {
      if (table === "eventos") {
        return { insert: async () => ({ error: null }) };
      }
      if (table === "ots_extended") {
        return {
          ...makeQuery(table),
          upsert: async (row: Record<string, unknown>) => {
            upserts.push({ table, row });
            return { error: null };
          },
        };
      }
      return makeQuery(table);
    },
  };

  const ctx: ToolContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger: createLogger("test-attach-photos"),
    defaultActor: "system",
    session_id: opts.sessionId,
  };
  return { ctx, upserts };
}

async function runAttachPhotosTests(): Promise<void> {
  const toolsMod = await import("@redin/tools/manos");
  const attachPhotos = (toolsMod as unknown as {
    attachPhotos?: (
      ctx: ToolContext,
      args: Record<string, unknown>
    ) => Promise<{ ok: boolean; data?: unknown; code?: string; error?: string }>;
  }).attachPhotos;
  assert.ok(
    typeof attachPhotos === "function",
    "@redin/tools/manos must export `attachPhotos`"
  );

  const OWNER = "arq-owner-1";
  const OT = "ot-row-1";
  const PHONE = "+573200000001";
  const SESSION = "session-uuid-test";
  const UUID_OK = "11111111-2222-3333-4444-555555555555";
  const VALID_KEY = `incoming/${PHONE}/${UUID_OK}.jpg`;
  const VALID_URL = `https://foerbjhnwbxfauajkbld.supabase.co/storage/v1/object/sign/alcance-photos/${VALID_KEY}?token=abc`;

  // --- Case 7: valid bare key incoming/<phone>/<uuid>.jpg → ok ---
  {
    const { ctx, upserts } = makeAttachStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      sessionPhone: PHONE,
      sessionId: SESSION,
    });
    const res = await attachPhotos!(ctx, {
      arq_row_id: OWNER,
      ot_row_id: OT,
      photo_urls: [VALID_KEY],
    });
    assert.equal(res.ok, true, `valid bare key must be accepted (got ${JSON.stringify(res)})`);
    assert.ok(upserts.length === 1, "upsert must fire on accepted entry");
    console.log("✅ Case 7: attach_photos accepts incoming/<phone>/<uuid>.jpg");
  }

  // --- Case 7b: valid signed URL also accepted ---
  {
    const { ctx, upserts } = makeAttachStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      sessionPhone: PHONE,
      sessionId: SESSION,
    });
    const res = await attachPhotos!(ctx, {
      arq_row_id: OWNER,
      ot_row_id: OT,
      photo_urls: [VALID_URL],
    });
    assert.equal(res.ok, true, `signed URL must be accepted (got ${JSON.stringify(res)})`);
    assert.ok(upserts.length === 1);
    console.log("✅ Case 7b: attach_photos accepts legitimate signed URL");
  }

  // --- Case 8: 'incoming/../secret.jpg' rejected ---
  {
    const { ctx, upserts } = makeAttachStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      sessionPhone: PHONE,
      sessionId: SESSION,
    });
    const res = await attachPhotos!(ctx, {
      arq_row_id: OWNER,
      ot_row_id: OT,
      photo_urls: ["incoming/../secret.jpg"],
    });
    assert.equal(res.ok, false, "'..' traversal must be rejected");
    assert.equal(
      res.code,
      "invalid_photo_url",
      `expected invalid_photo_url (got '${res.code}')`
    );
    assert.equal(upserts.length, 0, "no upsert when entry rejected");
    console.log("✅ Case 8: attach_photos rejects 'incoming/../secret.jpg'");
  }

  // --- Case 9: bare 'secret/key.jpg' (no incoming/ prefix) rejected ---
  {
    const { ctx, upserts } = makeAttachStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      sessionPhone: PHONE,
      sessionId: SESSION,
    });
    const res = await attachPhotos!(ctx, {
      arq_row_id: OWNER,
      ot_row_id: OT,
      photo_urls: ["secret/key.jpg"],
    });
    assert.equal(res.ok, false, "no-incoming-prefix must be rejected");
    assert.equal(
      res.code,
      "invalid_photo_url",
      `expected invalid_photo_url (got '${res.code}')`
    );
    assert.equal(upserts.length, 0);
    console.log("✅ Case 9: attach_photos rejects 'secret/key.jpg' (no incoming/ prefix)");
  }

  // --- Case 10: without session phone, path SHAPE still enforced (wrong phone in key still ok if SHAPE matches) ---
  {
    const { ctx } = makeAttachStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      sessionId: undefined,
    });
    const res = await attachPhotos!(ctx, {
      arq_row_id: OWNER,
      ot_row_id: OT,
      photo_urls: ["incoming/+999/" + UUID_OK + ".jpg"],
    });
    assert.equal(
      res.ok,
      true,
      `without session phone, valid shape must be accepted (got ${JSON.stringify(res)})`
    );
    console.log("✅ Case 10: shape-only check applied when session phone unavailable");
  }

  // --- Case 11: with session phone, wrong-phone entry rejected ---
  {
    const { ctx } = makeAttachStub({
      otRowId: OT,
      otOwnerArqRowId: OWNER,
      estado: "4. Coordinar – Listo para ejecutar",
      sessionPhone: PHONE,
      sessionId: SESSION,
    });
    const res = await attachPhotos!(ctx, {
      arq_row_id: OWNER,
      ot_row_id: OT,
      photo_urls: ["incoming/+999/" + UUID_OK + ".jpg"],
    });
    assert.equal(res.ok, false, "wrong phone in key must be rejected");
    assert.equal(res.code, "invalid_photo_url");
    console.log("✅ Case 11: session-phone-bound check rejects mismatched key");
  }
}

main().catch((e) => {
  console.error("❌ TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
