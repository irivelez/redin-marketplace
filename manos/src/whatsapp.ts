// Manos WhatsApp client — extends the Toño pattern with media handling.
//
// Key differences from tono/src/whatsapp.ts:
//   1. imageMessage: downloads via downloadMediaMessage, uploads to Supabase
//      Storage bucket alcance-photos/incoming/<phone>/<uuid>.jpg, passes public
//      URL to onMessage handler.
//   2. audioMessage (ptt or regular): downloads OGG/Opus bytes, passes them to
//      transcribe.ts; if transcription succeeds, appends [VOZ] prefix to text;
//      if it fails, passes a fallback prompt string.
//   3. documentMessage: sends polite "por ahora solo fotos y voz" reply.
//   4. Auth dir uses MANOS_DATA_DIR (not TONO_DATA_DIR).

import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { createLogger, phoneFromJid } from "@redin/shared";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { transcribeAudio } from "./transcribe";

const log = createLogger("manos:wa");

const INPUT_CAP_WHATSAPP = 2000;

export interface WhatsAppHandlers {
  onMessage: (ev: {
    phone: string;
    text: string;
    jid: string;
    imageUrls?: string[];
  }) => Promise<void>;
  onReady?: () => void | Promise<void>;
}

export interface WhatsAppOptions {
  authDir: string;
  handlers: WhatsAppHandlers;
  supabase: SupabaseClient;
  printQr?: boolean;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private reconnecting = false;
  private seenMessageIds = new Set<string>();

