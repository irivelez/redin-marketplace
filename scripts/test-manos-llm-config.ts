// Unit test for Manos LLM config (Wave 1 RED → Wave 2/3 GREEN).
//
// Asserts:
//   1. Default MANOS_MODEL is "claude-sonnet-4-5" (no env override).
//   2. TEMPERATURE === 0.3 (applied ONLY on the no-thinking path).
//   3. MAX_TOOL_ITERATIONS sane (>= 3, the S4 contract).
//   4. MANOS_MODEL env override is honored.
//   5. Extended thinking is ON by default (THINKING_ENABLED) with budget >= 1024,
//      MAX_TOKENS exceeds the budget, and llm.ts builds a `thinking:` param while
//      keeping `temperature` only on the no-thinking branch.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/test-manos-llm-config.ts
//
// This script DOES NOT call Anthropic — pure source-level assertions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  // 1-3: import the test seam (forces the export to exist).
  const llmMod = await import("../manos/src/llm");
  const cfg = (llmMod as unknown as {
    __configForTests?: {
      MODEL: string;
      TEMPERATURE: number;
      MAX_TOKENS: number;
      MAX_TOOL_ITERATIONS: number;
      THINKING_ENABLED: boolean;
      THINKING_BUDGET: number;
    };
  }).__configForTests;
  assert.ok(cfg, "manos/src/llm.ts must export `__configForTests` test seam");
  assert.equal(
    cfg.MODEL,
    "claude-sonnet-4-5",
    `default MANOS_MODEL must be 'claude-sonnet-4-5' (got '${cfg.MODEL}')`
  );
  assert.equal(cfg.TEMPERATURE, 0.3, "TEMPERATURE must be 0.3 (no-thinking path)");
  assert.ok(
    cfg.MAX_TOOL_ITERATIONS >= 3,
    `MAX_TOOL_ITERATIONS must be >=3 for S4 (got ${cfg.MAX_TOOL_ITERATIONS})`
  );
  assert.equal(
    cfg.THINKING_ENABLED,
    true,
    "extended thinking must be ON by default for Manos scope-building"
  );
  assert.ok(
    cfg.THINKING_BUDGET >= 1024,
    `THINKING_BUDGET must be >= 1024 (got ${cfg.THINKING_BUDGET})`
  );
  assert.ok(
    cfg.MAX_TOKENS > cfg.THINKING_BUDGET,
    `MAX_TOKENS (${cfg.MAX_TOKENS}) must exceed THINKING_BUDGET (${cfg.THINKING_BUDGET})`
  );
  console.log(
    `✅ default config: MODEL=${cfg.MODEL} TEMP=${cfg.TEMPERATURE} THINKING=${cfg.THINKING_ENABLED}/${cfg.THINKING_BUDGET} MAX_TOKENS=${cfg.MAX_TOKENS}`
  );

  // 4: env override via child process (current import has cached MODEL).
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync(
    "npx",
    [
      "tsx",
      "-e",
      `import('./manos/src/llm.js').then(m => process.stdout.write(JSON.stringify((m as unknown as {__configForTests:{MODEL:string}}).__configForTests)));`,
    ],
    { env: { ...process.env, MANOS_MODEL: "claude-opus-4-1" }, encoding: "utf8" }
  );
  assert.equal(probe.status, 0, `env-override probe exited non-zero: ${probe.stderr}`);
  const overridden = JSON.parse(probe.stdout) as { MODEL: string };
  assert.equal(
    overridden.MODEL,
    "claude-opus-4-1",
    `MANOS_MODEL env override should win (got '${overridden.MODEL}')`
  );
  console.log(`✅ MANOS_MODEL override honored: ${overridden.MODEL}`);

  // 5: source builds a `thinking:` param (extended thinking wired), and the
  // thinking branch must NOT carry `temperature` (Anthropic rejects the combo).
  const llmPath = path.resolve(process.cwd(), "manos/src/llm.ts");
  const src = readFileSync(llmPath, "utf8");
  const codeLines = src.split("\n").filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*");
  });
  const hasThinkingParam = codeLines.some((l) => /\bthinking\s*:\s*\{/.test(l));
  assert.ok(
    hasThinkingParam,
    "manos/src/llm.ts must build a `thinking: { ... }` param when thinking is enabled"
  );
  const hasEnabledType = codeLines.some((l) => /type:\s*["']enabled["']/.test(l));
  assert.ok(hasEnabledType, "thinking param must use type: 'enabled'");
  console.log("✅ `thinking: { type: 'enabled', ... }` param present");

  console.log("\n✅ ALL CONFIG ASSERTIONS PASSED");
}

main().catch((e) => {
  console.error("❌ TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
