// Code-based WhatsApp pairing for Toño.
// Run: tsx --env-file=.env.local scripts/pair-with-code.ts
//
// Prompts for the Toño phone number, requests an 8-digit pairing code from
// WhatsApp, prints it. User enters it on their phone via:
//   WhatsApp → Linked Devices → Link a device → Link with phone number
// Once paired, creds.json + signal state are saved to data/tono-wa-auth/.
//
// Alternative to QR-scan flow (tono:pair) — better for remote pairing where
// you can't show the QR image to the person holding the phone.

import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "node:path";

const AUTH_DIR = path.join(process.cwd(), "data", "tono-wa-auth");
const PHONE_NUMBER = (process.env.WA_NUMBER ?? "+573105751757").replace(/[^\d]/g, "");

async function main() {
  console.log(`[pair-code] Auth dir: ${AUTH_DIR}`);
  console.log(`[pair-code] Phone: +${PHONE_NUMBER}`);
  console.log();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    // We do NOT want QR; we want code-based pairing
    printQRInTerminal: false,
    browser: ["Antonio Red de Ingenieros", "Desktop", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  // Request the pairing code as soon as the socket is ready but BEFORE
  // it's authenticated. Per Baileys docs, you must call requestPairingCode
  // when `state.creds.registered === false`.
  if (!state.creds.registered) {
    // Brief delay lets the socket attach handlers before we request the code
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        const pretty = code.match(/.{1,4}/g)?.join("-") ?? code;
        console.log();
        console.log("═══════════════════════════════════════════════════");
        console.log(`  PAIRING CODE: ${pretty}`);
        console.log("═══════════════════════════════════════════════════");
        console.log();
        console.log("On your phone:");
        console.log("  WhatsApp → Settings → Linked Devices → Link a device");
        console.log("  → Link with phone number instead");
        console.log(`  → Enter: ${pretty}`);
        console.log();
        console.log("Code expires in ~3 minutes. Waiting for pairing...");
        console.log();
      } catch (err) {
        console.error("[pair-code] requestPairingCode failed:", err);
        process.exit(1);
      }
    }, 3000);
  } else {
    console.log("[pair-code] Already registered — nothing to pair. me.id:", state.creds.me?.id);
    process.exit(0);
  }

  sock.ev.on("connection.update", (u: Partial<ConnectionState>) => {
    const { connection, lastDisconnect } = u;
    if (connection === "close") {
      const status = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.log("[pair-code] disconnected | statusCode=" + status);
      if (status === DisconnectReason.loggedOut) {
        console.error("[pair-code] LOGGED OUT — pairing failed. Wipe auth dir + try again.");
        process.exit(2);
      }
    } else if (connection === "open") {
      console.log();
      console.log("✓ Paired successfully.");
      console.log("  me.id  =", sock.user?.id);
      console.log("  me.name=", sock.user?.name);
      console.log("  me.lid =", (sock.user as any)?.lid);
      // Give Baileys 2s to flush any final pre-key uploads to disk
      setTimeout(() => process.exit(0), 2000);
    }
  });
}

main().catch((e) => {
  console.error("[pair-code] fatal:", e);
  process.exit(1);
});
