// Recovered from the 2.1.177 binary (cluster D — refusal-fallback + credit).
//
// Surface of the model refusal-fallback / fallback-credit subsystem: telemetry
// event names (exact), the refusal-fallback model latch, the lane/toggle gates,
// and the classifier opus-reroute helper. The deep retry/rewind state-machine
// that drives this from query.ts is intricate and minified; it is NOT
// reconstructed here — only the recoverable surface — and the integration points
// are flagged `RECOVERY-UNCERTAIN`.
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDefaultOpusModel } from './model.js'
import type { ModelName } from './model.js'

/** Telemetry event names emitted by the refusal-fallback / credit flow (exact from binary). */
export const REFUSAL_FALLBACK_EVENTS = {
  triggered: 'tengu_refusal_fallback_triggered',
  entryRecorded: 'tengu_refusal_fallback_entry_recorded',
  promptShown: 'tengu_refusal_fallback_prompt_shown',
  promptChoice: 'tengu_refusal_fallback_prompt_choice',
  dialogSuppressed: 'tengu_refusal_fallback_dialog_suppressed',
  suppressed: 'tengu_refusal_fallback_suppressed',
  latchReset: 'tengu_refusal_fallback_latch_reset',
  resumeLatch: 'tengu_refusal_fallback_resume_latch',
  rewindUnwind: 'tengu_refusal_fallback_rewind_unwind',
  supersedes: 'tengu_refusal_fallback_supersedes',
  settingChanged: 'tengu_refusal_fallback_setting_changed',
} as const

export const FALLBACK_CREDIT_EVENTS = {
  minted: 'tengu_fallback_credit_minted',
  forfeited: 'tengu_fallback_credit_forfeited',
  skipped: 'tengu_fallback_credit_skipped',
  outcome: 'tengu_fallback_credit_outcome',
  stripAsMintModel: 'tengu_fallback_credit_strip_as_mint_model',
} as const

// ---- refusal-fallback model latch ------------------------------------------
// RECOVERY-UNCERTAIN: 2.1.177 stores the latch on the global app/session state
// store (minified B$.refusalFallbackModelLatch). Kept module-scoped here to
// avoid threading a new field through the state store across this partial tree;
// observable get/latch/clear behavior is preserved.
let refusalFallbackModelLatch: ModelName | undefined
let refusalFallbackOccurred = false

/** The model latched after a refusal fallback, if any. (minified getRefusalFallbackModelLatch) */
export function getRefusalFallbackModelLatch(): ModelName | undefined {
  return refusalFallbackModelLatch
}

/** Latch the fallback model so subsequent turns stay on it. (minified latchRefusalFallbackModel) */
export function latchRefusalFallbackModel(model: ModelName): void {
  refusalFallbackModelLatch = model
  refusalFallbackOccurred = true
}

/** Clear the latch (e.g. on rewind/reset). (minified clearRefusalFallbackModelLatch) */
export function clearRefusalFallbackModelLatch(): void {
  refusalFallbackModelLatch = undefined
}

export function getRefusalFallbackOccurred(): boolean {
  return refusalFallbackOccurred
}
export function clearRefusalFallbackOccurred(): void {
  refusalFallbackOccurred = false
}

// ---- gates -----------------------------------------------------------------

/** Whether the refusal-fallback lane is enabled (gate: tengu_loggia_carousel). (minified refusalFallbackLaneEnabled) */
export function refusalFallbackLaneEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_loggia_carousel', false)
}

/** Whether the refusal-fallback setting toggle is shown (gate: tengu_loggia_carousel_config). (minified refusalFallbackSettingToggleVisible) */
export function refusalFallbackSettingToggleVisible(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_loggia_carousel_config', false)
}

// ---- classifier reroute ----------------------------------------------------

/**
 * Reroute a classifier/auto request to an opus model when appropriate.
 * (minified getClassifierOpusReroute / nX$)
 * RECOVERY-UNCERTAIN: the original applies model-class predicates (minified
 * Uj/Sm/MX6) to decide; reconstructed here to honor ANTHROPIC_DEFAULT_OPUS_MODEL
 * and otherwise fall back to the default opus model.
 */
export function getClassifierOpusReroute(_model: ModelName): ModelName {
  return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? getDefaultOpusModel()
}
