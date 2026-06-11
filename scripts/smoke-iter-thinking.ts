// Smoke test for the Step-2c latency fix: per-iteration extended thinking.
//
// Product principle: intelligence at decision points, deterministic
// composition after tool returns. So extended thinking stays ON for
// iteration 0 (tool choice / policy gate / refusal / escalation) and is
// dropped for iteration >= 1 (composing the reply from a tool's
// suggested_reply — L26 "las herramientas mandan").
//
// This models a 2-iteration tool-using turn (one tool call):
//   - iter 0: model decides to call a tool       → params MUST include thinking
//   - iter 1: model composes reply from result   → params MUST omit thinking
//             (and KEEP temperature, for warmth on the no-thinking branch)
//
// Env override TONO_ITER1_THINKING=on restores thinking on ALL iterations
// (pre-fix behavior) for a no-code revert in Railway — verified via a child
// process so the module-level env read is re-evaluated.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/smoke-iter-thinking.ts
//
// No Anthropic API calls — pure assertions over the exported param builder
// (the same `buildIterParams` runTurn calls each iteration).

import assert from "node:assert/strict";

type AnyParams = Record<string, unknown>;

// Minimal stand-ins for the three static pieces runTurn feeds buildIterParams.
// Shapes don't matter to the thinking/temperature decision — they're passed
// through verbatim — so empty arrays keep the test focused.
function parts() {
  return {
    system: [{ type: "text" as const, text: "sys" }] as never,
    tools: [] as never,
    // iter 1 only happens AFTER a tool_use → tool_result round-trip; include a
    // representative tool_result message so the "one tool call" framing is real.
    messages: [
      { role: "user" as const, content: "necesito una OT" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use", id: "toolu_0", name: "list_open_ots", input: {} },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_0",
            content: '{"ok":true,"suggested_reply":"Tengo 2 OTs para ti."}',
          },
        ],
      },
    ] as never,
  };
}

async function main(): Promise<void> {
  const llmMod = await import("../tono/src/llm");
  const buildIterParams = (
    llmMod as unknown as {
      buildIterParams?: (iter: number, p: ReturnType<typeof parts>) => AnyParams;
    }
  ).buildIterParams;
  assert.ok(
    typeof buildIterParams === "function",
    "tono/src/llm.ts must export `buildIterParams(iter, parts)` test seam"
  );

  // --- iter 0: decision-making → thinking ON, temperature OMITTED ---
  {
    const p = buildIterParams(0, parts());
    assert.ok(
      p.thinking && typeof p.thinking === "object",
      "iter 0: params MUST include a `thinking` block"
    );
    const thinking = p.thinking as { type?: string; budget_tokens?: number };
    assert.equal(thinking.type, "enabled", "iter 0: thinking.type must be 'enabled'");
    assert.ok(
      typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= 1024,
      `iter 0: budget_tokens must be >= 1024 (got ${thinking.budget_tokens})`
    );
    assert.ok(
      !("temperature" in p),
      "iter 0: temperature MUST be omitted when thinking is enabled (Anthropic rejects the combo)"
    );
    console.log("✅ iter 0: thinking enabled, temperature omitted");
  }

  // --- iter 1: composition from tool result → thinking OFF, temperature KEPT ---
  {
    const p = buildIterParams(1, parts());
    assert.ok(
      !("thinking" in p),
      "iter 1 (default): params MUST omit `thinking` — composition needs no reasoning"
    );
    assert.ok(
      typeof p.temperature === "number",
      "iter 1: temperature MUST be retained on the no-thinking branch"
    );
    console.log("✅ iter 1: thinking omitted, temperature retained");
  }

  // --- iter 2+ behaves like iter 1 (still composition) ---
  {
    const p = buildIterParams(2, parts());
    assert.ok(!("thinking" in p), "iter 2 (default): params MUST omit `thinking`");
    console.log("✅ iter 2: thinking omitted (same as iter 1)");
  }

  // --- Env revert: TONO_ITER1_THINKING=on → thinking on ALL iterations ---
  // Re-evaluated in a child process (module-level env read is import-time).
  {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync(
      "npx",
      [
        "tsx",
        "-e",
        [
          "import('./tono/src/llm.ts').then((m) => {",
          "  const b = (m).buildIterParams;",
          "  const parts = { system: [{ type: 'text', text: 's' }], tools: [], messages: [] };",
          "  const p0 = b(0, parts); const p1 = b(1, parts);",
          "  process.stdout.write(JSON.stringify({",
          "    i0: 'thinking' in p0, i1: 'thinking' in p1,",
          "    i1temp: 'temperature' in p1,",
          "  }));",
          "});",
        ].join("\n"),
      ],
      {
        env: { ...process.env, TONO_ITER1_THINKING: "on" },
        encoding: "utf8",
        cwd: process.cwd(),
      }
    );
    assert.equal(
      probe.status,
      0,
      `TONO_ITER1_THINKING=on probe exited non-zero: ${probe.stderr}`
    );
    const r = JSON.parse(probe.stdout.trim()) as {
      i0: boolean;
      i1: boolean;
      i1temp: boolean;
    };
    assert.equal(r.i0, true, "override on: iter 0 still has thinking");
    assert.equal(
      r.i1,
      true,
      "override on: iter 1 MUST have thinking (revert to pre-fix behavior)"
    );
    assert.equal(
      r.i1temp,
      false,
      "override on: iter 1 thinking branch MUST omit temperature"
    );
    console.log("✅ TONO_ITER1_THINKING=on: thinking restored on iter 1 (no-code revert works)");
  }

  console.log("\n✅ ALL ITER-THINKING ASSERTIONS PASSED");
}

main().catch((e) => {
  console.error("❌ TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
