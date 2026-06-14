// Recovered from the 2.1.177 binary (cluster C — Fable 5 / Mythos models).
//
// Centralizes the Fable 5 and Mythos model identity, 3P provider ids, env-var
// overrides, and family/pin helpers introduced in 2.1.177. Model id strings,
// Bedrock/Vertex ids, display name, context window, and env var names are taken
// from the binary; the exact bodies of a few minified predicates
// (isPinnedFableModel / isNonCustomFableModel) are reconstructed from their
// opus/sonnet analogues and flagged `RECOVERY-UNCERTAIN`.
import type { ModelName } from './model.js'
import { getAPIProvider } from './providers.js'

// ---- Fable 5 ---------------------------------------------------------------

/** Canonical first-party Fable 5 model id. (minified FABLE_ID) */
export const FABLE_ID = 'claude-fable-5'
/** Display name. (minified FABLE_NAME) */
export const FABLE_NAME = 'Claude Fable 5'
/** 1M-context launch variant alias. */
export const FABLE_1M_ALIAS = 'fable[1m]'

/** Bedrock model ids for Fable 5. */
export const FABLE_BEDROCK_ID = 'anthropic.claude-fable-5'
export const FABLE_BEDROCK_ID_US = 'us.anthropic.claude-fable-5'
/** Vertex region env var name for Fable 5. (minified VERTEX_REGION_CLAUDE_FABLE_5) */
export const ENV_VERTEX_REGION_CLAUDE_FABLE_5 = 'VERTEX_REGION_CLAUDE_FABLE_5'

// Env-var overrides (minified ANTHROPIC_DEFAULT_FABLE_MODEL*).
export const ENV_DEFAULT_FABLE_MODEL = 'ANTHROPIC_DEFAULT_FABLE_MODEL'
export const ENV_DEFAULT_FABLE_MODEL_NAME = 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'
export const ENV_DEFAULT_FABLE_MODEL_DESCRIPTION = 'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION'
export const ENV_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES =
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES'
/** Third-party API-key env var for Fable. (minified DEFAULT_3P_FABLE_KEY) */
export const ENV_DEFAULT_3P_FABLE_KEY = 'DEFAULT_3P_FABLE_KEY'
/** Disables prompt caching for Fable when set. (minified DISABLE_PROMPT_CACHING_FABLE) */
export const ENV_DISABLE_PROMPT_CACHING_FABLE = 'DISABLE_PROMPT_CACHING_FABLE'

/** Fable 5 context window / output token caps (from the binary capability table). */
export const FABLE_CONTEXT_WINDOW = 1_000_000
export const FABLE_MAX_OUTPUT_TOKENS = 128_000

/** Natural-language aliases that resolve to Fable. */
export const FABLE_ALIASES = ['fable', 'fable 5', 'fable5', FABLE_1M_ALIAS] as const

// ---- Mythos (Project Glasswing) -------------------------------------------

export const MYTHOS_ID = 'claude-mythos-5'
export const MYTHOS_PREVIEW_ID = 'claude-mythos-preview'
export const MYTHOS_BEDROCK_ID = 'anthropic.claude-mythos-5'
export const MYTHOS_BEDROCK_ID_US = 'us.anthropic.claude-mythos-5'
export const MYTHOS_ALIASES = ['mythos', 'mythos 5', 'mythos5'] as const

// ---- predicates ------------------------------------------------------------

/** True for any Fable model id. (minified isFableModelValue) */
export function isFableModelValue(model: string | undefined | null): boolean {
  return !!model && model.includes('claude-fable')
}

/** True for any Mythos model id. (minified isMythosModelValue) */
export function isMythosModelValue(model: string | undefined | null): boolean {
  return !!model && model.includes('claude-mythos')
}

/** True for a Fable id or the "fable"/"fable[1m]" family aliases. (minified isFableFamilyOrPinnedModel) */
export function isFableFamilyOrPinnedModel(model: string | undefined | null): boolean {
  if (!model) return false
  return isFableModelValue(model) || (FABLE_ALIASES as readonly string[]).includes(model)
}

/** True for a Mythos id or its family aliases. (minified isMythosFamilyOrPinnedModel) */
export function isMythosFamilyOrPinnedModel(model: string | undefined | null): boolean {
  if (!model) return false
  return isMythosModelValue(model) || (MYTHOS_ALIASES as readonly string[]).includes(model)
}

/** True for the pinned 1M Fable launch alias. (minified isPinnedFableModel) */
export function isPinnedFableModel(model: string | undefined | null): boolean {
  // RECOVERY-UNCERTAIN: reconstructed from the opus[1m] pin analogue.
  return model === FABLE_1M_ALIAS
}

/**
 * True for a stock (non-custom-override) Fable id. (minified isNonCustomFableModel)
 * RECOVERY-UNCERTAIN: "custom" here means a user-supplied ANTHROPIC_DEFAULT_FABLE_MODEL
 * that isn't the canonical id; reconstructed from the opus analogue.
 */
export function isNonCustomFableModel(model: string | undefined | null): boolean {
  return isFableModelValue(model) && model !== process.env[ENV_DEFAULT_FABLE_MODEL]
}
export function isNonCustomMythosModel(model: string | undefined | null): boolean {
  return isMythosModelValue(model)
}

/** Whether Fable is selectable in this session. (minified isFableAvailable) */
export function isFableAvailable(): boolean {
  // RECOVERY-UNCERTAIN: original gates on launch/entitlement flags; default to true
  // so the id resolves once present in the allowlist.
  return true
}

// ---- defaults --------------------------------------------------------------

/** Resolve the default Fable model id, honoring the env override. (minified getDefaultFableModel) */
export function getDefaultFableModel(): ModelName {
  if (process.env[ENV_DEFAULT_FABLE_MODEL]) {
    return process.env[ENV_DEFAULT_FABLE_MODEL] as ModelName
  }
  if (getAPIProvider() !== 'firstParty') {
    return FABLE_BEDROCK_ID_US
  }
  return FABLE_ID
}

/** Pin options carried through model-setting updates. (minified pinFable / fable5LaunchShow) */
export type FablePinOptions = {
  pinFable?: boolean
}
