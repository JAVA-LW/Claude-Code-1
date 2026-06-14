// Recovered from the 2.1.177 binary (cluster B — ProjectsTool).
// Values extracted from the minified `.bun` section:
//   PROJECTS_TOOL_NAME   <- rp4 = "Projects"
//   REQUIRED_FIELDS      <- _2f
//   READONLY_METHODS     <- f2f
//   EXPANDED_SCOPES_NOTICE <- z2f
//   project URL pattern  <- EWH = /api/organizations/:orgUUID/projects/<uuid><sub>

export const PROJECTS_TOOL_NAME = 'Projects'

export type ProjectsMethod =
  | 'project_info'
  | 'project_read'
  | 'project_search'
  | 'project_write'
  | 'project_delete'

/** Required input fields per method (minified _2f). Drives validateInput. */
export const REQUIRED_FIELDS: Record<ProjectsMethod, string[]> = {
  project_info: [],
  project_read: ['path'],
  project_search: ['query'],
  project_write: ['path'],
  project_delete: ['path'],
}

/** Methods that don't mutate the project (minified f2f). */
export const READONLY_METHODS: ReadonlySet<ProjectsMethod> = new Set<ProjectsMethod>([
  'project_info',
  'project_read',
  'project_search',
])

/** Default number of knowledge-search hits when `n` is omitted. */
export const DEFAULT_SEARCH_HITS = 5

/** Shown once when the OAuth login is upgraded with project scopes (minified z2f). */
export const EXPANDED_SCOPES_NOTICE =
  "Upgraded your claude.ai login to include project access (user:projects:read, user:projects:write). This lets the session read and write the project's knowledge docs on claude.ai."

/** Auth/scope failure messages (minified A2f). */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  no_token:
    'Run /login and select "Claude account with subscription", then retry — the "Anthropic Console account" option does not provide claude.ai credentials.',
  no_refresh:
    'The OAuth token was supplied via CLAUDE_CODE_OAUTH_TOKEN and cannot be expanded with project scopes. Run /login in this session.',
  // RECOVERY-UNCERTAIN: full text of the expand_failed message was truncated in extraction.
  expand_failed:
    'Could not add project scopes to your claude.ai login. Run /login in this session.',
}
