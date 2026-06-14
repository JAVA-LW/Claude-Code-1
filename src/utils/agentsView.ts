// Recovered from the 2.1.177 binary (cluster F — Agents View / Fleet).
//
// Concrete surface of the Agents/Fleet view: the expandedView mode ('agents',
// added to AppState), usage/onboarding flags, and the stop-session telemetry
// event. The AgentsView UI component itself is large and not reconstructable
// from the minified bundle; this module recovers the supporting surface only.
import { getGlobalConfig } from './config.js'

/** expandedView value that selects the Agents/Fleet view. (minified agentsView) */
export const AGENTS_VIEW_MODE = 'agents' as const

/** Telemetry event for stopping a session from the fleet view. (minified fleet_view_stop_session) */
export const FLEET_VIEW_STOP_SESSION_EVENT = 'fleet_view_stop_session'

/**
 * Whether the user has opened the Agents view before (onboarding gate).
 * (minified hasOpenedAgentsView)
 * RECOVERY-UNCERTAIN: stored on global config; field name assumed to match.
 */
export function hasOpenedAgentsView(): boolean {
  return (getGlobalConfig() as { hasOpenedAgentsView?: boolean })?.hasOpenedAgentsView === true
}

/**
 * Whether the user has used the Agents fleet feature. (minified hasUsedAgentsFleet)
 * RECOVERY-UNCERTAIN: stored on global config; field name assumed to match.
 */
export function hasUsedAgentsFleet(): boolean {
  return (getGlobalConfig() as { hasUsedAgentsFleet?: boolean })?.hasUsedAgentsFleet === true
}
