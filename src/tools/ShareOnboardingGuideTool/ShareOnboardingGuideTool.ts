import axios from 'axios'
import { stat, readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { OAUTH_BETA_HEADER, getOauthConfig } from '../../constants/oauth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getOrganizationUUID } from '../../services/oauth/client.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getAPIProvider } from '../../utils/model/providers.js'

const TOOL_NAME = 'ShareOnboardingGuide'
const ONBOARDING_FILE = 'ONBOARDING.md'
const MAX_ONBOARDING_BYTES = 65_536
const REQUEST_TIMEOUT_MS = 10_000

const DESCRIPTION = `Upload the ONBOARDING.md in the current directory and return a share link teammates can open in Claude Code. Call this after the user has confirmed the final content.
When called with the default mode='check': if a local ONBOARDING.md is present, uploads it to the most-recently-updated org guide (or creates one if none exist) and returns a fresh link. If no local file is present, returns the existing link without uploading (status: has_existing).`

type Guide = {
  short_code: string
  share_url: string
  updated_at: string
}

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; detail?: string }

type GuideResult = {
  share_url: string
  short_code: string
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    mode: z
      .enum(['check', 'update', 'create', 'delete'])
      .default('check')
      .describe(
        "'check' (default): if ONBOARDING.md is present locally, uploads it to the most-recent guide (creates one if none exist); otherwise reports the existing link without uploading. 'update': upload to a specific guide by short_code. 'create': always make a new link. 'delete': remove a guide.",
      ),
    short_code: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional()
      .describe(
        'Short code of a specific guide to target (returned by a previous call). Honored by check, update, and delete — skips the org-wide lookup and targets this guide directly.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum([
      'created',
      'updated',
      'deleted',
      'has_existing',
      'unavailable',
    ]),
    share_url: z.string().optional(),
    short_code: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ShareOnboardingGuideOutput = z.infer<OutputSchema>

function isShareOnboardingGuideEnabled(): boolean {
  if (getAPIProvider() !== 'firstParty') {
    return false
  }
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_flint_harbor_share', false)
}

function unavailable(message: string): { data: ShareOnboardingGuideOutput } {
  return { data: { status: 'unavailable', message } }
}

function guideToolResult(
  status: 'created' | 'updated',
  shareUrl: string,
  shortCode: string,
  includeCloseInstruction: boolean,
): { data: ShareOnboardingGuideOutput } {
  const closeInstruction = includeCloseInstruction
    ? `\nClose with: "Here's your onboarding guide: ${shareUrl}" followed by the send-to-teammates line.`
    : ''
  return {
    data: {
      status,
      share_url: shareUrl,
      short_code: shortCode,
      message: `Share link ${status}: ${shareUrl} (short_code: ${shortCode})\n${closeInstruction}`,
    },
  }
}

function parseApiResponse<T>(response: ApiResponse<T>): T {
  if (!response.ok) {
    throw new Error(
      response.reason === 'no-auth'
        ? (response.detail ?? 'Not authenticated')
        : `Onboarding guide unavailable: ${response.reason}`,
    )
  }
  return response.data
}

