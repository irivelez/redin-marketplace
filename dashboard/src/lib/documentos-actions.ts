// Server actions for document validation — HR stamps a documento as validated.
// Lives in its own file to keep decisions.ts focused on the qualification gate.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// validateDocumento
//
// HR stamps a documentos row with validated_by = 'hr:<email>' and
// validated_at = now(). Idempotent — re-stamping is fine (HR may want to
// re-confirm after a doc update). The documento must belong to the tecnico
// (service client bypasses RLS; we manually check the FK).
// ---------------------------------------------------------------------------

export async function validateDocumento(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const documentoId = formData.get("documento_id");
  const tecnicoId = formData.get("tecnico_id");

  if (typeof documentoId !== "string" || !documentoId.trim()) return;
  if (typeof tecnicoId !== "string" || !tecnicoId.trim()) return;

  const supa = serviceClient();

  // Verify the documento belongs to this tecnico (prevents cross-worker stamping).
  const { data: doc, error: fetchErr } = await supa
    .from("documentos")
    .select("id, tecnico_id")
    .eq("id", documentoId)
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();

  if (fetchErr) {
    console.error("validateDocumento fetch failed", {
      documentoId,
      error: fetchErr.message,
    });
    return;
  }
  if (!doc) {
    console.error("validateDocumento: documento not found or belongs to different tecnico", {
      documentoId,
      tecnicoId,
    });
    return;
  }

  const { error: updateErr } = await supa
    .from("documentos")
    .update({
      validated_by: `hr:${hrEmail}`,
      validated_at: new Date().toISOString(),
    })
    .eq("id", documentoId);

  if (updateErr) {
    console.error("validateDocumento update failed", {
      documentoId,
      error: updateErr.message,
    });
    return;
  }

  // Audit trail.
  await supa.from("eventos").insert({
    type: "hr_doc_validated",
    entity_id: tecnicoId,
    actor: `hr:${hrEmail}`,
    meta: { documento_id: documentoId },
  });

  revalidatePath(`/hr/tecnicos/${tecnicoId}`);
}
