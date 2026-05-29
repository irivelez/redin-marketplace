// One-shot probe: does claude-sonnet-4-5 accept an `image` block inside
// `tool_result.content`? If yes, we use it as the primary path for the
// view_photo Manos tool. If 400, we fall back to returning the signed URL
// as text and appending a synthetic user message with the image block.
//
// Run from marketplace root:
//   npx tsx --env-file=.env.local scripts/probe-anthropic-tool-result-image.ts
//
// Uses a small public test image (a single-pixel JPEG URL via Anthropic's
// own docs domain would be ideal but we don't have a guaranteed URL; instead
// we use a public Wikimedia thumbnail which is stable + small).

import Anthropic from "@anthropic-ai/sdk";
import { createServerClient } from "@redin/shared";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MODEL = "claude-sonnet-4-5";

async function getImageSource(): Promise<{
  url: string;
  base64Source: Anthropic.Base64ImageSource;
}> {
  // Use a real local test photo so Anthropic's fetcher sees a real Supabase
  // signed URL (same provider as production). Falls back to base64 for the
  // primary path so URL-reachability isn't conflated with structural support.
  const photoPath = path.resolve(
    process.cwd(),
    "data/test-results-manos/May27-manos-capacho/00000012-PHOTO-2026-05-27-18-07-43.jpg"
  );
  const bytes = readFileSync(photoPath);
  const base64Source: Anthropic.Base64ImageSource = {
    type: "base64",
    media_type: "image/jpeg",
    data: bytes.toString("base64"),
  };

  const supabase = createServerClient();
  const tmpPath = `incoming/+19999999911/${randomUUID()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("alcance-photos")
    .upload(tmpPath, bytes, { contentType: "image/jpeg", upsert: false });
  if (upErr) throw new Error(`probe upload failed: ${upErr.message}`);
  const { data: signed } = await supabase.storage
    .from("alcance-photos")
    .createSignedUrl(tmpPath, 3600);
  const url = signed?.signedUrl;
  if (!url) throw new Error("probe could not sign url");
  // schedule cleanup on exit
  process.on("beforeExit", () => {
    supabase.storage.from("alcance-photos").remove([tmpPath]).catch(() => {});
  });
  return { url, base64Source };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const { url: IMG_URL, base64Source: IMG_BASE64 } = await getImageSource();
  console.log(`probe signed URL: ${IMG_URL.slice(0, 80)}...`);

  const TOOL_USE_ID = "toolu_probe_001";

  const tools: Anthropic.Tool[] = [
    {
      name: "view_photo",
      description: "Re-open a previously-uploaded photo.",
      input_schema: {
        type: "object",
        properties: {
          n: { type: "integer", description: "1-based photo index" },
        },
        required: ["n"],
      },
    },
  ];

  console.log("--- Probe: image block INSIDE tool_result.content ---");
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      temperature: 0.3,
      tools,
      messages: [
        { role: "user", content: "Mira la foto número 1 y dime qué color predomina." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: TOOL_USE_ID,
              name: "view_photo",
              input: { n: 1 },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: TOOL_USE_ID,
              content: [
                { type: "image", source: { type: "url", url: IMG_URL } },
                { type: "text", text: "(re-attached photo #1)" },
              ],
            },
          ],
        },
      ],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    console.log(`✅ PRIMARY PATH WORKS — model replied: "${text.slice(0, 140)}"`);
    console.log(JSON.stringify({ primary: "ok", reply_excerpt: text.slice(0, 200) }));
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`❌ PRIMARY PATH FAILED: ${msg}`);
    console.log("Trying FALLBACK: signed URL as text + synthetic user image message");
    try {
      const fallback = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        temperature: 0.3,
        tools,
        messages: [
          { role: "user", content: "Mira la foto número 1 y dime qué color predomina." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: TOOL_USE_ID,
                name: "view_photo",
                input: { n: 1 },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: TOOL_USE_ID,
                content: JSON.stringify({ ok: true, data: { image_url: IMG_URL, n: 1 } }),
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "(foto re-adjuntada, n=1)" },
              { type: "image", source: { type: "url", url: IMG_URL } },
            ],
          },
        ],
      });
      const text = fallback.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      console.log(`✅ FALLBACK WORKS — model replied: "${text.slice(0, 140)}"`);
      console.log(JSON.stringify({ primary: "failed", fallback: "ok", primary_error: msg }));
      process.exit(2); // distinct code so callers can detect "use fallback"
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      console.log(`❌ FALLBACK ALSO FAILED: ${msg2}`);
      console.log(JSON.stringify({ primary: "failed", fallback: "failed", primary_error: msg, fallback_error: msg2 }));
      process.exit(3);
    }
  }
}

main().catch((e) => {
  console.error("PROBE THREW:", e);
  process.exit(99);
});
