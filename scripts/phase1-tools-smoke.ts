// Phase 1 (Stream A) tools smoke test.
//
// Direct integration test for the 5 new Stream A tools. Runs against real
// Supabase and cleans up after itself. Companion to scripts/phase0-smoke.ts.
//
// Covers:
//   - find_by_cedula: not-found, found
//   - mark_candidate_withdrawn: screening -> withdrawn, idempotent on already-
//     withdrawn, refuses non-screening states
//   - submit_candidate_dossier: clean submit (state -> pending), already_decided
//     on cedula collision with pending, invalid_payload (3 variants), merged
//     from withdrawn
//   - complete_legacy_profile: enrich a bootstrapped legacy worker (cedula +
//     ciudad + categoria flips profile_complete=true), idempotent
//   - find_legacy_by_name: exact, fuzzy (1-letter drop), no match
//
// Usage:
//   npx tsx --env-file=.env.local scripts/phase1-tools-smoke.ts

import { randomUUID } from "node:crypto";
import { createServerClient, type CandidateState } from "@redin/shared";
import {
  makeDefaultToolContext,
  registerTecnico,
  findByCedula,
  markCandidateWithdrawn,
  submitCandidateDossier,
  completeLegacyProfile,
  findLegacyByName,
  type CandidateDossier,
} from "@redin/tools";

const sb = createServerClient();
const ctx = makeDefaultToolContext({ supabase: sb, defaultActor: "system" });

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`[FAIL] ${name}${detail ? " — " + JSON.stringify(detail).slice(0, 200) : ""}`);
  }
}

const RUN = `nt-${Date.now()}`;
const phoneA = `+57777${String(Date.now()).slice(-6)}`;
const phoneB = `+57777${String(Date.now() + 1).slice(-6)}`;
// Migration 011: contact_phone is required by validateIdentity. Distinct
// 10-digit numbers per worker so the happy-path registers succeed.
const contactA = `300${String(Date.now()).slice(-7)}`;
const contactB = `301${String(Date.now() + 1).slice(-7)}`;
const contactC = `302${String(Date.now() + 2).slice(-7)}`;
const contactD = `303${String(Date.now() + 3).slice(-7)}`;
const cedulaA = String(80000000 + (Date.now() % 10000000));
const cedulaB = String(80000000 + ((Date.now() + 1) % 10000000));

const cleanup: string[] = [];

function makeDossier(cedula: string): CandidateDossier {
  return {
    schema_version: 1,
    cedula: { tipo: "CC", numero: cedula },
    modalidad: "individual",
    categorias_principales: ["Eléctrico y Datos"],
    subcategorias: ["Iluminación (Paneles LED, Balastos)"],
    anos_experiencia: 5,
    ciudad_base: "Cali",
     certificaciones: {
       altura: false,
       altura_avanzado: false,
       retie: true,
       andamios: false,
       soldadura: false,
       conte: false,
       siso: false,
     },
    herramientas: {
      basicas: true,
      electrica_obra: true,
      electrica_medicion: true,
      altura_personal: false,
      andamio_propio: false,
      vehiculo_propio: false,
    },
    disponibilidad: {
      inicio_inmediato: true,
      fines_de_semana: true,
      nocturno: false,
      viaja_otra_ciudad: false,
    },
    cumplimiento: {
      arl_activa: true,
      eps_activa: true,
      antecedentes_limpios: true,
    },
    dossier:
      "5 años en mantenimiento eléctrico residencial y comercial. Certificado RETIE. Herramienta propia. Disponible para fines de semana.",
    tono_recommendation: "recommend_approve",
    tono_confidence: 0.85,
    tono_reasoning:
      "Perfil claro, certificación RETIE confirmada, herramienta propia, ARL activa. Match natural con OTs eléctricas en Cali.",
    gaps: [],
  };
}

