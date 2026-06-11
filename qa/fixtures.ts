/**
 * qa/fixtures.ts — DB seed/cleanup helpers for the S07 eval harness.
 *
 * All test rows use:
 *   phone:      "+99000" + 7-digit suffix  (e.g. +990001000001)
 *   tecnico_id: "TEST_" prefix             (e.g. TEST_bogel01)
 *   ot_id:      "TEST_OT_" prefix          (e.g. TEST_OT_bogota_elec_001)
 *
 * cleanupTestData() deletes every row matching these prefixes so the DB stays
 * clean between runs and on --clean invocations.
 */

import { createServerClient } from "@redin/shared";
import type { DBFixture } from "./seeds/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureRefs {
  tecnico_id: string | null;
  ot_ids: string[];
}

// ---------------------------------------------------------------------------
// Phone allocator — deterministic per seed run
// ---------------------------------------------------------------------------

let phoneCounter = 1_000_000;

export function allocateTestPhone(): string {
  const suffix = String(phoneCounter++).padStart(7, "0");
  return `+99000${suffix}`;
}

// ---------------------------------------------------------------------------
// Individual fixture seeders
// ---------------------------------------------------------------------------

async function seedTecnicoNotRegistered(
  _testPhone: string
): Promise<FixtureRefs> {
  // "not registered" = no rows needed. Phone is fresh.
  return { tecnico_id: null, ot_ids: [] };
}

// ---------------------------------------------------------------------------
// Stream A fixtures
// ---------------------------------------------------------------------------

// Cedulas live in a TEST_-reserved range so they never collide with real data.
// The trailing 6 digits of the testPhone yield a unique cedula per fixture.
// Exported so qa/runner.ts can substitute ${cedula} in user_utterances.
export function testCedulaFor(testPhone: string): string {
  return `99${testPhone.slice(-7).padStart(7, "0")}`;
}

