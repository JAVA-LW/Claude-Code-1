// Recovered from the 2.1.177 binary (cluster I — Skills governance).
//
// Gates for disabling bundled skills and skill shell execution, plus the
// plugin-skill-search error. Flag names/env vars are from the binary; the
// runtime read uses the existing merged-settings accessor.
import { isEnvTruthy } from '../utils/envUtils.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

/** Env override that disables the bundled skills. (minified CLAUDE_CODE_DISABLE_BUNDLED_SKILLS) */
export const ENV_DISABLE_BUNDLED_SKILLS = 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'

/** Whether the CLI's bundled skills are turned off (env or settings). (minified disableBundledSkills) */
export function isBundledSkillsDisabled(): boolean {
  if (isEnvTruthy(process.env[ENV_DISABLE_BUNDLED_SKILLS])) return true
  return getSettings_DEPRECATED()?.disableBundledSkills === true
}

/** Whether `!`-shell execution inside skill prompts is turned off. (minified disableSkillShellExecution) */
export function isSkillShellExecutionDisabled(): boolean {
  return getSettings_DEPRECATED()?.disableSkillShellExecution === true
}

/** Raised when a plugin-provided skill search backend is unavailable. (minified PluginSkillSearchUnavailableError) */
export class PluginSkillSearchUnavailableError extends Error {
  constructor(message = 'Plugin skill search is unavailable.') {
    super(message)
    this.name = 'PluginSkillSearchUnavailableError'
  }
}
