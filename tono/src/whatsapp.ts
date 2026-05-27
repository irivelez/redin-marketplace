// Baileys WhatsApp wrapper — handles multi-file auth, QR pairing, reconnect,
// and emits inbound text messages through a handler callback. Concurrency is
// handled by the caller (KeyedMutex); this file just bridges to Baileys.
//
// On pair: we print the QR in the terminal. On success Baileys writes creds
// to the auth dir. Reconnects on non-logout disconnects.

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
import { INPUT_CAPS } from "@redin/tools/schemas";
import { randomUUID } from "node:crypto";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

const log = createLogger("tono:wa");

// Gap A.5/A.6 follow-up — Tono needs to capture inbound media (photos +
// PDFs of ARL/EPS evidence) and pass storage paths to the LLM so it can
// call upload_documento with the right tipo. Mirrors Manos's pattern but
// stores to the `documentos` bucket so the upload_documento tool can
// reference the same path without re-uploading.
const INBOUND_MEDIA_BUCKET = "documentos";

export interface InboundMedia {
  storage_path: string;   // path inside the `documentos` bucket
  signed_url: string;     // 24h signed URL — LLM can preview if needed
  mime: string;
  filename: string;
  caption?: string;       // user's text caption on the media, if any
  kind: "image" | "document";
}

export interface WhatsAppHandlers {
  onMessage: (ev: {
    phone: string;
    text: string;
    jid: string;
    media?: InboundMedia;
  }) => Promise<void>;
  onReady?: () => void | Promise<void>;
}

