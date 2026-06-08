import { randomUUID } from 'crypto'
import { Socket, createConnection } from 'net'
import { platform } from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import WebSocket from 'ws'

type PermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
}

export type PermissionMode =
  | 'ask'
  | 'skip_all_permission_checks'
  | 'follow_a_plan'

export type Logger = {
  silly?(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type ConnectedExtension = {
  deviceId: string
  name?: string
  osPlatform?: string
  connectedAt: number
  isLocal?: boolean
}

export type BridgeConfig = {
  url: string
  devUserId?: string
  getUserId: () => Promise<string | undefined>
  getUserIdResult?: () => Promise<
    | { ok: true; userId: string }
    | { ok: false; error?: string }
  >
  getOAuthToken: () => Promise<string>
  wsOptions?: WebSocket.ClientOptions
  getWsOptions?: () => Promise<WebSocket.ClientOptions | undefined>
}

export type ToolCallOptions = {
  permissionMode?: PermissionMode
  allowedDomains?: string[]
  onPermissionRequest?: (request: unknown) => Promise<PermissionResponse>
  sessionScope?: {
    sessionId?: string
    userMessageUuid?: string
  }
}

export type ClaudeForChromeContext = {
  serverName?: string
  logger?: Logger
  socketPath?: string
  getSocketPaths?: () => string[]
  clientTypeId?: string
  bridgeConfig?: BridgeConfig
  initialPermissionMode?: PermissionMode
  askUserToolName?: string
  handleHostTool?: (
    name: string,
    args: Record<string, unknown>,
    helpers: { getActiveTabOrigin: () => Promise<string | undefined> },
  ) => Promise<CallToolResult | undefined>
  hostTools?: () => Tool[]
  isDisabled?: () => boolean
  getPersistedDeviceId?: () => string | undefined
  getRequirePairedDevice?: () => boolean
  onAuthenticationError?: () => void
  onRemoteExtensionWarning?: (extension: ConnectedExtension) => void
  onPairingPrompted?: (signal: AbortSignal) => void
  onExtensionPaired?: (
    deviceId: string,
    name: string,
    knownDeviceIds?: string[],
  ) => void
  onToolCallDisconnected?: () => string
  getToolCallTimeoutMs?: (toolName: string) => number
  callAnthropicMessages?: (req: {
    model: string
    max_tokens: number
    system: string
    messages: unknown[]
    stop_sequences?: string[]
    signal?: AbortSignal
  }) => Promise<unknown>
  trackEvent?: (eventName: string, metadata?: Record<string, unknown>) => void
}

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
const DISCOVERY_TIMEOUT_MS = 3_000
const PEER_WAIT_TIMEOUT_MS = 10_000
const PAIRING_TIMEOUT_MS = 120_000

const text = (textValue: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: textValue }],
  ...(isError ? { isError: true } : {}),
})

const objectSchema = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Tool['inputSchema'] => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
})

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const

const writeBrowser = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const

