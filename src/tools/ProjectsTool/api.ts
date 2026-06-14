// Recovered from the 2.1.177 binary (cluster B — ProjectsTool).
//
// Project API client + the five operations (minified dispatcher X2f and helpers
// SWH/Vk7/Wk7/Zk7/M2f). Calls the claude.ai project REST API under
// `/api/organizations/<orgUUID>/projects/<uuid>` with the session's claude.ai
// OAuth token. Endpoint sub-paths beyond /detail and /kb/search are flagged
// `RECOVERY-UNCERTAIN` (their exact shapes live inside helpers not fully extracted).
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getCwd } from '../../utils/cwd.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import {
  AUTH_ERROR_MESSAGES,
  DEFAULT_SEARCH_HITS,
  EXPANDED_SCOPES_NOTICE,
  type ProjectsMethod,
} from './constants.js'

/** Thrown when project tooling can't run (no attached project / no claude.ai auth). (minified D1$) */
export class ProjectsPreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectsPreconditionError'
  }
}

export type ProjectsInput = {
  method: ProjectsMethod
  path?: string
  content?: string
  local_path?: string
  force?: boolean
  query?: string
  n?: number
}

type Knowledge = {
  knowledge_size: number
  max_knowledge_size: number
  search_threshold: number | null
  rag_active: boolean
  remaining_budget: number | null
}

export type ProjectsOutput =
  | {
      method: 'project_info'
      notice?: string
      name: string
      description: string
      instructions: string
      docs: { path: string; created_at: string | null }[]
      files?: { path: string; file_kind: string; created_at: string | null }[]
      sync_sources?: { type: string | null; config: Record<string, unknown> }[]
      knowledge: Knowledge
    }
  | {
      method: 'project_read'
      notice?: string
      path: string
      file_kind?: string
      content?: string
      local_file?: string
      created_at: string | null
    }
  | {
      method: 'project_search'
      notice?: string
      rag: boolean
      hits?: { name?: string; doc_uuid?: string; text?: string }[]
      docs?: string[]
    }
  | {
      method: 'project_write'
      notice?: string
      path: string
      doc_uuid: string
      replaced: boolean
      knowledge: Knowledge
    }
  | { method: 'project_delete'; notice?: string; path: string; deleted: boolean }

/** The session's attached project UUID, or undefined. (minified ap4) */
export function getAttachedProject(): string | undefined {
  return process.env.CLAUDE_PROJECT_UUID?.trim() || undefined
}

/**
 * Acquire a claude.ai access token (with org) for project calls, throwing a
 * ProjectsPreconditionError with a login hint when unavailable. (minified Y2f)
 * RECOVERY-UNCERTAIN: the original (cJ8) can transparently *expand* an existing
 * login with project scopes and reports `expanded`; here we rely on the existing
 * prepareApiRequest() token and report expanded=false.
 */
async function getProjectAuth(): Promise<{ accessToken: string; orgUUID: string; expanded: boolean }> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()
    return { accessToken, orgUUID, expanded: false }
  } catch (e) {
    throw new ProjectsPreconditionError(
      `Projects needs a claude.ai login. ${AUTH_ERROR_MESSAGES.no_token}${
        e instanceof Error && e.message ? ` (${e.message})` : ''
      }`,
    )
  }
}

// RECOVERY-UNCERTAIN: minified EWH = `/api/organizations/:orgUUID/projects/<uuid><sub>`,
// called via a teleport-org client that resolves :orgUUID. Reconstructed here with
// the orgUUID from prepareApiRequest() and BASE_API_URL.
function projectUrl(orgUUID: string, projectUuid: string, sub: string): string {
  const base = getOauthConfig().BASE_API_URL
  return `${base}/api/organizations/${encodeURIComponent(orgUUID)}/projects/${encodeURIComponent(projectUuid)}${sub}`
}

function authConfig(accessToken: string, signal: AbortSignal) {
  return {
    headers: { ...getOAuthHeaders(accessToken), 'anthropic-beta': 'projects-2025' },
    timeout: 30000,
    validateStatus: () => true,
    signal,
  }
}

