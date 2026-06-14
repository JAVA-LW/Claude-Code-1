// Recovered from the 2.1.177 binary (cluster A — ArtifactTool).
//
// The Artifact tool renders a local .html/.md file to a default-private
// claude.ai web page ("Artifact") the user can later share. Reconstructed from
// the minified tool object (minified `pB4`/`dK(...)`) and its gating helpers.
// Gating predicates that depend on internal auth/connectivity helpers are
// reconstructed best-effort and flagged `RECOVERY-UNCERTAIN`.
import { extname, parse as parsePath, resolve } from 'path'
import { promises as fs } from 'fs'
import React from 'react'
import { marked } from 'marked'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import {
  buildTool,
  type ToolDef,
  type ToolUseContext,
  type ValidationResult,
} from '../../Tool.js'
import type { PermissionResult } from '../../types/permissions.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { openBrowser } from '../../utils/browser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  ARTIFACT_TOOL_NAME,
  ENV_ARTIFACT,
  ENV_ARTIFACT_AUTO_OPEN,
  ENV_DISABLE_ARTIFACT,
  MAX_ARTIFACT_BYTES,
} from './constants.js'
import { ARTIFACT_DESCRIPTION, ARTIFACT_PROMPT } from './prompt.js'
import {
  artifactViewerUrl,
  currentArtifactEnv,
  extractHtmlTitle,
  getArtifactReadVersion,
  getFrameUrl,
  parseArtifactUrl,
  publishArtifact,
  setArtifactReadVersion,
  setFrameUrl,
} from './publish.js'

/** Thrown for input problems surfaced to the model as a tool error. (minified FIH) */
export class ArtifactInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactInputError'
  }
}

// ---- gating -----------------------------------------------------------------

/** Env or settings hard-kill. (minified wv7) */
export function isArtifactHardDisabled(): boolean {
  if (isEnvTruthy(process.env[ENV_DISABLE_ARTIFACT])) return true
  // RECOVERY-UNCERTAIN: original reads `<config>.settings.disableArtifact === true`.
  return (getGlobalConfig() as { disableArtifact?: boolean })?.disableArtifact === true
}

/** SDK entrypoints default the tool off unless explicitly enabled. (minified Mv7) */
export function isArtifactSdkDefaultOff(): boolean {
  // RECOVERY-UNCERTAIN: minified Mv7 keys off CLAUDE_CODE_ENTRYPOINT; body not
  // fully reconstructed. Default to false (tool on unless other gates fail).
  return false
}

/** Plan-based admin allowance behind the growthbook gate. (minified jv7) */
export function isArtifactAdminAllowed(): boolean {
  const plan = getSubscriptionType()
  if (plan === 'pro' || plan === 'max') return false
  return getFeatureValue_CACHED_MAY_BE_STALE('allow_cobalt_plinth', false)
}

/**
 * Whether the Artifact tool is available in this session. (minified geH /
 * isArtifactToolEnabled). Internal codename: "cobalt plinth".
 */
export function isArtifactToolEnabled(): boolean {
  if (isArtifactHardDisabled()) return false
  // RECOVERY-UNCERTAIN: first-party-auth + connectivity gates (minified Tq()/l6()/K4())
  // are approximated by the entrypoint exclusions + subscription gate below.
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  if (entrypoint === 'local-agent' || entrypoint?.startsWith('claude-coworker')) {
    return false
  }
  const explicitlyEnabled = isEnvTruthy(process.env[ENV_ARTIFACT])
  if (!explicitlyEnabled && isArtifactSdkDefaultOff()) return false
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_plinth', false)) return false
  return isArtifactAdminAllowed()
}

/** Alias used by callers that gate the publish capability. (minified isPublishToolEnabled) */
export const isPublishToolEnabled = isArtifactToolEnabled

