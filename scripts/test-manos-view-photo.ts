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

  console.log("\n✅ ALL view_photo ASSERTIONS PASSED");
}

main().catch((e) => {
  console.error("❌ TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
