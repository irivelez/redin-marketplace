// Post-LLM grounding gate — log-only mode (v1).
//
// Problem: Toño hallucinates specifics (placa "HN 234", "número de Francia",
// etc.) that are not present in any tool output or the worker's profile. These
// are not caught by the router (pre-dispatch, structural) because they appear
// in the *text reply*, not in tool args.
//
// Solution: after the LLM emits a reply, extract structured tokens (numbers ≥3
// digits, probable proper nouns, placas, country names) and check each against
// the set of grounded facts available in this turn. Anything not in the ground-
// truth set is a violation.
//
// v1 policy: LOG-ONLY. Violations are written to turns.grounding_violations.
// If env TONO_GROUNDING_ENFORCE=true the reply is replaced with a safe fallback
// and a grounding_blocked evento is emitted.
//
// Allowlist: well-known Redin/Colombia constants that are always allowed
// (brand names, cities, etc.) — never flagged as violations.

// ── Allowlist ────────────────────────────────────────────────────────────────

/** Tokens that are always grounded (brand names, canonical cities, etc.). */
export const GROUNDED_ALLOWLIST = new Set<string>([
  // Brand names
  "redin", "toño", "tono", "whatsapp", "davivienda", "tigo",
  "bolivar", "bolívar", "casalimpia", "casa limpia", "inter rapidísimo",
  "inter rapidisimo", "appsheet",
  // Colombian canonical cities (27 from tono-system.ts)
  "bogotá", "bogota", "cali", "medellín", "medellin",
  "barranquilla", "cartagena", "bucaramanga", "pereira", "manizales",
  "pasto", "popayán", "popayan", "ibagué", "ibague", "neiva",
  "villavicencio", "yopal", "arauca", "florencia", "mocoa",
  "valledupar", "palmira", "jamundí", "jamundi", "buga",
  "girardot", "espinal", "melgar", "obando",
  "puerto boyacá", "puerto boyaca",
  "santander de quilichao",
  // Common Colombian country context (Colombia itself)
  "colombia",
  // Common words that look like proper nouns but aren't violations
  "redin", "rrhh",
]);

// Spanish stopwords whose capitalized forms should never be flagged as proper nouns
const SPANISH_STOPWORDS = new Set<string>([
  "de", "del", "la", "el", "los", "las", "en", "y", "o", "a",
  "por", "para", "con", "sin", "que", "listo", "bueno", "perfecto",
  "claro", "bien", "ok", "hola", "hoy", "hay", "ya", "así", "asi",
  "entonces", "pues", "este", "esta", "ese", "esa", "uno", "una",
  "mi", "tu", "su", "su", "nos", "les", "me", "te", "se",
  "cuando", "donde", "cómo", "como", "qué", "que", "si", "no",
  "más", "mas", "menos", "muy", "todo", "toda", "todos", "todas",
  "otro", "otra", "cada", "mismo", "misma", "ahora", "antes",
  "después", "despues", "solo", "sólo", "también", "tambien",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GroundingViolation {
  token: string;
  kind: "number" | "proper_noun" | "placa" | "country_name";
  reason: string;
}

export interface GroundingResult {
  ok: boolean;
  violations: GroundingViolation[];
}

export interface GroundedFacts {
  /** IdentityContext fields (nombre, cédula prefix, ciudad, categorias). */
  identity_nombre: string | null;
  identity_cedula: string | null; // digits-only; we check substrings of it
  identity_ciudad: string | null;
  identity_categorias: string[];
  /** The raw inbound user message for this turn. */
  user_message: string;
  /** All tool result payloads (as serialized strings) from this turn. */
  tool_payloads: string[];
  /** The sending phone number (grounded by definition). */
  phone: string;
}

// ── Normalization helpers ─────────────────────────────────────────────────────

/** Normalize to lowercase, remove accents, trim. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Check whether a normalized token is in the allowlist. */
function isAllowed(token: string): boolean {
  const n = normalize(token);
  if (GROUNDED_ALLOWLIST.has(n)) return true;
  // Also check multi-word phrases (e.g. "inter rapidísimo" split)
  return false;
}

// ── Entity extraction ─────────────────────────────────────────────────────────

/** Extract sequences of 3+ digits from text. */
function extractNumbers(text: string): string[] {
  const results: string[] = [];
  const re = /\d{3,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m[0]);
  }
  return results;
}

/**
 * Extract probable proper nouns: capitalized tokens ≥3 chars that are not
 * Spanish stopwords and not in the allowlist.
 *
 * We look at tokens that start with an uppercase letter after a word boundary
 * (not at the start of a sentence — too many false positives). We check the
 * position: if the preceding character is '. ' or '\n' or start-of-string,
 * the capitalization is just sentence-initial and we skip it.
 */
function extractProperNouns(text: string): string[] {
  const results: string[] = [];
  // Match word-internal capital starts: a lowercase/digit/space before the token
  // Split into tokens and analyze position
  const tokens = text.split(/\s+/);
  let charPos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] ?? "";
    // Strip punctuation from edges
    const cleaned = raw.replace(/^[¿¡"'([\].,!?:;]+/, "").replace(/[.,!?:;)"'\]]+$/, "");

    if (cleaned.length < 3) {
      charPos += raw.length + 1;
      continue;
    }

    // Must start with uppercase
    if (!/^[A-ZÁÉÍÓÚÑÜ]/.test(cleaned)) {
      charPos += raw.length + 1;
      continue;
    }

    // Skip stopwords
    const lowerCleaned = cleaned.toLowerCase();
    if (SPANISH_STOPWORDS.has(lowerCleaned)) {
      charPos += raw.length + 1;
      continue;
    }

    // Skip if at sentence start (first token, or preceded by .!? \n)
    const isSentenceStart =
      i === 0 ||
      (i > 0 && /[.!?\n]$/.test((tokens[i - 1] ?? "").replace(/\s+$/, "")));
    if (isSentenceStart) {
      charPos += raw.length + 1;
      continue;
    }

    results.push(cleaned);
    charPos += raw.length + 1;
  }
  return results;
}

/** Match placa-like patterns: 3 letters + 2-3 digits + optional letter (Colombian format). */
function extractPlacas(text: string): string[] {
  const results: string[] = [];
  const re = /\b[A-Z]{2,3}\s*\d{2,3}[A-Z]?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m[0].replace(/\s+/, ""));
  }
  return results;
}

