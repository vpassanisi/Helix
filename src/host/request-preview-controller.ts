import type { SkillCatalog, SkillTurnSelection } from '../shared/skills.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import type { ControlEvent } from '../runtime/control-bridge.js'
import type { PreviewPromptBreakdown, PreviewRequest, RequestPreviewResult } from '../runtime/control-protocol.js'
import type { RuntimeOptions } from '../runtime/types.js'

const CAPTURE_TIMEOUT_MS = 60_000

export interface RequestPreviewRuntime {
  skillCatalog?(sessionId: string): Promise<SkillCatalog>
  stageSkills?(sessionId: string, selection: SkillTurnSelection): Promise<void>
  start(options: RuntimeOptions): Promise<void>
  setReasoningEffort(sessionId: string, reasoningEffort: string | null): Promise<void>
  armRequestPreview(sessionId: string, captureId: string): Promise<void>
  prompt(sessionId: string, contentBlocks: Array<{ type: 'text'; text: string }>): Promise<string>
  dispose(): Promise<void>
}

export interface RequestPreviewControllerOptions {
  getRuntimeOptions: () => Promise<RuntimeOptions>
  resolveReasoningEffort: () => Promise<string | undefined>
  createRuntime?: (onControlEvent: (event: ControlEvent) => void) => RequestPreviewRuntime
  captureTimeoutMs?: number
  prepareSkills?: (runtime: RequestPreviewRuntime, sessionId: string, prompt: string) => Promise<SkillTurnSelection | undefined>
}

interface ActivePreview {
  cancellation: Promise<never>
  cancel: () => void
  done: Promise<void>
  finish: () => void
}

export class RequestPreviewCancelledError extends Error {
  constructor() {
    super('Request preview cancelled.')
    this.name = 'RequestPreviewCancelledError'
  }
}

export class RequestPreviewController {
  private active: ActivePreview | undefined

  constructor(private readonly options: RequestPreviewControllerOptions) {}

  run(prompt: string): Promise<RequestPreviewResult> {
    const text = prompt.trim()
    if (!text) return Promise.reject(new Error('Enter a prompt to preview.'))
    if (this.active !== undefined) return Promise.reject(new Error('A request preview is already running.'))

    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const active: ActivePreview = {
      cancellation,
      cancel: () => rejectCancellation(new RequestPreviewCancelledError()),
      done,
      finish,
    }
    this.active = active

    return this.runPreview(text, active).finally(() => {
      if (this.active === active) this.active = undefined
      active.finish()
    })
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    active.cancel()
    await active.done
  }

  private async runPreview(prompt: string, active: ActivePreview): Promise<RequestPreviewResult> {
    const sessionId = randomUUID()
    const captureId = randomUUID()
    let sessionStorageRoot: string | undefined
    let runtime: RequestPreviewRuntime | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveCapture!: (result: RequestPreviewResult) => void
    let rejectCapture!: (error: unknown) => void
    const captured = new Promise<RequestPreviewResult>((resolve, reject) => {
      resolveCapture = resolve
      rejectCapture = reject
    })

    try {
      const [runtimeOptions, reasoningEffort] = await Promise.race([
        Promise.all([this.options.getRuntimeOptions(), this.options.resolveReasoningEffort()]),
        active.cancellation,
      ])
      sessionStorageRoot = await mkdtemp(join(tmpdir(), 'helix-request-preview-'))
      runtime = (this.options.createRuntime ?? ((onControlEvent) => new HarnessRuntime({ onControlEvent })))(
        (event) => {
          if (
            event.method !== 'request.previewCaptured' ||
            event.sessionId !== sessionId ||
            event.params.captureId !== captureId
          ) return
          const request = event.params.request
          if (!isPreviewRequest(request)) {
            rejectCapture(new Error('DSH returned an invalid request preview.'))
            return
          }
          const promptBreakdown = isPreviewPromptBreakdown(event.params.promptBreakdown)
            ? event.params.promptBreakdown
            : undefined
          resolveCapture({ request, ...(promptBreakdown === undefined ? {} : { promptBreakdown }) })
        },
      )

      await Promise.race([
        runtime.start({ ...runtimeOptions, sessionStorageRoot }),
        active.cancellation,
      ])
      if (this.options.prepareSkills && runtime.stageSkills) {
        const selection = await Promise.race([this.options.prepareSkills(runtime, sessionId, prompt), active.cancellation])
        if (selection) await Promise.race([runtime.stageSkills(sessionId, selection), active.cancellation])
      }
      await Promise.race([runtime.setReasoningEffort(sessionId, reasoningEffort ?? null), active.cancellation])
      await Promise.race([runtime.armRequestPreview(sessionId, captureId), active.cancellation])

      void runtime.prompt(sessionId, [{ type: 'text', text: prompt }]).catch(rejectCapture)
      timer = setTimeout(() => rejectCapture(new Error('Timed out while waiting for DSH to assemble the request.')), this.options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS)
      return await Promise.race([captured, active.cancellation])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      try {
        await runtime?.dispose()
      } finally {
        if (sessionStorageRoot !== undefined) await rm(sessionStorageRoot, { recursive: true, force: true })
      }
    }
  }
}

function isPreviewRequest(value: unknown): value is PreviewRequest {
  return typeof value === 'object' && value !== null &&
    typeof (value as PreviewRequest).provider === 'string' &&
    typeof (value as PreviewRequest).model === 'string' &&
    Array.isArray((value as PreviewRequest).messages)
}

function isPreviewPromptBreakdown(value: unknown): value is PreviewPromptBreakdown {
  if (typeof value !== 'object' || value === null) return false
  const breakdown = value as Partial<PreviewPromptBreakdown>
  const isSections = (sections: unknown): sections is PreviewPromptBreakdown['systemSections'] =>
    Array.isArray(sections) && sections.every((section) =>
      typeof section === 'object' && section !== null &&
      typeof (section as { name?: unknown }).name === 'string' &&
      typeof (section as { text?: unknown }).text === 'string',
    )
  return isSections(breakdown.systemSections) && isSections(breakdown.contextSections)
}