  constructor(private opts: WhatsAppOptions) {
    fs.mkdirSync(opts.authDir, { recursive: true });
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const silentLogger = pino({ level: "silent" });
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined as unknown as [number, number, number],
    }));
    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger as unknown as pino.Logger,
      browser: ["Manos Redin", "Chrome", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (u) => this.onConnectionUpdate(u));
    this.sock.ev.on("messages.upsert", async (m) => {
      if (m.type !== "notify" && m.type !== "append") return;
      for (const msg of m.messages) {
        await this.handleIncoming(msg).catch((e) => {
          log.error("handle incoming failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("socket not ready");
    const chunks = chunkText(text, 3500);
    for (const c of chunks) {
      await this.sock.sendMessage(jid, { text: c });
    }
  }

  async sendDocument(
    jid: string,
    buffer: Buffer,
    opts: { fileName: string; mimetype?: string; caption?: string }
  ): Promise<void> {
    if (!this.sock) throw new Error("socket not ready");
    await this.sock.sendMessage(jid, {
      document: buffer,
      mimetype: opts.mimetype ?? "application/pdf",
      fileName: opts.fileName,
      caption: opts.caption,
    });
  }

  private onConnectionUpdate(u: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = u;
    if (qr && this.opts.printQr !== false) {
      log.info("QR code received — scan with the Manos WhatsApp number");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      log.info("connected to WhatsApp", { authDir: this.opts.authDir });
      this.opts.handlers.onReady?.();
    }
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log.warn("disconnected", { statusCode, loggedOut });
      if (!loggedOut && !this.reconnecting) {
        this.reconnecting = true;
        setTimeout(() => {
          this.reconnecting = false;
          this.start().catch((e) =>
            log.error("reconnect failed", { error: e instanceof Error ? e.message : String(e) })
          );
        }, 2000);
      }
      if (loggedOut) {
        log.error(
          "logged out — delete the auth dir and re-pair with `npm run manos:pair`",
          { authDir: this.opts.authDir }
        );
      }
    }
  }

  private async handleIncoming(msg: WAMessage): Promise<void> {
    if (msg.key.fromMe) return;

    // LID-mode self-loop guard (added 2026-05-26, mirrors tono/whatsapp.ts).
    // WhatsApp history-sync can replay the bot's OWN outbound back to Baileys
    // with key.fromMe inconsistent on LID-mode accounts. Without this check,
    // phoneFromJid extracts the bot's own LID as a "user phone" and the bot
    // enters an infinite self-reply loop. See tono/src/whatsapp.ts for incident.
    const remoteJid = msg.key.remoteJid ?? "";
    const user = this.sock?.user as { id?: string; lid?: string } | undefined;
    const stripIdDeviceAndDomain = (s: string): string =>
      (s.split(":")[0] ?? "").split("@")[0] ?? "";
    const remoteBase = stripIdDeviceAndDomain(remoteJid);
    if (remoteBase) {
      const ownIds: string[] = [];
      if (user?.id) ownIds.push(user.id);
      if (user?.lid) ownIds.push(user.lid);
      if (ownIds.some((o) => stripIdDeviceAndDomain(o) === remoteBase)) {
        log.warn("dropped inbound from own identity (LID self-loop guard)", { remoteJid });
        return;
      }
    }

    if (!msg.message) return;

    const msgId = msg.key.id;
    if (msgId) {
      if (this.seenMessageIds.has(msgId)) return;
      this.seenMessageIds.add(msgId);
      if (this.seenMessageIds.size > 500) {
        const firstHalf = Array.from(this.seenMessageIds).slice(0, 250);
        for (const id of firstHalf) this.seenMessageIds.delete(id);
      }
    }

    const jid = msg.key.remoteJid ?? "";
    if (!jid || jid.endsWith("@g.us")) return; // skip groups

    const phone = phoneFromJid(jid);
    if (!phone) return;

    const msgContent = msg.message;

    // ---- Document message: polite refusal + event log ----
    if (msgContent.documentMessage || msgContent.documentWithCaptionMessage) {
      const docMsg =
        msgContent.documentMessage ?? msgContent.documentWithCaptionMessage?.message?.documentMessage;
      const mimeType = docMsg?.mimetype ?? "unknown";
      const filename = docMsg?.fileName ?? "unknown";
      await this.sendText(
        jid,
        "Por ahora no proceso archivos Excel ni PDF en WhatsApp. Si tienes los datos en una hoja, mándamelos por voz o foto — yo armo el alcance contigo. (Excel sale en versión próxima)"
      );
      // Fire-and-forget — rejection logging must never block the response.
      this.opts.supabase.from("eventos").insert({
        type: "manos_unsupported_doc_type",
        entity_id: null,
        actor: `arquitecto:${phone}`,
        meta: { mime_type: mimeType, filename, phone },
      }).then(({ error }) => {
        if (error) {
          log.warn("failed to log manos_unsupported_doc_type event", { phone, error: error.message });
        }
      });
      return;
    }

    // ---- Image message: download + upload to Storage ----
    if (msgContent.imageMessage) {
      const imageUrls = await this.handleImageMessage(msg, phone);
      const caption =
        msgContent.imageMessage.caption?.trim() ?? "";
      // If the upload pipeline returned no URLs the architect's photo never
      // reached Storage. Surface this to the LLM via a sentinel marker in the
      // text so the prompt rule (manos-system.ts → "Errores de medios") can
      // ask for a resend instead of silently storing alcance with no photo.
      const captionText = caption.length > 0 ? caption.slice(0, INPUT_CAP_WHATSAPP) : "[foto]";
      const text =
        imageUrls.length === 0
          ? `[PHOTO_UPLOAD_FAILED] ${captionText}`.trim()
          : captionText;
      await this.opts.handlers.onMessage({ phone, text, jid, imageUrls });
      return;
    }

    // ---- Audio message (voice note or regular audio): transcribe ----
    if (msgContent.audioMessage) {
      const textResult = await this.handleAudioMessage(msg, phone);
      await this.opts.handlers.onMessage({ phone, text: textResult, jid });
      return;
    }

    // ---- Text message ----
    const text =
      msgContent.conversation ??
      msgContent.extendedTextMessage?.text ??
      "";
    if (!text.trim()) return;

    let safeText = text;
    if (text.length > INPUT_CAP_WHATSAPP) {
      log.warn("inbound message truncated", { phone, original_len: text.length });
      safeText = text.slice(0, INPUT_CAP_WHATSAPP);
    }
    await this.opts.handlers.onMessage({ phone, text: safeText, jid });
  }

  private async handleImageMessage(
    msg: WAMessage,
    phone: string
  ): Promise<string[]> {
    try {
      if (!this.sock) return [];
      const buffer = await downloadMediaMessage(msg, "buffer", {}, {
        logger: pino({ level: "silent" }) as unknown as pino.Logger,
        reuploadRequest: this.sock.updateMediaMessage,
      }) as Buffer;

      const uuid = randomUUID();
      const storagePath = `incoming/${phone}/${uuid}.jpg`;

      const { error } = await this.opts.supabase.storage
        .from("alcance-photos")
        .upload(storagePath, buffer, {
          contentType: "image/jpeg",
          upsert: false,
        });

      if (error) {
        log.error("image upload failed", { phone, error: error.message });
        return [];
      }

      // Get a signed URL valid for 24h (Manos turns happen in real-time).
      const { data: signedData } = await this.opts.supabase.storage
        .from("alcance-photos")
        .createSignedUrl(storagePath, 86400);

      if (!signedData?.signedUrl) {
        log.warn("could not get signed URL for image", { phone, storagePath });
        return [];
      }

      log.info("image uploaded", { phone, storagePath });
      return [signedData.signedUrl];
    } catch (e) {
      log.error("handleImageMessage threw", {
        phone,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  private async handleAudioMessage(
    msg: WAMessage,
    phone: string
  ): Promise<string> {
    // On any failure we surface a sentinel "[AUDIO_TRANSCRIPTION_FAILED]"
    // marker to the LLM rather than synthesising a user-facing apology.
    // Previously the WhatsApp client itself sent the apology disguised as
    // the architect's own text, which made it impossible for the LLM to
    // tell "audio failed" apart from "architect literally said that" — so
    // it might still try to set_alcance_ot with garbage. The prompt rule
    // in manos-system.ts ("Errores de medios") binds this sentinel to a
    // recovery script.
    const AUDIO_FAIL_SENTINEL =
      "[AUDIO_TRANSCRIPTION_FAILED] El arquitecto envió una nota de voz pero el sistema no pudo transcribirla.";
    try {
      if (!this.sock) {
        return AUDIO_FAIL_SENTINEL;
      }
      const buffer = await downloadMediaMessage(msg, "buffer", {}, {
        logger: pino({ level: "silent" }) as unknown as pino.Logger,
        reuploadRequest: this.sock.updateMediaMessage,
      }) as Buffer;

      const result = await transcribeAudio(buffer, "audio.ogg");
      if (!result) {
        return AUDIO_FAIL_SENTINEL;
      }

      log.info("audio transcribed", { phone, text_len: result.text.length });
      return `[VOZ transcrita con ${result.provenance}]: ${result.text}`;
    } catch (e) {
      log.error("handleAudioMessage threw", {
        phone,
        error: e instanceof Error ? e.message : String(e),
      });
      return AUDIO_FAIL_SENTINEL;
    }
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0 || cut > limit) cut = Math.min(limit, remaining.length);
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return chunks;
}

export function defaultAuthDir(): string {
  const base = process.env.MANOS_DATA_DIR || path.resolve(process.cwd(), "..", "data");
  return path.join(base, "manos-wa-auth");
}