type ProjectDetail = {
  name: string
  description?: string
  prompt_template?: string
  documents: { file_name: string | null; file_uuid?: string; created_at?: string | null }[]
  files?: { file_name: string | null; file_kind: string; file_uuid?: string; created_at?: string | null }[]
  sync_sources?: { type: string | null; config: Record<string, unknown> }[]
  knowledge_stats?: {
    knowledge_size?: number
    max_knowledge_size?: number
    project_knowledge_search_threshold?: number | null
    rag_active?: boolean
    remaining_budget?: number | null
  }
}

function mapKnowledge(stats: ProjectDetail['knowledge_stats']): Knowledge {
  return {
    knowledge_size: stats?.knowledge_size ?? 0,
    max_knowledge_size: stats?.max_knowledge_size ?? 0,
    search_threshold: stats?.project_knowledge_search_threshold ?? null,
    rag_active: stats?.rag_active ?? false,
    remaining_budget: stats?.remaining_budget ?? null,
  }
}

async function getProjectDetail(
  orgUUID: string,
  projectUuid: string,
  accessToken: string,
  signal: AbortSignal,
): Promise<ProjectDetail> {
  const res = await axios.get(projectUrl(orgUUID, projectUuid, '/detail'), authConfig(accessToken, signal))
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`get project detail ${res.status}`)
  }
  return res.data as ProjectDetail
}

function required<T>(value: T | undefined, name: string, method: string): T {
  if (value === undefined) throw new ProjectsPreconditionError(`${method} requires: ${name}.`)
  return value
}

