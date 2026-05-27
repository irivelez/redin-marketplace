// Tools index — import these wherever the agent contract is needed.
//
// Agent-visible contract (LLM tool list): 15 tools — see schemas.ts.
// Dispatch surface (this file): 15 + the deprecated set_qualification_state
// shim (kept reachable for HR dashboard server actions until Stream B updates
// them; not in the LLM-visible declarations).

export * from "./types";
export * from "./context";
export * from "./schemas";
export { recordEvent, logLlmCall, logLlmError } from "./events";
export type { RecordEventInput, LlmCallMeta, LlmErrorMeta } from "./events";

export { identifyUser } from "./identify-user";
export { registerTecnico } from "./register-tecnico";
export { readPendingOts } from "./read-pending-ots";
export { createPostulacion } from "./create-postulacion";
export { readMyPostulaciones } from "./read-my-postulaciones";
export { readMyContratos } from "./read-my-contratos";
export { uploadDocumento } from "./upload-documento";
export { escalateToHr } from "./escalate-to-hr";
export { logEvent } from "./log-event";
export { setQualificationState } from "./set-qualification-state";
export { submitCandidateDossier } from "./submit-candidate-dossier";
export { findByCedula } from "./find-by-cedula";
export { markCandidateWithdrawn } from "./mark-candidate-withdrawn";
export { completeLegacyProfile } from "./complete-legacy-profile";
export { findLegacyByName } from "./find-legacy-by-name";
export {
  normalizeName,
  levenshtein,
  findMatches,
} from "./legacy-name-match";
export { recommendShortlistCandidate } from "./recommend-shortlist-candidate";
export type {
  RecommendShortlistInput,
  RecommendShortlistOutput,
} from "./recommend-shortlist-candidate";
export { classifyDocumento } from "./classify-documento";
export type {
  ClassifyDocumentoInput,
  ClassifyDocumentoOutput,
} from "./types";
export type { NameMatch, FindMatchesOptions } from "./legacy-name-match";

// Manos tools (architect-facing) — separate tool set, not in TOOL_DECLARATIONS.
export { listMyPendingOts } from "./manos/list-my-pending-ots";
export type {
  ListMyPendingOtsInput,
  ListMyPendingOtsOutput,
  PendingOtItem,
} from "./manos/list-my-pending-ots";
export { attachPhotos, verifyOtOwnership } from "./manos/attach-photos";
export type { AttachPhotosInput, AttachPhotosOutput } from "./manos/attach-photos";
export { setAlcanceOt } from "./manos/set-alcance-ot";
export type {
  SetAlcanceOtInput,
  SetAlcanceOtOutput,
  AlcanceShape,
} from "./manos/set-alcance-ot";
export { finalizeAlcance } from "./manos/finalize-alcance";
export type { FinalizeAlcanceInput, FinalizeAlcanceOutput } from "./manos/finalize-alcance";
export type {
  LegacyEnrichmentData,
  CompleteLegacyProfileInput,
  CompleteLegacyProfileOutput,
} from "./complete-legacy-profile";
export type {
  FindLegacyByNameInput,
  FindLegacyByNameOutput,
} from "./find-legacy-by-name";

// Centralized dispatcher — used by Toño and by the dashboard chat API route.
import type { ToolContext } from "./context";
import { identifyUser } from "./identify-user";
import { registerTecnico } from "./register-tecnico";
import { readPendingOts } from "./read-pending-ots";
import { createPostulacion } from "./create-postulacion";
import { readMyPostulaciones } from "./read-my-postulaciones";
import { readMyContratos } from "./read-my-contratos";
import { uploadDocumento } from "./upload-documento";
import { escalateToHr } from "./escalate-to-hr";
import { logEvent } from "./log-event";
import { setQualificationState } from "./set-qualification-state";
import { submitCandidateDossier } from "./submit-candidate-dossier";
import { findByCedula } from "./find-by-cedula";
import { markCandidateWithdrawn } from "./mark-candidate-withdrawn";
import { completeLegacyProfile } from "./complete-legacy-profile";
import { findLegacyByName } from "./find-legacy-by-name";
import { classifyDocumento } from "./classify-documento";
import type { ToolName } from "./schemas";
import type { ToolResult } from "./types";

export type ToolArgs = Record<string, unknown>;

export async function dispatchTool(
  ctx: ToolContext,
  name: ToolName | string,
  args: ToolArgs
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "identify_user":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return identifyUser(ctx, args as any);
    case "register_tecnico":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return registerTecnico(ctx, args as any);
    case "read_pending_ots":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readPendingOts(ctx, args as any);
    case "create_postulacion":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return createPostulacion(ctx, args as any);
    case "read_my_postulaciones":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readMyPostulaciones(ctx, args as any);
    case "read_my_contratos":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readMyContratos(ctx, args as any);
    case "upload_documento":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return uploadDocumento(ctx, args as any);
    case "escalate_to_hr":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return escalateToHr(ctx, args as any);
    case "log_event":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return logEvent(ctx, args as any);
    case "submit_candidate_dossier":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return submitCandidateDossier(ctx, args as any);
    case "find_by_cedula":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return findByCedula(ctx, args as any);
    case "mark_candidate_withdrawn":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return markCandidateWithdrawn(ctx, args as any);
    case "complete_legacy_profile":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return completeLegacyProfile(ctx, args as any);
    case "classify_documento":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return classifyDocumento(ctx, args as any);
    case "set_qualification_state":
      // Deprecated. Routed to the compat shim. Not in schemas.ts so the LLM
      // never sees it; HR dashboard server actions still call it by name
      // until Stream B updates them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return setQualificationState(ctx, args as any);
    default:
      return {
        ok: false,
        error: `unknown tool: ${name}`,
        code: "unknown_tool",
      };
  }
}
