// Recovered from the 2.1.177 binary (cluster E — model enforcement).
//
// The model-enforcement layer built on the availableModels allowlist: whether a
// default is enforced, the enforced default, allow-under-enforcement, and an
// unavailability reason. Function names are exact from the binary; the exact
// reason-string text and the startup-warning policy are reconstructed and
// flagged `RECOVERY-UNCERTAIN`.
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAllowed } from './modelAllowlist.js'
import type { ModelName } from './model.js'

/** True when an availableModels allowlist is active (non-empty). (minified isDefaultModelEnforced) */
export function isDefaultModelEnforced(): boolean {
  const available = getSettings_DEPRECATED()?.availableModels
  return Array.isArray(available) && available.length > 0
}

/** The enforced default model under an active allowlist, if any. (minified getEnforcedDefaultModel) */
export function getEnforcedDefaultModel(): ModelName | undefined {
  const available = getSettings_DEPRECATED()?.availableModels
  return Array.isArray(available) && available.length > 0 ? available[0] : undefined
}

/** Whether a model is permitted under the currently-active enforcement. (minified isModelAllowedUnderActiveEnforcement) */
export function isModelAllowedUnderActiveEnforcement(model: ModelName): boolean {
  return isModelAllowed(model)
}

/**
 * A human-readable reason a model is unavailable, or null when it is available.
 * (minified getModelUnavailabilityReason)
 * RECOVERY-UNCERTAIN: exact reason text not extracted; reconstructed.
 */
export function getModelUnavailabilityReason(model: ModelName): string | null {
  if (isModelAllowed(model)) return null
  const available = getSettings_DEPRECATED()?.availableModels
  if (Array.isArray(available) && available.length === 0) {
    return `Model "${model}" is not available: the availableModels allowlist is empty.`
  }
  return `Model "${model}" is not in the availableModels allowlist for this session.`
}

/**
 * Whether to warn that the startup model is restricted by enforcement.
 * (minified shouldWarnRestrictedStartupModel)
 * RECOVERY-UNCERTAIN: exact policy not extracted; warns when a startup model is
 * set but disallowed under active enforcement.
 */
export function shouldWarnRestrictedStartupModel(startupModel: ModelName | undefined): boolean {
  if (!startupModel) return false
  return isDefaultModelEnforced() && !isModelAllowedUnderActiveEnforcement(startupModel)
}

/** Telemetry key for the unavailable-models report. (minified unavailable_models) */
export const UNAVAILABLE_MODELS_EVENT = 'unavailable_models'
