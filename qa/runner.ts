/**
 * qa/runner.ts — S07 Eval harness entry point.
 *
 * Usage:
 *   npm run eval                          # full suite
 *   npm run eval -- --limit 1            # first N seeds (smoke run)
 *   npm run eval -- --only journey_9_1_registration
 *   npm run eval -- --limit 1 --no-judge # skip Gemini judge (cheapest smoke)
 *   npm run eval -- --clean              # just clean test data, exit
 *
 * Exit codes:
 *   0 — all deterministic pass + ≥90% judge pass + 100% coverage
 *   1 — any deterministic FAIL, judge below gate, or coverage gap
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { createServerClient } from "@redin/shared";
import { parseSeedYaml, type Seed } from "./seeds/schema.js";
import {
  applyFixtures,
  cleanupTestData,
  allocateTestPhone,
  testCedulaFor,
  legacyNombreFor,
} from "./fixtures.js";
import { injectMessage, type InjectResult } from "./inject.js";
import {
  deterministicCheck,
  deterministicCheckWithDbState,
  type DeterministicResult,
} from "./deterministic.js";
import { judgeConversation, type JudgeResult } from "./judge.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEEDS_DIR = join(__dirname, "seeds");
const REPORTS_DIR = join(__dirname, "reports");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): {
  limit: number | null;
  only: string | null;
  noJudge: boolean;
  clean: boolean;
} {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let only: string | null = null;
  let noJudge = false;
  let clean = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1] ?? "0", 10);
      i++;
    } else if (arg === "--only" && args[i + 1]) {
      only = args[i + 1] ?? null;
      i++;
    } else if (arg === "--no-judge") {
      noJudge = true;
    } else if (arg === "--clean") {
      clean = true;
    }
  }

  return { limit, only, noJudge, clean };
}

// ---------------------------------------------------------------------------
// Seed loader
// ---------------------------------------------------------------------------

function loadSeeds(onlyName: string | null): Seed[] {
  const dirs = ["journeys", "refusals", "redteam", "onboarding"];
  const seeds: Seed[] = [];

  for (const dir of dirs) {
    const dirPath = join(SEEDS_DIR, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".yaml"));
    } catch {
      console.warn(`[warn] seeds dir not found: ${dirPath}`);
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      const raw = yaml.load(readFileSync(filePath, "utf8"));
      const seed = parseSeedYaml(raw);
      seeds.push(seed);
    }
  }

  if (onlyName) {
    const matched = seeds.filter((s) => s.name === onlyName);
    if (matched.length === 0) {
      console.error(`[error] --only "${onlyName}" matched no seeds.`);
      process.exit(1);
    }
    return matched;
  }

  return seeds;
}

// ---------------------------------------------------------------------------
// Per-seed result type
// ---------------------------------------------------------------------------

interface SeedResult {
  seed: Seed;
  detResult: DeterministicResult;
  judgeResult: JudgeResult;
  turns: InjectResult[];
  testPhone: string;
}

// ---------------------------------------------------------------------------
// Coverage gate
// ---------------------------------------------------------------------------

interface CoverageReport {
  journeys: { total: number; covered: number };
  refusals: { total: number; covered: number };
  redteam: { total: number; covered: number };
  onboarding: { total: number; covered: number };
  ok: boolean;
}

function computeCoverage(results: SeedResult[]): CoverageReport {
  const passing = results.filter(
    (r) =>
      r.detResult.passed &&
      (r.judgeResult.status === "pass" || r.judgeResult.status === "skipped")
  );

  const passNames = new Set(passing.map((r) => r.seed.name));

  const journeySeeds = results.filter((r) => r.seed.category === "journey");
  const refusalSeeds = results.filter((r) => r.seed.category === "refusal");
  const redteamSeeds = results.filter((r) => r.seed.category === "redteam");
  const onboardingSeeds = results.filter((r) => r.seed.category === "onboarding");

  const journeysCovered = journeySeeds.filter((r) => passNames.has(r.seed.name)).length;
  const refusalsCovered = refusalSeeds.filter((r) => passNames.has(r.seed.name)).length;
  const redteamCovered = redteamSeeds.filter((r) => passNames.has(r.seed.name)).length;
  const onboardingCovered = onboardingSeeds.filter((r) => passNames.has(r.seed.name)).length;

  const ok =
    journeysCovered === journeySeeds.length &&
    refusalsCovered === refusalSeeds.length &&
    redteamCovered === redteamSeeds.length &&
    onboardingCovered === onboardingSeeds.length;

  return {
    journeys: { total: journeySeeds.length, covered: journeysCovered },
    refusals: { total: refusalSeeds.length, covered: refusalsCovered },
    redteam: { total: redteamSeeds.length, covered: redteamCovered },
    onboarding: { total: onboardingSeeds.length, covered: onboardingCovered },
    ok,
  };
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

function formatTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}-${hh}${mm}`;
}

function excerptReply(turns: InjectResult[], maxLines = 8): string {
  const last = [...turns].reverse().find((t) => t.reply);
  if (!last) return "(no reply)";
  return last.reply.split("\n").slice(0, maxLines).join("\n");
}

function writeReport(
  results: SeedResult[],
  coverage: CoverageReport,
  noJudge: boolean
): string {
  const ts = formatTimestamp();
  const reportPath = join(REPORTS_DIR, `EVAL-${ts}.md`);

  const totalSeeds = results.length;
  const detPass = results.filter((r) => r.detResult.passed).length;
  const detFail = totalSeeds - detPass;

  const judgedSeeds = results.filter(
    (r) => r.judgeResult.status === "pass" || r.judgeResult.status === "fail"
  );
  const judgePass = judgedSeeds.filter((r) => r.judgeResult.status === "pass").length;
  const judgeTotal = judgedSeeds.length;
  const judgeRate = judgeTotal > 0 ? Math.round((judgePass / judgeTotal) * 100) : 0;
  const judgeGateOk = noJudge || judgeTotal === 0 || judgeRate >= 90;

  const unknown = results.filter((r) => r.judgeResult.status === "skipped" || r.judgeResult.status === "error").length;

  const overallVerdict =
    detFail === 0 && judgeGateOk && coverage.ok ? "PASS ✅" : "BLOCKED ❌";

  const lines: string[] = [];

  lines.push(`# Evaluation Report — ${ts.replace(/-(\d{4})$/, " $1").replace(/-/g, "-")}`);
  lines.push("");
  lines.push(
    `Summary: ${detPass} PASS / ${detFail} FAIL / ${unknown} UNKNOWN (judge skipped/error)`
  );
  lines.push(`Deterministic: ${detPass}/${totalSeeds} pass`);

  if (noJudge) {
    lines.push(`Judge: skipped (--no-judge)`);
  } else {
    const gateLabel = judgeGateOk ? "OK" : "BELOW 90% GATE";
    lines.push(
      `Judge: ${judgePass}/${judgeTotal} pass (${judgeRate}%) — ${gateLabel}`
    );
  }

  lines.push(
    `Coverage: journeys ${coverage.journeys.covered}/${coverage.journeys.total}, ` +
      `refusals ${coverage.refusals.covered}/${coverage.refusals.total}, ` +
      `redteam ${coverage.redteam.covered}/${coverage.redteam.total}, ` +
      `onboarding ${coverage.onboarding.covered}/${coverage.onboarding.total} → ` +
      `${coverage.journeys.covered + coverage.refusals.covered + coverage.redteam.covered + coverage.onboarding.covered}/${totalSeeds} covered`
  );
  lines.push("");
  lines.push("## Results");
  lines.push("");

  for (const r of results) {
    const { seed, detResult, judgeResult, turns } = r;
    const detLabel = detResult.passed ? "PASS" : "FAIL (deterministic)";

    let judgeLabel = "";
    if (judgeResult.status === "pass" && "score" in judgeResult) {
      const { factuality: f, policy: p, escalation: e, rationale } = judgeResult.score;
      judgeLabel = `F=${f} P=${p} E=${e} PASS  "${rationale}"`;
    } else if (judgeResult.status === "fail" && "score" in judgeResult) {
      const { factuality: f, policy: p, escalation: e, rationale } = judgeResult.score;
      judgeLabel = `F=${f} P=${p} E=${e} FAIL  "${rationale}"`;
    } else if (judgeResult.status === "skipped") {
      judgeLabel = `skipped`;
    } else if (judgeResult.status === "error") {
      judgeLabel = `error: ${"reason" in judgeResult ? judgeResult.reason : "unknown"}`;
    }

    const overallSeedStatus = detResult.passed
      ? judgeResult.status === "pass" || judgeResult.status === "skipped"
        ? "PASS"
        : "FAIL (judge)"
      : "FAIL";

    lines.push(`### [${seed.prd_ref} | ${seed.name}] — ${overallSeedStatus}`);
    lines.push(`Deterministic: ${detResult.passed ? "✅ all assertions met" : "❌ failed"}`);
    if (!detResult.passed) {
      for (const f of detResult.failures) {
        lines.push(`- **${f.assertion}**: expected \`${f.expected}\` — observed \`${f.observed}\``);
        lines.push(`  evidence: ${f.evidence}`);
      }
    }
    if (judgeLabel) {
      lines.push(`Judge: ${judgeLabel}`);
    }

    const excerpt = excerptReply(turns);
    lines.push("Reply excerpt:");
    lines.push("```");
    lines.push(excerpt);
    lines.push("```");

    if (!detResult.passed) {
      lines.push(
        `Repro: \`npm run eval -- --only=${seed.name}\``
      );
      const firstFail = detResult.failures[0];
      if (firstFail) {
        lines.push(
          `Hypothesis: ${firstFail.assertion} failed — check system prompt / router enforcement.`
        );
      }
    }

    lines.push(`Deterministic label: ${detLabel}`);
    lines.push("");
  }

  // Verdict
  const verdictReasons: string[] = [];
  if (detFail > 0) verdictReasons.push(`${detFail} deterministic fail`);
  if (!judgeGateOk) verdictReasons.push(`judge below 90% gate (${judgeRate}%)`);
  if (!coverage.ok) verdictReasons.push("coverage gap");

  lines.push(
    `VERDICT: ${overallVerdict}${verdictReasons.length > 0 ? " — " + verdictReasons.join(" + ") : ""}`
  );

  const content = lines.join("\n");
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(reportPath, content, "utf8");
  return reportPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { limit, only, noJudge, clean } = parseArgs();

  // --clean: just wipe test data and exit.
  if (clean) {
    console.log("[eval] --clean: removing all TEST_ / +99000 data...");
    await cleanupTestData();
    console.log("[eval] clean complete.");
    process.exit(0);
  }

  // Pre-run cleanup: wipe any stale TEST_ / +99000 rows left by a prior crashed run.
  // Without this, a prior run that exited without cleanup leaves sessions that
  // getOrCreate() re-uses, then an in-flight cleanup from the prior run deletes them
  // mid-turn causing FK violations on messages inserts.
  console.log("[eval] Pre-run cleanup of stale test data...");
  await cleanupTestData();

  let seeds = loadSeeds(only);
  if (limit !== null) {
    seeds = seeds.slice(0, limit);
  }

  console.log(`[eval] Running ${seeds.length} seed(s)${noJudge ? " (--no-judge)" : ""}...`);

  const results: SeedResult[] = [];

  for (const seed of seeds) {
    const testPhone = allocateTestPhone();
    console.log(`\n[eval] → ${seed.name} (${testPhone})`);

    // Seed DB.
    let fixtureRefs;
    try {
      fixtureRefs = await applyFixtures(seed.db_fixtures, testPhone);
      void fixtureRefs; // used by future: could pass to inject for context
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [error] fixture setup failed: ${msg}`);
      // Still record a result so coverage gate knows this seed failed.
      results.push({
        seed,
        detResult: {
          seed_name: seed.name,
          passed: false,
          failures: [
            {
              assertion: "fixture_setup",
              expected: "fixtures applied without error",
              observed: msg,
              evidence: "applyFixtures threw",
            },
          ],
        },
        judgeResult: { status: "skipped", reason: "fixture setup failed" },
        turns: [],
        testPhone,
      });
      await cleanupTestData();
      continue;
    }

    // Drive Toño turn by turn.
    const turns: InjectResult[] = [];
    let sessionId: string | undefined;
    // Capture the conversation start time so DB-state assertions know the
    // floor for "rows written during this conversation".
    const conversationStart = new Date();

    // Per-run substitutions in user_utterances AND deeply within
    // expected_tool_calls / expected_assertions / expected_eventos so a seed
    // can reference the fixture-allocated cedula or legacy name uniformly.
    //   ${cedula}        — testCedulaFor(testPhone)
    //   ${legacy_nombre} — legacyNombreFor(testPhone)
    const runCedula = testCedulaFor(testPhone);
    const runLegacyNombre = legacyNombreFor(testPhone);
    const expand = (s: string): string =>
      s.replace(/\$\{cedula\}/g, runCedula).replace(/\$\{legacy_nombre\}/g, runLegacyNombre);
    const expandDeep = (v: unknown): unknown => {
      if (typeof v === "string") return expand(v);
      if (Array.isArray(v)) return v.map(expandDeep);
      if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          out[k] = expandDeep(val);
        }
        return out;
      }
      return v;
    };
    const liveSeed: Seed = {
      ...seed,
      user_utterances: seed.user_utterances.map(expand),
      expected_tool_calls: (expandDeep(seed.expected_tool_calls) as Seed["expected_tool_calls"]) ?? [],
      expected_assertions: (expandDeep(seed.expected_assertions) as Seed["expected_assertions"]) ?? [],
      expected_eventos: seed.expected_eventos
        ? (expandDeep(seed.expected_eventos) as Seed["expected_eventos"])
        : undefined,
    };

    for (const utterance of liveSeed.user_utterances) {
      const turnStart = new Date();
      const expanded = utterance;
      try {
        const result = await injectMessage(testPhone, expanded, turnStart, sessionId);
        turns.push(result);
        console.log(
          `  [turn] "${expanded.slice(0, 50)}" → tools:[${result.toolCallsMade.map((t) => t.name).join(",")}] reply:${result.reply.length}c`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  [error] inject failed for turn "${expanded.slice(0, 40)}": ${msg}`);
        // Push an empty turn so indices remain aligned.
        turns.push({ reply: "", toolCallsMade: [], eventosWritten: [] });
      }
    }

    // Deterministic check. Use the async variant when the seed declares any
    // of expected_db_state / expected_dossier / expected_eventos so we read
    // the post-conversation row state (Stream A assertions). liveSeed has
    // had ${cedula} / ${legacy_nombre} substituted so assertions match the
    // actual values the agent saw.
    const needsDbCheck =
      liveSeed.expected_db_state ||
      liveSeed.expected_dossier ||
      (liveSeed.expected_eventos && liveSeed.expected_eventos.length > 0);
    const detResult: DeterministicResult = needsDbCheck
      ? await deterministicCheckWithDbState(
          liveSeed,
          turns,
          testPhone,
          conversationStart,
          createServerClient(),
          runCedula
        )
      : deterministicCheck(liveSeed, turns, runCedula);
    console.log(
      `  [det] ${detResult.passed ? "PASS" : `FAIL (${detResult.failures.length} failure(s))`}`
    );

    // LLM-as-judge — only if deterministic passed.
    let judgeResult: JudgeResult;
    if (detResult.passed) {
      judgeResult = await judgeConversation(seed, turns, { noJudge });
      if (judgeResult.status !== "skipped") {
        console.log(`  [judge] ${judgeResult.status}`);
      }
    } else {
      judgeResult = { status: "skipped", reason: "deterministic failed" };
    }

    // Cleanup this seed's test data.
    try {
      await cleanupTestData();
    } catch (e) {
      console.warn(`  [warn] cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    results.push({ seed, detResult, judgeResult, turns, testPhone });
  }

  // Compute coverage gate.
  const coverage = computeCoverage(results);

  // Write report.
  const reportPath = writeReport(results, coverage, noJudge);
  console.log(`\n[eval] Report written: ${reportPath}`);

  // Gate summary.
  const detPass = results.filter((r) => r.detResult.passed).length;
  const detFail = results.length - detPass;
  const judgedSeeds = results.filter(
    (r) => r.judgeResult.status === "pass" || r.judgeResult.status === "fail"
  );
  const judgePass = judgedSeeds.filter((r) => r.judgeResult.status === "pass").length;
  const judgeTotal = judgedSeeds.length;
  const judgeRate = judgeTotal > 0 ? Math.round((judgePass / judgeTotal) * 100) : 100;
  const judgeGateOk = noJudge || judgeTotal === 0 || judgeRate >= 90;

  console.log(`\n[eval] Deterministic: ${detPass}/${results.length} pass`);
  if (!noJudge) {
    console.log(`[eval] Judge: ${judgePass}/${judgeTotal} pass (${judgeRate}%)`);
  }
  console.log(
    `[eval] Coverage: journeys ${coverage.journeys.covered}/${coverage.journeys.total} ` +
      `refusals ${coverage.refusals.covered}/${coverage.refusals.total} ` +
      `redteam ${coverage.redteam.covered}/${coverage.redteam.total} ` +
      `onboarding ${coverage.onboarding.covered}/${coverage.onboarding.total}`
  );

  if (detFail > 0 || !judgeGateOk || !coverage.ok) {
    const reasons: string[] = [];
    if (detFail > 0) reasons.push(`${detFail} deterministic FAIL`);
    if (!judgeGateOk) reasons.push(`judge ${judgeRate}% < 90% gate`);
    if (!coverage.ok) reasons.push("coverage gap");
    console.error(`\n[eval] BLOCKED ❌ — ${reasons.join(", ")}`);
    process.exit(1);
  }

  console.log("\n[eval] PASS ✅ — all gates met");
  process.exit(0);
}

main().catch((e) => {
  console.error("[eval] fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