async function onboardingApiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  context: ToolUseContext,
  data?: unknown,
): Promise<T> {
  await checkAndRefreshOAuthTokenIfNeeded()
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error(
      'Not authenticated with a claude.ai account. Run /login and try again.',
    )
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to resolve organization UUID.')
  }

  const resolvedPath = path.replace(
    ':orgUUID',
    encodeURIComponent(orgUUID),
  )
  const response = await axios.request<ApiResponse<T>>({
    method,
    url: `${getOauthConfig().BASE_API_URL}${resolvedPath}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA_HEADER,
      'x-organization-uuid': orgUUID,
    },
    data,
    timeout: REQUEST_TIMEOUT_MS,
    signal: context.abortController.signal,
  })
  return parseApiResponse(response.data)
}

async function listGuides(context: ToolUseContext): Promise<Guide[]> {
  const result = await onboardingApiRequest<{ guides: Guide[] }>(
    'GET',
    '/api/organizations/:orgUUID/claude_code/onboarding',
    context,
  )
  return result.guides
}

async function getMostRecentGuide(
  context: ToolUseContext,
): Promise<Guide | undefined> {
  const guides = await listGuides(context)
  if (guides.length === 0) {
    return undefined
  }
  return guides.reduce((latest, guide) =>
    latest.updated_at > guide.updated_at ? latest : guide,
  )
}

async function createGuide(
  content: string,
  context: ToolUseContext,
): Promise<GuideResult> {
  const result = await onboardingApiRequest<GuideResult>(
    'POST',
    '/api/organizations/:orgUUID/claude_code/onboarding',
    context,
    { content },
  )
  logEvent('tengu_team_onboarding_share_created', {})
  return result
}

async function updateGuide(
  shortCode: string,
  content: string,
  context: ToolUseContext,
): Promise<GuideResult> {
  const result = await onboardingApiRequest<GuideResult>(
    'PUT',
    `/api/organizations/:orgUUID/claude_code/onboarding/${encodeURIComponent(shortCode)}`,
    context,
    { content },
  )
  logEvent('tengu_team_onboarding_share_updated', {})
  return result
}

async function deleteGuide(
  shortCode: string,
  context: ToolUseContext,
): Promise<void> {
  await onboardingApiRequest<unknown>(
    'DELETE',
    `/api/organizations/:orgUUID/claude_code/onboarding/${encodeURIComponent(shortCode)}`,
    context,
  )
  logEvent('tengu_team_onboarding_share_deleted', {})
}

async function getOnboardingFileSize(): Promise<number | null> {
  const path = join(getCwd(), ONBOARDING_FILE)
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
}

async function readOnboardingFile(): Promise<string | null> {
  const filePath = join(getCwd(), ONBOARDING_FILE)
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }

  if (size > MAX_ONBOARDING_BYTES) {
    throw new Error(
      `${ONBOARDING_FILE} is over ${MAX_ONBOARDING_BYTES / 1024}KB. Trim it before sharing.`,
    )
  }
  return readFile(filePath, 'utf8')
}

export const ShareOnboardingGuideTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'upload ONBOARDING.md and get a team share link',
  maxResultSizeChars: 1000,
  async description() {
    return DESCRIPTION
  },
  isEnabled() {
    return isShareOnboardingGuideEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async validateInput() {
    return { result: true as const }
  },
  async prompt() {
    return DESCRIPTION
  },
  toAutoClassifierInput(input: Input) {
    return `share onboarding guide (mode: ${input.mode ?? 'check'})`
  },
  isDestructive(input: Input) {
    return input.mode === 'delete'
  },
  renderToolUseMessage(input: Partial<Input>) {
    return input.mode && input.mode !== 'check' ? input.mode : null
  },
  renderToolResultMessage() {
    return null
  },
  async call({ mode = 'check', short_code }, context) {
    if (mode === 'delete') {
      try {
        const target = short_code ?? (await getMostRecentGuide(context))?.short_code
        if (!target) {
          return unavailable('No guide found for this org to delete.')
        }
        await deleteGuide(target, context)
        return { data: { status: 'deleted', message: `Guide ${target} deleted.` } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return unavailable(`Delete didn't go through (${message}).`)
      }
    }

    if (mode === 'check') {
      try {
        const existing = short_code
          ? (await listGuides(context)).find(guide => guide.short_code === short_code)
          : await getMostRecentGuide(context)
        if (existing) {
          const size = await getOnboardingFileSize()
          if (size === null) {
            return {
              data: {
                status: 'has_existing',
                share_url: existing.share_url,
                short_code: existing.short_code,
                message: `A guide already exists for this org at ${existing.share_url} (short_code: ${existing.short_code}). If this link is what the user needed, share it. If they want to create or update a guide, tell them to run /team-onboarding themselves (it scans local session data and cannot be invoked by the model).`,
              },
            }
          }
          if (size > MAX_ONBOARDING_BYTES) {
            return unavailable(
              `${ONBOARDING_FILE} is over ${MAX_ONBOARDING_BYTES / 1024}KB. Trim it before sharing.`,
            )
          }
          const content = await readFile(join(getCwd(), ONBOARDING_FILE), 'utf8')
          const updated = await updateGuide(existing.short_code, content, context)
          return guideToolResult(
            'updated',
            updated.share_url,
            updated.short_code,
            false,
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return unavailable(
          `Upload didn't go through (${message}). Fall back to the manual share copy.`,
        )
      }
    }

    const content = await readOnboardingFile()
    if (content === null) {
      return unavailable(
        `${ONBOARDING_FILE} not found in the current directory. Write the guide first.`,
      )
    }

    try {
      if (mode === 'update') {
        const target = short_code ?? (await getMostRecentGuide(context))?.short_code
        if (target) {
          const updated = await updateGuide(target, content, context)
          return guideToolResult(
            'updated',
            updated.share_url,
            updated.short_code,
            true,
          )
        }
      }
      const created = await createGuide(content, context)
      return guideToolResult(
        'created',
        created.share_url,
        created.short_code,
        false,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return unavailable(
        `Upload didn't go through (${message}). Fall back to the manual share copy.`,
      )
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `[${output.status}] ${output.message}`,
    }
  },
} satisfies ToolDef<InputSchema, ShareOnboardingGuideOutput>)
