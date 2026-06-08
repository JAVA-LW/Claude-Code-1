import { randomBytes } from 'crypto'
import { constants as fsConstants } from 'fs'
import { open, realpath, stat } from 'fs/promises'
import { extname, resolve, sep } from 'path'
import { z } from 'zod/v4'
import { getOauthConfig } from '../../constants/oauth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { refreshOAuthToken } from '../../services/oauth/client.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getClaudeAIOAuthTokens,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'

const DESIGN_SYNC_TOOL_NAME = 'DesignSync'
const DESIGN_SERVICE = 'anthropic.omelette.api.v1alpha.OmeletteService'
const DESIGN_PROJECT_TYPE = 'PROJECT_TYPE_DESIGN_SYSTEM'
const DESIGN_READ_SCOPE = 'user:design:read'
const DESIGN_WRITE_SCOPE = 'user:design:write'
const DESIGN_SCOPE_NOTICE =
  "Upgraded your claude.ai login to include design-system access (user:design:read, user:design:write). This lets /design-sync read and write your org's design-system projects on claude.ai/design."
const MAX_PATH_LENGTH = 256
const MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024
const MAX_WILDCARDS_PER_PATTERN = 3
const TEXT_EXTENSIONS = new Set([
  'html',
  'css',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'json',
  'svg',
  'xml',
  'md',
  'txt',
  'csv',
  'yaml',
  'yml',
  'toml',
])

type Plan = {
  projectId: string
  writes: string[]
  deletes: string[]
  localDir?: string
}

type DesignAuthResult =
  | { ok: true; accessToken: string; expanded: boolean }
  | {
      ok: false
      reason:
        | 'wrong_provider'
        | 'essential_traffic_only'
        | 'no_token'
        | 'no_refresh'
        | 'expand_failed'
      detail?: string
    }