export const BROWSER_TOOLS: Tool[] = [
  {
    name: 'javascript_tool',
    description:
      "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      text: { type: 'string' },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'read_page',
    description:
      "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      depth: { type: 'number' },
      ref: { type: 'string' },
      interactiveOnly: { type: 'boolean' },
    }),
    annotations: readOnly,
  },
  {
    name: 'find',
    description:
      "Find text or elements on the current page. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      query: { type: 'string' },
    }),
    annotations: readOnly,
  },
  {
    name: 'form_input',
    description:
      'Set values in form elements using element reference ID from the read_page tool. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      ref: { type: 'string' },
      value: { type: 'string' },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'computer',
    description:
      'Interact with the browser using screenshots, mouse, keyboard, scrolling, hover, and wait actions. Use screenshots before coordinate-based clicks.',
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      action: { type: 'string' },
      coordinate: { type: 'array', items: { type: 'number' } },
      text: { type: 'string' },
      ref: { type: 'string' },
      duration: { type: 'number' },
      modifiers: { type: 'string' },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'navigate',
    description:
      "Navigate a browser tab to a URL. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      url: { type: 'string' },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'resize_window',
    description: 'Resize the browser window for the current tab.',
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'switch_browser',
    description:
      "Send a connection request to every Chrome browser with the extension installed and wait (up to 2 minutes) for the user to click 'Connect' in the one they want to use. The user can name the browser when they connect. Use this when the user wants to pick the browser themselves from inside Chrome rather than choosing from a list; otherwise prefer select_browser with a known deviceId.",
    inputSchema: objectSchema(),
    annotations: writeBrowser,
  },
  {
    name: 'list_connected_browsers',
    description:
      'List all Chrome browsers (extension instances) currently connected to this account. Returns each browser\'s deviceId, display name, OS platform, and whether it appears to be on this computer. Use this before select_browser to present choices to the user.',
    inputSchema: objectSchema(),
    annotations: readOnly,
  },
  {
    name: 'select_browser',
    description:
      'Select a specific Chrome browser by deviceId for browser automation, without broadcasting a pairing request. Use this after list_connected_browsers when the user has chosen one from the list.',
    inputSchema: objectSchema(
      {
        deviceId: {
          type: 'string',
          description: 'The deviceId from list_connected_browsers.',
        },
      },
      ['deviceId'],
    ),
    annotations: writeBrowser,
  },
  {
    name: 'gif_creator',
    description: 'Record browser interactions as a GIF.',
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      action: { type: 'string' },
      filename: { type: 'string' },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'upload_image',
    description:
      'Upload one or more image files into the page. Provide either ref or coordinate, not both.',
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      paths: { type: 'array', items: { type: 'string' } },
      ref: { type: 'string' },
      coordinate: { type: 'array', items: { type: 'number' } },
    }),
    annotations: writeBrowser,
  },
  {
    name: 'get_page_text',
    description: 'Get visible text from a browser tab.',
    inputSchema: objectSchema({ tabId: { type: 'number' } }),
    annotations: readOnly,
  },
  {
    name: 'tabs_context_mcp',
    description:
      'Get information about current browser tabs, including available tab IDs and the selected tab.',
    inputSchema: objectSchema(),
    annotations: readOnly,
  },
  {
    name: 'tabs_create_mcp',
    description: 'Create a new browser tab, optionally with a URL.',
    inputSchema: objectSchema({ url: { type: 'string' } }),
    annotations: writeBrowser,
  },
  {
    name: 'tabs_close_mcp',
    description: 'Close a browser tab.',
    inputSchema: objectSchema({ tabId: { type: 'number' } }, ['tabId']),
    annotations: writeBrowser,
  },
  {
    name: 'update_plan',
    description: 'Update the browser task plan shown in the extension side panel.',
    inputSchema: objectSchema({ plan: { type: 'string' } }),
    annotations: writeBrowser,
  },
  {
    name: 'read_console_messages',
    description:
      "Read JavaScript console messages from a specific tab. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      pattern: { type: 'string' },
      onlyErrors: { type: 'boolean' },
      limit: { type: 'number' },
    }),
    annotations: readOnly,
  },
  {
    name: 'read_network_requests',
    description:
      "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: objectSchema({
      tabId: { type: 'number' },
      urlPattern: { type: 'string' },
      limit: { type: 'number' },
    }),
    annotations: readOnly,
  },
  {
    name: 'shortcuts_list',
    description: 'List shortcuts available in the browser extension.',
    inputSchema: objectSchema(),
    annotations: readOnly,
  },
  {
    name: 'shortcuts_execute',
    description: 'Execute a browser extension shortcut.',
    inputSchema: objectSchema({ shortcutId: { type: 'string' } }, ['shortcutId']),
    annotations: writeBrowser,
  },
]

class SocketConnectionError extends Error {}
class NoExtensionConnectedError extends Error {}
class ToolCallTimeoutError extends Error {
  constructor(toolName: string) {
    super(`The "${toolName}" tool did not respond in time.`)
  }
}

type ToolResponse = {
  result?: unknown
  error?: unknown
}

type PendingCall = {
  resolve: (response: ToolResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  onPermissionRequest?: (request: unknown) => Promise<PermissionResponse>
}

type BrowserClient = {
  ensureConnected(): Promise<boolean>
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<ToolResponse | null | undefined>
  setNotificationHandler(handler: (notification: { method: string; params?: unknown }) => void): void
  listConnectedExtensions?(): Promise<ConnectedExtension[]>
  switchBrowser?(): Promise<'no_other_browsers' | { deviceId: string; name?: string } | null>
  selectExtensionById?(deviceId: string, name?: string, knownDeviceIds?: string[]): void
}

function logger(context: ClaudeForChromeContext): Logger {
  return (
    context.logger ?? {
      info() {},
      warn() {},
      error() {},
    }
  )
}

function serverName(context: ClaudeForChromeContext): string {
  return context.serverName ?? 'Claude in Chrome'
}

function localPlatformLabel(): string {
  const p = platform()
  if (p === 'darwin') return 'macos'
  if (p === 'win32') return 'windows'
  return p
}

function normalizeExtension(raw: unknown): ConnectedExtension | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const deviceId = obj.deviceId ?? obj.device_id ?? obj.id
  if (typeof deviceId !== 'string' || deviceId.length === 0) return undefined
  const name = obj.name ?? obj.displayName ?? obj.display_name
  const osPlatform = obj.osPlatform ?? obj.os_platform ?? obj.platform
  const connectedAt = obj.connectedAt ?? obj.connected_at
  return {
    deviceId,
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    ...(typeof osPlatform === 'string' && osPlatform.length > 0
      ? { osPlatform }
      : {}),
    connectedAt: typeof connectedAt === 'number' ? connectedAt : Date.now(),
  }
}

