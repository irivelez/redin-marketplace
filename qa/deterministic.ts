/**
 * qa/deterministic.ts — Layer 1 checks for the S07 eval harness.
 *
 * Mostly pure. Takes a Seed + the InjectResult array from the conversation
 * and returns a structured pass/fail with evidence. Stream A added DB-state
 * assertions that need a Supabase read AFTER the conversation finishes;
 * those live in `deterministicCheckWithDbState` (the runner calls that
 * variant when the seed declares any of expected_db_state, expected_dossier,
 * expected_eventos).
 *
 * Checks (in order):
 *   1. Tool sequence  — must_be_first, args_contain, result_code,
 *                       must_NOT_be_called
 *   2. Response assertions — contains / does_not_contain / cedula / regex
 *   3. Refusal check  — if expected_refusal, eventos must contain "refused"
 *                        with policy_line
 *   4. Escalation check — if expected_escalation, escalate_to_hr must appear
 *                          in tool calls (and reason matches when given)
 *   5. Grounding check — digit sequences in reply must appear in any tool
 *                         result of the same turn
 *   6. (Stream A, async) DB state — candidate_state, profile_complete, cedula
 *                                    presence, withdrawal_reason, etc.
 *   7. (Stream A, async) Dossier — candidate_dossiers row written + recommendation
 *                                   triplet sanity
 *   8. (Stream A, async) Eventos — required types + meta partial-match
 */

import type { ServerClient } from "@redin/shared";
import type { DBFixture, Seed } from "./seeds/schema.js";
import type { InjectResult } from "./inject.js";

// Fixtures that pre-create an approved técnico whose row.phone === testPhone.
// For these seeds the identity gate (tono/src/agent.ts) pre-resolves
// session.tecnico_id BEFORE the first LLM turn, the agent enters
// routingMode="returning"/"enrichment", and identify_user is correctly skipped
// because identity is already known — see router.ts:240-254 Rule 1b. The
// "sister phone" fixtures (legacy_incomplete_sister_phone, screening/
// withdrawn/pending_with_cedula) seed onto a DIFFERENT phone, so testPhone is
// fresh and identify_user is still required.
const PRE_IDENTIFIED_FIXTURES: ReadonlySet<DBFixture> = new Set<DBFixture>([
  "tecnico_registered_bogota_electrico",
  "tecnico_registered_cali_plomero",
  "tecnico_with_pending_postulacion",
  "tecnico_with_signed_contract",
  "tecnico_legacy_approved_incomplete",
  "tecnico_legacy_approved_complete",
]);