class DesignRpcError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Design API ${method} failed: HTTP ${status} ${summarizeBody(body)}`)
    this.name = 'DesignRpcError'
  }
}

class DesignAuthError extends DesignRpcError {
  constructor(method: string, status: number, body: unknown) {
    super(method, status, body)
    this.name = 'DesignAuthError'
  }
}

const fileInputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .min(1)
      .max(MAX_PATH_LENGTH)
      .describe('Path within the project, e.g. components/button/index.html'),
    localPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Path on disk to read file contents from, relative to the localDir approved at finalize_plan. Preferred for anything you have on disk: the tool reads, encodes, and uploads directly so the contents never enter the model context. Mutually exclusive with data.',
      ),
    data: z
      .string()
      .optional()
      .describe(
        'Inline file contents (UTF-8 text, or base64 when encoding is "base64"). For small dynamic content only — anything you have on disk should use localPath instead.',
      ),
    encoding: z.enum(['base64']).optional().describe('Set to "base64" for binary inline data'),
    mimeType: z.string().optional(),
  }),
)

type DesignFileInput = z.infer<ReturnType<typeof fileInputSchema>>

const assetInputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .min(1)
      .max(255)
      .describe('Short human-readable label ("Primary buttons"), not a path'),
    path: z
      .string()
      .min(1)
      .max(MAX_PATH_LENGTH)
      .describe('Project-relative path to the preview/spec file this card renders'),
    subtitle: z
      .string()
      .max(255)
      .optional()
      .describe('Variants shown ("Primary / secondary / ghost, 3 sizes")'),
    viewport: z
      .strictObject({
        width: z.number().int().positive(),
        height: z.number().int().positive().optional(),
      })
      .optional()
      .describe('Card dimensions in the Design System pane'),
    group: z
      .string()
      .max(64)
      .optional()
      .describe(
        'Free-form section label for the Design System pane (max 64 chars). Use the source design system\'s own categorization if it has one — e.g. Material has Buttons/Cards/Forms/etc., a corporate kit might have Actions/Forms/Navigation. Common foundational labels: "Type", "Colors", "Spacing", "Components", "Brand". The pane groups by the value you send.',
      ),
  }),
)

type DesignAssetInput = z.infer<ReturnType<typeof assetInputSchema>>

const inputSchema = lazySchema(() =>
  z.strictObject({
    method: z.enum([
      'list_projects',
      'get_project',
      'list_files',
      'get_file',
      'finalize_plan',
      'write_files',
      'delete_files',
      'register_assets',
      'unregister_assets',
      'create_project',
      'report_validate',
    ]),
    projectId: z
      .string()
      .min(1)
      .optional()
      .describe('Required for all methods except list_projects and create_project'),
    path: z.string().min(1).optional().describe('get_file: file path to read'),
    writes: z
      .array(z.string().min(1).max(MAX_PATH_LENGTH))
      .max(256)
      .optional()
      .describe(
        'finalize_plan: exact paths or glob patterns that will be written. `*` matches within a single segment, `**` matches any depth (e.g. `ui_kits/acme/**/*.html`). Max 3 `*`/`**` wildcards per pattern and max 256 entries — use broader globs to cover more files rather than enumerating paths.',
      ),
    deletes: z
      .array(z.string().min(1).max(MAX_PATH_LENGTH))
      .max(256)
      .optional()
      .describe('finalize_plan: exact paths or glob patterns that will be deleted (same syntax and limits as writes).'),
    planId: z
      .string()
      .min(1)
      .optional()
      .describe('write_files/delete_files/register_assets/unregister_assets: token from a prior finalize_plan call'),
    files: z
      .array(fileInputSchema())
      .max(256)
      .optional()
      .describe('write_files: file contents to write (max 256 per call — split larger bundles across multiple write_files calls under the same planId).'),
    paths: z
      .array(z.string().min(1).max(MAX_PATH_LENGTH))
      .max(256)
      .optional()
      .describe('delete_files: paths to delete. unregister_assets: paths whose Design System pane card should be removed. Max 256 per call — split larger batches across multiple calls under the same planId.'),
    name: z.string().min(1).max(200).optional().describe('create_project: name for the new design-system project'),
    assets: z
      .array(assetInputSchema())
      .max(256)
      .optional()
      .describe('register_assets: cards to register in the Design System pane. Each path must be in the finalized plan. Run after write_files succeeds. Max 256 per call.'),
    localDir: z
      .string()
      .min(1)
      .optional()
      .describe('finalize_plan: directory the bundle was built into. write_files with localPath may only read files inside this directory. Defaults to the current working directory. Resolved to an absolute path and shown in the permission prompt.'),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        bad: z.number().int().nonnegative(),
        thin: z.number().int().nonnegative(),
        variantsIdentical: z.number().int().nonnegative(),
        iterations: z.number().int().nonnegative(),
      })
      .optional()
      .describe('report_validate: aggregate from the final .render-check.json — counts only, no component names or paths.'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => {
  const notice = { notice: z.string().optional() }
  return z.discriminatedUnion('method', [
    z.object({
      method: z.literal('list_projects'),
      ...notice,
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          ownerDisplayName: z.string().optional(),
          isOwned: z.boolean().optional(),
          updatedAt: z.string().optional(),
        }),
      ),
    }),
    z.object({
      method: z.literal('get_project'),
      ...notice,
      projectId: z.string(),
      name: z.string(),
      type: z.string().optional(),
      ownerDisplayName: z.string().optional(),
      isOwned: z.boolean().optional(),
      canEdit: z.boolean().optional(),
    }),
    z.object({ method: z.literal('list_files'), ...notice, paths: z.array(z.string()) }),
    z.object({
      method: z.literal('get_file'),
      ...notice,
      path: z.string(),
      content: z.string(),
      contentType: z.string(),
      isBase64: z.boolean(),
      truncated: z.boolean(),
    }),
    z.object({
      method: z.literal('finalize_plan'),
      ...notice,
      planId: z.string(),
      writes: z.array(z.string()),
      deletes: z.array(z.string()),
    }),
    z.object({ method: z.literal('write_files'), ...notice, written: z.number() }),
    z.object({ method: z.literal('delete_files'), ...notice, deleted: z.number() }),
    z.object({ method: z.literal('register_assets'), ...notice, registered: z.number() }),
    z.object({ method: z.literal('unregister_assets'), ...notice, unregistered: z.number() }),
    z.object({ method: z.literal('create_project'), ...notice, projectId: z.string(), name: z.string() }),
    z.object({ method: z.literal('report_validate'), ...notice }),
  ])
})

type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

const REQUIRED_FIELDS: Record<Input['method'], { present: Array<keyof Input>; nonEmpty: Array<keyof Input> }> = {
  list_projects: { present: [], nonEmpty: [] },
  get_project: { present: ['projectId'], nonEmpty: [] },
  list_files: { present: ['projectId'], nonEmpty: [] },
  get_file: { present: ['projectId', 'path'], nonEmpty: [] },
  finalize_plan: { present: ['projectId', 'writes', 'deletes'], nonEmpty: [] },
  write_files: { present: ['projectId', 'planId'], nonEmpty: ['files'] },
  delete_files: { present: ['projectId', 'planId'], nonEmpty: ['paths'] },
  register_assets: { present: ['projectId', 'planId'], nonEmpty: ['assets'] },
  unregister_assets: { present: ['projectId', 'planId'], nonEmpty: ['paths'] },
  create_project: { present: ['name'], nonEmpty: [] },
  report_validate: { present: ['counts'], nonEmpty: [] },
}

const plans = new Map<string, Plan>()

function isDesignSyncEnabled(): boolean {
  if (!isPolicyAllowed('allow_design_sync')) return false
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_DESIGN_SYNC) && getAPIProvider() === 'firstParty') return true
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_quill', false)
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.').join('/')
}

function isReservedPath(path: string): boolean {
  const normalized = normalizeProjectPath(path).toLowerCase()
  return normalized === 'claude.md' || normalized.startsWith('claude.md/') || normalized === '.claude' || normalized.startsWith('.claude/')
}

function hasGlob(path: string): boolean {
  return /[*?]/.test(path)
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  let index = 0
  let wildcardCount = 0
  const countWildcard = () => {
    wildcardCount++
    if (wildcardCount > MAX_WILDCARDS_PER_PATTERN) {
      throw new Error(`glob "${pattern}" exceeds ${MAX_WILDCARDS_PER_PATTERN} '*'/'**' wildcards`)
    }
  }

  while (index < pattern.length) {
    const char = pattern.charAt(index)
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      countWildcard()
      if (pattern.charAt(index + 2) === '/') {
        source += '(?:.*/)?'
        index += 3
      } else {
        source += '.*'
        index += 2
      }
    } else if (char === '*') {
      countWildcard()
      source += '[^/]*'
      index++
    } else if (char === '?') {
      source += '[^/]'
      index++
    } else if (/[.+^$|()[\]{}\\]/.test(char)) {
      source += `\\${char}`
      index++
    } else {
      source += char
      index++
    }
  }
  return new RegExp(`^${source}$`)
}

function pathMatchesPlan(path: string, patterns: string[]): boolean {
  const normalized = normalizeProjectPath(path)
  if (!normalized || normalized.length > MAX_PATH_LENGTH || normalized.split('/').includes('..') || normalized.includes('\0')) {
    return false
  }
  for (const pattern of patterns) {
    const normalizedPattern = normalizeProjectPath(pattern)
    if (hasGlob(normalizedPattern)) {
      try {
        if (globToRegExp(normalizedPattern).test(normalized)) return true
      } catch {
        // Invalid globs are rejected during finalize_plan; ignore stale bad plans defensively.
      }
    } else if (normalizedPattern === normalized) {
      return true
    }
  }
  return false
}

function registerPlan(plan: Plan): string {
  for (const pattern of [...plan.writes, ...plan.deletes]) {
    if (hasGlob(pattern)) globToRegExp(pattern)
  }
  const prefix = plan.projectId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'anon'
  const planId = `plan_${prefix}_${randomBytes(6).toString('hex')}`
  plans.set(planId, plan)
  return planId
}

function getPlan(planId: string | undefined): Plan | null {
  if (!planId || !/^plan_[a-z0-9]{1,16}_[a-f0-9]{12}$/.test(planId)) return null
  return plans.get(planId) ?? null
}

function missingFields(input: Input): string[] {
  const rule = REQUIRED_FIELDS[input.method]
  const missingPresent = rule.present.filter(key => input[key] === undefined)
  const missingNonEmpty = rule.nonEmpty.filter(key => {
    const value = input[key]
    return value === undefined || (Array.isArray(value) && value.length === 0)
  })
  return [...missingPresent, ...missingNonEmpty]
}

function isReadMethod(method: Input['method']): boolean {
  return method === 'list_projects' || method === 'get_project' || method === 'list_files' || method === 'get_file' || method === 'report_validate'
}

function shortProject(projectId: string | undefined): string {
  if (!projectId) return '?'
  return projectId.length > 12 ? `${projectId.slice(0, 8)}…` : projectId
}

function summarizeAction(input: Partial<Input> | undefined): string {
  switch (input?.method) {
    case 'list_projects':
      return 'List design-system projects'
    case 'get_project':
      return 'Read project metadata'
    case 'list_files':
      return 'List project files'
    case 'get_file':
      return input.path ? `Read ${input.path}` : 'Read file'
    case 'finalize_plan': {
      const writes = input.writes?.length ?? 0
      const deletes = input.deletes?.length ?? 0
      return `Upload design system (${deletes > 0 ? `${writes} to upload, ${deletes} to delete` : `${writes} to upload`})`
    }
    case 'write_files': {
      const files = input.files?.length ?? 0
      const diskFiles = input.files?.filter(file => file.localPath !== undefined).length ?? 0
      const suffix = diskFiles > 0 && diskFiles < files ? ` (${diskFiles} from disk, ${files - diskFiles} inline)` : diskFiles === files && files > 0 ? ' from disk' : ''
      return `Write ${files} ${files === 1 ? 'file' : 'files'}${suffix}`
    }
    case 'delete_files':
      return `Delete ${input.paths?.length ?? 0} ${(input.paths?.length ?? 0) === 1 ? 'file' : 'files'}`
    case 'register_assets':
      return `Register ${input.assets?.length ?? 0} ${(input.assets?.length ?? 0) === 1 ? 'asset card' : 'asset cards'}`
    case 'unregister_assets':
      return `Unregister ${input.paths?.length ?? 0} ${(input.paths?.length ?? 0) === 1 ? 'asset card' : 'asset cards'}`
    case 'create_project':
      return input.name ? `Create project "${input.name}"` : 'Create design-system project'
    case 'report_validate':
      return 'Report validate metrics'
    default:
      return 'Design sync'
  }
}

function authGuidance(reason: Exclude<DesignAuthResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'no_token':
      return 'Run /login to sign in to claude.ai, then retry.'
    case 'no_refresh':
      return 'The OAuth token was supplied via CLAUDE_CODE_OAUTH_TOKEN and cannot be expanded with design scopes. Run /login in this session.'
    case 'expand_failed':
      return 'Could not add design scopes to the token. Run /login and retry.'
    case 'wrong_provider':
      return 'DesignSync is only available with claude.ai authentication. It is not supported through Bedrock, Vertex, or other third-party providers.'
    case 'essential_traffic_only':
      return 'DesignSync is unavailable while nonessential network traffic is restricted (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set). Unset it to use /design-sync.'
  }
}

function hasDesignScopes(scopes: unknown): boolean {
  return Array.isArray(scopes) && scopes.includes(DESIGN_READ_SCOPE) && scopes.includes(DESIGN_WRITE_SCOPE)
}

async function getDesignAuth(): Promise<DesignAuthResult> {
  if (getAPIProvider() !== 'firstParty') return { ok: false, reason: 'wrong_provider' }
  if (isEssentialTrafficOnly()) return { ok: false, reason: 'essential_traffic_only' }

  let tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) return { ok: false, reason: 'no_token' }
  if (hasDesignScopes(tokens.scopes)) return { ok: true, accessToken: tokens.accessToken, expanded: false }
  if (!tokens.refreshToken) return { ok: false, reason: 'no_refresh' }

  try {
    const expanded = await refreshOAuthToken(tokens.refreshToken, {
      scopes: [
        ...new Set([
          ...((Array.isArray(tokens.scopes) ? tokens.scopes : []) as string[]),
          DESIGN_READ_SCOPE,
          DESIGN_WRITE_SCOPE,
        ]),
      ],
    })
    saveOAuthTokensIfNeeded(expanded)
    tokens = getClaudeAIOAuthTokens()
    const accessToken = tokens?.accessToken ?? expanded.accessToken
    if (!hasDesignScopes(expanded.scopes) || !accessToken) {
      return { ok: false, reason: 'expand_failed', detail: 'refresh succeeded but design scopes not granted' }
    }
    return { ok: true, accessToken, expanded: true }
  } catch (error) {
    return { ok: false, reason: 'expand_failed', detail: errorMessage(error) }
  }
}

async function requireDesignAuth(): Promise<{ accessToken: string; expanded: boolean }> {
  const result = await getDesignAuth()
  if (!result.ok) {
    const prefix = result.reason === 'wrong_provider' || result.reason === 'essential_traffic_only' ? '' : 'DesignSync needs a claude.ai login. '
    const detail = result.detail ? ` (${result.detail})` : ''
    throw new Error(`${prefix}${authGuidance(result.reason)}${detail}`)
  }
  return { accessToken: result.accessToken, expanded: result.expanded }
}

function needsScopeExpansion(): boolean {
  if (getAPIProvider() !== 'firstParty' || isEssentialTrafficOnly()) return false
  const tokens = getClaudeAIOAuthTokens()
  return !!tokens?.accessToken && !!tokens.refreshToken && !hasDesignScopes(tokens.scopes)
}

function requireField<T>(value: T | undefined, field: string, method: string): T {
  if (value === undefined) throw new Error(`${method} requires "${field}"`)
  return value
}

async function resolveLocalDir(localDir: string | undefined): Promise<string> {
  return realpath(resolve(getCwd(), localDir ?? '.'))
}

function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

async function filePayload(input: DesignFileInput, localDir: string | undefined) {
  const path = normalizeProjectPath(input.path)
  if (input.localPath === undefined) {
    if (input.data === undefined) throw new Error(`write_files: ${path} has neither data nor localPath`)
    return { path, data: input.data, encoding: input.encoding, mimeType: input.mimeType }
  }
  if (input.data !== undefined) throw new Error(`write_files: ${path} has both data and localPath`)
  if (localDir === undefined) {
    throw new Error('write_files with localPath requires a plan finalized with localDir. Re-run finalize_plan with the bundle directory.')
  }

  const base = resolve(localDir)
  const rawPath = resolve(base, input.localPath)
  if (rawPath !== base && !rawPath.startsWith(withTrailingSeparator(base))) {
    throw new Error('write_files: localPath must be inside the directory approved at finalize_plan.')
  }

  const [fileRealPath, baseRealPath] = await Promise.all([realpath(rawPath), realpath(base)])
  if (fileRealPath !== baseRealPath && !fileRealPath.startsWith(withTrailingSeparator(baseRealPath))) {
    throw new Error('write_files: localPath resolves outside the directory approved at finalize_plan.')
  }

  const handle = await open(fileRealPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('write_files: localPath must be a regular file.')
    if (info.size > MAX_LOCAL_FILE_BYTES) throw new Error(`write_files: file at localPath exceeds the ${MAX_LOCAL_FILE_BYTES} byte limit.`)
    const data = await handle.readFile()
    const extension = extname(fileRealPath).slice(1).toLowerCase()
    if (TEXT_EXTENSIONS.has(extension)) {
      return { path, data: data.toString('utf8'), mimeType: input.mimeType }
    }
    return { path, data: data.toString('base64'), encoding: 'base64' as const, mimeType: input.mimeType }
  } finally {
    await handle.close()
  }
}

async function designApiRequest(method: string, accessToken: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${getOauthConfig().BASE_API_URL}/${DESIGN_SERVICE}/${method}`, {
      method: 'POST',
      headers: {
        ...getOAuthHeaders(accessToken),
        'X-Anthropic-Client': 'claude-cli-design-sync',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    if (response.status === 401 || response.status === 403) throw new DesignAuthError(method, response.status, data)
    if (response.status < 200 || response.status >= 300) throw new DesignRpcError(method, response.status, data)
    return data as Record<string, unknown>
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

async function listProjects(accessToken: string, signal: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const data = await designApiRequest('ListOrgProjects', accessToken, { type: DESIGN_PROJECT_TYPE }, signal)
  return Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : []
}

async function listProjectFiles(accessToken: string, projectId: string, signal: AbortSignal): Promise<string[]> {
  const paths: string[] = []
  let offset = 0
  for (let page = 0; page < 50; page++) {
    const data = await designApiRequest('ListFiles', accessToken, { projectId, depth: -1, ...(offset > 0 && { offset }) }, signal)
    const entries = Array.isArray(data.entries) ? data.entries as Array<Record<string, unknown>> : []
    for (const entry of entries) {
      if (typeof entry.path === 'string') paths.push(entry.path)
    }
    if (!data.truncated || entries.length === 0) return paths
    offset += entries.length
  }
  throw new DesignRpcError('ListFiles', 0, { error: `pagination exceeded 50 pages (${paths.length} paths)` })
}

async function getProjectFile(accessToken: string, projectId: string, path: string, signal: AbortSignal, maxBytes = 262_144) {
  const data = await designApiRequest('GetFile', accessToken, { projectId, path, raw: true }, signal)
  const content = typeof data.content === 'string' ? data.content : ''
  const isBase64 = data.isBase64 === true
  let rendered: string
  let truncated = false
  if (isBase64) {
    rendered = content
    if (rendered.length > maxBytes) {
      rendered = rendered.slice(0, maxBytes)
      truncated = true
    }
  } else {
    let buffer = Buffer.from(content, 'base64')
    if (buffer.byteLength > maxBytes) {
      buffer = buffer.subarray(0, maxBytes)
      truncated = true
    }
    rendered = buffer.toString('utf8')
  }
  return {
    content: rendered,
    contentType: typeof data.contentType === 'string' ? data.contentType : '',
    isBase64,
    truncated,
  }
}

async function execute(input: Input, accessToken: string, signal: AbortSignal): Promise<Output> {
  switch (input.method) {
    case 'list_projects': {
      const projects = await listProjects(accessToken, signal)
      return {
        method: 'list_projects',
        projects: projects
          .filter(project => project.canEdit ?? project.isOwned ?? false)
          .map(project => ({
            projectId: String(project.projectId),
            name: String(project.name),
            ...(typeof project.ownerDisplayName === 'string' && { ownerDisplayName: project.ownerDisplayName }),
            ...(typeof project.isOwned === 'boolean' && { isOwned: project.isOwned }),
            ...(typeof project.updatedAt === 'string' && { updatedAt: project.updatedAt }),
          })),
      }
    }
    case 'get_project': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const project = await designApiRequest('GetProject', accessToken, { projectId }, signal)
      return {
        method: 'get_project',
        projectId: String(project.projectId),
        name: String(project.name),
        ...(typeof project.type === 'string' && { type: project.type }),
        ...(typeof project.ownerDisplayName === 'string' && { ownerDisplayName: project.ownerDisplayName }),
        ...(typeof project.isOwned === 'boolean' && { isOwned: project.isOwned }),
        ...(typeof project.canEdit === 'boolean' && { canEdit: project.canEdit }),
      }
    }
    case 'list_files': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      return { method: 'list_files', paths: await listProjectFiles(accessToken, projectId, signal) }
    }
    case 'get_file': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const path = requireField(input.path, 'path', input.method)
      const file = await getProjectFile(accessToken, projectId, path, signal)
      return { method: 'get_file', path, content: file.content, contentType: file.contentType, isBase64: file.isBase64, truncated: file.truncated }
    }
    case 'finalize_plan': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const writes = requireField(input.writes, 'writes', input.method).map(normalizeProjectPath)
      const deletes = requireField(input.deletes, 'deletes', input.method).map(normalizeProjectPath)
      const localDir = await resolveLocalDir(input.localDir)
      return { method: 'finalize_plan', planId: registerPlan({ projectId, writes, deletes, localDir }), writes, deletes }
    }
    case 'write_files': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const plan = getPlan(input.planId)
      if (!plan || plan.projectId !== projectId) throw new Error('Plan token is missing or does not match this project. Call finalize_plan first.')
      const files = requireField(input.files, 'files', input.method)
      const reserved = files.map(file => file.path).filter(isReservedPath)
      if (reserved.length > 0) throw new Error(`Cannot write reserved paths: ${reserved.join(', ')}. CLAUDE.md and .claude/ carry instructions to the design agent and are blocked regardless of the plan.`)
      const outside = files.map(file => normalizeProjectPath(file.path)).filter(path => !pathMatchesPlan(path, plan.writes))
      if (outside.length > 0) throw new Error(`Cannot write paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`)
      const payloads = []
      for (let index = 0; index < files.length; index += 32) {
        if (signal.aborted) throw new Error('The operation was aborted.')
        payloads.push(...await Promise.all(files.slice(index, index + 32).map(file => filePayload(file, plan.localDir))))
      }
      const data = await designApiRequest('WriteFiles', accessToken, { projectId, files: payloads, deduplicate: false }, signal)
      return { method: 'write_files', written: Array.isArray(data.files) ? data.files.length : 0 }
    }
    case 'delete_files': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const plan = getPlan(input.planId)
      if (!plan || plan.projectId !== projectId) throw new Error('Plan token is missing or does not match this project. Call finalize_plan first.')
      const paths = requireField(input.paths, 'paths', input.method).map(normalizeProjectPath)
      const reserved = paths.filter(isReservedPath)
      if (reserved.length > 0) throw new Error(`Cannot delete reserved paths: ${reserved.join(', ')}. CLAUDE.md and .claude/ carry instructions to the design agent and are blocked regardless of the plan.`)
      const outside = paths.filter(path => !pathMatchesPlan(path, plan.deletes))
      if (outside.length > 0) throw new Error(`Cannot delete paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`)
      const data = await designApiRequest('DeleteFiles', accessToken, { projectId, paths }, signal)
      return { method: 'delete_files', deleted: typeof data.deleted === 'number' ? data.deleted : 0 }
    }
    case 'register_assets': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const plan = getPlan(input.planId)
      if (!plan || plan.projectId !== projectId) throw new Error('Plan token is missing or does not match this project. Call finalize_plan first.')
      const assets = requireField(input.assets, 'assets', input.method)
      const outside = assets.map(asset => normalizeProjectPath(asset.path)).filter(path => !pathMatchesPlan(path, plan.writes))
      if (outside.length > 0) throw new Error(`Cannot register paths outside the finalized plan: ${outside.join(', ')}. Re-run finalize_plan with the full set.`)
      let registered = 0
      for (const asset of assets) {
        if (signal.aborted) throw new Error('The operation was aborted.')
        await designApiRequest('RecordAsset', accessToken, {
          projectId,
          name: asset.name,
          path: normalizeProjectPath(asset.path),
          ...(asset.subtitle && { subtitle: asset.subtitle }),
          ...(asset.viewport && { viewport: asset.viewport }),
          ...(asset.group && { section: asset.group }),
        }, signal)
        registered++
      }
      return { method: 'register_assets', registered }
    }
    case 'unregister_assets': {
      const projectId = requireField(input.projectId, 'projectId', input.method)
      const plan = getPlan(input.planId)
      if (!plan || plan.projectId !== projectId) throw new Error('Plan token is missing or does not match this project. Call finalize_plan first.')
      const paths = requireField(input.paths, 'paths', input.method).map(normalizeProjectPath)
      const outside = paths.filter(path => !pathMatchesPlan(path, plan.deletes))
      if (outside.length > 0) throw new Error(`Cannot unregister cards for paths outside the finalized plan's deletes: ${outside.join(', ')}. Re-run finalize_plan with the full set.`)
      let unregistered = 0
      for (const path of paths) {
        if (signal.aborted) throw new Error('The operation was aborted.')
        await designApiRequest('DeleteAsset', accessToken, { projectId, path }, signal)
        unregistered++
      }
      return { method: 'unregister_assets', unregistered }
    }
    case 'create_project': {
      const name = requireField(input.name, 'name', input.method)
      const project = await designApiRequest('CreateProject', accessToken, { name, type: DESIGN_PROJECT_TYPE }, signal)
      if (!project.projectId) throw new DesignRpcError('CreateProject', 200, project)
      return { method: 'create_project', projectId: String(project.projectId), name }
    }
    case 'report_validate':
      return { method: 'report_validate' }
  }
}