function normalizeExtensions(raw: unknown): ConnectedExtension[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null
      ? ((raw as Record<string, unknown>).extensions ??
        (raw as Record<string, unknown>).browsers ??
        (raw as Record<string, unknown>).peers)
      : []
  if (!Array.isArray(values)) return []

  const deduped = new Map<string, ConnectedExtension>()
  for (const value of values) {
    const extension = normalizeExtension(value)
    if (!extension) continue
    const previous = deduped.get(extension.deviceId)
    if (!previous || extension.connectedAt > previous.connectedAt) {
      deduped.set(extension.deviceId, extension)
    }
  }
  return [...deduped.values()]
}

function displayName(extension: ConnectedExtension, index: number): string {
  return extension.name || `${extension.osPlatform || 'Chrome'} ${index + 1}`
}

function bridgeOnly(message: string): CallToolResult {
  return text(message, true)
}

function formatToolResponse(response: ToolResponse | null | undefined, context: ClaudeForChromeContext): CallToolResult {
  if (response === null || response === undefined) {
    return text('Tool execution completed')
  }

  const payload = response.error ?? response.result
  const isError = response.error !== undefined
  if (!payload) return text('Tool execution completed')

  if (typeof payload === 'object' && payload !== null) {
    const content = (payload as { content?: unknown }).content
    if (Array.isArray(content)) {
      if (isError && contentText(content).toLowerCase().includes('re-authenticated')) {
        context.onAuthenticationError?.()
      }
      return {
        content: content.map(item => normalizeContentBlock(item)),
        ...(isError ? { isError: true } : {}),
      }
    }
    if (typeof content === 'string') return text(content, isError)
  }

  if (typeof payload === 'string') return text(payload, isError)
  logger(context).warn(
    `[${serverName(context)}] Unexpected result format from socket bridge`,
    response,
  )
  return text(JSON.stringify(response), isError)
}

function normalizeContentBlock(item: unknown): { [key: string]: unknown; type: string } {
  if (typeof item === 'object' && item !== null && 'type' in item) {
    const block = item as Record<string, unknown>
    if (
      block.type === 'image' &&
      typeof block.source === 'object' &&
      block.source !== null &&
      'data' in block.source
    ) {
      const source = block.source as Record<string, unknown>
      return {
        type: 'image',
        data: source.data,
        mimeType:
          typeof source.media_type === 'string' ? source.media_type : 'image/png',
      }
    }
    return block as { [key: string]: unknown; type: string }
  }
  return { type: 'text', text: String(item) }
}

function contentText(content: unknown[]): string {
  return content
    .map(item => {
      if (typeof item === 'string') return item
      if (typeof item === 'object' && item !== null && 'text' in item) {
        const textValue = (item as { text?: unknown }).text
        return typeof textValue === 'string' ? textValue : ''
      }
      return ''
    })
    .join(' ')
}

class BridgeClient implements BrowserClient {
  private ws?: WebSocket
  private connected = false
  private authenticated = false
  private connecting = false
  private pendingCalls = new Map<string, PendingCall>()
  private pendingDiscovery?: {
    resolve: (extensions: ConnectedExtension[]) => void
    timeout: ReturnType<typeof setTimeout>
  }
  private peerConnectedWaiters: Array<(connected: boolean) => void> = []
  private listExtensionsPromise?: Promise<ConnectedExtension[]>
  private selectedDeviceId?: string
  private previousSelectedDeviceId?: string
  private persistedDeviceId?: string
  private discoveryComplete = false
  private discoveryPromise?: Promise<void>
  private pairingInProgress = false
  private multiBrowserPendingSelection = false
  private pendingPairingRequestId?: string
  private pendingSwitchResolve?: (
    value: { deviceId: string; name?: string } | null,
  ) => void
  private lastKnownExtensionIdsValue: string[] = []
  private pairingPromptAbort?: AbortController
  private pairingPromptTimeout?: ReturnType<typeof setTimeout>
  private notificationHandler?: (notification: { method: string; params?: unknown }) => void

  constructor(private readonly context: ClaudeForChromeContext) {}

  setNotificationHandler(handler: (notification: { method: string; params?: unknown }) => void): void {
    this.notificationHandler = handler
  }

