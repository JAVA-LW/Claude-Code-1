// Recovered from the 2.1.177 binary (cluster A — ArtifactTool).
//
// Reconstructs the artifact publish/deploy module (minified module `Kk4` +
// helpers). The deploy contract is reconstructed from the minified
// `publishArtifact` (V6q): wrap content -> POST /api/frame/deploy/init ->
// PUT the page to the returned signed URL -> confirm. Wire-level details
// (exact endpoint base, request/response field names, the X-Frame-CP header,
// the confirm call) are reconstructed from the minified source and the
// observable behavior; they are flagged `RECOVERY-UNCERTAIN` where inferred.
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'
import {
  ARTIFACT_CONFLICT_MESSAGE,
  ARTIFACT_PAGE_STYLE,
  ARTIFACT_PATH_PREFIX,
  ARTIFACT_SLUG_REGEX,
  ENV_ARTIFACT_DIRECT_UPLOAD,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_TITLE_LENGTH,
  TITLE_SCAN_CHARS,
} from './constants.js'

export type ArtifactEnv = 'prod' | 'staging'

export type ParsedArtifactUrl = {
  slug: string
  env: ArtifactEnv
}

export type PublishArtifactOptions = {
  /** Existing slug to redeploy to. Omit to mint a new artifact. */
  slug?: string
  title: string
  favicon: string
  label?: string
  /** Gated MCP manifest to attach to the page (frame connector bridge). */
  mcp?: unknown
  /** Base version for optimistic-concurrency redeploys. */
  baseVersion?: string
}

export type PublishArtifactResult =
  | {
      url: string
      slug: string
      version: string
      err: null
      mcpDropped?: string
    }
  | {
      url: null
      slug: null
      version: null
      err: string
      /** Server's current live version, when a conflict/precondition is reported. */
      liveVersion?: string
      conflict?: boolean
    }

function publishError(err: string): PublishArtifactResult {
  return { url: null, slug: null, version: null, err }
}

/** Current claude.ai environment, derived from the active OAuth config. */
export function currentArtifactEnv(): ArtifactEnv {
  return getOauthConfig().CLAUDE_AI_ORIGIN.includes('staging') ? 'staging' : 'prod'
}

/** Public viewer URL for a published artifact slug. (minified T6q) */
export function artifactViewerUrl(slug: string): string {
  return new URL(
    ARTIFACT_PATH_PREFIX + slug,
    getOauthConfig().CLAUDE_AI_ORIGIN,
  ).toString()
}

/**
 * Parse a claude.ai artifact URL into its slug and environment, or null when
 * the URL is not a recognizable artifact link. (minified parseArtifactUrl)
 */
export function parseArtifactUrl(url: string): ParsedArtifactUrl | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const prefix = ARTIFACT_PATH_PREFIX
  const idx = parsed.pathname.indexOf(prefix)
  if (idx === -1) return null
  const slug = parsed.pathname.slice(idx + prefix.length).split('/')[0] ?? ''
  if (!ARTIFACT_SLUG_REGEX.test(slug)) return null
  const env: ArtifactEnv = parsed.hostname.includes('staging') ? 'staging' : 'prod'
  return { slug, env }
}

/** Trim/clamp a derived title to the backend's accepted length. (minified sanitizeArtifactTitle) */
export function sanitizeArtifactTitle(title: string): string {
  return title.trim().slice(0, MAX_ARTIFACT_TITLE_LENGTH)
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    const named = HTML_ENTITIES[code.toLowerCase()]
    if (named !== undefined) return named
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16)
      return Number.isNaN(cp) ? whole : String.fromCodePoint(cp)
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10)
      return Number.isNaN(cp) ? whole : String.fromCodePoint(cp)
    }
    return whole
  })
}

/**
 * Extract the <title> from the first TITLE_SCAN_CHARS of an HTML document,
 * decoded and sanitized, or undefined when absent. (minified extractHtmlTitle / CJ8)
 */
