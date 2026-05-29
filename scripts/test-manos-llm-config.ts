// Unit test for Manos LLM config (Wave 1 RED → Wave 2/3 GREEN).
//
// Asserts:
//   1. Default MANOS_MODEL is "claude-sonnet-4-5" (no env override).
//   2. TEMPERATURE === 0.3.
//   3. MAX_TOOL_ITERATIONS sane (>= 3, the S4 contract).
//   4. MANOS_MODEL env override is honored.
//   5. manos/src/llm.ts contains NO `thinking:` block in messages.create
//      params (Sonnet 4.5 + extended thinking would force temperature=1).
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
    };
  }).__configForTests;
  assert.ok(cfg, "manos/src/llm.ts must export `__configForTests` test seam");
  assert.equal(
    cfg.MODEL,
    "claude-sonnet-4-5",
    `default MANOS_MODEL must be 'claude-sonnet-4-5' (got '${cfg.MODEL}')`
  );
  assert.equal(cfg.TEMPERATURE, 0.3, "TEMPERATURE must be 0.3 (thinking is OFF)");
  assert.ok(
    cfg.MAX_TOOL_ITERATIONS >= 3,
    `MAX_TOOL_ITERATIONS must be >=3 for S4 (got ${cfg.MAX_TOOL_ITERATIONS})`
  );
  console.log(
    `✅ default config: MODEL=${cfg.MODEL} TEMP=${cfg.TEMPERATURE} MAX_TOOL_ITERATIONS=${cfg.MAX_TOOL_ITERATIONS}`
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

  // 5: source contains no `thinking:` block in messages.create params.
  // Exclude code comments — we look for an actual `thinking:` property
  // inside the params object.
  const llmPath = path.resolve(process.cwd(), "manos/src/llm.ts");
  const src = readFileSync(llmPath, "utf8");
  const lines = src.split("\n");
  const thinkingLines = lines.filter((l) => {
    const trimmed = l.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    return /\bthinking\s*:/.test(l);
  });
  assert.equal(
    thinkingLines.length,
    0,
    `manos/src/llm.ts must NOT contain a 'thinking:' param (found: ${JSON.stringify(thinkingLines)})`
  );
  console.log("✅ no `thinking:` block in messages.create params");

  console.log("\n✅ ALL CONFIG ASSERTIONS PASSED");
}

main().catch((e) => {
  console.error("❌ TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