  async ensureConnected(): Promise<boolean> {
    if (this.isConnected()) return true
    await this.connect()
    return this.waitForConnection()
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<ToolResponse> {
    const log = logger(this.context)
    const bridgeConfig = this.context.bridgeConfig
    if (!bridgeConfig || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new SocketConnectionError(`[${serverName(this.context)}] Bridge not connected`)
    }

    if (!this.selectedDeviceId && !this.discoveryComplete) {
      this.discoveryPromise ??= this.discoverAndSelectExtension().finally(() => {
        this.discoveryPromise = undefined
      })
      await this.discoveryPromise
    }

    if (
      this.discoveryComplete &&
      !this.selectedDeviceId &&
      !this.pairingInProgress &&
      !this.multiBrowserPendingSelection
    ) {
      throw new NoExtensionConnectedError(
        `[${serverName(this.context)}] No Chrome extension connected after discovery`,
      )
    }

    const toolUseId = randomUUID()
    const timeoutMs =
      this.context.getToolCallTimeoutMs?.(name) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    const message: Record<string, unknown> = {
      type: 'tool_call',
      tool_use_id: toolUseId,
      client_type: this.context.clientTypeId ?? 'claude-code',
      tool: name,
      args,
    }
    if (this.selectedDeviceId) message.target_device_id = this.selectedDeviceId
    if (options?.permissionMode) message.permission_mode = options.permissionMode
    if (options?.allowedDomains?.length) {
      message.allowed_domains = options.allowedDomains
    }
    if (options?.onPermissionRequest) message.handle_permission_prompts = true
    if (options?.sessionScope) message.session_scope = options.sessionScope

    this.context.trackEvent?.('chrome_bridge_tool_call_started', {
      tool_name: name,
      tool_use_id: toolUseId,
      timeout_ms: timeoutMs,
      session_id: options?.sessionScope?.sessionId,
      user_message_uuid: options?.sessionScope?.userMessageUuid,
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(toolUseId)
        reject(new ToolCallTimeoutError(name))
      }, timeoutMs)
      this.pendingCalls.set(toolUseId, {
        resolve,
        reject,
        timer,
        onPermissionRequest: options?.onPermissionRequest,
      })
      log.debug?.(
        `[${serverName(this.context)}] Sending tool_call: ${name} (${toolUseId.slice(0, 8)})`,
      )
      this.ws?.send(JSON.stringify(message))
    })
  }

  async listConnectedExtensions(): Promise<ConnectedExtension[]> {
    if (!await this.ensureConnected()) return []
    return (await this.queryBridgeExtensions()).map(extension => ({
      ...extension,
      isLocal: this.isLocalExtension(extension),
    }))
  }

  selectExtensionById(deviceId: string, name?: string, knownDeviceIds?: string[]): void {
    this.discoveryComplete = true
    this.pairingInProgress = false
    this.pendingPairingRequestId = undefined
    this.selectExtension(deviceId)
    this.context.onExtensionPaired?.(deviceId, name ?? deviceId.slice(0, 8), knownDeviceIds ?? [])
    this.pendingSwitchResolve?.({ deviceId, name })
    this.abortPairingPrompt()
  }

  async switchBrowser(): Promise<'no_other_browsers' | { deviceId: string; name?: string } | null> {
    const extensions = await this.queryBridgeExtensions()
    const current = this.selectedDeviceId ?? this.previousSelectedDeviceId
    if (
      extensions.length === 0 ||
      (extensions.length === 1 && (!current || extensions[0]?.deviceId === current))
    ) {
      return 'no_other_browsers'
    }

    this.previousSelectedDeviceId = this.selectedDeviceId
    this.selectedDeviceId = undefined
    this.discoveryComplete = false
    this.pairingInProgress = true
    const requestId = randomUUID()
    this.pendingPairingRequestId = requestId
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null
    this.ws.send(
      JSON.stringify({
        type: 'pairing_request',
        request_id: requestId,
        client_type: this.context.clientTypeId ?? 'claude-code',
      }),
    )
    this.firePairingPrompt()
    this.pendingSwitchResolve?.(null)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pendingPairingRequestId === requestId) {
          this.pendingPairingRequestId = undefined
        }
        this.pendingSwitchResolve = undefined
        this.abortPairingPrompt()
        resolve(null)
      }, PAIRING_TIMEOUT_MS)
      this.pendingSwitchResolve = value => {
        clearTimeout(timer)
        this.pendingSwitchResolve = undefined
        resolve(value)
      }
    })
  }

  private isConnected(): boolean {
    return this.connected && this.authenticated && this.ws?.readyState === WebSocket.OPEN
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.isConnected()) return
    const bridgeConfig = this.context.bridgeConfig
    const log = logger(this.context)
    if (!bridgeConfig) return

    this.connecting = true
    this.connected = false
    this.authenticated = false

    let userId: string | undefined
    let errorDetail: string | undefined
    if (bridgeConfig.devUserId) {
      userId = bridgeConfig.devUserId
    } else if (bridgeConfig.getUserIdResult) {
      const result = await bridgeConfig.getUserIdResult()
      if (result.ok) userId = result.userId
      else errorDetail = result.error
    } else {
      userId = await bridgeConfig.getUserId()
    }

    if (!userId) {
      log.error(`[${serverName(this.context)}] No user ID available`, errorDetail)
      this.connecting = false
      return
    }

    const oauthToken = bridgeConfig.devUserId
      ? undefined
      : await bridgeConfig.getOAuthToken()
    if (!bridgeConfig.devUserId && !oauthToken) {
      log.error(`[${serverName(this.context)}] No OAuth token available`)
      this.connecting = false
      return
    }

    const url = `${bridgeConfig.url}/chrome/${userId}`
    log.info(`[${serverName(this.context)}] Connecting to bridge: ${url}`)
    const wsOptions = await bridgeConfig.getWsOptions?.() ?? bridgeConfig.wsOptions
    this.ws = new WebSocket(url, wsOptions)

    this.ws.on('open', () => {
      this.ws?.send(
        JSON.stringify({
          type: 'connect',
          client_type: this.context.clientTypeId ?? 'claude-code',
          ...(bridgeConfig.devUserId
            ? { dev_user_id: bridgeConfig.devUserId }
            : { oauth_token: oauthToken }),
        }),
      )
    })
    this.ws.on('message', data => {
      try {
        this.handleMessage(JSON.parse(data.toString()))
      } catch (error) {
        log.error(`[${serverName(this.context)}] Failed to parse bridge message:`, error)
      }
    })
    this.ws.on('close', () => {
      this.connected = false
      this.authenticated = false
      this.connecting = false
      this.rejectPendingCalls(new SocketConnectionError('Bridge connection closed mid-call'))
    })
    this.ws.on('error', error => {
      log.error(`[${serverName(this.context)}] Bridge WebSocket error:`, error)
      this.connected = false
      this.authenticated = false
      this.connecting = false
      this.rejectPendingCalls(new SocketConnectionError(`Bridge connection error: ${error.message}`))
    })
  }

  private waitForConnection(): Promise<boolean> {
    return new Promise(resolve => {
      const deadline = Date.now() + 10_000
      const poll = (): void => {
        if (this.isConnected()) {
          resolve(true)
        } else if (Date.now() >= deadline || (!this.connecting && !this.ws)) {
          resolve(false)
        } else {
          setTimeout(poll, 200)
        }
      }
      poll()
    })
  }

  private handleMessage(message: Record<string, unknown>): void {
    const log = logger(this.context)
    switch (message.type) {
      case 'paired':
      case 'connected':
        this.connected = true
        this.authenticated = true
        this.connecting = false
        break
      case 'waiting':
        log.info(`[${serverName(this.context)}] Waiting for Chrome extension to connect`)
        this.connected = true
        this.authenticated = true
        this.connecting = false
        break
      case 'extensions_list':
        this.resolveDiscovery(normalizeExtensions(message.extensions ?? message.peers ?? message.browsers))
        break
      case 'peer_connected': {
        const extension = normalizeExtension(message.extension ?? message.peer ?? message)
        this.context.trackEvent?.('chrome_bridge_peer_connected', {})
        for (const waiter of this.peerConnectedWaiters.splice(0)) waiter(true)
        if (extension && this.previousSelectedDeviceId === extension.deviceId) {
          log.info(`[${serverName(this.context)}] Previously selected extension reconnected, auto-reselecting`)
          this.selectExtension(extension.deviceId)
        }
        break
      }
      case 'peer_disconnected': {
        const deviceId = message.deviceId ?? message.device_id
        if (typeof deviceId === 'string' && deviceId === this.selectedDeviceId) {
          this.selectedDeviceId = undefined
          this.discoveryComplete = false
        }
        break
      }
      case 'pairing_response': {
        const accepted = message.accepted !== false
        const extension = normalizeExtension(message.extension ?? message.peer ?? message)
        if (accepted && extension) {
          this.selectExtensionById(extension.deviceId, extension.name, this.lastKnownExtensionIds())
        } else {
          this.pendingSwitchResolve?.(null)
        }
        break
      }
      case 'permission_request':
        void this.handlePermissionRequest(message)
        break
      case 'tool_response':
        this.handleToolResult(message)
        break
      case 'notification':
        if (typeof message.method === 'string') {
          this.notificationHandler?.({ method: message.method, params: message.params })
        }
        break
      default:
        log.debug?.(`[${serverName(this.context)}] Ignoring bridge message: ${String(message.type)}`)
    }
  }

  private handleToolResult(message: Record<string, unknown>): void {
    const id = message.tool_use_id ?? message.toolUseId ?? message.id
    if (typeof id !== 'string') return
    const pending = this.pendingCalls.get(id)
    if (!pending) return
    this.pendingCalls.delete(id)
    clearTimeout(pending.timer)
    pending.resolve({ result: message.result, error: message.error })
  }

  private async handlePermissionRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.tool_use_id ?? message.toolUseId ?? message.id
    if (typeof id !== 'string') return
    const pending = this.pendingCalls.get(id)
    if (!pending?.onPermissionRequest || !this.ws) return
    const response = await pending.onPermissionRequest(message)
    this.ws.send(
      JSON.stringify({
        type: 'permission_response',
        tool_use_id: id,
        ...response,
      }),
    )
  }

  private async discoverAndSelectExtension(): Promise<void> {
    const log = logger(this.context)
    this.persistedDeviceId = this.context.getPersistedDeviceId?.()
    let extensions = await this.queryBridgeExtensions()
    if (extensions.length === 0) {
      log.info(
        `[${serverName(this.context)}] No extensions connected, waiting up to ${PEER_WAIT_TIMEOUT_MS}ms for peer_connected`,
      )
      if (await this.waitForPeerConnected(PEER_WAIT_TIMEOUT_MS)) {
        extensions = await this.queryBridgeExtensions()
      }
    }

    if (this.context.getRequirePairedDevice?.()) {
      this.discoveryComplete = true
      if (!this.persistedDeviceId) return
      const persisted = extensions.find(e => e.deviceId === this.persistedDeviceId)
      if (persisted) this.selectExtension(persisted.deviceId)
      return
    }

    this.discoveryComplete = true
    if (this.selectedDeviceId) return
    if (extensions.length === 0) return
    if (extensions.length === 1) {
      const extension = extensions[0]
      if (!extension) return
      if (!this.isLocalExtension(extension)) {
        this.context.onRemoteExtensionWarning?.(extension)
      }
      this.selectExtension(extension.deviceId)
      return
    }
    if (this.persistedDeviceId) {
      const persisted = extensions.find(e => e.deviceId === this.persistedDeviceId)
      if (persisted) {
        this.selectExtension(persisted.deviceId)
        return
      }
    }
    if (this.context.askUserToolName) {
      this.multiBrowserPendingSelection = true
      return
    }
    this.broadcastPairingRequest()
    this.pairingInProgress = true
    this.firePairingPrompt()
  }

  private queryBridgeExtensions(): Promise<ConnectedExtension[]> {
    if (this.listExtensionsPromise) return this.listExtensionsPromise
    const promise = new Promise<ConnectedExtension[]>(resolve => {
      const timeout = setTimeout(() => {
        this.pendingDiscovery = undefined
        resolve([])
      }, DISCOVERY_TIMEOUT_MS)
      this.pendingDiscovery = { resolve, timeout }
      this.ws?.send(JSON.stringify({ type: 'list_extensions' }))
    }).then(extensions => {
      this.lastKnownExtensionIdsValue = extensions.map(extension => extension.deviceId)
      return extensions
    })
    this.listExtensionsPromise = promise
    void promise.finally(() => {
      if (this.listExtensionsPromise === promise) {
        this.listExtensionsPromise = undefined
      }
    })
    return promise
  }

  private resolveDiscovery(extensions: ConnectedExtension[]): void {
    if (!this.pendingDiscovery) return
    clearTimeout(this.pendingDiscovery.timeout)
    this.pendingDiscovery.resolve(extensions)
    this.pendingDiscovery = undefined
  }

  private selectExtension(deviceId: string): void {
    this.selectedDeviceId = deviceId
    this.previousSelectedDeviceId = undefined
    this.multiBrowserPendingSelection = false
    logger(this.context).info(
      `[${serverName(this.context)}] Selected Chrome extension: ${deviceId.slice(0, 8)}...`,
    )
  }

  private lastKnownExtensionIds(): string[] {
    return this.lastKnownExtensionIdsValue
  }

  private isLocalExtension(extension: ConnectedExtension): boolean {
    return extension.osPlatform === localPlatformLabel()
  }

  private waitForPeerConnected(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.peerConnectedWaiters = this.peerConnectedWaiters.filter(waiter => waiter !== finish)
        resolve(false)
      }, timeoutMs)
      const finish = (connected: boolean): void => {
        clearTimeout(timeout)
        resolve(connected)
      }
      this.peerConnectedWaiters.push(finish)
    })
  }

  private broadcastPairingRequest(): void {
    const requestId = randomUUID()
    this.pendingPairingRequestId = requestId
    this.ws?.send(
      JSON.stringify({
        type: 'pairing_request',
        request_id: requestId,
        client_type: this.context.clientTypeId ?? 'claude-code',
      }),
    )
  }

  private firePairingPrompt(): void {
    this.abortPairingPrompt()
    if (!this.context.onPairingPrompted) return
    const controller = new AbortController()
    this.pairingPromptAbort = controller
    this.pairingPromptTimeout = setTimeout(
      () => this.abortPairingPrompt(),
      PAIRING_TIMEOUT_MS,
    )
    this.context.onPairingPrompted(controller.signal)
  }

  private abortPairingPrompt(): void {
    if (this.pairingPromptTimeout) clearTimeout(this.pairingPromptTimeout)
    this.pairingPromptTimeout = undefined
    this.pairingPromptAbort?.abort()
    this.pairingPromptAbort = undefined
  }

  private rejectPendingCalls(error: Error): void {
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingCalls.delete(id)
    }
  }
}