export interface WhatsAppOptions {
  authDir: string;
  handlers: WhatsAppHandlers;
  // Supabase client for inbound-media uploads. Required when media handling
  // is enabled (always-on in v1).
  supabase: SupabaseClient;
  // If true, print QR to stdout. False in prod (we pair once, creds persist).
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
    // Silence Baileys' internal logger — we have our own structured logger.
    const silentLogger = pino({ level: "silent" });
    // Pull the live WA web version so the handshake is not rejected (HTTP 405)
    // when the version Baileys ships with falls behind WhatsApp's current range.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined as unknown as [number, number, number],
    }));
    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // we handle QR ourselves
      logger: silentLogger as unknown as pino.Logger,
      // mobile=false → standard multi-device (QR scan pairing)
      browser: ["Toño Redin", "Chrome", "1.0"],
      // syncFullHistory false — we only care about new messages
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
      log.info("QR code received — scan with the Toño WhatsApp number (printing to terminal)");
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
          "logged out — delete the auth dir and re-pair with `npm run tono:pair`",
          { authDir: this.opts.authDir }
        );
      }
    }
  }

  private async handleIncoming(msg: WAMessage): Promise<void> {
    if (msg.key.fromMe) return;

    // LID-mode self-loop guard (added 2026-05-26 after credit-exhaustion incident).
    // WhatsApp history-sync can replay the bot's OWN outbound messages back to
    // Baileys with key.fromMe inconsistently set on accounts that use LID (Linked
    // Identity). Without this check, phoneFromJid extracts the bot's own LID as a
    // "user phone" and the bot enters an infinite self-reply loop. Compare
    // remoteJid against the socket's own id + lid, stripping device suffix.
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

    // Inbound dedup. Baileys redelivers the same message on network glitches
    // (m.type='append' after a missed 'notify', or a remote retry from
    // WhatsApp). Without this guard the runner processes the same inbound
    // twice in a row, and the LLM emits a near-identical duplicate reply —
    // observed in Carlos's 2026-05-25 screening where the same Toño message
    // arrived twice 1 second apart. Set is bounded to avoid unbounded growth.
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
    if (!jid || jid.endsWith("@g.us")) return; // skip groups in v1
    const phone = phoneFromJid(jid);
    if (!phone) return;

    const msgContent = msg.message;

    // ---- Image message: download + upload to Storage, pass to handler ----
    // Captures ARL/EPS photos the worker sends after the HR doc-request or
    // Toño proactive followup. The LLM sees `[MEDIA_RECEIVED: …]` injected
    // by agent.ts into the user message and calls upload_documento with
    // the right tipo based on conversation context.
    if (msgContent.imageMessage) {
      const captionRaw = msgContent.imageMessage.caption?.trim() ?? "";
      const caption =
        captionRaw.length > INPUT_CAPS.whatsapp
          ? captionRaw.slice(0, INPUT_CAPS.whatsapp)
          : captionRaw;
      const media = await this.downloadAndStore(msg, phone, {
        ext: "jpg",
        mime: "image/jpeg",
        kind: "image",
      });
      if (media) media.caption = caption;
      const text = caption.length > 0 ? caption : "[foto]";
      await this.opts.handlers.onMessage({
        phone,
        text,
        jid,
        media: media ?? undefined,
      });
      return;
    }

    // ---- Document message (PDF) — same pattern as image ----
    const docMsg =
      msgContent.documentMessage ??
      msgContent.documentWithCaptionMessage?.message?.documentMessage;
    if (docMsg) {
      const captionRaw =
        msgContent.documentWithCaptionMessage?.message?.documentMessage?.caption?.trim() ?? "";
      const caption =
        captionRaw.length > INPUT_CAPS.whatsapp
          ? captionRaw.slice(0, INPUT_CAPS.whatsapp)
          : captionRaw;
      const fileName = docMsg.fileName ?? "documento.pdf";
      const ext = (fileName.split(".").pop() ?? "pdf").toLowerCase();
      const mime = docMsg.mimetype ?? "application/pdf";
      const media = await this.downloadAndStore(msg, phone, {
        ext,
        mime,
        kind: "document",
        filename: fileName,
      });
      if (media) media.caption = caption;
      const text = caption.length > 0 ? caption : `[documento: ${fileName}]`;
      await this.opts.handlers.onMessage({
        phone,
        text,
        jid,
        media: media ?? undefined,
      });
      return;
    }

    // ---- Text message (default) ----
    const text =
      msgContent.conversation ??
      msgContent.extendedTextMessage?.text ??
      "";
    if (!text.trim()) return;
    // PRD §20 cap — truncate before LLM assembly; log internally, no user-visible error.
    let safeText = text;
    if (text.length > INPUT_CAPS.whatsapp) {
      log.warn("inbound message truncated", { phone, original_len: text.length, cap: INPUT_CAPS.whatsapp });
      safeText = text.slice(0, INPUT_CAPS.whatsapp);
    }
    await this.opts.handlers.onMessage({ phone, text: safeText, jid });
  }

  // Downloads inbound media to Supabase Storage under
  // documentos/incoming/<phone>/<uuid>.<ext>. Returns the storage path +
  // 24h signed URL so the LLM can preview if needed AND can re-use the
  // path when calling upload_documento (which accepts a pre-existing
  // storage_path without re-uploading).
  private async downloadAndStore(
    msg: WAMessage,
    phone: string,
    args: { ext: string; mime: string; kind: "image" | "document"; filename?: string }
  ): Promise<InboundMedia | null> {
    try {
      if (!this.sock) {
        log.warn("downloadAndStore: socket not ready", { phone });
        return null;
      }
      const buffer = (await downloadMediaMessage(msg, "buffer", {}, {
        logger: pino({ level: "silent" }) as unknown as pino.Logger,
        reuploadRequest: this.sock.updateMediaMessage,
      })) as Buffer;

      const uuid = randomUUID();
      const cleanExt = args.ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
      const storagePath = `incoming/${phone}/${Date.now()}-${uuid}.${cleanExt}`;
      const filename = args.filename ?? `${uuid}.${cleanExt}`;

      const { error: upErr } = await this.opts.supabase.storage
        .from(INBOUND_MEDIA_BUCKET)
        .upload(storagePath, buffer, {
          contentType: args.mime,
          upsert: false,
        });
      if (upErr) {
        log.error("inbound media upload failed", { phone, error: upErr.message });
        return null;
      }

      const { data: signed } = await this.opts.supabase.storage
        .from(INBOUND_MEDIA_BUCKET)
        .createSignedUrl(storagePath, 86400);
      if (!signed?.signedUrl) {
        log.warn("no signed URL for inbound media", { phone, storagePath });
      }

      log.info("inbound media stored", {
        phone,
        storage_path: storagePath,
        kind: args.kind,
        size_bytes: buffer.length,
      });

      return {
        storage_path: storagePath,
        signed_url: signed?.signedUrl ?? "",
        mime: args.mime,
        filename,
        kind: args.kind,
      };
    } catch (e) {
      log.error("downloadAndStore threw", {
        phone,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
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

// Canonical auth dir for the Toño session. Railway volume mounts to /data in prod;
// locally it lives under the marketplace data/ dir (gitignored).
export function defaultAuthDir(): string {
  const base = process.env.TONO_DATA_DIR || path.resolve(process.cwd(), "..", "data");
  return path.join(base, "tono-wa-auth");
}