/** Namespace a bare filename under claude/ unless it already exists or is pathed. (minified qB4) */
function namespacePath(path: string, existing: Set<string>): string {
  const p = path.replace(/^\.\//, '')
  if (existing.has(p)) return p
  return p.includes('/') ? p : `claude/${p}`
}

/** Dispatch a Projects operation against the attached project. (minified X2f) */
export async function runProjectMethod(
  input: ProjectsInput,
  projectUuid: string,
  signal: AbortSignal,
): Promise<{ data: ProjectsOutput; expandedNotice: boolean }> {
  const { accessToken, orgUUID, expanded } = await getProjectAuth()
  const detail = () => getProjectDetail(orgUUID, projectUuid, accessToken, signal)
  let data: ProjectsOutput

  switch (input.method) {
    case 'project_info': {
      const d = await detail()
      data = {
        method: 'project_info',
        name: d.name,
        description: d.description ?? '',
        instructions: d.prompt_template ?? '',
        docs: d.documents.flatMap(f =>
          f.file_name !== null ? [{ path: f.file_name, created_at: f.created_at ?? null }] : [],
        ),
        files: (d.files ?? []).flatMap(f =>
          f.file_name !== null
            ? [{ path: f.file_name, file_kind: f.file_kind, created_at: f.created_at ?? null }]
            : [],
        ),
        sync_sources: (d.sync_sources ?? []).map(s => ({ type: s.type, config: s.config })),
        knowledge: mapKnowledge(d.knowledge_stats),
      }
      break
    }
    case 'project_read': {
      const path = required(input.path, 'path', input.method)
      const d = await detail()
      const doc = d.documents.find(f => f.file_name === path)
      if (doc) {
        // RECOVERY-UNCERTAIN: doc content endpoint (minified Wk7).
        const res = await axios.get(
          projectUrl(orgUUID, projectUuid, `/docs/${encodeURIComponent(doc.file_uuid ?? path)}`),
          authConfig(accessToken, signal),
        )
        data = {
          method: 'project_read',
          path,
          content: typeof res.data?.content === 'string' ? res.data.content : '',
          created_at: doc.created_at ?? null,
        }
      } else {
        const file = (d.files ?? []).find(f => f.file_name === path)
        if (!file) {
          throw new ProjectsPreconditionError(`"${path}" not found in this project.`)
        }
        // RECOVERY-UNCERTAIN: file content endpoint (minified Zk7).
        const res = await axios.get(
          projectUrl(orgUUID, projectUuid, `/files/${encodeURIComponent(file.file_uuid ?? path)}`),
          authConfig(accessToken, signal),
        )
        if (file.file_kind !== 'document') {
          data = {
            method: 'project_read',
            path,
            file_kind: file.file_kind,
            content: '',
            created_at: file.created_at ?? null,
            notice: `"${path}" is a ${file.file_kind} file with no text extract. project_read returns extracted text for document uploads (PDF, docx).`,
          }
        } else {
          data = {
            method: 'project_read',
            path,
            content: typeof res.data?.content === 'string' ? res.data.content : '',
            created_at: file.created_at ?? null,
          }
        }
      }
      break
    }
    case 'project_search': {
      const query = required(input.query, 'query', input.method)
      const n = input.n ?? DEFAULT_SEARCH_HITS
      // RECOVERY-UNCERTAIN: knowledge-search endpoint (minified Vk7) — /kb/search.
      const res = await axios.post(
        projectUrl(orgUUID, projectUuid, '/kb/search'),
        { query, n },
        authConfig(accessToken, signal),
      )
      if (res.status === 403) {
        const d = await detail()
        data = {
          method: 'project_search',
          rag: false,
          docs: d.documents.map(f => f.file_name).filter((f): f is string => f !== null),
        }
      } else if (res.status < 200 || res.status >= 300) {
        throw new Error(`project search ${res.status}`)
      } else {
        const hits = Array.isArray(res.data?.hits) ? res.data.hits : []
        data = {
          method: 'project_search',
          rag: true,
          hits: hits.map((h: { name?: string; doc_uuid?: string; text?: string }) => ({
            name: h.name,
            doc_uuid: h.doc_uuid,
            text: h.text,
          })),
        }
      }
      break
    }
    case 'project_write': {
      const rawPath = required(input.path, 'path', input.method)
      const content =
        input.local_path !== undefined
          ? await readFile(resolve(getCwd(), input.local_path), 'utf8')
          : required(input.content, 'content', input.method)
      const d = await detail()
      const existing = new Set(
        d.documents.map(f => f.file_name).filter((f): f is string => f !== null),
      )
      const path = namespacePath(rawPath, existing)
      const replaced = existing.has(path)
      // RECOVERY-UNCERTAIN: doc upsert endpoint + budget-guard semantics (force).
      const res = await axios.put(
        projectUrl(orgUUID, projectUuid, `/docs/${encodeURIComponent(path)}`),
        { content, force: input.force === true },
        authConfig(accessToken, signal),
      )
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`project write ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`)
      }
      const after = await detail()
      data = {
        method: 'project_write',
        path,
        doc_uuid: typeof res.data?.doc_uuid === 'string' ? res.data.doc_uuid : '',
        replaced,
        knowledge: mapKnowledge(after.knowledge_stats),
      }
      break
    }
    case 'project_delete': {
      const path = required(input.path, 'path', input.method)
      const d = await detail()
      const doc = d.documents.find(f => f.file_name === path)
      if (!doc) {
        data = { method: 'project_delete', path, deleted: false }
        break
      }
      // RECOVERY-UNCERTAIN: doc delete endpoint.
      const res = await axios.delete(
        projectUrl(orgUUID, projectUuid, `/docs/${encodeURIComponent(doc.file_uuid ?? path)}`),
        authConfig(accessToken, signal),
      )
      data = { method: 'project_delete', path, deleted: res.status >= 200 && res.status < 300 }
      break
    }
  }

  return { data: expanded ? { ...data, notice: EXPANDED_SCOPES_NOTICE } : data, expandedNotice: expanded }
}

/** Short one-line summary of a Projects call for UI/classifier. (minified kb8) */
export function summarizeProjectsInput(input: Partial<ProjectsInput> | undefined): string {
  switch (input?.method) {
    case 'project_info':
      return 'Project info'
    case 'project_read':
      return `Read ${input.path ?? '?'}`
    case 'project_search':
      return input.query ? `Search "${input.query}"` : 'Search project'
    case 'project_write': {
      const p = input.path ?? '?'
      const from = input.local_path ? ` from ${resolve(getCwd(), input.local_path)}` : ''
      const force = input.force ? ' (force, bypassing budget guard)' : ''
      return `Write ${p}${from}${force}`
    }
    case 'project_delete':
      return input.path ? `Delete ${input.path}` : 'Delete project doc'
    default:
      return 'Project'
  }
}
