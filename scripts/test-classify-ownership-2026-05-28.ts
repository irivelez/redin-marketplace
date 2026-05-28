import { createClient } from "@supabase/supabase-js";
import { createLogger } from "@redin/shared";
import { classifyDocumento } from "@redin/tools";
import type { ToolContext } from "@redin/tools";

const RUN_ID = `qa-classify-${Date.now()}`;
const WORKER_A = crypto.randomUUID();
const WORKER_B = crypto.randomUUID();
const PHONE_A = `+57000${(Date.now() % 1e8).toString().padStart(8, "0")}`;
const PHONE_B = `+57001${(Date.now() % 1e8).toString().padStart(8, "0")}`;

(async () => {
  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const cleanup: Array<() => Promise<unknown>> = [];

  try {
    console.log(`\n=== ${RUN_ID} ===`);
    console.log(`worker A: ${WORKER_A} (${PHONE_A})`);
    console.log(`worker B: ${WORKER_B} (${PHONE_B})`);

    // 1. Seed two fake workers
    for (const [id, phone] of [[WORKER_A, PHONE_A], [WORKER_B, PHONE_B]] as const) {
      const { error } = await supa.from("tecnicos_extended").insert({
        tecnico_id: id, phone, contact_phone: phone.slice(3), nombre: `QA ${id.slice(0, 4)}`,
        candidate_state: "screening",
      });
      if (error) throw new Error(`seed tecnico ${id} failed: ${error.message}`);
      cleanup.push(() => supa.from("tecnicos_extended").delete().eq("tecnico_id", id));
    }

    // 2. Insert a fake documento owned by worker A (no storage file — we only
    //    need the row; the ownership check runs BEFORE storage / Gemini calls)
    const { data: doc, error: docErr } = await supa.from("documentos").insert({
      tecnico_id: WORKER_A,
      tipo: "cedula",
      storage_path: `${WORKER_A}/cedula/test.pdf`,
    }).select("id").single();
    if (docErr) throw new Error(`seed documento failed: ${docErr.message}`);
    const documentoId = doc.id;
    cleanup.push(() => supa.from("documentos").delete().eq("id", documentoId));
    console.log(`documento ${documentoId} owned by worker A`);

    const baseCtx: ToolContext = {
      supabase: supa as any,
      logger: createLogger("qa"),
      defaultActor: "system",
    };

    // CASE 1 — worker B tries to classify worker A's doc → MUST be blocked
    const r1 = await classifyDocumento({ ...baseCtx, session_tecnico_id: WORKER_B }, {
      documento_id: documentoId,
    });
    if (r1.ok) {
      console.error("❌ CASE 1 FAIL: cross-worker access ALLOWED — security check broken");
      process.exit(1);
    }
    if (r1.code !== "forbidden") {
      console.error(`❌ CASE 1 FAIL: expected code=forbidden, got code=${r1.code}, error=${r1.error}`);
      process.exit(1);
    }
    console.log(`✅ CASE 1 PASS: cross-worker blocked (code=${r1.code})`);

    // CASE 2 — no session_tecnico_id (smoke-test path) → ownership check skips
    //    (will then either succeed or fail at Gemini/storage; we only assert
    //    that we got PAST the forbidden gate)
    const r2 = await classifyDocumento({ ...baseCtx, session_tecnico_id: null }, {
      documento_id: documentoId,
    });
    if (!r2.ok && r2.code === "forbidden") {
      console.error("❌ CASE 2 FAIL: ownership check blocked when session_tecnico_id was null");
      process.exit(1);
    }
    console.log(`✅ CASE 2 PASS: smoke-path bypasses ownership gate (got code=${r2.ok ? "ok" : r2.code})`);

    // CASE 3 — worker A classifies their own doc → MUST be allowed past gate
    const r3 = await classifyDocumento({ ...baseCtx, session_tecnico_id: WORKER_A }, {
      documento_id: documentoId,
    });
    if (!r3.ok && r3.code === "forbidden") {
      console.error("❌ CASE 3 FAIL: same-worker access blocked");
      process.exit(1);
    }
    console.log(`✅ CASE 3 PASS: same-worker passes gate (got code=${r3.ok ? "ok" : r3.code})`);

    console.log("\n=== ALL 3 CASES PASS ===");
  } catch (e) {
    console.error("FATAL:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    for (const c of cleanup.reverse()) {
      try { await c(); } catch {}
    }
    console.log("(cleanup done)");
  }
})();
