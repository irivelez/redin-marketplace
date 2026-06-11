# /port — twin port (working pattern → sibling agent)

Port an existing, production-working capability from one agent to its
twin. Don't audit, don't redesign — port. The working code IS the spec.

## What to port

$ARGUMENTS

## Protocol

1. READ THE TWIN FIRST. Quote every file in the source path (handler
   signatures, error handling, how results enter the LLM turn). The
   port must preserve the source's semantics exactly.
2. EXTRACT TO shared/ if the helper is inline in the source agent and
   the target needs the same logic. Source agent stays byte-identical
   (git diff on it must be empty).
3. RESOLVE RISK DECISIONS INLINE — list them in your plan with your
   chosen resolution before coding. Typical ones: high-stakes fields
   that must stay text-only, failure sentinel reuse, dedup exemptions,
   feature-flag naming. Do not defer decisions to "later".
4. WIRE SYMMETRICALLY: the target's pipeline (whatsapp.ts → agent.ts)
   gets a branch parallel to the closest existing media path. Reuse
   the [MEDIA_FAILED] sentinel + immediate fallback pattern.
5. PROMPT EDITS ARE SURGICAL: read the target's system prompt first —
   other concerns own most of it. Add the minimum lines; never
   restructure.

## Gates (same as /implement)

typecheck all workspaces · npm run smoke · seed validation · a new
scripts/smoke-*.ts proving the ported path (mock the external service)
· 2 new qa/seeds covering the happy path + the riskiest refusal path.

## Budget

If the twin's pattern doesn't transplant after 3 attempts, STOP and
report the structural difference — do not invent a new design inside
a port.

## Done = commit (do NOT push), flag scope deviations explicitly.
