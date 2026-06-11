// Smoke for S12 — secondary text dedup (phone+text+3s) in WhatsAppClient.
// Drives handleIncoming directly with synthetic WAMessages. Each message gets
// a UNIQUE id so the primary seenMessageIds dedup never triggers — we are
// exercising the secondary recentTextByPhone path only. Scenarios (prd.json
// S12 criterion 5):
//   A. same phone + same text, <1s apart  -> second dropped (1 emission)
//   B. same phone + same text, 5s apart   -> both processed (2 emissions)
//   C. same phone + diff text, <1s apart  -> both processed (1 batched emission, 2 texts)
import { WhatsAppClient } from "../tono/src/whatsapp";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { SupabaseClient } from "@supabase/supabase-js";
import os from "node:os";
import path from "node:path";

const PHONE = "573001234567";
const JID = `${PHONE}@s.whatsapp.net`;
const FLUSH_WAIT_MS = 2600; // > BATCH_IDLE_MS (2000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeMsg(text: string, id: string): WAMessage {
  return {
    key: { fromMe: false, remoteJid: JID, id },
    message: { conversation: text },
  } as WAMessage;
}

interface Step {
  text: string;
  delayMs: number;
}

async function runScenario(name: string, steps: Step[]): Promise<string[]> {
  const received: string[] = [];
  const client = new WhatsAppClient({
    authDir: path.join(os.tmpdir(), "smoke-s12-auth"),
    supabase: {} as unknown as SupabaseClient,
    printQr: false,
    handlers: {
      onMessage: async (ev) => {
        received.push(ev.text);
      },
    },
  });
  let i = 0;
  for (const step of steps) {
    if (step.delayMs > 0) await sleep(step.delayMs);
    await client["handleIncoming"](fakeMsg(step.text, `${name}-${i++}`));
  }
  await sleep(FLUSH_WAIT_MS);
  return received;
}

function check(name: string, expected: string[], actual: string[]): boolean {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`\n[${name}] expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)} -> ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function main() {
  console.log("=== S12 dedup smoke ===");

  console.log("\n--- Scenario A: same text twice, 800ms apart (second must drop) ---");
  const a = await runScenario("A", [
    { text: "6", delayMs: 0 },
    { text: "6", delayMs: 800 },
  ]);

  console.log("\n--- Scenario B: same text twice, 5s apart (both must process) ---");
  const b = await runScenario("B", [
    { text: "6", delayMs: 0 },
    { text: "6", delayMs: 5000 },
  ]);

  console.log("\n--- Scenario C: different texts, 800ms apart (both must process) ---");
  const c = await runScenario("C", [
    { text: "6", delayMs: 0 },
    { text: "sí", delayMs: 800 },
  ]);

  const results = [
    check("A: second dropped", ["6"], a),
    check("B: both processed (separate batches)", ["6", "6"], b),
    check("C: both processed (same batch)", ["6\nsí"], c),
  ];

  const allPass = results.every(Boolean);
  console.log(`\n=== ${allPass ? "ALL PASS" : "FAILURES PRESENT"} ===`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
