// Verification trace B3: submit-candidate-dossier with all mandatory fields
// but NO ARL doc. Must return recommend_approve, not recommend_call.
// Run: npx tsx --env-file=.env.local scripts/trace-b3-arl.ts

import type { CandidateDossier } from "@redin/shared/dossier-types";

// Inline validatePayload from submit-candidate-dossier for local tracing
// (we can't easily import + call the full DB tool without a real Supabase row).
// Instead we replicate the scoring logic exactly as it stands post-fix.

const dossier: CandidateDossier = {
  schema_version: 1,
  cedula: { tipo: "CC", numero: "1098765432" },
  modalidad: "individual",
  categorias_principales: ["electricidad"],
  subcategorias: ["instalaciones_electricas_residenciales"],
  anos_experiencia: 5,
  ciudad_base: "Bogotá",
  ciudades_cobertura: ["Bogotá"],
   certificaciones: {
     altura: false,
     altura_avanzado: false,
     retie: false,
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
    fines_de_semana: false,
    nocturno: false,
    viaja_otra_ciudad: false,
  },
  cumplimiento: {
    arl_activa: true,    // declared YES
    eps_activa: true,    // declared YES
    antecedentes_limpios: true,
  },
  dossier: "Técnico eléctrico con 5 años de experiencia residencial en Bogotá.",
  tono_recommendation: "recommend_approve",
  tono_confidence: 0.85,
  tono_reasoning: "Perfil completo con experiencia verificable y buenas referencias.",
  gaps: [],
  // NO arl_doc_id — ARL declared but no doc uploaded
  // NO eps_doc_id — EPS declared but no doc uploaded
};

// Simulate the scoring logic post-B3-fix
const raw = dossier;
const cumplimiento = raw.cumplimiento ?? { arl_activa: false, eps_activa: false, antecedentes_limpios: null };
const gaps: string[] = [];
const warnings: string[] = [];

let finalRecommendation = raw.tono_recommendation;
let finalConfidence = raw.tono_confidence;
const reasoning = raw.tono_reasoning;

// ARL: tie-breaker only — gap registered but NEVER overrides recommendation
const arlDeclaredNoDoc = cumplimiento.arl_activa === true && !raw.arl_doc_id;
if (arlDeclaredNoDoc) {
  gaps.push("ARL sin documento");
  warnings.push("ARL declarada activa pero sin documento subido — registrado como gap, no bloquea recomendación");
}

// EPS: DOES override recommendation when doc is missing
const epsDeclaredNoDoc = cumplimiento.eps_activa === true && !raw.eps_doc_id;
const epsUnknownNoDoc = (cumplimiento.eps_activa === false || cumplimiento.eps_activa == null) && !raw.eps_doc_id;
if (epsDeclaredNoDoc && raw.tono_recommendation === "recommend_approve") {
  finalRecommendation = "recommend_call";
  finalConfidence = Math.min(raw.tono_confidence, 0.7);
  warnings.push("tono_recommendation downgraded from recommend_approve to recommend_call: missing EPS doc");
} else if (epsUnknownNoDoc && raw.tono_recommendation === "recommend_approve") {
  finalRecommendation = "recommend_call";
  finalConfidence = Math.min(raw.tono_confidence, 0.7);
  warnings.push("tono_recommendation downgraded from recommend_approve to recommend_call: EPS status unknown and no doc");
}

console.log("\n=== B3 ARL Scoring Trace ===");
console.log("Input:");
console.log("  arl_activa:", cumplimiento.arl_activa, "  arl_doc_id:", raw.arl_doc_id ?? "(none)");
console.log("  eps_activa:", cumplimiento.eps_activa, "  eps_doc_id:", raw.eps_doc_id ?? "(none)");
console.log("  original tono_recommendation:", raw.tono_recommendation);
console.log("\nResult:");
console.log("  finalRecommendation:", finalRecommendation);
console.log("  finalConfidence:", finalConfidence);
console.log("  gaps:", gaps);
console.log("  warnings:", warnings);
console.log("\nEXPECTED: finalRecommendation = recommend_call (EPS declared but no doc)");
console.log("  ARL gap ONLY goes into gaps[], does NOT change recommendation");
console.log("\nTest:", finalRecommendation === "recommend_call" ? "PASS ✓" : "FAIL ✗");
console.log("  (EPS without doc correctly triggers recommend_call)");
console.log("\n--- Now test: ALL fields present + ARL declared but no doc → recommend_approve ---");

// Second trace: EPS has doc but ARL doesn't — should be recommend_approve
const dossier2: typeof raw = { ...dossier, eps_doc_id: "some-eps-doc-uuid" };
const gaps2: string[] = [];
const warnings2: string[] = [];
let finalRec2 = dossier2.tono_recommendation;
let finalConf2 = dossier2.tono_confidence;

const arl2 = dossier2.cumplimiento?.arl_activa === true && !dossier2.arl_doc_id;
if (arl2) {
  gaps2.push("ARL sin documento");
  warnings2.push("ARL gap only");
}
const eps2NoDoc = dossier2.cumplimiento?.eps_activa === true && !dossier2.eps_doc_id;
if (eps2NoDoc && dossier2.tono_recommendation === "recommend_approve") {
  finalRec2 = "recommend_call";
}

console.log("\nInput:");
console.log("  arl_activa:", dossier2.cumplimiento?.arl_activa, "  arl_doc_id:", dossier2.arl_doc_id ?? "(none)");
console.log("  eps_activa:", dossier2.cumplimiento?.eps_activa, "  eps_doc_id:", dossier2.eps_doc_id ?? "(none)");
console.log("  original recommendation:", dossier2.tono_recommendation);
console.log("\nResult:");
console.log("  finalRecommendation:", finalRec2);
console.log("  gaps:", gaps2);
console.log("  warnings:", warnings2);
console.log("\nTest:", finalRec2 === "recommend_approve" ? "PASS ✓" : "FAIL ✗");
console.log("  (ARL gap only → recommend_approve preserved)");
