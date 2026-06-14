// Recovered from the 2.1.177 binary (cluster A — ArtifactTool).
// Values extracted from the minified `.bun` section:
//   ARTIFACT_TOOL_NAME  <- mzH = "Artifact"
//   MAX_ARTIFACT_BYTES  <- J9H = 16777216
//   TITLE_SCAN_CHARS    <- zv7 = 8192   (byte budget = zv7 * 4, minified Km6)
//   MAX_ARTIFACT_TITLE  <- Av7 = 280
//   slug regex          <- qm6
//   conflict message    <- $k4
//   ARTIFACT_PAGE_STYLE <- NYf (the default <style> wrapped around published content)

export const ARTIFACT_TOOL_NAME = 'Artifact'

/** Hard cap on the rendered page size accepted by the deploy backend. */
export const MAX_ARTIFACT_BYTES = 16_777_216 // 16 MiB

/** Number of leading characters scanned for a <title> when deriving a title. */
export const TITLE_SCAN_CHARS = 8192
/** Byte budget for the title scan (utf-8 worst case is 4 bytes/char). */
export const TITLE_SCAN_BYTES = TITLE_SCAN_CHARS * 4

/** Titles longer than this are truncated by sanitizeArtifactTitle. */
export const MAX_ARTIFACT_TITLE_LENGTH = 280

/** An artifact slug is a v4-style UUID. */
export const ARTIFACT_SLUG_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const ARTIFACT_SLUG_REGEX = new RegExp(`^${ARTIFACT_SLUG_PATTERN}$`)

/** Path prefix for the published artifact viewer on claude.ai. */
export const ARTIFACT_PATH_PREFIX = '/code/artifact/'

export const ARTIFACT_CONFLICT_MESSAGE =
  'conflict: another session published a newer version of this artifact. Re-read the current content (WebFetch the URL), reconcile your edits, then publish again.'

/**
 * Default <style> injected into the <head> of every published page. Sets a
 * light color-scheme, a system font stack, comfortable padding, and
 * `img{max-width:100%}` so images never overflow. Verbatim from the binary.
 */
export const ARTIFACT_PAGE_STYLE =
  '<style>:root{color-scheme:light}body{margin:0;padding:20px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}</style>'

// Environment variables / settings that gate or steer the Artifact tool.
export const ENV_DISABLE_ARTIFACT = 'CLAUDE_CODE_DISABLE_ARTIFACT'
export const ENV_ARTIFACT = 'CLAUDE_CODE_ARTIFACT'
export const ENV_ARTIFACT_AUTO_OPEN = 'CLAUDE_CODE_ARTIFACT_AUTO_OPEN'
export const ENV_ARTIFACT_DIRECT_UPLOAD = 'CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD'