async function seedTecnicoLegacyApprovedIncomplete(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_legacy_inc_${testPhone.slice(-6)}`;
  const nombre = `Legacy Worker ${testPhone.slice(-3)}`;

  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: testPhone,
    estado: "activo",
    candidate_state: "approved",
    profile_complete: false,
    appsheet_row_id: `TEST_AS_${tecnico_id}`,
    legacy_popularidad: 5,
    legacy_activity_count: 5,
    imported_at: new Date().toISOString(),
    import_source: "appsheet_legacy_bootstrap",
    source: "appsheet_legacy_bootstrap",
  });
  if (extErr)
    throw new Error(`fixture legacy_approved_incomplete: ${extErr.message}`);

  // Bootstrap event so loadDisplayName can greet by name.
  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_legacy_bootstrap")
    .eq("entity_id", tecnico_id);
  const { error: evtErr } = await supabase.from("eventos").insert({
    type: "tecnico_legacy_bootstrap",
    entity_id: tecnico_id,
    actor: "system:legacy_bootstrap",
    meta: {
      nombre,
      email: null,
      telefono: testPhone,
      popularidad: 5,
      activity_count: 5,
      appsheet_row_id: `TEST_AS_${tecnico_id}`,
    },
  });
  if (evtErr) throw new Error(`fixture legacy bootstrap event: ${evtErr.message}`);

  // Synthetic candidate_decisions row mirrors what the bootstrap script writes.
  await supabase
    .from("candidate_decisions")
    .delete()
    .eq("tecnico_id", tecnico_id)
    .eq("decided_by", "system:legacy_bootstrap");
  await supabase.from("candidate_decisions").insert({
    tecnico_id,
    dossier_id: null,
    decision: "approve",
    resulting_state: "approved",
    prior_state: "screening",
    tono_recommendation_at_decision_time: null,
    agreed_with_tono: null,
    hr_reasoning:
      "TEST fixture — legacy bootstrap. Eligible by historical work record.",
    decided_by: "system:legacy_bootstrap",
  });

  return { tecnico_id, ot_ids: [] };
}

// Same as tecnico_legacy_approved_incomplete but the row lives on a sister
// phone, leaving testPhone fresh. Used by Test G to verify the
// find_legacy_by_name -> escalate_to_hr reconciliation path: the conversation
// happens on a brand new phone, but the worker's name matches a legacy
// worker who was bootstrapped under another number.
async function seedTecnicoLegacyIncompleteSisterPhone(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_legacy_sis_${testPhone.slice(-6)}`;
  // Use a stable, recognizable name — the test seed will reproduce it
  // verbatim (or with a 1-letter typo for the fuzzy path).
  const nombre = legacyNombreFor(testPhone);
  const sisterPhone = sisterPhoneFor(testPhone);

  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: sisterPhone,
    estado: "activo",
    candidate_state: "approved",
    profile_complete: false,
    appsheet_row_id: `TEST_AS_${tecnico_id}`,
    legacy_popularidad: 7,
    legacy_activity_count: 7,
    imported_at: new Date().toISOString(),
    import_source: "appsheet_legacy_bootstrap",
    source: "appsheet_legacy_bootstrap",
  });
  if (extErr)
    throw new Error(`fixture legacy_incomplete_sister_phone: ${extErr.message}`);

  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_legacy_bootstrap")
    .eq("entity_id", tecnico_id);
  await supabase.from("eventos").insert({
    type: "tecnico_legacy_bootstrap",
    entity_id: tecnico_id,
    actor: "system:legacy_bootstrap",
    meta: {
      nombre,
      email: null,
      telefono: sisterPhone,
      popularidad: 7,
      activity_count: 7,
      appsheet_row_id: `TEST_AS_${tecnico_id}`,
    },
  });

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoLegacyApprovedComplete(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_legacy_cmp_${testPhone.slice(-6)}`;
  const nombre = `Returning Worker ${testPhone.slice(-3)}`;
  const cedula = testCedulaFor(testPhone);

  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: testPhone,
    estado: "activo",
    candidate_state: "approved",
    profile_complete: true,
    cedula,
    appsheet_row_id: `TEST_AS_${tecnico_id}`,
    legacy_popularidad: 9,
    legacy_activity_count: 9,
    imported_at: new Date().toISOString(),
    import_source: "appsheet_legacy_bootstrap",
    source: "appsheet_legacy_bootstrap",
    enrichment_data: {
      cedula: { tipo: "CC", numero: cedula },
      ciudad_base: "Cali",
      categorias_principales: ["Eléctrico y Datos"],
    },
  });
  if (extErr)
    throw new Error(`fixture legacy_approved_complete: ${extErr.message}`);

  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_legacy_bootstrap")
    .eq("entity_id", tecnico_id);
  await supabase.from("eventos").insert({
    type: "tecnico_legacy_bootstrap",
    entity_id: tecnico_id,
    actor: "system:legacy_bootstrap",
    meta: { nombre, email: null, telefono: testPhone, popularidad: 9 },
  });

  return { tecnico_id, ot_ids: [] };
}

// Returns a "sister" phone derived from testPhone — used for fixtures that
// must seed a worker on a DIFFERENT phone than the conversation phone, so the
// cross-phone resumption flow has somewhere to resume from.
function sisterPhoneFor(testPhone: string): string {
  return `+99001${testPhone.slice(-7)}`;
}

// The deterministic name used by tecnico_legacy_incomplete_sister_phone.
// Exported so the runner can substitute ${legacy_nombre} in user_utterances —
// keeps the seed YAML free of testPhone-derived literals.
export function legacyNombreFor(testPhone: string): string {
  return `Andres Mendoza ${testPhone.slice(-3)}`;
}

async function seedTecnicoScreeningWithCedula(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_scr_ced_${testPhone.slice(-6)}`;
  const cedula = testCedulaFor(testPhone);
  // Seed on a sister phone so the conversation testPhone is fresh and
  // submit_candidate_dossier triggers a cross-phone merge.
  const sisterPhone = sisterPhoneFor(testPhone);

  const { error } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: sisterPhone,
    estado: "activo",
    candidate_state: "screening",
    cedula,
    source: "warm",
  });
  if (error) throw new Error(`fixture screening_with_cedula: ${error.message}`);

  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id);
  await supabase.from("eventos").insert({
    type: "tecnico_registered",
    entity_id: tecnico_id,
    actor: "agent",
    meta: {
      nombre: `Cross-Phone Worker ${testPhone.slice(-3)}`,
      ciudad: "Bogotá",
      especialidades: ["eléctrico"],
      modalidad: "individual",
      phone: sisterPhone,
    },
  });

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoWithdrawnWithCedula(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_wd_ced_${testPhone.slice(-6)}`;
  const cedula = testCedulaFor(testPhone);
  const sisterPhone = sisterPhoneFor(testPhone);

  const { error } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: sisterPhone,
    estado: "activo",
    candidate_state: "withdrawn",
    cedula,
    withdrawal_reason: "no_cedula_provided",
    source: "warm",
  });
  if (error) throw new Error(`fixture withdrawn_with_cedula: ${error.message}`);

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoPendingWithCedula(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_pen_ced_${testPhone.slice(-6)}`;
  const cedula = testCedulaFor(testPhone);
  // Pending on a sister phone so cross-phone resumption from testPhone
  // hits find_by_cedula -> already_decided.
  const sisterPhone = sisterPhoneFor(testPhone);

  const { error } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: sisterPhone,
    estado: "activo",
    candidate_state: "pending",
    cedula,
    source: "warm",
  });
  if (error) throw new Error(`fixture pending_with_cedula: ${error.message}`);

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoRegisteredBogotaElectrico(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_bogel01_${testPhone.slice(-6)}`;
  const cedula = testCedulaFor(testPhone);

  // Post-approval state (candidate_state="approved", profile_complete=true,
  // cedula set) is required by the journeys/refusals that read this fixture —
  // router.ts APPROVAL_GATED_TOOLS blocks read_pending_ots / create_postulacion
  // for any other state, which is the correct production behavior.
  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: testPhone,
    estado: "activo",
    source: "warm",
    candidate_state: "approved",
    profile_complete: true,
    cedula,
  });
  if (extErr) throw new Error(`fixture tecnicos_extended bogota_electrico: ${extErr.message}`);

  // tecnicos_mirror columns: row_id, data, synced_at (no flat cols — all data in jsonb)
  const { error: mirrorErr } = await supabase.from("tecnicos_mirror").upsert({
    row_id: tecnico_id,
    data: {
      "Row ID": tecnico_id,
      Nombre: "Juan Rodriguez",
      Especialidad: "eléctrico",
      Modalidad: "prestación",
      Ciudad: "Bogotá",
      Teléfono: testPhone,
    },
  });
  if (mirrorErr) throw new Error(`fixture tecnicos_mirror bogota_electrico: ${mirrorErr.message}`);

  // Insert a tecnico_registered event so read_pending_ots(tecnico_id) can profile-match.
  // Upsert via (type, entity_id) — events table has no unique constraint, so we
  // delete the old one first to stay idempotent.
  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id);
  const { error: evtErr } = await supabase.from("eventos").insert({
    type: "tecnico_registered",
    entity_id: tecnico_id,
    actor: "agent",
    meta: {
      ciudad: "Bogotá",
      especialidades: ["eléctrico"],
      modalidad: "solo",
      nombre: "Juan Rodriguez",
      phone: testPhone,
    },
  });
  if (evtErr) throw new Error(`fixture eventos bogota_electrico: ${evtErr.message}`);

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoRegisteredCaliPlomero(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_calpl01_${testPhone.slice(-6)}`;
  const cedula = testCedulaFor(testPhone);

  // Post-approval state — see seedTecnicoRegisteredBogotaElectrico for rationale.
  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: testPhone,
    estado: "activo",
    source: "warm",
    candidate_state: "approved",
    profile_complete: true,
    cedula,
  });
  if (extErr) throw new Error(`fixture tecnicos_extended cali_plomero: ${extErr.message}`);

  const { error: mirrorErr } = await supabase.from("tecnicos_mirror").upsert({
    row_id: tecnico_id,
    data: {
      "Row ID": tecnico_id,
      Nombre: "Carlos Mendez",
      Especialidad: "plomería",
      Modalidad: "prestación",
      Ciudad: "Cali",
      Teléfono: testPhone,
    },
  });
  if (mirrorErr) throw new Error(`fixture tecnicos_mirror cali_plomero: ${mirrorErr.message}`);

  // Insert tecnico_registered event for profile-matching in read_pending_ots.
  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id);
  const { error: evtErr } = await supabase.from("eventos").insert({
    type: "tecnico_registered",
    entity_id: tecnico_id,
    actor: "agent",
    meta: {
      ciudad: "Cali",
      especialidades: ["plomería"],
      modalidad: "solo",
      nombre: "Carlos Mendez",
      phone: testPhone,
    },
  });
  if (evtErr) throw new Error(`fixture eventos cali_plomero: ${evtErr.message}`);

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoWithPendingPostulacion(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const refs = await seedTecnicoRegisteredBogotaElectrico(testPhone);
  const tecnico_id = refs.tecnico_id!;
  const ot_id = `TEST_OT_pending_${testPhone.slice(-6)}`;

  const { error: otErr } = await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — instalación eléctrica Bogotá",
      Ciudad: "Bogotá",
      Categoria: "eléctrico",
      Estado: "pendiente",
    },
    ciudad: "Bogotá",
    especialidad: "eléctrico",
    estado: "pendiente",
  });
  if (otErr) throw new Error(`fixture ots_mirror pending: ${otErr.message}`);

  // Idempotent: delete before insert to avoid duplicate (ot_id, tecnico_id) constraint.
  await supabase
    .from("postulaciones")
    .delete()
    .eq("ot_id", ot_id)
    .eq("tecnico_id", tecnico_id);
  const { error: postErr } = await supabase.from("postulaciones").insert({
    ot_id,
    tecnico_id,
    state: "postulado",
    mensaje: "TEST postulacion",
  });
  if (postErr) throw new Error(`fixture postulaciones pending: ${postErr.message}`);

  return { tecnico_id, ot_ids: [ot_id] };
}