class NativeSocketClient implements BrowserClient {
  private socket?: Socket
  private buffer = Buffer.alloc(0)
  private pending: Array<{
    resolve: (response: ToolResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private notificationHandler?: (notification: { method: string; params?: unknown }) => void

  constructor(private readonly context: ClaudeForChromeContext) {}

  setNotificationHandler(handler: (notification: { method: string; params?: unknown }) => void): void {
    this.notificationHandler = handler
  }

  async ensureConnected(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return true
    const paths = this.context.getSocketPaths?.() ??
      (this.context.socketPath ? [this.context.socketPath] : [])
    for (const path of paths) {
      try {
        await this.connectPath(path)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
    if (!await this.ensureConnected()) {
      throw new SocketConnectionError(`[${serverName(this.context)}] Browser extension socket not connected`)
    }
    const payload = Buffer.from(JSON.stringify({ method: name, params: args }), 'utf-8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(payload.length, 0)
    this.socket?.write(Buffer.concat([length, payload]))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.shift()
        reject(new ToolCallTimeoutError(name))
      }, this.context.getToolCallTimeoutMs?.(name) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS)
      this.pending.push({ resolve, reject, timer })
    })
  }

  private connectPath(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      socket.once('connect', () => {
        this.socket = socket
        socket.on('data', data => this.handleData(data))
        socket.on('close', () => {
          this.socket = undefined
        })
        resolve()
      })
      socket.once('error', reject)
    })
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>
      if (typeof parsed.method === 'string') {
        this.notificationHandler?.({ method: parsed.method, params: parsed.params })
        continue
      }
      const pending = this.pending.shift()
      if (!pending) continue
      clearTimeout(pending.timer)
      pending.resolve({ result: parsed.result ?? parsed, error: parsed.error })
    }
  }
}