function summarizeBody(body: unknown): string {
  if (body == null) return ''
  if (typeof body === 'string') return body.slice(0, 200)
  try {
    return JSON.stringify(body).slice(0, 200)
  } catch {
    return String(body).slice(0, 200)
  }
}

function redactToken(message: string, token: string): string {
  if (!token) return message
  return message.split(token).join('[redacted-oauth-token]')
}

export const DesignSyncTool = buildTool({
  name: DESIGN_SYNC_TOOL_NAME,
  searchHint: 'sync local design system components to a claude.ai/design project',
  shouldDefer: true,
  maxResultSizeChars: 300_000,
  isEnabled() {
    return isDesignSyncEnabled()
  },
  async description() {
    return 'Sync local design system files and asset cards to claude.ai/design projects.'
  },
  async prompt() {
    return 'Use this tool to sync local design system components to a claude.ai/design project. Read methods inspect projects and files. For writes, first call finalize_plan with all paths or globs to upload/delete and the localDir containing generated files; then call write_files, delete_files, register_assets, or unregister_assets with the returned planId.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input: Input) {
    return isReadMethod(input.method)
  },
  isDestructive(input: Input) {
    return input.method === 'write_files' || input.method === 'delete_files' || input.method === 'unregister_assets'
  },
  userFacingName(input: Partial<Input> | undefined) {
    return `Design: ${summarizeAction(input)}`
  },
  getToolUseSummary(input: Partial<Input> | undefined) {
    return input?.method ? summarizeAction(input) : null
  },
  toAutoClassifierInput(input: Input) {
    if (input.method === 'finalize_plan') {
      const summarizePaths = (paths: string[] | undefined) => {
        const values = paths ?? []
        if (values.length <= 50) return values.join(', ')
        return `${values.length} paths (too many to list here; the user's permission prompt shows the full list)`
      }
      return `project ${input.projectId ?? '?'} from ${resolve(getCwd(), input.localDir ?? '.')}: write ${summarizePaths(input.writes)}; delete ${summarizePaths(input.deletes)}`
    }
    if (input.method === 'create_project') return `create project "${input.name ?? '?'}"`
    return input.method
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (input.method === 'finalize_plan') return shortProject(input.projectId)
    return summarizeAction(input)
  },
  async validateInput(input: Input) {
    const missing = missingFields(input)
    if (missing.length > 0) return { result: false as const, message: `${input.method} requires: ${missing.join(', ')}.`, errorCode: 1 }
    if (input.method === 'finalize_plan' && (input.writes?.length ?? 0) === 0 && (input.deletes?.length ?? 0) === 0) {
      return { result: false as const, message: 'finalize_plan needs at least one write or delete path.', errorCode: 1 }
    }
    if (input.method === 'write_files') {
      for (const file of input.files ?? []) {
        const hasData = file.data !== undefined
        const hasLocalPath = file.localPath !== undefined
        if (hasData === hasLocalPath) {
          return { result: false as const, message: `Each file needs exactly one of "data" or "localPath" (offending path: ${file.path}).`, errorCode: 1 }
        }
        if (hasLocalPath && file.encoding !== undefined) {
          return { result: false as const, message: `"encoding" only applies to inline "data"; localPath files are encoded automatically (offending path: ${file.path}).`, errorCode: 1 }
        }
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input: Input) {
    const scopeMessage = needsScopeExpansion()
      ? 'DesignSync needs design-system access added to your claude.ai login (user:design:read, user:design:write). Approving refreshes your token with these scopes — you\'ll be able to read and write your org\'s design-system projects on claude.ai/design.'
      : null

    if (scopeMessage && input.method !== 'finalize_plan' && input.method !== 'create_project') {
      return {
        behavior: 'ask' as const,
        message: scopeMessage,
        updatedInput: input,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: 'scope expansion — approving persists user:design:write to the OAuth credential store',
          classifierApprovable: false,
        },
      }
    }

    if (input.method === 'finalize_plan') {
      let localDir: string
      try {
        localDir = await resolveLocalDir(input.localDir)
      } catch (error) {
        return {
          behavior: 'deny' as const,
          message: `localDir does not exist or is not accessible: ${input.localDir ?? getCwd()} (${errorMessage(error)})`,
          decisionReason: { type: 'safetyCheck' as const, reason: 'localDir not found', classifierApprovable: false },
        }
      }

      const writes = (input.writes ?? []).map(normalizeProjectPath)
      const deletes = (input.deletes ?? []).map(normalizeProjectPath)
      const globWrites = writes.filter(hasGlob)
      const literalWrites = writes.filter(path => !hasGlob(path))
      const globDeletes = deletes.filter(hasGlob)
      const literalDeletes = deletes.filter(path => !hasGlob(path))
      const existingWrites = await Promise.all(literalWrites.map(async path => {
        try {
          await stat(resolve(localDir, path))
          return true
        } catch {
          return false
        }
      }))
      const missingWrites = literalWrites.filter((_, index) => !existingWrites[index])
      const missingNote = literalWrites.length - missingWrites.length > 0 && missingWrites.length > 0
        ? `⚠ ${missingWrites.length} of ${literalWrites.length} literal write ${literalWrites.length === 1 ? 'path' : 'paths'} not found under localDir — expected if they use a different localPath or inline data, otherwise check for a typo: ${missingWrites.slice(0, 5).join(', ')}${missingWrites.length > 5 ? `, … and ${missingWrites.length - 5} more` : ''}`
        : null

      return {
        behavior: 'ask' as const,
        message: [
          scopeMessage,
          `To project: ${shortProject(input.projectId)}`,
          `From folder: ${localDir}`,
          literalWrites.length > 0 ? `Upload ${literalWrites.length} ${literalWrites.length === 1 ? 'file' : 'files'}: ${literalWrites.join(', ')}` : null,
          globWrites.length > 0 ? `Upload files matching: ${globWrites.join(', ')}` : null,
          missingNote,
          literalDeletes.length > 0 ? `Delete ${literalDeletes.length} ${literalDeletes.length === 1 ? 'file' : 'files'}: ${literalDeletes.join(', ')}` : null,
          globDeletes.length > 0 ? `Delete files matching: ${globDeletes.join(', ')}` : null,
        ].filter(value => value !== null).join('\n'),
        updatedInput: { ...input, localDir },
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: scopeMessage ? 'Approving also grants Claude ongoing write access to your design projects.' : 'Review what will be uploaded before continuing.',
          classifierApprovable: false,
        },
      }
    }

    if (input.method === 'create_project') {
      return {
        behavior: 'ask' as const,
        message: [
          scopeMessage,
          `Create design-system project "${input.name ?? '?'}" on claude.ai/design. The new project will be visible to your whole org (server default — you can change this from the Share menu after creation).`,
        ].filter(value => value !== null).join('\n'),
        updatedInput: input,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: scopeMessage ? 'Approving also grants Claude ongoing write access to your design projects.' : 'This creates a new project on your claude.ai account.',
          classifierApprovable: false,
        },
      }
    }

    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input, context) {
    if (input.method === 'report_validate') return { data: { method: 'report_validate' as const } }
    let token = ''
    try {
      const auth = await requireDesignAuth()
      token = auth.accessToken
      const result = await execute(input, token, context.abortController.signal)
      return { data: auth.expanded ? { ...result, notice: DESIGN_SCOPE_NOTICE } : result }
    } catch (error) {
      throw new Error(redactToken(errorMessage(error), token))
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: jsonStringify(output) }
  },
} satisfies ToolDef<InputSchema, Output>)
