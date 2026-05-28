import { createClient } from "@supabase/supabase-js";
import { createLogger } from "@redin/shared";
import { classifyDocumento } from "@redin/tools";

const DOC_ID = process.argv[2];
if (!DOC_ID) { console.error("usage: diag-classify.ts <documento_id>"); process.exit(1); }

(async () => {
  const supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const ctx = {
    supabase: supa as never,
    logger: createLogger("diag"),
    defaultActor: "system" as const,
  };
  console.log(`calling classifyDocumento(${DOC_ID})...`);
  const t0 = Date.now();
  const result = await classifyDocumento(ctx, { documento_id: DOC_ID });
  console.log(`  elapsed: ${Date.now() - t0}ms`);
  console.log(`  result:`, JSON.stringify(result, null, 2));
})();
