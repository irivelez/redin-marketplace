import { createServerClient } from "@redin/shared";
const supa = createServerClient();
(async () => {
  // List candidates: every approved or screening tecnico marked as test-like
  const { data: approved } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, candidate_state, profile_complete, phone, contact_phone, onboarded_at, source, import_source")
    .in("candidate_state", ["approved", "screening", "pending", "needs_call"]);

  const candidates = approved ?? [];

  console.log("=== Tecnicos with no validated docs (potential test data) ===");
  for (const t of candidates) {
    const { count: docCount } = await supa
      .from("documentos")
      .select("id", { count: "exact", head: true })
      .eq("tecnico_id", t.tecnico_id);
    const { count: postCount } = await supa
      .from("postulaciones")
      .select("id", { count: "exact", head: true })
      .eq("tecnico_id", t.tecnico_id);
    const { count: contractCount } = await supa
      .from("contratos")
      .select("id", { count: "exact", head: true })
      .eq("tecnico_id", t.tecnico_id);

    console.log(
      `  ${t.candidate_state.padEnd(11)} | docs=${(docCount ?? 0)} posts=${(postCount ?? 0)} contratos=${(contractCount ?? 0)} | ${t.nombre ?? "(no name)"} | phone=${t.phone} contact=${t.contact_phone ?? "-"} | source=${t.source ?? t.import_source ?? "-"} | id=${t.tecnico_id}`
    );
  }
})();