// ---- schema -----------------------------------------------------------------

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'Path to an .html or .md file to render. Use a short, distinctive basename — it is the fallback title if the HTML has no <title>.',
      ),
    favicon: z
      .string()
      .describe(
        'Browser-tab icon: one or two emoji (e.g. "📊"). No markup. Keep stable across redeploys; change only on a hard topic pivot.',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'Short human-readable name for this version (e.g. "fixed-background"). Shown in the version picker instead of the raw version id.',
      ),
    url: z
      .string()
      .optional()
      .describe(
        'Existing artifact URL to redeploy to. Pass when the user gives you a URL for an artifact not published in this session; omit for new artifacts or same-session redeploys. Must be an artifact the user owns.',
      ),
    // RECOVERY-UNCERTAIN: `force` is read by call() (minified `"force" in H`) but
    // is not in the published sdk-tools schema; modeled as an optional escape hatch.
    force: z
      .boolean()
      .optional()
      .describe(
        'Bypass the unseen-version guard and overwrite the current artifact version.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    url: z.string(),
    path: z.string(),
    title: z.string().optional(),
    version: z.string().optional(),
    mcpDropped: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ArtifactOutput = z.infer<OutputSchema>

function resolveArtifactPath(filePath: string): string {
  return resolve(getCwd(), filePath)
}

// ---- tool -------------------------------------------------------------------

export const ArtifactTool = buildTool({
  name: ARTIFACT_TOOL_NAME,
  searchHint: 'render an HTML or Markdown file to a claude.ai web page',
  maxResultSizeChars: 1000,
  shouldDefer: false,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isArtifactToolEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isDestructive() {
    // Publishing to the web is outward-facing and effectively irreversible.
    return true
  },
  userFacingName() {
    return 'Artifact'
  },
  getPath({ file_path }) {
    return resolveArtifactPath(file_path)
  },
  toAutoClassifierInput({ file_path, url }) {
    return url ? `${file_path} → ${url}` : file_path
  },
  async description() {
    return ARTIFACT_DESCRIPTION
  },
  async prompt() {
    return ARTIFACT_PROMPT
  },
  async validateInput({ file_path, favicon, url }): Promise<ValidationResult> {
    const ext = extname(file_path).toLowerCase()
    if (ext !== '.html' && ext !== '.htm' && ext !== '.md') {
      return {
        result: false,
        message: `unsupported file type: ${ext || '(none)'} — use .html or .md`,
        errorCode: 1,
      }
    }
    if (favicon.includes('<')) {
      return {
        result: false,
        message: 'favicon must be one or two emoji — no markup',
        errorCode: 1,
      }
    }
    if (url !== undefined) {
      const parsed = parseArtifactUrl(url)
      if (!parsed) {
        return { result: false, message: `not an artifact URL: ${url}`, errorCode: 1 }
      }
      const env = currentArtifactEnv()
      if (parsed.env !== env) {
        return {
          result: false,
          message: `that artifact URL is for ${parsed.env}, but this session targets ${env} claude.ai — republish it here to mint a ${env} URL, or switch environments`,
          errorCode: 1,
        }
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    // RECOVERY-UNCERTAIN: the original first merges the shared rule-based
    // permission check (minified q4H) for deny/ask rules. Here we implement the
    // artifact-specific allow/ask decision; rule-based denies still flow through
    // the general permission system around this tool method.
    const path = resolveArtifactPath(input.file_path)
    const existing = getFrameUrl(path)

    // Same-session redeploy of an already-published file: no re-confirm.
    if (input.url === undefined && existing !== undefined && parseArtifactUrl(existing.url)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'other',
          reason: 'Redeploy of an artifact already published this session',
        },
      }
    }

    let title: string | undefined
    if (extname(path).toLowerCase() !== '.md') {
      try {
        const head = await fs.readFile(path, 'utf8')
        title = extractHtmlTitle(head)
      } catch {
        // ignore — title is best-effort for the prompt message
      }
    }
    title = title ?? existing?.title

    const message =
      title !== undefined
        ? `Claude wants to publish "${title}" (${input.file_path}) to a private page on claude.ai`
        : `Claude wants to publish ${input.file_path} to a private page on claude.ai`

    return {
      behavior: 'ask',
      message,
      decisionReason: {
        type: 'other',
        reason: 'Publishing a file to the web requires confirmation',
      },
    }
  },
  async call(input, context): Promise<{ data: ArtifactOutput }> {
    const { file_path, favicon, label, url, force } = input
    const path = resolveArtifactPath(file_path)
    const isMarkdown = extname(path).toLowerCase() === '.md'

    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(path)
    } catch (e) {
      if (isENOENT(e)) throw new ArtifactInputError(`file not found: ${path}`)
      throw e
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new ArtifactInputError(
        `too large: ${Math.ceil(stat.size / 1024 / 1024)}MB (max ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB)`,
      )
    }

    const raw = await fs.readFile(path, 'utf8')
    const body = isMarkdown ? renderMarkdown(raw) : raw

    context.readFileState.set(path, {
      content: raw,
      timestamp: Math.floor(stat.mtimeMs),
      offset: undefined,
      limit: undefined,
    })

    const previous = getFrameUrl(path)
    const target = url ?? previous?.url
    const slug = target ? (parseArtifactUrl(target)?.slug ?? null) : null

    // Unseen-version write guard (only when the version flag is on).
    const versionGuardOn = getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_plinth_fern', false)
    const baseVersion =
      versionGuardOn && slug && force !== true ? getArtifactReadVersion(slug) : undefined
    if (versionGuardOn && slug && baseVersion === undefined && force !== true) {
      throw new ArtifactInputError(
        "This session hasn't viewed the latest version of the artifact. WebFetch the URL first, or pass force:true to overwrite.",
      )
    }

    const title =
      (isMarkdown ? undefined : extractHtmlTitle(raw)) ?? previous?.title ?? parsePath(path).name

    const result = await publishArtifact(body, {
      ...(slug ? { slug } : {}),
      title,
      favicon,
      ...(label ? { label } : {}),
      ...(baseVersion ? { baseVersion } : {}),
    })

    if (result.err !== null) {
      if (versionGuardOn && result.liveVersion && slug && !result.conflict) {
        setArtifactReadVersion(slug, result.liveVersion)
      }
      throw new ArtifactInputError(result.err)
    }

    // Auto-open a freshly-minted artifact in interactive sessions.
    // RECOVERY-UNCERTAIN: original also excludes remote/coworker/fork contexts
    // (minified V7/Mz/Tg/_6H) and keys off CLAUDE_CODE_ARTIFACT_AUTO_OPEN.
    const interactive = context.agentId === undefined && !context.options.isNonInteractiveSession
    if (slug === null && interactive && !isEnvTruthy(process.env[ENV_ARTIFACT_AUTO_OPEN])) {
      void openBrowser(result.url)
    }

    setFrameUrl(path, {
      url: result.url,
      updatedAt: Date.now(),
      title,
      favicon,
    })
    if (versionGuardOn) setArtifactReadVersion(result.slug, result.version)

    return {
      data: {
        url: result.url,
        path,
        title,
        version: result.version,
        ...(result.mcpDropped !== undefined && { mcpDropped: result.mcpDropped }),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const warning = output.mcpDropped
      ? `\n\n⚠ The mcp manifest was rejected by the server and the page was published without it (the page's connector bridge will be unavailable). Server said: ${output.mcpDropped}`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Published ${output.path} at ${output.url}${warning}`,
    }
  },
  renderToolUseMessage(input) {
    const { file_path, url } = input
    return React.createElement(
      Text,
      null,
      file_path,
      url ? React.createElement(Text, { dimColor: true }, ` → ${url}`) : null,
    )
  },
  renderToolResultMessage(output) {
    return React.createElement(Text, { dimColor: true }, `published ${output.url}`)
  },
} satisfies ToolDef<InputSchema, ArtifactOutput>)

/**
 * Render Markdown to a self-contained HTML body. (minified CB4)
 * RECOVERY-UNCERTAIN: the original markdown renderer config is not fully known;
 * uses the bundled `marked` synchronously, consistent with other call sites.
 */
function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}
