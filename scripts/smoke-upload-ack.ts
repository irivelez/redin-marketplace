// Smoke for the upload_documento acknowledgment contract (2026-06-11).
//
// Runs OFFLINE against a stubbed Supabase — no env, no network, no cleanup.
// Prints the suggested_reply / user_message_hint the LLM will receive for
// each scenario so a human can eyeball voice (Colombian Spanish, tú register).
//
// Usage: npx tsx scripts/smoke-upload-ack.ts

import { uploadDocumento, type ToolContext } from "@redin/tools";
import type { ServerClient } from "@redin/shared";

interface StubConfig {
  tecnicoLookupError?: string;
  recentTipos: string[];
  cedulaCount: number;
  storageUploadError?: string;
}

function makeStubSupabase(cfg: StubConfig): ServerClient {
  const stub = {
    from(table: string) {
      return makeQuery(table, cfg);
    },
    storage: {
      from() {
        return {
          upload: async () => ({
            error: cfg.storageUploadError ? { message: cfg.storageUploadError } : null,
          }),
        };
      },
    },
  };
  return stub as unknown as ServerClient;
}

function makeQuery(table: string, cfg: StubConfig) {
  let isCount = false;
  const q = {
    select(_cols: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.count) isCount = true;
      return q;
    },
    insert() {
      return q;
    },
    eq() {
      return q;
    },
    gte() {
      return q;
    },
    async maybeSingle() {
      if (table === "tecnicos_extended") {
        if (cfg.tecnicoLookupError) {
          return { data: null, error: { message: cfg.tecnicoLookupError } };
        }
        return { data: { tecnico_id: "TEST_SMOKE_T1" }, error: null };
      }
      return { data: null, error: null };
    },
    async single() {
      return { data: { id: `${table}-row-1` }, error: null };
    },
    then(resolve: (v: unknown) => void) {
      if (isCount) {
        resolve({ count: cfg.cedulaCount, data: null, error: null });
        return;
      }
      resolve({ data: cfg.recentTipos.map((tipo) => ({ tipo })), error: null });
    },
  };
  return q;
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeCtx(cfg: StubConfig): ToolContext {
  return {
    supabase: makeStubSupabase(cfg),
    logger: silentLogger as ToolContext["logger"],
    defaultActor: "system",
  };
}

interface Scenario {
  name: string;
  cfg: StubConfig;
  input: Parameters<typeof uploadDocumento>[1];
}

const BASE = {
  tecnico_id: "TEST_SMOKE_T1",
  filename: "foto.jpg",
  storage_path: "incoming/573000000000/x.jpg",
} as const;

const scenarios: Scenario[] = [
  {
    name: "(a) cédula — cara de adelante (1 de 2)",
    cfg: { recentTipos: ["cedula"], cedulaCount: 1 },
    input: { ...BASE, tipo: "cedula" },
  },
  {
    name: "(b) cédula — cara de atrás (2 de 2)",
    cfg: { recentTipos: ["cedula", "cedula"], cedulaCount: 2 },
    input: { ...BASE, tipo: "cedula" },
  },
  {
    name: "(b2) ráfaga sinvaqueva — 4 fotos de cédula en 2s (4ta llamada)",
    cfg: { recentTipos: ["cedula", "cedula", "cedula", "cedula"], cedulaCount: 4 },
    input: { ...BASE, tipo: "cedula" },
  },
  {
    name: "(e) EPS — foto única",
    cfg: { recentTipos: ["evidencia_eps"], cedulaCount: 0 },
    input: { ...BASE, tipo: "evidencia_eps" },
  },
  {
    name: "(f) ráfaga mixta — cédula + EPS en el mismo lote",
    cfg: { recentTipos: ["cedula", "evidencia_eps"], cedulaCount: 1 },
    input: { ...BASE, tipo: "evidencia_eps" },
  },
  {
    name: "(c) falla recuperable — db_error",
    cfg: { recentTipos: [], cedulaCount: 0, tecnicoLookupError: "connection reset" },
    input: { ...BASE, tipo: "cedula" },
  },
  {
    name: "(d) falla de storage — storage_error",
    cfg: { recentTipos: [], cedulaCount: 0, storageUploadError: "bucket unavailable" },
    input: {
      tecnico_id: "TEST_SMOKE_T1",
      tipo: "cedula",
      filename: "foto.jpg",
      content: Buffer.from("fake-bytes"),
      contentType: "image/jpeg",
    },
  },
];

async function main() {
  let fail = 0;
  for (const s of scenarios) {
    const res = await uploadDocumento(makeCtx(s.cfg), s.input);
    console.log(`\n=== ${s.name} ===`);
    if (res.ok) {
      console.log(`  next_action:     ${res.data.next_action}`);
      console.log(`  document_type:   ${res.data.document_type}`);
      console.log(`  suggested_reply: "${res.data.suggested_reply}"`);
      if (!res.data.suggested_reply || !res.data.next_action) fail++;
    } else {
      console.log(`  code:               ${res.code}`);
      console.log(`  suggested_recovery: ${res.suggested_recovery}`);
      console.log(`  user_message_hint:  "${res.user_message_hint}"`);
      if (!res.user_message_hint || !res.suggested_recovery) fail++;
    }
  }
  console.log(fail === 0 ? "\nALL SCENARIOS SHAPED OK" : `\n${fail} SCENARIO(S) MISSING FIELDS`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
