import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import {
  addSessionCronTask,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  DEFAULT_WAKEUP_DELAY_SECONDS,
  MAX_WAKEUP_DELAY_SECONDS,
  MIN_WAKEUP_DELAY_SECONDS,
  SCHEDULE_WAKEUP_TOOL_NAME,
} from './constants.js'
import {
  SCHEDULE_WAKEUP_DESCRIPTION,
  SCHEDULE_WAKEUP_PROMPT,
} from './prompt.js'
import { isKairosCronEnabled } from '../ScheduleCronTool/prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: z
      .number()
      .describe(
        'Seconds from now to wake up. Clamped to [60, 3600] by the runtime.',
      ),
    prompt: z
      .string()
      .describe(
        'The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead (the dynamic-pacing variant, not the CronCreate-mode `<<autonomous-loop>>`).',
      ),
    reason: z
      .string()
      .describe(
        'One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    cron: z.string(),
    humanSchedule: z.string(),
    scheduledFor: z.number(),
    clampedDelaySeconds: z.number(),
    wasClamped: z.boolean(),
    reason: z.string(),
    supersededCount: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ScheduleWakeupOutput = z.infer<OutputSchema>

function clampDelaySeconds(delaySeconds: number): {
  clamped: number
  wasClamped: boolean
} {
  let rounded: number
  if (Number.isNaN(delaySeconds)) {
    rounded = DEFAULT_WAKEUP_DELAY_SECONDS
  } else if (delaySeconds === Infinity) {
    rounded = MAX_WAKEUP_DELAY_SECONDS
  } else if (delaySeconds === -Infinity) {
    rounded = MIN_WAKEUP_DELAY_SECONDS
  } else {
    rounded = Math.round(delaySeconds)
  }

  const clamped = Math.max(
    MIN_WAKEUP_DELAY_SECONDS,
    Math.min(MAX_WAKEUP_DELAY_SECONDS, rounded),
  )
  return {
    clamped,
    wasClamped: !Number.isFinite(delaySeconds) || rounded !== clamped,
  }
}

function roundUpToCronMinute(ms: number): number {
  const target = new Date(ms)
  if (target.getSeconds() > 0 || target.getMilliseconds() > 0) {
    target.setMinutes(target.getMinutes() + 1)
  }
  target.setSeconds(0, 0)
  return target.getTime()
}

function buildOneShotWakeupSchedule(delaySeconds: number): {
  cron: string
  createdAt: number
  scheduledFor: number
} {
  const desiredMs = Date.now() + delaySeconds * 1000
  const scheduledFor = roundUpToCronMinute(desiredMs)
  const target = new Date(scheduledFor)
  return {
    cron: `${target.getMinutes()} ${target.getHours()} * * *`,
    createdAt: desiredMs < scheduledFor ? desiredMs : scheduledFor - 1,
    scheduledFor,
  }
}

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  searchHint: 'schedule dynamic loop wakeup',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.delaySeconds}s: ${input.reason}: ${input.prompt}`
  },
  async description() {
    return SCHEDULE_WAKEUP_DESCRIPTION
  },
  async prompt() {
    return SCHEDULE_WAKEUP_PROMPT
  },
  async call({ delaySeconds, prompt, reason }) {
    const { clamped, wasClamped } = clampDelaySeconds(delaySeconds)
    const { cron, createdAt, scheduledFor } = buildOneShotWakeupSchedule(clamped)
    const ctx = getTeammateContext()
    const supersededIds = getSessionCronTasks()
      .filter(t => t.kind === 'loop' && t.agentId === ctx?.agentId)
      .map(t => t.id)
    removeSessionCronTasks(supersededIds)
    const id = randomUUID().slice(0, 8)
    addSessionCronTask({
      id,
      cron,
      prompt,
      createdAt,
      kind: 'loop',
      ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    })
    setScheduledTasksEnabled(true)
    return {
      data: {
        id,
        cron,
        humanSchedule: cronToHuman(cron),
        scheduledFor,
        clampedDelaySeconds: clamped,
        wasClamped,
        reason,
        supersededCount: supersededIds.length,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Scheduled dynamic /loop wakeup ${output.id} in ${output.clampedDelaySeconds}s (${output.humanSchedule}). Session-only; it will fire once then auto-delete.${output.wasClamped ? ' Delay was clamped to the supported range.' : ''}${output.supersededCount > 0 ? ` Superseded ${output.supersededCount} pending loop wakeup(s).` : ''} Reason: ${output.reason}`,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
} satisfies ToolDef<InputSchema, ScheduleWakeupOutput>)