async function main() {
  // ============== Test 1: find_by_cedula on a new cedula -> not found ==============
  {
    const r = await findByCedula(ctx, { cedula: cedulaA });
    check("find_by_cedula not found", r.ok && r.data.found === false, r);
  }

  // Setup: create a screening worker A.
  const regA = await registerTecnico(ctx, {
    phone: phoneA,
    nombre: "Test Eléctrico A",
    ciudad: "Cali",
    especialidades: ["Eléctrico"],
    modalidad: "individual",
    contact_phone: contactA,
    source: RUN,
  });
  if (!regA.ok) throw new Error(`registerTecnico A failed: ${JSON.stringify(regA)}`);
  const tecnicoIdA = regA.data.tecnico_id;
  cleanup.push(tecnicoIdA);

  // ============== Test 2: submit_candidate_dossier (clean submit) ==============
  {
    const r = await submitCandidateDossier(ctx, {
      tecnico_id: tecnicoIdA,
      dossier: makeDossier(cedulaA),
    });
    check(
      "submit_candidate_dossier (submitted)",
      r.ok && r.data.code === "submitted" && r.data.resulting_state === "pending",
      r
    );
  }

  // ============== Test 3: find_by_cedula now finds A as 'pending' ==============
  {
    const r = await findByCedula(ctx, { cedula: cedulaA });
    check(
      "find_by_cedula found pending",
      r.ok &&
        r.data.found === true &&
        r.data.candidate_state === "pending" &&
        r.data.tecnico_id === tecnicoIdA,
      r
    );
  }

  // ============== Test 4: submit_candidate_dossier with same cedula on new worker -> already_decided ==============
  const regB = await registerTecnico(ctx, {
    phone: phoneB,
    nombre: "Test Eléctrico B",
    ciudad: "Cali",
    especialidades: ["Eléctrico"],
    modalidad: "individual",
    contact_phone: contactB,
    source: RUN,
  });
  if (!regB.ok) throw new Error(`registerTecnico B failed`);
  const tecnicoIdB = regB.data.tecnico_id;
  cleanup.push(tecnicoIdB);

  {
    const r = await submitCandidateDossier(ctx, {
      tecnico_id: tecnicoIdB,
      dossier: makeDossier(cedulaA), // same cedula as A
    });
    check(
      "submit_candidate_dossier (already_decided on pending collision)",
      r.ok && r.data.code === "already_decided" && r.data.existing_state === "pending",
      r
    );
  }

  // ============== Test 5: invalid_payload (bad cedula format) ==============
  {
    const bad = makeDossier("12"); // too short
    const r = await submitCandidateDossier(ctx, {
      tecnico_id: tecnicoIdB,
      dossier: bad,
    });
    check("submit_candidate_dossier (invalid_payload)", r.ok && r.data.code === "invalid_payload", r);
  }

  // ============== Test 6: invalid_payload (bad recommendation) ==============
  {
    const bad = makeDossier(cedulaB);
    (bad as { tono_recommendation: string }).tono_recommendation = "recommend_unicorn";
    const r = await submitCandidateDossier(ctx, { tecnico_id: tecnicoIdB, dossier: bad });
    check("submit_candidate_dossier (bad recommendation)", r.ok && r.data.code === "invalid_payload", r);
  }

  // ============== Test 7: invalid_payload (reasoning too short) ==============
  {
    const bad = makeDossier(cedulaB);
    bad.tono_reasoning = "ok";
    const r = await submitCandidateDossier(ctx, { tecnico_id: tecnicoIdB, dossier: bad });
    check("submit_candidate_dossier (reasoning too short)", r.ok && r.data.code === "invalid_payload", r);
  }

  // ============== Test 8: mark_candidate_withdrawn on a screening worker ==============
  // Use B (still in 'screening' since its dossier submit hit the cedula collision).
  {
    const r = await markCandidateWithdrawn(ctx, {
      tecnico_id: tecnicoIdB,
      reason: "no_cedula_provided",
    });
    check(
      "mark_candidate_withdrawn screening->withdrawn",
      r.ok && r.data.resulting_state === "withdrawn" && !r.data.noop,
      r
    );
  }

  // ============== Test 9: mark_candidate_withdrawn idempotent on already-withdrawn ==============
  {
    const r = await markCandidateWithdrawn(ctx, {
      tecnico_id: tecnicoIdB,
      reason: "no_cedula_provided",
    });
    check(
      "mark_candidate_withdrawn idempotent",
      r.ok && r.data.resulting_state === "withdrawn" && r.data.noop === true,
      r
    );
  }

  // ============== Test 10: mark_candidate_withdrawn refuses on non-screening ==============
  // A is currently 'pending' (post-dossier-submit).
  {
    const r = await markCandidateWithdrawn(ctx, {
      tecnico_id: tecnicoIdA,
      reason: "opted_out",
    });
    check(
      "mark_candidate_withdrawn refuses pending",
      !r.ok && r.code === "illegal_transition",
      r
    );
  }

  // ============== Test 11: submit_candidate_dossier with merge from withdrawn ==============
  // Reuse B's withdrawn row by submitting with cedulaB (a fresh cedula different from A).
  // First seed cedulaB onto B by re-attempting submit.
  // Actually, the simpler path: create a new worker C with a fresh phone, submit a dossier
  // with cedulaB, then withdraw, then have a NEW worker D submit cedulaB -> should merge.

  const phoneC = `+57777${String(Date.now() + 2).slice(-6)}`;
  const phoneD = `+57777${String(Date.now() + 3).slice(-6)}`;

  const regC = await registerTecnico(ctx, {
    phone: phoneC,
    nombre: "Test C García",
    ciudad: "Cali",
    especialidades: ["Eléctrico"],
    modalidad: "individual",
    contact_phone: contactC,
    source: RUN,
  });
  if (!regC.ok) throw new Error(`registerTecnico C failed`);
  const tecnicoIdC = regC.data.tecnico_id;
  cleanup.push(tecnicoIdC);

  // Submit dossier with cedulaB so C has cedulaB.
  await submitCandidateDossier(ctx, { tecnico_id: tecnicoIdC, dossier: makeDossier(cedulaB) });

  // Manually flip C to 'withdrawn' (simulating refusal). State is currently 'pending'
  // after the dossier; we need to bypass to 'withdrawn' for merge testing.
  // mark_candidate_withdrawn refuses pending->withdrawn (illegal). We do a direct
  // SQL update for test setup only.
  await sb
    .from("tecnicos_extended")
    .update({ candidate_state: "withdrawn" as CandidateState, withdrawal_reason: "no_cedula_provided" })
    .eq("tecnico_id", tecnicoIdC);

  // Now D registers and submits with cedulaB -> should merge.
  const regD = await registerTecnico(ctx, {
    phone: phoneD,
    nombre: "Test D García",
    ciudad: "Cali",
    especialidades: ["Eléctrico"],
    modalidad: "individual",
    contact_phone: contactD,
    source: RUN,
  });
  if (!regD.ok) throw new Error(`registerTecnico D failed`);
  const tecnicoIdD = regD.data.tecnico_id;

  {
    const r = await submitCandidateDossier(ctx, {
      tecnico_id: tecnicoIdD,
      dossier: makeDossier(cedulaB),
    });
    // The merge picks the older row as canonical. D was created AFTER C,
    // so canonical = C, dropped = D. effective_tecnico_id should be C.
    check(
      "submit_candidate_dossier (merged from withdrawn)",
      r.ok &&
        r.data.code === "merged" &&
        r.data.effective_tecnico_id === tecnicoIdC &&
        r.data.resulting_state === "pending",
      r
    );
  }

  // ============== Test 12: complete_legacy_profile on a bootstrapped legacy worker ==============
  const { data: legacyRow } = await sb
    .from("tecnicos_extended")
    .select("tecnico_id, profile_complete")
    .eq("import_source", "appsheet_legacy_bootstrap")
    .eq("profile_complete", false)
    .limit(1)
    .maybeSingle();
  if (!legacyRow) {
    check("complete_legacy_profile setup", false, "no legacy row available");
  } else {
    const legacyId = legacyRow.tecnico_id;
    // Use a unique cedula for the test legacy enrichment, then revert at cleanup.
    const cedulaLegacy = String(70000000 + (Date.now() % 10000000));

    {
      const r = await completeLegacyProfile(ctx, {
        tecnico_id: legacyId,
        profile_data: {
          cedula: { tipo: "CC", numero: cedulaLegacy },
          ciudad_base: "Cali",
          categorias_principales: ["Eléctrico y Datos"],
        },
      });
      check(
        "complete_legacy_profile (cedula+ciudad+categoria -> profile_complete=true)",
        r.ok && r.data.profile_complete === true && !r.data.noop,
        r
      );
    }

    {
      // Re-call with the same data — should be a no-op.
      const r = await completeLegacyProfile(ctx, {
        tecnico_id: legacyId,
        profile_data: {
          cedula: { tipo: "CC", numero: cedulaLegacy },
          ciudad_base: "Cali",
          categorias_principales: ["Eléctrico y Datos"],
        },
      });
      check(
        "complete_legacy_profile (idempotent)",
        r.ok && r.data.noop === true,
        r
      );
    }

    // Revert the test legacy row so re-running the bootstrap stays unchanged.
    await sb
      .from("tecnicos_extended")
      .update({
        cedula: null,
        enrichment_data: null,
        profile_complete: false,
      })
      .eq("tecnico_id", legacyId);
  }

  // ============== Test 13: find_legacy_by_name against bootstrapped data ==============
  const { data: bootstrapEvents } = await sb
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_legacy_bootstrap")
    .limit(1)
    .maybeSingle();
  if (bootstrapEvents?.meta) {
    const m = bootstrapEvents.meta as Record<string, unknown>;
    const realName = m.nombre as string;
    {
      const r = await findLegacyByName(ctx, { name: realName });
      check(
        `find_legacy_by_name exact (${realName})`,
        r.ok && r.data.matches.length >= 1 && r.data.matches[0]?.similarity === 1,
        r
      );
    }
    {
      // Fuzzy: drop one letter
      const fuzzy = realName.length > 4 ? realName.slice(0, -1) : realName;
      const r = await findLegacyByName(ctx, { name: fuzzy });
      check(
        `find_legacy_by_name fuzzy (${fuzzy})`,
        r.ok && r.data.matches.length >= 1,
        r
      );
    }
    {
      const r = await findLegacyByName(ctx, { name: "Pepito Pérez Inexistente Random" });
      check(
        "find_legacy_by_name no match",
        r.ok && r.data.matches.length === 0,
        r
      );
    }
  }

  // Cleanup test workers.
  for (const id of cleanup) {
    await sb.from("candidate_dossiers").delete().eq("tecnico_id", id);
    await sb.from("candidate_decisions").delete().eq("tecnico_id", id);
    await sb.from("eventos").delete().eq("entity_id", id);
    await sb.from("messages").delete().eq("session_id", id);
    await sb.from("tecnicos_extended").delete().eq("tecnico_id", id);
  }
  // tecnicoIdD merged into C; only C remains. Ensure deletion.

  console.log(`\n${pass}/${pass + fail} checks passed${fail > 0 ? ` — ${fail} FAILED:\n  ${failures.join("\n  ")}` : ""}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