/** Detect country names that are NOT Colombia (since Colombia is grounded). */
const FOREIGN_COUNTRY_NAMES = new Set([
  "francia", "france", "venezuela", "brazil", "brasil",
  "ecuador", "perú", "peru", "panama", "panamá",
  "mexico", "méxico", "argentina", "chile", "eeuu",
  "estados unidos", "usa", "spain", "españa", "espana",
]);

function extractForeignCountries(text: string): string[] {
  const normalized = normalize(text);
  const found: string[] = [];
  for (const country of FOREIGN_COUNTRY_NAMES) {
    if (normalized.includes(country)) {
      found.push(country);
    }
  }
  return found;
}

// ── Ground-truth corpus ───────────────────────────────────────────────────────

/**
 * Build a single normalized string corpus from all grounded facts.
 * An entity is grounded if it appears (case-insensitive, accent-normalized)
 * anywhere in this corpus.
 */
function buildCorpus(facts: GroundedFacts): string {
  const parts: string[] = [];

  if (facts.identity_nombre) parts.push(facts.identity_nombre);
  if (facts.identity_cedula) parts.push(facts.identity_cedula);
  if (facts.identity_ciudad) parts.push(facts.identity_ciudad);
  for (const cat of facts.identity_categorias) parts.push(cat);
  parts.push(facts.user_message);
  parts.push(facts.phone);
  for (const payload of facts.tool_payloads) parts.push(payload);

  return normalize(parts.join(" "));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Check whether all specific entities in `reply` are grounded in `facts`.
 *
 * Called AFTER LLM returns reply, BEFORE persisting outbound_text.
 * Always returns a result — never throws (belt-and-suspenders try/catch).
 */
export function checkGrounding(
  reply: string,
  facts: GroundedFacts
): GroundingResult {
  try {
    return _checkGrounding(reply, facts);
  } catch (e) {
    // Gate must never crash the turn. Log and return ok=true (fail open).
    console.error("[grounding-gate] unexpected error — failing open", e);
    return { ok: true, violations: [] };
  }
}

function _checkGrounding(reply: string, facts: GroundedFacts): GroundingResult {
  const corpus = buildCorpus(facts);
  const violations: GroundingViolation[] = [];

  // 1. Numbers (3+ digits)
  for (const num of extractNumbers(reply)) {
    if (isAllowed(num)) continue;
    if (corpus.includes(num)) continue;
    violations.push({
      token: num,
      kind: "number",
      reason: `Number "${num}" not found in any grounded fact (tool output, identity, user message).`,
    });
  }

  // 2. Placa-like patterns (checked before proper nouns to avoid double-flagging)
  const placasInReply = extractPlacas(reply);
  const placasSet = new Set(placasInReply.map(normalize));
  for (const placa of placasInReply) {
    if (isAllowed(placa)) continue;
    if (corpus.includes(normalize(placa))) continue;
    violations.push({
      token: placa,
      kind: "placa",
      reason: `Placa-like token "${placa}" not grounded in tool output or user message.`,
    });
  }

  // 3. Foreign country names
  for (const country of extractForeignCountries(reply)) {
    if (isAllowed(country)) continue;
    if (corpus.includes(country)) continue;
    violations.push({
      token: country,
      kind: "country_name",
      reason: `Foreign country "${country}" mentioned but not present in any grounded fact.`,
    });
  }

  // 4. Proper nouns (capitalized mid-sentence tokens)
  for (const noun of extractProperNouns(reply)) {
    const nNorm = normalize(noun);
    // Skip if it looks like a placa (already covered above)
    if (placasSet.has(nNorm)) continue;
    if (isAllowed(noun)) continue;
    if (corpus.includes(nNorm)) continue;
    violations.push({
      token: noun,
      kind: "proper_noun",
      reason: `Proper noun "${noun}" not found in grounded facts.`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
