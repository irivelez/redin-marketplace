# /diagnose — read-only root-cause hunt (Diagnose-Step-1)

You are diagnosing, not fixing. Do NOT edit any file. Output is a written
report only.

## Symptom (user-reported)

$ARGUMENTS

## Protocol

1. SEPARATE SYMPTOM FROM GUESSES. If the input above contains the user's
   theories about the cause ("I think it's X"), list them under a
   "NOT A SYMPTOM — user guesses, set aside" heading and do NOT anchor
   on them. Diagnose from code and data, not from the theory.

2. BUILD YOUR OWN READING LIST. Locate the relevant surface first:
   - Which agent? tono/ (workers) or manos/ (architects) or sync/ or
     dashboard/
   - The system prompt: {agent}/src/prompts/*-system.ts
   - The inbound pipeline: {agent}/src/whatsapp.ts → agent.ts → llm.ts
   - Tools: tools/src/ (shared 9-tool contract + manos/ subdir)
   - Live evidence: data/test-results-*/ transcripts, Supabase `eventos`,
     `turns`, `outbound_messages` tables
   - Recent context: .omo/handoffs/ (newest first), CHANGELOG.md, prd.json

3. QUOTE, DON'T PARAPHRASE. Every claim carries file:line. Missing code
   is a valid finding — write "ABSENT" and name where it should live.

## Deliverable (single markdown report)

1. THE CODE PATH, VERBATIM — quote the exact code/prompt lines that
   produce what the user observes.
2. LIVE EVIDENCE — at least one real transcript or DB row exhibiting the
   symptom. If none exists, say so explicitly.
3. THREE HYPOTHESES ranked by likelihood, each with: (a) responsible
   file:line, (b) ONE observation query/grep to confirm, (c) evidence.
4. SMALLEST FIX SKETCH per hypothesis — described in 2 lines, NOT
   implemented.

## Budget

Max 15 tool-use turns. If not converged by then, STOP and report
findings + best hypothesis, marked unconfirmed.

## Invariants (always)

- Production is live with real workers. No edits, no migrations, no
  deploys, no writes to any table.
- AppSheet is read-only by hard constraint.
- Do not propose re-architecting. Smallest-fix bias.