async function seedTecnicoWithSignedContract(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const refs = await seedTecnicoRegisteredBogotaElectrico(testPhone);
  const tecnico_id = refs.tecnico_id!;
  const ot_id = `TEST_OT_signed_${testPhone.slice(-6)}`;

  const { error: otErr } = await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — contrato firmado",
      Ciudad: "Bogotá",
      Categoria: "eléctrico",
      Estado: "asignado",
    },
    ciudad: "Bogotá",
    especialidad: "eléctrico",
    estado: "asignado",
  });
  if (otErr) throw new Error(`fixture ots_mirror signed: ${otErr.message}`);

  // Idempotent: delete before insert (contratos has no unique constraint on tecnico_id+ot_id).
  await supabase
    .from("contratos")
    .delete()
    .eq("tecnico_id", tecnico_id)
    .eq("ot_id", ot_id);
  const { error: ctrErr } = await supabase.from("contratos").insert({
    tecnico_id,
    ot_id,
    status: "firmado",
    created_by: "hr:test",
  });
  if (ctrErr) throw new Error(`fixture contratos signed: ${ctrErr.message}`);

  return { tecnico_id, ot_ids: [ot_id] };
}

async function seedOpenOtBogotaElectrico(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_id = `TEST_OT_bogel_${testPhone.slice(-6)}`;

  await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — instalación eléctrica residencial Bogotá",
      Ciudad: "Bogotá",
      Categoria: "eléctrico",
      Estado: "pendiente",
    },
    ciudad: "Bogotá",
    especialidad: "eléctrico",
    estado: "pendiente",
  });

  return { tecnico_id: null, ot_ids: [ot_id] };
}

