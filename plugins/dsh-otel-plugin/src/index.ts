import type { Context, Plugin } from '@deepseek-ai/cordis'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { TracerProvider } from '@opentelemetry/sdk-trace'
import { ConfigSchema, resolveConfig, type TracingConfig } from './config.ts'
import { TraceAdapter } from './adapter.ts'
import { createSpanProcessors, type DeliveryCounters } from './exporters.ts'

type Session = Parameters<TraceAdapter['onSessionEvent']>[0]
type DurableEvent = Parameters<TraceAdapter['onSessionEvent']>[1]
type StreamPayload = Parameters<TraceAdapter['onAssistantStream']>[0]

type DshEvents = {
  on(name: 'session/event', listener: (session: Session, event: DurableEvent) => void, options?: { global?: boolean }): unknown
  on(name: 'session/disposed', listener: (session: Session) => void, options?: { global?: boolean }): unknown
  on(name: 'agent/assistant-stream', listener: (payload: StreamPayload) => void, options?: { global?: boolean }): unknown
  on(name: 'system-prompt/change', listener: () => void, options?: { global?: boolean }): unknown
}

/** One assembled prompt section: a name and resolved, uninterpolated text. */
type PromptSection = { name: string; text: string; interpolate?: boolean }
type PromptAssembly = {
  sections: PromptSection[]
  contexts: unknown[]
  tools: Array<{ name: string }>
  variables: Record<string, string | undefined>
}
type PromptEvents = {
  on(
    name: 'system-prompt/assemble',
    listener: (
      assembly: PromptAssembly,
      context: { scope?: object; agent?: { session?: Session }; signal?: AbortSignal },
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>,
    options?: { global?: boolean; prepend?: boolean },
  ): unknown
}

type Logger = { warn?: (message: string, error?: unknown) => void } | undefined

function safeListener<T extends unknown[]>(label: string, logger: Logger, listener: (...args: T) => void): (...args: T) => void {
  return (...args) => {
    try {
      listener(...args)
    } catch (error) {
      try {
        logger?.warn?.(`[dsh-otel-plugin] ${label} failed`, error)
      } catch {
        // Logging is best effort too. Observer errors must not escape into DSH.
      }
    }
  }
}

/**
 * `renderPrompt` from `@deepseek-ai/dsh-system-prompt`, loaded lazily.
 *
 * DSH renders a system prompt by interpolating each section against the assembly
 * variables, dropping empty sections, and joining with blank lines. Rendering one section
 * at a time through the host's own function gives exactly the text the model received, so
 * a section ref names model-facing bytes and cannot drift from the host renderer. A bundle
 * without the package degrades to whole-prompt refs.
 */
let renderPromptLoader: Promise<((assembly: PromptAssembly) => string) | undefined> | undefined

function loadRenderPrompt(): Promise<((assembly: PromptAssembly) => string) | undefined> {
  renderPromptLoader ??= (async () => {
    const specifier: string = '@deepseek-ai/dsh-system-prompt'
    try {
      const module = (await import(specifier)) as { renderPrompt?: (assembly: PromptAssembly) => string }
      return typeof module.renderPrompt === 'function' ? module.renderPrompt : undefined
    } catch {
      return undefined
    }
  })()
  return renderPromptLoader
}

/** Render each section exactly as the host renders the whole prompt, in assembly order. */
async function renderSections(assembly: PromptAssembly, logger: Logger): Promise<Array<{ name: string; text: string }>> {
  const renderPrompt = await loadRenderPrompt()
  if (!renderPrompt) return assembly.sections.map(section => ({ name: section.name, text: section.text }))
  const rendered: Array<{ name: string; text: string }> = []
  for (const section of assembly.sections) {
    if (section.interpolate === false) {
      if (section.text.length > 0) rendered.push({ name: section.name, text: section.text })
      continue
    }
    try {
      const text = renderPrompt({ ...assembly, sections: [section], contexts: [] })
      if (text.length > 0) rendered.push({ name: section.name, text })
    } catch (error) {
      // A section that cannot interpolate alone cannot render in the whole prompt either;
      // keep the raw text and let the adapter's decomposition check fall back.
      logger?.warn?.(`[dsh-otel-plugin] prompt section "${section.name}" did not interpolate; publishing raw text`)
      if (section.text.length > 0) rendered.push({ name: section.name, text: section.text })
    }
  }
  return rendered
}

const plugin: Plugin.Object<TracingConfig> = {
  name: 'dsh-otel-plugin',
  Config: ConfigSchema as unknown as NonNullable<Plugin.Object<TracingConfig>['Config']>,
  apply(ctx: Context, config: TracingConfig) {
    if (!config.enabled) return
    const resolved = resolveConfig(config)
    if (resolved.endpoints.length === 0) return

    const counters: DeliveryCounters = { exported: 0, failures: 0 }
    let reportGap: (() => void) | undefined
    const processors = createSpanProcessors(resolved.endpoints, undefined, {
      counters,
      onFailure: () => reportGap?.(),
    })
    const provider = new TracerProvider({
      resource: resourceFromAttributes({ 'service.name': resolved.serviceName }),
      spanProcessors: processors,
    })
    const tracer = provider.getTracer('dsh-otel-plugin', '0.3.0')
    const adapter = new TraceAdapter(tracer, resolved)
    reportGap = () => adapter.markExportGap()
    const logger = (ctx as Context & { logger?: (name: string) => Logger }).logger?.('dsh-otel-plugin')
    adapter.onWarn = message => logger?.warn?.(message)
    adapter.setDeliveryCounter(counters)

    const events = ctx as unknown as DshEvents & PromptEvents

    // Cordis unwinds effects in reverse order, so register this before hooks.
    // The hooks are removed before the final span flush starts.
    ctx.effect(() => async () => {
      adapter.dispose()
      try {
        await provider.shutdown()
      } catch (error) {
        try {
          logger?.warn?.('[dsh-otel-plugin] exporter shutdown failed', error)
        } catch {
          // Shutdown errors are contained so unloading does not reject DSH work.
        }
      }
    })

    events.on('session/event', safeListener('session/event', logger, (session, event) => {
      adapter.onSessionEvent(session, event)
    }), { global: true })
    events.on('session/disposed', safeListener('session/disposed', logger, session => {
      adapter.onSessionDisposed(session)
    }), { global: true })
    events.on('agent/assistant-stream', safeListener('agent/assistant-stream', logger, payload => {
      adapter.onAssistantStream(payload)
    }), { global: true })

    if (resolved.capturePrompts && resolved.captureSystemPromptSections) {
      // Post-waterfall sections are authoritative: `next()` runs the other listeners first.
      events.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next()
        const sessionId = context.agent?.session?.id
        if (sessionId === undefined) return assembly
        const sections = await renderSections(assembly, logger)
        adapter.noteAssembly(sessionId, sections, assembly.tools.map(tool => tool.name))
        return assembly
      }, { global: true })
      // A section registration or disposal can change the next assembly for every scope.
      events.on('system-prompt/change', safeListener('system-prompt/change', logger, () => {
        adapter.notePromptRegistryChange()
      }), { global: true })
    }
  },
}

export { ConfigSchema, resolveConfig }
export { TraceAdapter } from './adapter.ts'
export { resolveMessages, resolveTranscript } from './resolve.ts'
export { packRefs, unpackRefs, computeRef, computeRoot } from './refs.ts'
export default plugin