function sessionStartsIdentified(seed: Seed): boolean {
  return seed.db_fixtures.some((f) => PRE_IDENTIFIED_FIXTURES.has(f));
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DeterministicFailure {
  assertion: string;
  expected: string;
  observed: string;
  evidence: string;
}

export interface DeterministicResult {
  seed_name: string;
  passed: boolean;
  failures: DeterministicFailure[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allToolCalls(
  turns: InjectResult[]
): { name: string; args: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string; code?: string } }[] {
  return turns.flatMap((t) => t.toolCallsMade);
}

function allReplies(turns: InjectResult[]): string {
  return turns
    .map((t) => t.reply)
    .filter(Boolean)
    .join("\n");
}

function lastReply(turns: InjectResult[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const r = turns[i];
    if (r !== undefined && r.reply) return r.reply;
  }
  return "";
}

/** Extract all digit sequences of ≥4 chars from a string.
 * 4+ avoids false positives from short references (OT-001, ordinals, years).
 * Specific facts like tecnico_ids (000006) or amounts (12500) are ≥4 digits. */
function digitSequences(s: string): string[] {
  return (s.match(/\d{4,}/g) ?? []);
}

/** Deep-partial match: does `actual` contain all key/values from `expected`?
 *
 * String matching is a case-insensitive substring check so seeds can assert
 * partial values (e.g. nombre:"Juan" matches actual "Juan Rodríguez").
 * Array matching checks that every expected element appears in actual.
 */
function argsContain(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const av = actual[k];
    if (Array.isArray(v) && Array.isArray(av)) {
      // Each expected element must appear in actual (case-insensitive substring).
      const avStr = av.map((x) => String(x).toLowerCase());
      const ok = (v as unknown[]).every((e) =>
        avStr.some((a) => a.includes(String(e).toLowerCase()))
      );
      if (!ok) return false;
    } else if (typeof v === "string") {
      // Substring match: actual must contain the expected string (case-insensitive).
      if (!String(av).toLowerCase().includes(v.toLowerCase())) return false;
    } else if (String(av).toLowerCase() !== String(v).toLowerCase()) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Check: tool sequence
// ---------------------------------------------------------------------------

function checkToolSequence(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  const failures: DeterministicFailure[] = [];
  const calls = allToolCalls(turns);
  const callNames = calls.map((c) => c.name);

  // Drop stale `identify_user must_be_first` for pre-identified sessions —
  // see PRE_IDENTIFIED_FIXTURES comment at top of file.
  const effectiveAssertions = sessionStartsIdentified(seed)
    ? seed.expected_tool_calls.filter(
        (a) => !(a.tool === "identify_user" && a.must_be_first === true)
      )
    : seed.expected_tool_calls;

  for (const assertion of effectiveAssertions) {
    // must_NOT_be_called
    if (assertion.must_NOT_be_called === true) {
      if (callNames.includes(assertion.tool)) {
        failures.push({
          assertion: `tool.must_NOT_be_called`,
          expected: `${assertion.tool} must NOT be called`,
          observed: `${assertion.tool} was called`,
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      }
      continue; // no further checks for this assertion
    }

    // must_be_first
    if (assertion.must_be_first === true) {
      const firstCall = calls[0];
      if (!firstCall || firstCall.name !== assertion.tool) {
        failures.push({
          assertion: `tool.must_be_first`,
          expected: `${assertion.tool} must be first call`,
          observed: firstCall ? `first call was ${firstCall.name}` : "no tool calls made",
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      }
    }

    // args_contain
    if (assertion.args_contain) {
      const matchingCall = calls.find((c) => c.name === assertion.tool);
      if (!matchingCall) {
        failures.push({
          assertion: `tool.args_contain`,
          expected: `${assertion.tool} called with args ${JSON.stringify(assertion.args_contain)}`,
          observed: `${assertion.tool} was never called`,
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      } else if (!argsContain(matchingCall.args, assertion.args_contain)) {
        failures.push({
          assertion: `tool.args_contain`,
          expected: `${assertion.tool} args contain ${JSON.stringify(assertion.args_contain)}`,
          observed: JSON.stringify(matchingCall.args),
          evidence: `tool: ${assertion.tool}`,
        });
      }
    }

    // result_code — assert the FIRST call to this tool returned the expected
    // typed outcome code (e.g. submit_candidate_dossier -> "submitted").
    if (assertion.result_code !== undefined) {
      const matchingCall = calls.find((c) => c.name === assertion.tool);
      if (!matchingCall) {
        failures.push({
          assertion: `tool.result_code`,
          expected: `${assertion.tool} called with result code "${assertion.result_code}"`,
          observed: `${assertion.tool} was never called`,
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      } else {
        const r = matchingCall.result;
        const observedCode = r.ok
          ? (r.data as { code?: string } | null)?.code ?? "(ok, no code)"
          : r.code ?? "(no code)";
        if (observedCode !== assertion.result_code) {
          failures.push({
            assertion: `tool.result_code`,
            expected: `${assertion.tool} result.code === "${assertion.result_code}"`,
            observed: `result.code === "${observedCode}"`,
            evidence: JSON.stringify(matchingCall.result).slice(0, 200),
          });
        }
      }
    }

    // Tool must exist in calls (if no other flag set but tool is listed)
    if (
      !assertion.must_be_first &&
      !assertion.args_contain &&
      !assertion.result_code &&
      !assertion.must_NOT_be_called
    ) {
      if (!callNames.includes(assertion.tool)) {
        failures.push({
          assertion: `tool.called`,
          expected: `${assertion.tool} must be called`,
          observed: "not called",
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: response assertions
// ---------------------------------------------------------------------------

function checkResponseAssertions(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  const failures: DeterministicFailure[] = [];
  const last = lastReply(turns);
  const all = allReplies(turns);

  for (const assertion of seed.expected_assertions) {
    if (assertion.response_contains !== undefined) {
      // Check all replies — case-insensitive so seed authors don't need to match
      // exact capitalisation (e.g. "depende" matches "Depende").
      if (!all.toLowerCase().includes(assertion.response_contains.toLowerCase())) {
        failures.push({
          assertion: "response_contains",
          expected: `any reply contains "${assertion.response_contains}"`,
          observed: last.slice(0, 200),
          evidence: `all replies length: ${all.length}`,
        });
      }
    }

    if (assertion.response_does_not_contain !== undefined) {
      // Check ALL replies (not just last) — a leaked value in any turn is a failure.
      if (all.toLowerCase().includes(assertion.response_does_not_contain.toLowerCase())) {
        failures.push({
          assertion: "response_does_not_contain",
          expected: `reply does NOT contain "${assertion.response_does_not_contain}"`,
          observed: `found in replies`,
          evidence: all.slice(0, 300),
        });
      }
    }

    if (assertion.response_does_not_contain_cedula === true) {
      // Match 6–12 digit sequences that look like cédulas.
      const cedulaPattern = /\b\d{6,12}\b/g;
      if (cedulaPattern.test(all)) {
        const matches = all.match(/\b\d{6,12}\b/g) ?? [];
        failures.push({
          assertion: "response_does_not_contain_cedula",
          expected: "reply must NOT contain cédula-like digit sequences",
          observed: `found: [${matches.slice(0, 5).join(", ")}]`,
          evidence: all.slice(0, 300),
        });
      }
    }

    if (assertion.response_matches_regex !== undefined) {
      const re = new RegExp(assertion.response_matches_regex);
      if (!re.test(last)) {
        failures.push({
          assertion: "response_matches_regex",
          expected: `reply matches /${assertion.response_matches_regex}/`,
          observed: last.slice(0, 200),
          evidence: `last reply length: ${last.length}`,
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: refusal
// ---------------------------------------------------------------------------

function checkRefusal(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  if (!seed.expected_refusal) return [];

  const failures: DeterministicFailure[] = [];
  const { policy_line, must_log_eventos_refused } = seed.expected_refusal;

  if (must_log_eventos_refused) {
    const allEvents = turns.flatMap((t) => t.eventosWritten);
    const refusedEvent = allEvents.find(
      (e) =>
        e.type === "refused" &&
        (e.meta["policy_line"] === policy_line ||
          e.meta["policy_line"] === String(policy_line))
    );

    if (!refusedEvent) {
      const observedTypes = allEvents.map((e) => e.type);
      failures.push({
        assertion: "expected_refusal.eventos_refused",
        expected: `eventos must contain type="refused" with policy_line=${policy_line}`,
        observed: `eventos: [${observedTypes.join(", ")}]`,
        evidence: JSON.stringify(allEvents.slice(0, 5)),
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: escalation
// ---------------------------------------------------------------------------

function checkEscalation(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  if (!seed.expected_escalation) return [];

  const failures: DeterministicFailure[] = [];
  const { must_call_escalate_to_hr, reason } = seed.expected_escalation;

  if (must_call_escalate_to_hr) {
    const calls = allToolCalls(turns);
    const escalations = calls.filter((c) => c.name === "escalate_to_hr");
    if (escalations.length === 0) {
      failures.push({
        assertion: "expected_escalation.must_call_escalate_to_hr",
        expected: "escalate_to_hr must be called",
        observed: `tool calls: [${calls.map((c) => c.name).join(", ")}]`,
        evidence: "no escalate_to_hr in tool trace",
      });
    } else if (reason !== undefined) {
      // Match the assertion's reason against the tool's args.reason as a
      // case-insensitive substring (Tono may phrase it slightly differently
      // turn-to-turn).
      const matched = escalations.some((c) => {
        const r = (c.args as { reason?: unknown } | undefined)?.reason;
        return typeof r === "string" && r.toLowerCase().includes(reason.toLowerCase());
      });
      if (!matched) {
        failures.push({
          assertion: "expected_escalation.reason",
          expected: `escalate_to_hr called with reason containing "${reason}"`,
          observed: escalations
            .map((c) => `reason="${(c.args as { reason?: unknown }).reason}"`)
            .join(" | "),
          evidence: "no escalate_to_hr call had the expected reason substring",
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: cédula echo (universal — fires when testCedula is provided)
// ---------------------------------------------------------------------------
//
// The per-seed `response_does_not_contain_cedula` heuristic catches any 6–12
// digit sequence but false-positives on phone numbers and OT IDs. This check
// is narrow: it asserts the EXACT testCedula assigned to this run does not
// leak into any "Toño:" reply, including obfuscated forms ("99-12-34-567",
// "99.12.34.567", "99 12 34 567"). Normalize by stripping non-digits before
// substring match so the bypass cases are caught too.
function checkCedulaEcho(
  turns: InjectResult[],
  testCedula: string | undefined
): DeterministicFailure[] {
  if (!testCedula) return [];
  const failures: DeterministicFailure[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t === undefined || !t.reply) continue;
    const digitsOnly = t.reply.replace(/\D+/g, "");
    if (digitsOnly.includes(testCedula)) {
      failures.push({
        assertion: "no_cedula_echo",
        expected: `reply must NOT contain the test cédula (${testCedula}) in any digit form`,
        observed: `cédula digit sequence found in turn ${i} reply (after stripping non-digits)`,
        evidence: t.reply.slice(0, 300),
      });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Check: grounding (loose digit-overlap heuristic)
// ---------------------------------------------------------------------------

function checkGrounding(turns: InjectResult[]): DeterministicFailure[] {
  const failures: DeterministicFailure[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    if (turn.toolCallsMade.length === 0) continue;

    const reply = turn.reply;
    const replyDigits = digitSequences(reply);
    if (replyDigits.length === 0) continue; // no specific numbers to verify

    // Check digit overlap against ALL tool results in this turn (not just last).
    // A digit that appears in any tool result is considered grounded — the agent
    // may legitimately surface a value from an earlier call in the same turn.
    const lastTool = turn.toolCallsMade[turn.toolCallsMade.length - 1];
    if (lastTool === undefined) continue;

    const allResultsStr = turn.toolCallsMade
      .map((t) => JSON.stringify(t.result))
      .join(" ");
    const ungrounded = replyDigits.filter((d) => !allResultsStr.includes(d));

    if (ungrounded.length > 0) {
      failures.push({
        assertion: "grounding.digit_overlap",
        expected: `digit sequences in reply appear in tool results`,
        observed: `ungrounded digits: [${ungrounded.join(", ")}]`,
        evidence: `turn ${i}, tool: ${lastTool.name}, reply excerpt: ${reply.slice(0, 150)}`,
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function deterministicCheck(
  seed: Seed,
  turns: InjectResult[],
  testCedula?: string
): DeterministicResult {
  const failures: DeterministicFailure[] = [
    ...checkToolSequence(seed, turns),
    ...checkResponseAssertions(seed, turns),
    ...checkRefusal(seed, turns),
    ...checkEscalation(seed, turns),
    ...checkCedulaEcho(turns, testCedula),
    ...checkGrounding(turns),
  ];

  return {
    seed_name: seed.name,
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Stream A — async DB state checks (require Supabase reads)
// ---------------------------------------------------------------------------

/** Deep-partial match for eventos meta. Same semantics as argsContain. */
function metaContains(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  return argsContain(actual, expected);
}

async function checkDbState(
  seed: Seed,
  testPhone: string,
  turnStart: Date,
  supabase: ServerClient
): Promise<DeterministicFailure[]> {
  if (!seed.expected_db_state) return [];

  const failures: DeterministicFailure[] = [];
  const exp = seed.expected_db_state;

  const { data: row, error } = await supabase
    .from("tecnicos_extended")
    .select(
      "tecnico_id, candidate_state, profile_complete, cedula, withdrawal_reason, import_source, enrichment_data"
    )
    .eq("phone", testPhone)
    .maybeSingle();
  if (error) {
    failures.push({
      assertion: "expected_db_state.read",
      expected: "tecnicos_extended row readable",
      observed: error.message,
      evidence: `phone=${testPhone}`,
    });
    return failures;
  }
  if (!row) {
    failures.push({
      assertion: "expected_db_state.row_exists",
      expected: "tecnicos_extended row should exist for testPhone",
      observed: "no row found",
      evidence: `phone=${testPhone}`,
    });
    return failures;
  }

  if (exp.candidate_state !== undefined && row.candidate_state !== exp.candidate_state) {
    failures.push({
      assertion: "expected_db_state.candidate_state",
      expected: exp.candidate_state,
      observed: String(row.candidate_state),
      evidence: `phone=${testPhone}`,
    });
  }
  if (exp.profile_complete !== undefined && row.profile_complete !== exp.profile_complete) {
    failures.push({
      assertion: "expected_db_state.profile_complete",
      expected: String(exp.profile_complete),
      observed: String(row.profile_complete),
      evidence: `phone=${testPhone}`,
    });
  }
  if (exp.cedula_present !== undefined) {
    const present = row.cedula !== null && row.cedula !== undefined;
    if (present !== exp.cedula_present) {
      failures.push({
        assertion: "expected_db_state.cedula_present",
        expected: String(exp.cedula_present),
        observed: present ? "cedula set" : "cedula NULL",
        evidence: `phone=${testPhone}`,
      });
    }
  }
  if (exp.withdrawal_reason !== undefined && row.withdrawal_reason !== exp.withdrawal_reason) {
    failures.push({
      assertion: "expected_db_state.withdrawal_reason",
      expected: exp.withdrawal_reason,
      observed: String(row.withdrawal_reason),
      evidence: `phone=${testPhone}`,
    });
  }
  if (exp.import_source !== undefined && row.import_source !== exp.import_source) {
    failures.push({
      assertion: "expected_db_state.import_source",
      expected: exp.import_source,
      observed: String(row.import_source),
      evidence: `phone=${testPhone}`,
    });
  }
  if (exp.enrichment_data_has_keys !== undefined) {
    const data =
      row.enrichment_data && typeof row.enrichment_data === "object"
        ? (row.enrichment_data as Record<string, unknown>)
        : null;
    const present = data ? Object.keys(data) : [];
    const missing = exp.enrichment_data_has_keys.filter((k) => !present.includes(k));
    if (missing.length > 0) {
      failures.push({
        assertion: "expected_db_state.enrichment_data_has_keys",
        expected: `keys [${exp.enrichment_data_has_keys.join(", ")}]`,
        observed: `keys [${present.join(", ")}]`,
        evidence: `missing: [${missing.join(", ")}]`,
      });
    }
  }

  return failures;
  // turnStart is unused for db_state but kept in signature for symmetry with
  // checkEventosWritten / checkDossierWritten which DO need a time floor.
  void turnStart;
}

async function checkDossierWritten(
  seed: Seed,
  testPhone: string,
  turnStart: Date,
  supabase: ServerClient
): Promise<DeterministicFailure[]> {
  if (!seed.expected_dossier) return [];

  const failures: DeterministicFailure[] = [];
  const exp = seed.expected_dossier;

  const { data: tec } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("phone", testPhone)
    .maybeSingle();
  const tecnicoId = tec?.tecnico_id;

  if (!tecnicoId) {
    if (exp.must_be_written) {
      failures.push({
        assertion: "expected_dossier.tecnico_id",
        expected: "row in tecnicos_extended for testPhone",
        observed: "no row",
        evidence: `phone=${testPhone}`,
      });
    }
    return failures;
  }

  const { data: dossiers, error } = await supabase
    .from("candidate_dossiers")
    .select("id, tono_recommendation, tono_confidence, tono_reasoning, created_at")
    .eq("tecnico_id", tecnicoId)
    .gte("created_at", turnStart.toISOString())
    .order("created_at", { ascending: false });
  if (error) {
    failures.push({
      assertion: "expected_dossier.read",
      expected: "candidate_dossiers readable",
      observed: error.message,
      evidence: `tecnico_id=${tecnicoId}`,
    });
    return failures;
  }

  if (exp.must_be_written) {
    if (!dossiers || dossiers.length === 0) {
      failures.push({
        assertion: "expected_dossier.must_be_written",
        expected: "at least one candidate_dossiers row inserted during conversation",
        observed: "no rows",
        evidence: `tecnico_id=${tecnicoId}`,
      });
      return failures;
    }
    const latest = dossiers[0]!;
    if (
      exp.tono_recommendation_in &&
      !exp.tono_recommendation_in.includes(latest.tono_recommendation as never)
    ) {
      failures.push({
        assertion: "expected_dossier.tono_recommendation_in",
        expected: `one of [${exp.tono_recommendation_in.join(", ")}]`,
        observed: String(latest.tono_recommendation),
        evidence: `dossier_id=${latest.id}`,
      });
    }
    if (
      exp.tono_confidence_min !== undefined &&
      Number(latest.tono_confidence) < exp.tono_confidence_min
    ) {
      failures.push({
        assertion: "expected_dossier.tono_confidence_min",
        expected: `>= ${exp.tono_confidence_min}`,
        observed: String(latest.tono_confidence),
        evidence: `dossier_id=${latest.id}`,
      });
    }
    if (
      exp.tono_reasoning_min_length !== undefined &&
      String(latest.tono_reasoning ?? "").length < exp.tono_reasoning_min_length
    ) {
      failures.push({
        assertion: "expected_dossier.tono_reasoning_min_length",
        expected: `>= ${exp.tono_reasoning_min_length} chars`,
        observed: `${String(latest.tono_reasoning ?? "").length} chars`,
        evidence: `dossier_id=${latest.id}`,
      });
    }
  } else {
    if (dossiers && dossiers.length > 0) {
      failures.push({
        assertion: "expected_dossier.must_be_written=false",
        expected: "no candidate_dossiers row written",
        observed: `${dossiers.length} row(s) found`,
        evidence: `tecnico_id=${tecnicoId}`,
      });
    }
  }

  return failures;
}

async function checkEventosWritten(
  seed: Seed,
  testPhone: string,
  turnStart: Date,
  supabase: ServerClient
): Promise<DeterministicFailure[]> {
  if (!seed.expected_eventos || seed.expected_eventos.length === 0) return [];

  const failures: DeterministicFailure[] = [];

  // Pull all eventos written since turnStart for either entity_id matching the
  // worker's tecnico_id OR with no entity_id (e.g. cost_kill_switch_triggered
  // is sometimes scoped to session_id, escalate_to_hr to phone, etc.).
  const { data: tec } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("phone", testPhone)
    .maybeSingle();
  const tecnicoId = tec?.tecnico_id;

  const { data: rows, error } = await supabase
    .from("eventos")
    .select("type, entity_id, meta, created_at")
    .gte("created_at", turnStart.toISOString())
    .order("created_at", { ascending: true });
  if (error) {
    failures.push({
      assertion: "expected_eventos.read",
      expected: "eventos readable",
      observed: error.message,
      evidence: `phone=${testPhone}`,
    });
    return failures;
  }

  // Scope to events that mention this worker (entity_id match OR meta.phone
  // match OR meta.tecnico_id match) — keeps the matcher tight under
  // concurrent test runs.
  const scoped = (rows ?? []).filter((r) => {
    if (tecnicoId && r.entity_id === tecnicoId) return true;
    const m = (r.meta as Record<string, unknown> | null) ?? null;
    if (m && (m["phone"] === testPhone || m["tecnico_id"] === tecnicoId)) return true;
    return false;
  });

  for (const want of seed.expected_eventos) {
    const matches = scoped.filter((r) => r.type === want.type);
    if (matches.length === 0) {
      failures.push({
        assertion: "expected_eventos.type",
        expected: `eventos type="${want.type}" for this worker`,
        observed: `types: [${scoped.map((s) => s.type).join(", ")}]`,
        evidence: `phone=${testPhone} tecnico_id=${tecnicoId ?? "(none)"}`,
      });
      continue;
    }
    if (want.meta_contains) {
      const matched = matches.some((m) => {
        const meta = (m.meta as Record<string, unknown> | null) ?? {};
        return metaContains(meta, want.meta_contains!);
      });
      if (!matched) {
        failures.push({
          assertion: "expected_eventos.meta_contains",
          expected: `eventos type="${want.type}" with meta containing ${JSON.stringify(want.meta_contains)}`,
          observed: matches
            .map((m) => JSON.stringify(m.meta).slice(0, 100))
            .join(" | "),
          evidence: `phone=${testPhone}`,
        });
      }
    }
  }

  return failures;
}

/**
 * Stream A: full deterministic check including post-conversation DB reads.
 * Use this when the seed declares any of expected_db_state, expected_dossier,
 * or expected_eventos. Otherwise the synchronous deterministicCheck is fine.
 */
export async function deterministicCheckWithDbState(
  seed: Seed,
  turns: InjectResult[],
  testPhone: string,
  turnStart: Date,
  supabase: ServerClient,
  testCedula?: string
): Promise<DeterministicResult> {
  const sync = deterministicCheck(seed, turns, testCedula);
  const asyncFailures = [
    ...(await checkDbState(seed, testPhone, turnStart, supabase)),
    ...(await checkDossierWritten(seed, testPhone, turnStart, supabase)),
    ...(await checkEventosWritten(seed, testPhone, turnStart, supabase)),
  ];
  return {
    seed_name: seed.name,
    passed: sync.failures.length + asyncFailures.length === 0,
    failures: [...sync.failures, ...asyncFailures],
  };
}
