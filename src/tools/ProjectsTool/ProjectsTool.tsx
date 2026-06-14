// Recovered from the 2.1.177 binary (cluster B — ProjectsTool).
//
// The Projects tool reads/writes/searches the single claude.ai Project bound to
// the session (via CLAUDE_PROJECT_UUID). Reconstructed from the minified tool
// object (minified O2f / dK(...)). Behavior lives in ./api.ts.
import React from 'react'
import { z } from 'zod/v4'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  PROJECTS_TOOL_NAME,
  READONLY_METHODS,
  REQUIRED_FIELDS,
  type ProjectsMethod,
} from './constants.js'
import { PROJECTS_PROMPT } from './prompt.js'
import {
  getAttachedProject,
  ProjectsPreconditionError,
  runProjectMethod,
  summarizeProjectsInput,
  type ProjectsOutput,
} from './api.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    method: z
      .enum([
        'project_info',
        'project_read',
        'project_search',
        'project_write',
        'project_delete',
      ])
      .describe('Which project operation to run.'),
    path: z
      .string()
      .optional()
      .describe(
        'project_read/project_write/project_delete: doc path. project_write: an existing path is replaced in place; a new bare filename (no "/") is namespaced to "claude/<name>".',
      ),
    content: z
      .string()
      .optional()
      .describe(
        'project_write: inline doc text. Mutually exclusive with local_path. Use local_path for anything you have on disk.',
      ),
    local_path: z
      .string()
      .optional()
      .describe(
        'project_write: a file inside the working directory to upload. The tool reads, encodes, and uploads directly — contents never enter your context. Mutually exclusive with content.',
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'project_write: bypass the chat-injection budget guard. Set only when the write is genuinely worth degrading chat to retrieval mode for everyone in the project.',
      ),
    query: z.string().optional().describe('project_search: knowledge-base query'),
    n: z.number().optional().describe('project_search: number of hits (default 5)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Output is a discriminated union on `method`; modeled loosely here since the
// tool returns the api.ts result verbatim (see ProjectsOutput for the full shape).
const outputSchema = lazySchema(() =>
  z.looseObject({ method: z.string() }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export const ProjectsTool = buildTool({
  name: PROJECTS_TOOL_NAME,
  searchHint: "read and write the session's attached claude.ai project",
  maxResultSizeChars: 300_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return (
      getFeatureValue_CACHED_MAY_BE_STALE('allow_projects_tool', false) &&
      getAttachedProject() !== undefined
    )
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return READONLY_METHODS.has(input.method as ProjectsMethod)
  },
  isDestructive(input) {
    return input.method === 'project_write' || input.method === 'project_delete'
  },
  userFacingName(input) {
    return `Project: ${summarizeProjectsInput(input)}`
  },
  getToolUseSummary(input) {
    return input?.method ? summarizeProjectsInput(input) : null
  },
  toAutoClassifierInput(input) {
    return summarizeProjectsInput(input)
  },
  async description() {
    return PROJECTS_PROMPT
  },
  async prompt() {
    return PROJECTS_PROMPT
  },
  async validateInput(input): Promise<ValidationResult> {
    const missing = REQUIRED_FIELDS[input.method as ProjectsMethod].filter(
      key => (input as Record<string, unknown>)[key] === undefined,
    )
    if (missing.length > 0) {
      return {
        result: false,
        message: `${input.method} requires: ${missing.join(', ')}.`,
        errorCode: 1,
      }
    }
    if (input.method === 'project_write') {
      const hasContent = input.content !== undefined
      const hasLocal = input.local_path !== undefined
      if (hasContent === hasLocal) {
        return {
          result: false,
          message: 'project_write requires exactly one of "content" or "local_path".',
          errorCode: 1,
        }
      }
    }
    return { result: true }
  },
  async call(input, context): Promise<{ data: ProjectsOutput }> {
    const projectUuid = getAttachedProject()
    if (!projectUuid) {
      throw new ProjectsPreconditionError(
        'No project attached to this session. Project tools are available when the session is started inside a claude.ai Project.',
      )
    }
    const { data } = await runProjectMethod(input, projectUuid, context.abortController.signal)
    return { data }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },
  renderToolUseMessage(input) {
    return React.createElement(Text, null, summarizeProjectsInput(input))
  },
} satisfies ToolDef<InputSchema, ProjectsOutput>)
