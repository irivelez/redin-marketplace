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
import {
  createLogger,
  phoneFromJid,
  transcribeAudio,
  type TranscribeResult,
} from "@redin/shared";
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

// A media item the worker sent that we could NOT ingest (download from WA
// failed, the Storage upload failed, or — for voice notes — Groq Whisper
// could not produce a transcript). Surfaced to the agent so the LLM turn
// knows a photo/voice note was attempted — the delivery layer has ALREADY
// sent the user-facing "reenvíamela" fallback by the time this reaches the
// handler.
export interface InboundMediaFailure {
  kind: "image" | "document" | "voice";
  reason: "download" | "storage" | "transcription";
}

type MediaResult = InboundMedia | { failed: true; reason: "download" | "storage" };

export interface WhatsAppHandlers {
  onMessage: (ev: {
    phone: string;
    text: string;
    jid: string;
    media?: InboundMedia[];
    media_failures?: InboundMediaFailure[];
    // Voice-note transcripts (Groq Whisper port from Manos, 2026-06-11).
    // agent.ts wraps each one in <data source="tecnico_voice_transcript">
    // before it reaches the LLM — same injection defense as typed text.
    voice_transcripts?: string[];
  }) => Promise<void>;
  onReady?: () => void | Promise<void>;
}

// Per-phone batching buffer (see handleIncoming / flushBatch).
// Baileys delivers each photo as a separate `messages.upsert`. Without
// batching, sending N photos = N parallel LLM turns and only the first
// reply ships. We accumulate consecutive messages from the same sender
// inside an idle debounce window and emit ONE onMessage with the joined
// text + media[]. Two timers: `idleTimer` resets on each new message
// (typical "user is still attaching stuff" case), `maxAgeTimer` is set
// once on the first message of the batch and forces a flush even if the
// user keeps trickling files (anti-starvation).
interface PendingBatch {
  jid: string;
  texts: string[];
  medias: InboundMedia[];
  mediaFailures: InboundMediaFailure[];
  voiceTranscripts: string[];
  idleTimer: NodeJS.Timeout;
  maxAgeTimer: NodeJS.Timeout;
  firstAt: number;
}

const BATCH_IDLE_MS = 2000;
const BATCH_MAX_AGE_MS = 8000;

// S12: secondary text-dedup window. WhatsApp sometimes retransmits the same
// text with a FRESH message id (observed across 4 sessions: May25-Carlos,
// May28-juanpablo, May28-irina-tono, May28-julian), so the seenMessageIds
// primary dedup misses it. Same phone + identical text within this window
// is treated as a retransmission and dropped. Text-only; media is exempt.
const TEXT_RETRANSMIT_WINDOW_MS = 3000;

export interface WhatsAppOptions {
  authDir: string;
  handlers: WhatsAppHandlers;
  // Supabase client for inbound-media uploads. Required when media handling
  // is enabled (always-on in v1).
  supabase: SupabaseClient;
  // If true, print QR to stdout. False in prod (we pair once, creds persist).
  printQr?: boolean;
  // TEST SEAMS (scripts/smoke-voice-input.ts) — production leaves both unset:
  // transcriber defaults to shared transcribeAudio (Groq Whisper),
  // audioDownloader defaults to Baileys downloadMediaMessage.
  transcriber?: (
    bytes: Buffer,
    filename?: string
  ) => Promise<TranscribeResult | null>;
  audioDownloader?: (msg: WAMessage) => Promise<Buffer>;
}

