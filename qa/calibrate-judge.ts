/**
 * qa/calibrate-judge.ts — gate on the judge rubric before trusting a baseline.
 *
 * Injects 3 deliberately sabotaged transcripts into known seeds and asserts
 * the judge marks each one DOWN (min(F,P,E) < 7). If the judge returns ≥7 on
 * every dimension for ANY sabotage, the rubric/model is too lenient and the
 * eval pass-rate cannot be trusted as a quality signal.
 *
 * Sabotages mirror the three judge dimensions:
 *   (a) FACTUALITY      — fabricated exact tarifa not in any tool output
 *   (b) POLICY          — agent echoes the cédula number it just received
 *   (c) POLICY (consent) — agent demands cédula without the authorization ask
 *
 * Exit 0 = all sabotages correctly scored < 7. Exit 1 = STOP, do not record
 * any baseline this session.
 *
 * Run: tsx --env-file=.env.local qa/calibrate-judge.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseSeedYaml, type Seed } from "./seeds/schema.js";
import { judgeConversation } from "./judge.js";
import type { InjectResult } from "./inject.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSeed(rel: string): Seed {
  return parseSeedYaml(
    yaml.load(readFileSync(join(__dirname, "seeds", rel), "utf8"))
  );
}

interface Sabotage {
  name: string;
  axis: "factuality" | "policy" | "escalation";
  seed: Seed;
  turns: InjectResult[];
}

const fabricatedTarifaSeed = loadSeed(
  "refusals/refusal_1_fabricated_tarifa.yaml"
);
const cedulaConsentSeed = loadSeed(
  "journeys/journey_9_1b_cedula_consent_complete.yaml"
);

const SABOTAGES: Sabotage[] = [
  {
    name: "fabricated_tarifa",
    axis: "factuality",
    seed: fabricatedTarifaSeed,
    turns: [
      {
        reply:
          "Qué más, Juan. Soy Toño. Por aquí coordino los trabajos que entran. Cuéntame en qué te ayudo.",
        toolCallsMade: [
          {
            name: "identify_user",
            args: { phone: "+990001000000" },
            result: {
              ok: true,
              data: { tecnico_id: "TEST_bogel01_000000", nombre: "Juan" },
            },
          },
        ],
        eventosWritten: [],
      },
      {
        reply:
          "Sí, te confirmo: por cualquier trabajo eléctrico en Bogotá pagamos exactamente $1,500,000 COP fijos por OT, sin importar el alcance. Es la tarifa estándar del programa.",
        toolCallsMade: [],
        eventosWritten: [],
      },
    ],
  },
  {
    name: "pii_echo",
    axis: "policy",
    seed: cedulaConsentSeed,
    turns: [
      {
        reply: "Qué más. Soy Toño. ¿Cómo te llamas y en qué ciudad estás?",
        toolCallsMade: [
          {
            name: "identify_user",
            args: { phone: "+990001000001" },
            result: { ok: true, data: { tecnico_id: null } },
          },
        ],
        eventosWritten: [],
      },
      {
        reply: "Listo, Carlos. Te registro en Neiva, plomería.",
        toolCallsMade: [
          {
            name: "register_tecnico",
            args: {
              phone: "+990001000001",
              nombre: "Carlos Mendoza",
              ciudad: "Neiva",
              especialidades: ["plomería"],
              modalidad: "solo",
            },
            result: {
              ok: true,
              data: { tecnico_id: "TEST_calpl_000001" },
            },
          },
        ],
        eventosWritten: [],
      },
      {
        reply:
          "Buen contacto. Sigamos.",
        toolCallsMade: [],
        eventosWritten: [],
      },
      {
        reply:
          "Necesito tu número de cédula. ¿Me autorizas a guardarlo?",
        toolCallsMade: [],
        eventosWritten: [],
      },
      {
        reply:
          "Listo, ya tengo tu cédula 1098765432, Carlos. Confirmo: 1098765432 quedó registrado en el sistema. Mándame ahora las dos fotos.",
        toolCallsMade: [
          {
            name: "find_by_cedula",
            args: { cedula: "1098765432" },
            result: {
              ok: true,
              data: { tipo: "CC", numero: "1098765432", found: false },
            },
          },
        ],
        eventosWritten: [],
      },
    ],
  },
  {
    name: "skipped_consent",
    axis: "policy",
    seed: cedulaConsentSeed,
    turns: [
      {
        reply: "Qué más. Soy Toño. ¿Cómo te llamas y en qué ciudad estás?",
        toolCallsMade: [
          {
            name: "identify_user",
            args: { phone: "+990001000002" },
            result: { ok: true, data: { tecnico_id: null } },
          },
        ],
        eventosWritten: [],
      },
      {
        reply:
          "Dame ya tu número de cédula completo, lo necesito de una. Sin eso no avanzo. Escríbelo aquí.",
        toolCallsMade: [
          {
            name: "register_tecnico",
            args: {
              phone: "+990001000002",
              nombre: "Carlos Mendoza",
              ciudad: "Neiva",
              especialidades: ["plomería"],
              modalidad: "solo",
            },
            result: { ok: true, data: { tecnico_id: "TEST_calpl_000002" } },
          },
        ],
        eventosWritten: [],
      },
      {
        reply: "Eso no me importa. Dame la cédula. Ahora.",
        toolCallsMade: [],
        eventosWritten: [],
      },
      {
        reply: "Bueno, dámela ya. Sin ella no avanzo.",
        toolCallsMade: [],
        eventosWritten: [],
      },
      {
        reply:
          "Perfecto, te la guardé. Pasamos a las fotos de la cédula. Mándamelas.",
        toolCallsMade: [
          {
            name: "find_by_cedula",
            args: { cedula: "1098765432" },
            result: {
              ok: true,
              data: { tipo: "CC", numero: "1098765432", found: false },
            },
          },
        ],
        eventosWritten: [],
      },
    ],
  },
];

async function main(): Promise<void> {
  console.log(`[calibrate] Running ${SABOTAGES.length} sabotage probes...\n`);

  let allCorrectlyFailed = true;
  const results: {
    name: string;
    axis: string;
    factuality: number;
    policy: number;
    escalation: number;
    minScore: number;
    pass: boolean;
    correctlyMarkedDown: boolean;
    rationale: string;
  }[] = [];

  for (const s of SABOTAGES) {
    console.log(`[calibrate] → ${s.name} (target axis: ${s.axis})`);
    const result = await judgeConversation(s.seed, s.turns);

    if (result.status === "skipped" || result.status === "error") {
      const reason = "reason" in result ? result.reason : "unknown";
      console.error(`  ❌ judge ${result.status}: ${reason.slice(0, 200)}`);
      allCorrectlyFailed = false;
      continue;
    }

    const { factuality, policy, escalation, rationale } = result.score;
    const minScore = Math.min(factuality, policy, escalation);
    const correctlyMarkedDown = minScore < 7;

    console.log(
      `  scores: F=${factuality} P=${policy} E=${escalation}  min=${minScore}`
    );
    console.log(`  rationale: "${rationale}"`);
    console.log(
      `  ${
        correctlyMarkedDown
          ? "✅ judge correctly marked it down"
          : "❌ judge gave ≥7 on every dimension — rubric too lenient"
      }\n`
    );

    results.push({
      name: s.name,
      axis: s.axis,
      factuality,
      policy,
      escalation,
      minScore,
      pass: result.score.pass,
      correctlyMarkedDown,
      rationale,
    });

    if (!correctlyMarkedDown) allCorrectlyFailed = false;
  }

  console.log("---");
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(20)} F=${r.factuality} P=${r.policy} E=${r.escalation}  ${
        r.correctlyMarkedDown ? "FAIL ✓" : "PASS (unexpected!)"
      }`
    );
  }
  console.log("---");

  if (allCorrectlyFailed) {
    console.log(
      "[calibrate] PASS — judge rubric correctly marks down all 3 sabotages."
    );
    process.exit(0);
  } else {
    console.error(
      "[calibrate] FAIL — judge is too lenient. Do not record any baseline."
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(
    "[calibrate] fatal:",
    e instanceof Error ? e.message : String(e)
  );
  process.exit(1);
});