function createBrowserClient(context: ClaudeForChromeContext): BrowserClient {
  if (context.bridgeConfig) return new BridgeClient(context)
  return new NativeSocketClient(context)
}

function disconnectedResult(context: ClaudeForChromeContext): CallToolResult {
  return text(
    context.onToolCallDisconnected?.() ??
      'Browser extension is not connected. Please ensure the Claude browser extension is installed and running.',
    true,
  )
}

async function listConnectedBrowsers(
  context: ClaudeForChromeContext,
  client: BrowserClient,
): Promise<CallToolResult> {
  if (!context.bridgeConfig || !client.listConnectedExtensions) {
    return bridgeOnly('Listing browsers is only available with bridge connections.')
  }
  if (!await client.ensureConnected()) return disconnectedResult(context)
  const extensions = await client.listConnectedExtensions()
  const named = extensions.map((extension, index) => ({
    ...extension,
    name: displayName(extension, index),
  }))
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(named) },
  ]
  if (extensions.length > 1) {
    content.push({
      type: 'text',
      text: `${extensions.length} browsers are connected. ${browserPickerInstruction(context)}`,
    })
  }
  return { content }
}

async function switchBrowser(
  context: ClaudeForChromeContext,
  client: BrowserClient,
): Promise<CallToolResult> {
  if (!context.bridgeConfig) {
    return bridgeOnly('Browser switching is only available with bridge connections.')
  }
  if (!await client.ensureConnected()) return disconnectedResult(context)
  const result = await client.switchBrowser?.() ?? null
  if (result === 'no_other_browsers') {
    return text(
      'No other browsers available to switch to. Open Chrome with the Claude extension in another browser to switch.',
    )
  }
  if (result) {
    return text(`Connected to browser "${result.name ?? result.deviceId.slice(0, 8)}".`)
  }
  return text(
    'No browser responded within the timeout. Make sure Chrome is open with the Claude extension installed, then try again.',
    true,
  )
}