export function extractHtmlTitle(html: string): string | undefined {
  const head = html.slice(0, TITLE_SCAN_CHARS)
  const match = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return undefined
  const title = sanitizeArtifactTitle(decodeHtmlEntities(match[1]))
  return title.length > 0 ? title : undefined
}

/** Wrap rendered content in the standard self-contained page shell. */
export function wrapArtifactHtml(body: string): string {
  return `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">${ARTIFACT_PAGE_STYLE}</head><body>\n${body}\n</body></html>`
}

// RECOVERY-UNCERTAIN: 2.1.177 stores per-session artifact state in
// AppState.frameUrls / AppState.artifactReadVersions and mutates it via
// context.setAppState / context.setArtifactReadVersion. Wiring two new fields
// through the (large, DeepImmutable) AppState and every context factory across
// this partial source tree is invasive and risks destabilizing the build, so
// the recovery keeps the equivalent state module-scoped here. Observable
// behavior (same-session redeploy targeting + the unseen-version write guard)
// is preserved; the storage mechanism differs from the original.
export type FrameUrlEntry = {
  url: string
  updatedAt: number
  title: string
  favicon: string
}
const frameUrls = new Map<string, FrameUrlEntry>()
const artifactReadVersions = new Map<string, string>()

export function getFrameUrl(resolvedPath: string): FrameUrlEntry | undefined {
  return frameUrls.get(resolvedPath)
}
export function setFrameUrl(resolvedPath: string, entry: FrameUrlEntry): void {
  // A slug can only be bound to one path: drop any stale path pointing at it.
  const slug = parseArtifactUrl(entry.url)?.slug
  if (slug) {
    for (const [path, existing] of frameUrls)
      if (path !== resolvedPath && parseArtifactUrl(existing.url)?.slug === slug)
        frameUrls.delete(path)
  }
  frameUrls.set(resolvedPath, entry)
}
export function getArtifactReadVersion(slug: string): string | undefined {
  return artifactReadVersions.get(slug)
}
export function setArtifactReadVersion(slug: string, version: string): void {
  artifactReadVersions.set(slug, version)
}

type DeployInitResponse = {
  slug?: string
  version?: string
  putURL?: string
  putHeaders?: Record<string, string>
  conflict?: boolean
  liveVersion?: string
}

// RECOVERY-UNCERTAIN: the deploy API base. The minified client posts the
// relative path "/api/frame/deploy/init"; the base is taken to be CLAUDE_AI_ORIGIN
// (same host that serves the /code/artifact/ viewer). Confirm against the live
// service if the wire contract matters.
function deployApiUrl(path: string): string {
  return new URL(path, getOauthConfig().CLAUDE_AI_ORIGIN).toString()
}

/**
 * Publish (or redeploy) an artifact. (minified publishArtifact / V6q)
 *
 * Flow: wrap -> size check -> POST /api/frame/deploy/init -> PUT page to the
 * returned signed URL -> confirm. Returns the viewer URL + version on success.
 */