async function seedOpenOtNeivaPlomero(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_id = `TEST_OT_neipl_${testPhone.slice(-6)}`;

  await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — reparación plomería Neiva",
      Ciudad: "Neiva",
      Categoria: "plomería",
      Estado: "pendiente",
    },
    ciudad: "Neiva",
    especialidad: "plomería",
    estado: "pendiente",
  });

  return { tecnico_id: null, ot_ids: [ot_id] };
}

async function seedOpenOtCaliPlomero(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_id = `TEST_OT_calpl_${testPhone.slice(-6)}`;

  const { error } = await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — reparación plomería Cali",
      Ciudad: "Cali",
      Categoria: "plomería",
      Estado: "pendiente",
    },
    ciudad: "Cali",
    especialidad: "plomería",
    estado: "pendiente",
  });
  if (error) throw new Error(`fixture ots_mirror cali_plomero: ${error.message}`);

  return { tecnico_id: null, ot_ids: [ot_id] };
}

async function seedMultipleOpenOtsBogota(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_ids: string[] = [];

  // Insert 51 OTs — enough to trigger the ≥50 truncation rule (router postDispatch).
  const rows = Array.from({ length: 51 }, (_, i) => {
    const ot_id = `TEST_OT_multi_${testPhone.slice(-6)}_${String(i).padStart(3, "0")}`;
    ot_ids.push(ot_id);
    return {
      row_id: ot_id,
      data: {
        "Row ID": ot_id,
        Descripcion: `TEST OT multi ${i} — Bogotá eléctrico`,
        Ciudad: "Bogotá",
        Categoria: "eléctrico",
        Estado: "pendiente",
      },
      ciudad: "Bogotá",
      especialidad: "eléctrico",
      estado: "pendiente",
    };
  });

  // Batch insert in chunks of 20 to avoid payload limits.
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    await supabase.from("ots_mirror").upsert(chunk);
  }

  return { tecnico_id: null, ot_ids };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SEEDERS: Record<
  DBFixture,
  (testPhone: string) => Promise<FixtureRefs>