async function selectBrowser(
  context: ClaudeForChromeContext,
  client: BrowserClient,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const deviceId = typeof args.deviceId === 'string' ? args.deviceId : ''
  if (
    !context.bridgeConfig ||
    !client.selectExtensionById ||
    !client.listConnectedExtensions ||
    !deviceId
  ) {
    return bridgeOnly('select_browser requires a bridge connection and a deviceId argument.')
  }
  if (!await client.ensureConnected()) return disconnectedResult(context)
  const extensions = await client.listConnectedExtensions()
  const extension = extensions.find(item => item.deviceId === deviceId)
  if (!extension) {
    return text(
      `No connected browser has deviceId "${deviceId}". Call list_connected_browsers to see currently connected browsers.`,
      true,
    )
  }
  const name = displayName(extension, extensions.indexOf(extension))
  client.selectExtensionById(deviceId, name, extensions.map(item => item.deviceId))
  return text(`Connected to browser "${name}".`)
}

function browserPickerInstruction(context: ClaudeForChromeContext): string {
  if (!context.askUserToolName) return ''
  return `Before any browser action, you MUST call your ask-user tool (if available) with a question listing EVERY connected browser as a separate option (use the display name as the label, and include the deviceId in parentheses), plus one final option labeled exactly: "Open a confirmation screen in every connected Chrome extension and let me select the right one there." Do not skip any connected browser and do not pick one yourself. If the user picks a specific browser, call select_browser with that browser's deviceId.`
}

