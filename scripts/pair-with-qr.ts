// QR-based WhatsApp pairing for Toño.
// Run: tsx --env-file=.env.local scripts/pair-with-qr.ts
//
// Boots Baileys with empty auth state, captures the QR string, saves it as
// PNG at /tmp/tono-pair-qr.png AND prints it as ASCII to stdout. User scans
// from WhatsApp → Linked Devices → Link a device.
//
// QR rotates every ~20s. We re-save the PNG on each new QR.

import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";

const AUTH_DIR = path.join(process.cwd(), "data", "tono-wa-auth");
const PNG_OUT = "/tmp/tono-pair-qr.png";

async function main() {
  console.log(`[pair-qr] Auth dir: ${AUTH_DIR}`);
  console.log(`[pair-qr] QR PNG will be written to: ${PNG_OUT}`);
  console.log();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false, // we'll handle the QR ourselves
    browser: ["Antonio Red de Ingenieros", "Desktop", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  let qrCount = 0;
  sock.ev.on("connection.update", async (u: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      qrCount += 1;
      // Save PNG
      try {
        await QRCode.toFile(PNG_OUT, qr, { width: 512, margin: 2 });
        console.log(`[pair-qr] QR #${qrCount} saved → ${PNG_OUT}`);
      } catch (e) {
        console.error("[pair-qr] PNG write failed:", e);
      }
      // ASCII fallback
      console.log();
      qrcodeTerminal.generate(qr, { small: true });
      console.log();
      console.log(`[pair-qr] Open ${PNG_OUT} on screen → scan with phone:`);
      console.log("  WhatsApp Business → Settings → Linked Devices → Link a device → scan QR");
      console.log("  QR rotates every ~20s; latest is always at the same path.");
      console.log();
    }

    if (connection === "close") {
      const status = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.log("[pair-qr] disconnected | statusCode=" + status);
      if (status === DisconnectReason.loggedOut) {
        console.error("[pair-qr] LOGGED OUT — pairing failed.");
        process.exit(2);
      }
    } else if (connection === "open") {
      console.log();
      console.log("✓ Paired successfully.");
      console.log("  me.id  =", sock.user?.id);
      console.log("  me.name=", sock.user?.name);
      console.log("  me.lid =", (sock.user as any)?.lid);
      // Give Baileys 2s to flush pre-keys to disk
      setTimeout(() => process.exit(0), 2000);
    }
  });
}

main().catch((e) => {
  console.error("[pair-qr] fatal:", e);
  process.exit(1);
});
