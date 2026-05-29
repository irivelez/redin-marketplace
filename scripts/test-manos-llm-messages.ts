// Unit test for Manos toAnthropicMessages (Wave 1 RED → Wave 2 GREEN).
//
// Crown-jewel safety net for S4: the Anthropic API's tool_use ↔ tool_result
// pairing contract MUST stay intact when we additively decorate the
// current-turn user message with an image content block.
//
// Asserts:
//   A. History user/assistant turns stay PLAIN STRING content (no image leaks).
//   B. When userImages is empty / absent, the final user message is a plain
//      string (current behaviour, unchanged).
//   C. When userImages has 1+ items, the final user message is a content array
//      with one text block followed by one image block per URL.
//   D. Across 3 simulated tool iterations (tool_call → tool_response × 3),
//      every assistant tool_use block has a matching tool_result in the next
//      user message, with matching ids and counts (count-mismatch or orphan
//      protection logic stays correct).
//   E. Image attachment NEVER appears on a history user message — only on
//      the final synthesized current-turn message.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/test-manos-llm-messages.ts
//
// No Anthropic API calls — pure unit test of the boundary translation.

import assert from "node:assert/strict";

interface PlainContent {
  role: "user" | "assistant";
  content: string | unknown[];
}

async function main(): Promise<void> {
  const llmMod = await import("../manos/src/llm");
  const toAnthropicMessages = (llmMod as unknown as {
    toAnthropicMessages?: (
      history: unknown[],
      currentUserMessage: string,
      currentUserImages?: { url: string }[]
    ) => PlainContent[];
  }).toAnthropicMessages;
  assert.ok(
    typeof toAnthropicMessages === "function",
    "manos/src/llm.ts must export `toAnthropicMessages`"
  );

  // --- B: no images → final user message is a plain string ---
  {
    const out = toAnthropicMessages([], "hola", undefined);
    assert.equal(out.length, 1, "no history → one message");
    const last = out[0]!;
    assert.equal(last.role, "user");
    assert.equal(
      typeof last.content,
      "string",
      "B: with no images, current-turn user message MUST be a plain string"
    );
    assert.equal(last.content, "hola");
    console.log("✅ B: no-images path emits plain-string user content");
  }

  // --- C: images present → final user message is a content array
  //        with text first, then 1 image block per URL ---
  {
    const out = toAnthropicMessages([], "describe esta foto", [
      { url: "https://example.com/a.jpg" },
      { url: "https://example.com/b.jpg" },
    ]);
    assert.equal(out.length, 1);
    const last = out[0]!;
    assert.equal(last.role, "user");
    assert.ok(
      Array.isArray(last.content),
      "C: with images, content MUST be an array of blocks"
    );
    const blocks = last.content as Array<Record<string, unknown>>;
    assert.equal(blocks.length, 3, "1 text + 2 image blocks");
    assert.equal(blocks[0]!.type, "text");
    assert.equal(blocks[0]!.text, "describe esta foto");
    for (let i = 0; i < 2; i++) {
      const b = blocks[i + 1]!;
      assert.equal(b.type, "image", `block ${i + 1} must be image`);
      const src = b.source as Record<string, unknown>;
      assert.equal(src.type, "url", "source.type must be 'url'");
      const urlValue = typeof src.url === "string" ? src.url : "";
      assert.ok(
        urlValue.startsWith("https://example.com/"),
        `source.url must be the signed URL passed in (got ${urlValue})`
      );
    }
    console.log("✅ C: images path emits text + image-url blocks");
  }

  // --- A + D: 3 tool iterations + image on current turn ---
  // History: user → tool_call(2) → tool_response(2) → tool_call(1) →
  //          tool_response(1) → tool_call(1) → tool_response(1) → assistant.
  // Current turn (userMessage="follow-up", userImages=[1])
  {
    const history = [
      { role: "user", text: "primer turno" },
      {
        role: "tool_call",
        calls: [
          { name: "list_my_pending_ots", args: {} },
          { name: "attach_photos", args: { ot_row_id: "ot1" } },
        ],
      },
      {
        role: "tool_response",
        responses: [
          { name: "list_my_pending_ots", response: { ok: true, data: [] } },
          { name: "attach_photos", response: { ok: true, data: { total_photos: 1 } } },
        ],
      },
      {
        role: "tool_call",
        calls: [{ name: "set_alcance_ot", args: { ot_row_id: "ot1" } }],
      },
      {
        role: "tool_response",
        responses: [{ name: "set_alcance_ot", response: { ok: true, data: {} } }],
      },
      {
        role: "tool_call",
        calls: [{ name: "finalize_alcance", args: { ot_row_id: "ot1" } }],
      },
      {
        role: "tool_response",
        responses: [
          { name: "finalize_alcance", response: { ok: true, data: { url: "x" } } },
        ],
      },
      { role: "assistant", text: "listo" },
    ];
    const out = toAnthropicMessages(history as unknown[], "follow-up con foto", [
      { url: "https://example.com/follow.jpg" },
    ]);

    // E: every NON-LAST user message must be plain string.
    for (let i = 0; i < out.length - 1; i++) {
      const m = out[i]!;
      if (m.role !== "user") continue;
      // tool_result-bearing user messages contain arrays — that's fine.
      // We only police the architect-utterance user message (text content).
      // A user message is "architect utterance" iff its content is a string
      // OR (array AND none of its blocks are tool_result).
      if (typeof m.content === "string") {
        // OK — plain string history user turn.
        continue;
      }
      const blocks = m.content as Array<Record<string, unknown>>;
      const isToolResult = blocks.some((b) => b.type === "tool_result");
      if (!isToolResult) {
        // Architect utterance with an image block — only allowed on the LAST one.
        assert.fail(
          `E: history user message at index ${i} carries non-tool_result content array — image leaked into history`
        );
      }
    }
    console.log("✅ E: history user turns are plain strings (no image leak)");

    // D: walk pairs.
    let i = 0;
    let pairsFound = 0;
    while (i < out.length) {
      const m = out[i]!;
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const toolUses = (m.content as Array<Record<string, unknown>>).filter(
          (b) => b.type === "tool_use"
        );
        if (toolUses.length > 0) {
          const next = out[i + 1];
          assert.ok(next, `D: assistant tool_use at ${i} must be followed by a user message`);
          assert.equal(next!.role, "user");
          assert.ok(Array.isArray(next!.content), "D: tool_result user must be content array");
          const toolResults = (next!.content as Array<Record<string, unknown>>).filter(
            (b) => b.type === "tool_result"
          );
          assert.equal(
            toolResults.length,
            toolUses.length,
            `D: tool_use count (${toolUses.length}) must match tool_result count (${toolResults.length})`
          );
          const useIds = toolUses.map((b) => b.id as string);
          const resultIds = toolResults.map((b) => b.tool_use_id as string);
          for (let k = 0; k < useIds.length; k++) {
            assert.equal(
              resultIds[k],
              useIds[k],
              `D: tool_use[${k}].id must match tool_result[${k}].tool_use_id`
            );
          }
          pairsFound += 1;
          i += 2;
          continue;
        }
      }
      i += 1;
    }
    assert.equal(
      pairsFound,
      3,
      `D: 3 tool iterations expected, found ${pairsFound} pair(s)`
    );
    console.log("✅ D: 3 tool iterations correctly paired (use ↔ result by id+count)");

    // C-on-history: the very last message must still be the current-turn
    // user message with the image block.
    const last = out[out.length - 1]!;
    assert.equal(last.role, "user");
    assert.ok(Array.isArray(last.content), "current-turn must be content array");
    const lastBlocks = last.content as Array<Record<string, unknown>>;
    assert.equal(lastBlocks[0]!.type, "text");
    assert.equal(lastBlocks[0]!.text, "follow-up con foto");
    assert.equal(lastBlocks[1]!.type, "image");
    console.log("✅ current-turn image block appears AFTER history pairs");
  }

  console.log("\n✅ ALL MESSAGE-SHAPE ASSERTIONS PASSED");
}

main().catch((e) => {
  console.error("❌ TEST FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