async function maybeBrowserSelectionError(
  context: ClaudeForChromeContext,
  client: BrowserClient,
): Promise<CallToolResult | undefined> {
  if (!context.bridgeConfig || !context.askUserToolName || !client.listConnectedExtensions) {
    return undefined
  }
  const extensions = await client.listConnectedExtensions()
  if (extensions.length <= 1 || context.getPersistedDeviceId?.()) return undefined
  const names = extensions
    .slice(0, 8)
    .map((extension, index) => {
      const local = extension.isLocal ? ' (this computer)' : ''
      return `- ${displayName(extension, index)} (${extension.deviceId})${local}`
    })
    .join('\n')
  const more = extensions.length > 8 ? `\nand ${extensions.length - 8} more` : ''
  return text(
    `Multiple Chrome browsers are connected to this account and none has been selected for this session. ${browserPickerInstruction(context)}\nConnected browsers:\n${names}${more}`,
    true,
  )
}

async function callChromeTool(
  context: ClaudeForChromeContext,
  client: BrowserClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (toolName === 'switch_browser') return switchBrowser(context, client)
  if (toolName === 'list_connected_browsers') {
    return listConnectedBrowsers(context, client)
  }
  if (toolName === 'select_browser') return selectBrowser(context, client, args)

  try {
    if (!await client.ensureConnected()) return disconnectedResult(context)
    const selectionError = await maybeBrowserSelectionError(context, client)
    if (selectionError) return selectionError
    const hostResult = await context.handleHostTool?.(toolName, args, {
      getActiveTabOrigin: async () => undefined,
    })
    if (hostResult !== undefined) return hostResult
    const response = await client.callTool(toolName, args)
    return formatToolResponse(response, context)
  } catch (error) {
    logger(context).info(`[${serverName(context)}] Error calling tool:`, error)
    if (error instanceof SocketConnectionError || error instanceof NoExtensionConnectedError) {
      return disconnectedResult(context)
    }
    if (error instanceof ToolCallTimeoutError) {
      return text(
        `The "${toolName}" tool did not respond in time. The Chrome extension is connected but the page may be loading, unresponsive, or waiting on a permission prompt in the extension side panel. Try a lighter operation (e.g., "get_page_text" instead of a screenshot) or ask the user to check the page and any pending prompts.`,
        true,
      )
    }
    return text(
      `Error calling tool, please try again. : ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  }
}

export function createBridgeClient(context: ClaudeForChromeContext): BridgeClient {
  return new BridgeClient(context)
}

export function createChromeSocketClient(context: ClaudeForChromeContext): BrowserClient {
  return createBrowserClient(context)
}

export function createClaudeForChromeMcpServer(
  context: ClaudeForChromeContext,
  client = createBrowserClient(context),
): Server {
  const effectiveContext = {
    serverName: 'Claude in Chrome',
    clientTypeId: 'claude-code',
    ...context,
  }
  const server = new Server(
    {
      name: effectiveContext.serverName ?? 'Claude in Chrome',
      version: '1.0.0',
    },
    { capabilities: { tools: {}, logging: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (effectiveContext.isDisabled?.()) return { tools: [] }
    const pickerText = browserPickerInstruction(effectiveContext)
    return {
      tools: [
        ...BROWSER_TOOLS.map(tool =>
          tool.name === 'list_connected_browsers' && pickerText
            ? { ...tool, description: `${tool.description} ${pickerText}` }
            : tool,
        ),
        ...(effectiveContext.hostTools?.() ?? []),
      ],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name
    const args =
      typeof request.params.arguments === 'object' &&
      request.params.arguments !== null
        ? (request.params.arguments as Record<string, unknown>)
        : {}
    logger(effectiveContext).info(`[${serverName(effectiveContext)}] Executing tool: ${name}`)
    return callChromeTool(effectiveContext, client, name, args)
  })

  client.setNotificationHandler(notification => {
    logger(effectiveContext).info(
      `[${serverName(effectiveContext)}] Forwarding MCP notification: ${notification.method}`,
    )
    server.notification(notification).catch(error => {
      logger(effectiveContext).info(
        `[${serverName(effectiveContext)}] Failed to forward MCP notification: ${error.message}`,
      )
    })
  })

  return server
}