export async function publishArtifact(
  htmlBody: string,
  options: PublishArtifactOptions,
): Promise<PublishArtifactResult> {
  const { slug, title, favicon, label, mcp, baseVersion } = options
  const page = wrapArtifactHtml(htmlBody)
  const bytes = Buffer.byteLength(page, 'utf8')
  if (bytes > MAX_ARTIFACT_BYTES) {
    logEvent('artifact_publish', { outcome: 'too_large' })
    return publishError(
      `too large: rendered page is ${Math.ceil(bytes / 1024 / 1024)}MB (max ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB)`,
    )
  }

  // RECOVERY-UNCERTAIN: a "direct upload" fast path (minified ev4) exists for
  // certain entrypoints and when CLAUDE_CODE_ARTIFACT_DIRECT_UPLOAD is set. Its
  // body was not fully reconstructed; we log that it was requested and fall
  // through to the standard init+PUT flow.
  if (isEnvTruthy(process.env[ENV_ARTIFACT_DIRECT_UPLOAD])) {
    logForDebugging('[artifact] direct-upload requested; using standard deploy flow (RECOVERY-UNCERTAIN)')
  }

  const initBody = (includeMcp: boolean) => ({
    ...(slug && { slug }),
    title,
    favicon,
    ...(label && { label }),
    ...(includeMcp && mcp ? { mcp } : {}),
    ...(baseVersion && { baseVersion }),
  })

  let headers: Record<string, string>
  try {
    headers = { ...(await getOAuthHeaders()), 'X-Frame-CP': 'go' }
  } catch (e) {
    logEvent('artifact_publish', { outcome: 'no-auth' })
    return publishError(
      `not authenticated — run /login (${e instanceof Error ? e.message : String(e)})`,
    )
  }

  const postInit = (includeMcp: boolean) =>
    axios.post<DeployInitResponse>(deployApiUrl('/api/frame/deploy/init'), initBody(includeMcp), {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    })

  try {
    let res = await postInit(true)
    let mcpDropped: string | undefined

    // A 400 with an mcp manifest attached: retry once without it, remember why.
    if (res.status === 400 && mcp) {
      mcpDropped = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '(400, no body)')
      logForDebugging(`[artifact] init 400 with mcp, retrying without: ${mcpDropped}`)
      res = await postInit(false)
    }

    // Optimistic-concurrency conflict on a versioned redeploy.
    if (baseVersion && res.status === 409) {
      const liveVersion = (res.data as DeployInitResponse | undefined)?.liveVersion
      logEvent('artifact_publish', { outcome: 'conflict' })
      return { ...publishError(ARTIFACT_CONFLICT_MESSAGE), liveVersion, conflict: true }
    }

    if (res.status < 200 || res.status >= 300) {
      logEvent('artifact_publish', { outcome: 'init_failed' })
      return publishError(`init ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`)
    }

    const { slug: liveSlug, version, putURL, putHeaders } = res.data ?? {}
    if (!liveSlug || !version || !putURL) {
      logEvent('artifact_publish', { outcome: 'init_incomplete' })
      return publishError('init returned incomplete response')
    }

    // Upload the rendered page to the signed URL.
    const putRes = await axios.put(putURL, page, {
      headers: { 'Content-Type': 'text/html', ...(putHeaders ?? {}) },
      timeout: 15000,
      maxBodyLength: MAX_ARTIFACT_BYTES,
      maxContentLength: MAX_ARTIFACT_BYTES,
      validateStatus: () => true,
    })
    if (putRes.status < 200 || putRes.status >= 300) {
      await confirmDeploy(liveSlug, version, false)
      logEvent('artifact_publish', { outcome: putRes.status === 403 ? 'upload_blocked' : 'upload_failed' })
      const err = `upload ${putRes.status}`
      return baseVersion ? { ...publishError(err), liveVersion: version } : publishError(err)
    }

    await confirmDeploy(liveSlug, version, true)
    if (mcpDropped !== undefined) logEvent('artifact_publish', { outcome: 'mcp_rejected' })
    logEvent('artifact_publish', { outcome: 'success' })
    return {
      url: artifactViewerUrl(liveSlug),
      slug: liveSlug,
      version,
      err: null,
      ...(mcpDropped !== undefined && { mcpDropped }),
    }
  } catch (e) {
    logEvent('artifact_publish', { outcome: 'request_error' })
    return publishError(e instanceof Error ? e.message : String(e))
  }
}

// RECOVERY-UNCERTAIN: the confirm/finalize call (minified tv4) signals the
// backend whether the PUT succeeded. Endpoint shape inferred.
async function confirmDeploy(slug: string, version: string, ok: boolean): Promise<void> {
  try {
    const headers = { ...(await getOAuthHeaders()), 'X-Frame-CP': 'go' }
    await axios.post(
      deployApiUrl('/api/frame/deploy/confirm'),
      { slug, version, ok },
      { headers, timeout: 15000, validateStatus: () => true },
    )
  } catch (e) {
    logForDebugging(`[artifact] confirm failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
