// Recovered from the 2.1.177 binary (cluster G — Chrome auto-enable).
//
// Auto-enable surface for Claude-in-Chrome: per-session "wired" tracking, the
// accepted config flag, the suppress-offer gate, and auto-enable telemetry.
// The ChromeAutoEnableDialog UI component is not reconstructable from the
// minified bundle; this module recovers the supporting logic only.
import { getGlobalConfig } from '../config.js'

// Per-session wired state (minified module global $p$).
let claudeInChromeWiredThisSession = false

/** Whether Claude-in-Chrome was wired during this session. (minified isClaudeInChromeWiredThisSession) */
export function isClaudeInChromeWiredThisSession(): boolean {
  return claudeInChromeWiredThisSession
}

/** Mark Claude-in-Chrome as wired this session. */
export function markClaudeInChromeWired(): void {
  claudeInChromeWiredThisSession = true
}

/** Clear the wired-this-session flag. (minified markClaudeInChromeUnwired) */
export function markClaudeInChromeUnwired(): void {
  claudeInChromeWiredThisSession = false
}

/** Clear the wired flag only when the affected browser is Chrome. (minified markClaudeInChromeUnwiredIfChrome) */
export function markClaudeInChromeUnwiredIfChrome(browser: string | undefined): void {
  if (browser === 'chrome') markClaudeInChromeUnwired()
}

/** Whether the user has accepted the Claude-in-Chrome auto-enable offer. (minified claudeInChromeAccepted) */
export function claudeInChromeAccepted(): boolean {
  return (getGlobalConfig() as { claudeInChromeAccepted?: boolean })?.claudeInChromeAccepted === true
}

/**
 * Whether to suppress the Claude-in-Chrome offer this session. (minified shouldSuppressChromeOffer)
 * RECOVERY-UNCERTAIN: original also factors session mode (ssh/remote/safe) and
 * prior dismissals; reconstructed to suppress once accepted or already wired.
 */
export function shouldSuppressChromeOffer(): boolean {
  return claudeInChromeAccepted() || isClaudeInChromeWiredThisSession()
}

// Telemetry / config keys (exact from binary).
export const CHROME_AUTO_ENABLE_PROMPT = 'chrome_auto_enable_prompt'
export const TENGU_CHROME_AUTO_ENABLE_PROMPT_SHOWN = 'tengu_chrome_auto_enable_prompt_shown'