> = {
  tecnico_not_registered: seedTecnicoNotRegistered,
  tecnico_registered_bogota_electrico: seedTecnicoRegisteredBogotaElectrico,
  tecnico_registered_cali_plomero: seedTecnicoRegisteredCaliPlomero,
  tecnico_with_pending_postulacion: seedTecnicoWithPendingPostulacion,
  tecnico_with_signed_contract: seedTecnicoWithSignedContract,
  open_ot_bogota_electrico: seedOpenOtBogotaElectrico,
  open_ot_neiva_plomero: seedOpenOtNeivaPlomero,
  open_ot_cali_plomero: seedOpenOtCaliPlomero,
  multiple_open_ots_bogota: seedMultipleOpenOtsBogota,
  // Stream A
  tecnico_legacy_approved_incomplete: seedTecnicoLegacyApprovedIncomplete,
  tecnico_legacy_approved_complete: seedTecnicoLegacyApprovedComplete,
  tecnico_legacy_incomplete_sister_phone: seedTecnicoLegacyIncompleteSisterPhone,
  tecnico_screening_with_cedula: seedTecnicoScreeningWithCedula,
  tecnico_withdrawn_with_cedula: seedTecnicoWithdrawnWithCedula,
  tecnico_pending_with_cedula: seedTecnicoPendingWithCedula,
};

/**
 * Apply a list of DB fixtures for a given test phone. Returns merged refs
 * (last non-null tecnico_id wins; all ot_ids collected).
 */
export async function applyFixtures(
  fixtures: DBFixture[],
  testPhone: string
): Promise<FixtureRefs> {
  const merged: FixtureRefs = { tecnico_id: null, ot_ids: [] };
  for (const fixture of fixtures) {
    const seeder = SEEDERS[fixture];
    const refs = await seeder(testPhone);
    if (refs.tecnico_id !== null) merged.tecnico_id = refs.tecnico_id;
    merged.ot_ids.push(...refs.ot_ids);
  }
  return merged;
}

/**
 * Delete all test rows matching the TEST_ / +99000 prefixes from all tables.
 * Safe to call multiple times (idempotent deletes).
 */
export async function cleanupTestData(): Promise<void> {
  const supabase = createServerClient();

  // Collect TEST_ tecnico_ids for cascading deletes. The +9900%/+99001% range
  // covers both primary test phones and Stream A "sister" phones used by
  // cross-phone fixtures.
  const { data: tecs } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .like("phone", "+9900%");

  const ids = (tecs ?? []).map((t) => t.tecnico_id);

  // Also collect any TEST_-prefixed tecnico_ids directly.
  const { data: testTecs } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .like("tecnico_id", "TEST_%");

  const testIds = (testTecs ?? []).map((t) => t.tecnico_id);
  const allIds = [...new Set([...ids, ...testIds])];

  // Delete child rows first (FK order).
  if (allIds.length > 0) {
    await supabase.from("documentos").delete().in("tecnico_id", allIds);
    await supabase.from("contratos").delete().in("tecnico_id", allIds);
    await supabase.from("postulaciones").delete().in("tecnico_id", allIds);
    // Stream A tables — must delete BEFORE tecnicos_extended (FK).
    await supabase.from("hr_notes").delete().in("tecnico_id", allIds);
    await supabase.from("candidate_decisions").delete().in("tecnico_id", allIds);
    await supabase.from("candidate_dossiers").delete().in("tecnico_id", allIds);
    await supabase.from("eventos").delete().in("entity_id", allIds);
    await supabase.from("tecnicos_mirror").delete().in("row_id", allIds);
  }

  // Delete TEST_OT_ rows from ots_mirror + associated postulaciones/contratos.
  await supabase.from("postulaciones").delete().like("ot_id", "TEST_OT_%");
  await supabase.from("contratos").delete().like("ot_id", "TEST_OT_%");
  await supabase.from("ots_mirror").delete().like("row_id", "TEST_OT_%");

  // Delete sessions + messages for test phones (turns cascade via FK).
  const { data: sessions } = await supabase
    .from("sessions")
    .select("id")
    .like("phone", "+9900%");

  const sessionIds = (sessions ?? []).map((s) => s.id);
  if (sessionIds.length > 0) {
    await supabase.from("messages").delete().in("session_id", sessionIds);
    await supabase.from("sessions").delete().in("id", sessionIds);
  }

  // Finally delete tecnicos_extended rows (children already cleared above).
  await supabase.from("tecnicos_extended").delete().like("phone", "+9900%");
  await supabase.from("tecnicos_extended").delete().like("tecnico_id", "TEST_%");
}