// Voice input flag — direct rollout, "off" is the instant revert switch
// (restores pre-port behavior: audio messages silently ignored).
function voiceInputEnabled(): boolean {
  const v = (process.env.TONO_VOICE_INPUT ?? "").toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private reconnecting = false;
  private seenMessageIds = new Set<string>();
  private pending = new Map<string, PendingBatch>();
  // S12 belt-and-suspenders dedup (see TEXT_RETRANSMIT_WINDOW_MS). One entry
  // per phone, overwritten on every accepted text — bounded below at 500.
  private recentTextByPhone = new Map<string, { text: string; at: number }>();

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
    // Best-effort flush so in-flight batches don't get silently dropped on
    // shutdown. Flush THEN clear timers (flushBatch already clears its own
    // timers), but defensively walk remaining entries too in case flushBatch
    // throws synchronously before clearing.
    for (const phone of Array.from(this.pending.keys())) {
      try {
        this.flushBatch(phone);
      } catch (e) {
        log.error("flushBatch on stop failed", { phone, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.idleTimer);
      clearTimeout(entry.maxAgeTimer);
    }
    this.pending.clear();
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
      // Best-effort: drain pending batches before tearing down. If we don't,
      // any photo/text accumulated in the last ≤2s of debounce window dies
      // with the socket and the user gets no reply at all on next reconnect.
      for (const phone of Array.from(this.pending.keys())) {
        try {
          this.flushBatch(phone);
        } catch (e) {
          log.error("flushBatch on disconnect failed", { phone, error: e instanceof Error ? e.message : String(e) });
        }
      }
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
      const result = await this.downloadAndStore(msg, phone, {
        ext: "jpg",
        mime: "image/jpeg",
        kind: "image",
      });
      const text = caption.length > 0 ? caption : "[foto]";
      log.info("inbound", {
        phone,
        msgId,
        text_preview: text.slice(0, 60),
        dedup_decision: "media_exempt",
      });
      if ("failed" in result) {
        await this.notifyMediaFailure(jid, "image");
        this.enqueue(phone, jid, text, null, { kind: "image", reason: result.reason });
        return;
      }
      result.caption = caption;
      this.enqueue(phone, jid, text, result);
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
      const result = await this.downloadAndStore(msg, phone, {
        ext,
        mime,
        kind: "document",
        filename: fileName,
      });
      const text = caption.length > 0 ? caption : `[documento: ${fileName}]`;
      log.info("inbound", {
        phone,
        msgId,
        text_preview: text.slice(0, 60),
        dedup_decision: "media_exempt",
      });
      if ("failed" in result) {
        await this.notifyMediaFailure(jid, "document");
        this.enqueue(phone, jid, text, null, { kind: "document", reason: result.reason });
        return;
      }
      result.caption = caption;
      this.enqueue(phone, jid, text, result);
      return;
    }

    // ---- Audio message (voice note or regular audio): transcribe ----
    // Groq Whisper port from Manos (2026-06-11). Transcript travels as a
    // separate batch field (NOT as text) so agent.ts can wrap it in
    // <data source="tecnico_voice_transcript">. Voice is exempt from the S12
    // recentTextByPhone dedup by construction — this branch never touches it.
    if (msgContent.audioMessage) {
      if (!voiceInputEnabled()) {
        log.info("voice note ignored (TONO_VOICE_INPUT off)", { phone, msgId });
        return;
      }
      log.info("inbound", {
        phone,
        msgId,
        text_preview: "[nota de voz]",
        dedup_decision: "media_exempt",
      });
      const outcome = await this.transcribeVoiceNote(msg, phone);
      if ("failed" in outcome) {
        await this.notifyMediaFailure(jid, "voice");
        this.enqueue(phone, jid, "[nota de voz]", null, {
          kind: "voice",
          reason: outcome.reason,
        });
        return;
      }
      this.enqueue(phone, jid, "[nota de voz]", null, undefined, outcome.text);
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

    const now = Date.now();
    const last = this.recentTextByPhone.get(phone);
    const isRetransmission =
      last !== undefined &&
      last.text === safeText &&
      now - last.at < TEXT_RETRANSMIT_WINDOW_MS;
    log.info("inbound", {
      phone,
      msgId,
      text_preview: safeText.slice(0, 60),
      dedup_decision: isRetransmission ? "dropped_retransmission" : "enqueued",
    });
    if (isRetransmission) {
      log.warn("dropped likely retransmission (phone+text+3s)", {
        phone,
        msgId,
        text_preview: safeText.slice(0, 60),
      });
      return;
    }
    this.recentTextByPhone.set(phone, { text: safeText, at: now });
    if (this.recentTextByPhone.size > 500) {
      const oldest = this.recentTextByPhone.keys().next().value;
      if (oldest !== undefined) this.recentTextByPhone.delete(oldest);
    }
    this.enqueue(phone, jid, safeText, null);
  }

  // Push a single processed message (text + optional media) into the
  // per-phone batch. Idle timer is reset on each call; max-age timer is
  // armed exactly once when the batch is created. Both timers call
  // flushBatch, which is idempotent w.r.t. the entry being gone (it just
  // returns early). Note: we accept null media (text-only) but text-only
  // messages with empty text were already rejected by the caller.
  private enqueue(
    phone: string,
    jid: string,
    text: string,
    media: InboundMedia | null,
    mediaFailure?: InboundMediaFailure,
    voiceTranscript?: string
  ): void {
    let entry = this.pending.get(phone);
    if (!entry) {
      const now = Date.now();
      const idleTimer = setTimeout(() => this.flushBatch(phone), BATCH_IDLE_MS);
      const maxAgeTimer = setTimeout(() => this.flushBatch(phone), BATCH_MAX_AGE_MS);
      entry = {
        jid,
        texts: [],
        medias: [],
        mediaFailures: [],
        voiceTranscripts: [],
        idleTimer,
        maxAgeTimer,
        firstAt: now,
      };
      this.pending.set(phone, entry);
    } else {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => this.flushBatch(phone), BATCH_IDLE_MS);
    }
    if (text.length > 0) entry.texts.push(text);
    if (media) entry.medias.push(media);
    if (mediaFailure) entry.mediaFailures.push(mediaFailure);
    if (voiceTranscript) entry.voiceTranscripts.push(voiceTranscript);
  }

  // Drain the per-phone batch into a single onMessage call. MUST clear
  // timers and remove the map entry BEFORE awaiting onMessage so that:
  //  (a) a second flush triggered by the other timer is a no-op, and
  //  (b) any new message arriving while onMessage is in-flight starts a
  //      fresh batch with its own timers (caller's KeyedMutex serializes
  //      the resulting LLM turns per-phone).
  private flushBatch(phone: string): void {
    const entry = this.pending.get(phone);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.maxAgeTimer);
    this.pending.delete(phone);
    if (
      entry.texts.length === 0 &&
      entry.medias.length === 0 &&
      entry.mediaFailures.length === 0 &&
      entry.voiceTranscripts.length === 0
    ) {
      return;
    }
    const joinedText = entry.texts.join("\n");
    this.opts.handlers
      .onMessage({
        phone,
        text: joinedText,
        jid: entry.jid,
        media: entry.medias.length > 0 ? entry.medias : undefined,
        media_failures:
          entry.mediaFailures.length > 0 ? entry.mediaFailures : undefined,
        voice_transcripts:
          entry.voiceTranscripts.length > 0 ? entry.voiceTranscripts : undefined,
      })
      .catch((e) => {
        log.error("batched onMessage failed", {
          phone,
          error: e instanceof Error ? e.message : String(e),
          texts: entry.texts.length,
          medias: entry.medias.length,
        });
      });
  }

  // Downloads inbound media to Supabase Storage under
  // documentos/incoming/<phone>/<uuid>.<ext>. Returns the storage path +
  // 24h signed URL so the LLM can preview if needed AND can re-use the
  // path when calling upload_documento (which accepts a pre-existing
  // storage_path without re-uploading).
  // Sends the delivery-layer fallback when a photo/PDF could not be ingested.
  // Deliberately does NOT wait for the LLM turn: the worker must hear "resend
  // it" within seconds, not after a 10-20s agent round-trip (May25-Carlos
  // re-send regression).
  private async notifyMediaFailure(
    jid: string,
    kind: "image" | "document" | "voice"
  ): Promise<void> {
    const body =
      kind === "image"
        ? "Hubo un problema recibiendo la última foto, ¿me la puedes reenviar por favor?"
        : kind === "document"
          ? "Hubo un problema recibiendo el último archivo, ¿me lo puedes reenviar por favor?"
          : "Hubo un problema con la nota de voz, ¿me la puedes mandar de nuevo o escribirla por acá?";
    try {
      await this.sendText(jid, body);
    } catch (e) {
      log.error("media-failure fallback send failed", {
        jid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async downloadAndStore(
    msg: WAMessage,
    phone: string,
    args: { ext: string; mime: string; kind: "image" | "document"; filename?: string }
  ): Promise<MediaResult> {
    let buffer: Buffer;
    try {
      if (!this.sock) {
        log.warn("downloadAndStore: socket not ready", { phone });
        return { failed: true, reason: "download" };
      }
      buffer = (await downloadMediaMessage(msg, "buffer", {}, {
        logger: pino({ level: "silent" }) as unknown as pino.Logger,
        reuploadRequest: this.sock.updateMediaMessage,
      })) as Buffer;
    } catch (e) {
      log.error("downloadAndStore: media download threw", {
        phone,
        error: e instanceof Error ? e.message : String(e),
      });
      return { failed: true, reason: "download" };
    }
    try {
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
        return { failed: true, reason: "storage" };
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
      return { failed: true, reason: "storage" };
    }
  }

  // Mirrors manos/src/whatsapp.ts handleAudioMessage, adapted to Toño's
  // batch + media-failure shape. Audio bytes are transcribed in-memory and
  // never stored (no PII at rest beyond the transcript in the session log).
  private async transcribeVoiceNote(
    msg: WAMessage,
    phone: string
  ): Promise<{ text: string } | { failed: true; reason: "download" | "transcription" }> {
    let buffer: Buffer;
    try {
      if (this.opts.audioDownloader) {
        buffer = await this.opts.audioDownloader(msg);
      } else {
        if (!this.sock) {
          log.warn("transcribeVoiceNote: socket not ready", { phone });
          return { failed: true, reason: "download" };
        }
        buffer = (await downloadMediaMessage(msg, "buffer", {}, {
          logger: pino({ level: "silent" }) as unknown as pino.Logger,
          reuploadRequest: this.sock.updateMediaMessage,
        })) as Buffer;
      }
    } catch (e) {
      log.error("voice note download threw", {
        phone,
        error: e instanceof Error ? e.message : String(e),
      });
      return { failed: true, reason: "download" };
    }
    try {
      const transcribe = this.opts.transcriber ?? transcribeAudio;
      const result = await transcribe(buffer, "audio.ogg");
      if (!result || result.text.trim().length === 0) {
        return { failed: true, reason: "transcription" };
      }
      let text = result.text;
      if (text.length > INPUT_CAPS.whatsapp) {
        log.warn("voice transcript truncated", {
          phone,
          original_len: text.length,
          cap: INPUT_CAPS.whatsapp,
        });
        text = text.slice(0, INPUT_CAPS.whatsapp);
      }
      log.info("voice note transcribed", { phone, text_len: text.length });
      return { text };
    } catch (e) {
      log.error("voice transcription threw", {
        phone,
        error: e instanceof Error ? e.message : String(e),
      });
      return { failed: true, reason: "transcription" };
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
