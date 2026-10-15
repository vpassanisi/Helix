<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import ConnectionSettings from '../../src/webview/components/ConnectionSettings.svelte'
  import type { DecisionSettings } from '../../src/shared/skills.js'
  import { DEFAULT_OTEL_TRACING_SETTINGS, type OtelTracingSettings } from '../../src/shared/otel-tracing.js'
  import type { SandboxMode } from '../../src/webview/types.js'

  let { args }: { args: ComponentProps<typeof ConnectionSettings> } = $props()
  let provider = $state('')
  let baseUrl = $state('')
  let apiKey = $state('')
  let clearApiKey = $state(false)
  let sandboxMode = $state<SandboxMode>('workspace-write')
  let decisions = $state<DecisionSettings>({ enabled: false, useMainConnection: true, format: 'typesafe', baseUrl: '', model: '' })
  let tracing = $state<OtelTracingSettings>({ ...DEFAULT_OTEL_TRACING_SETTINGS })
  let decisionApiKey = $state('')
  let clearDecisionApiKey = $state(false)
  let statusText = $state('')
  let statusTone = $state<'success' | 'warning' | ''>('')

  $effect(() => {
    provider = args.provider
    baseUrl = args.baseUrl
    apiKey = args.apiKey
    clearApiKey = args.clearApiKey
    sandboxMode = args.sandboxMode
    decisions = structuredClone($state.snapshot(args.decisions))
    tracing = structuredClone($state.snapshot(args.tracing))
    decisionApiKey = args.decisionApiKey
    clearDecisionApiKey = args.clearDecisionApiKey
  })

  function handleStatus(text: string, tone: 'success' | 'warning' | ''): void {
    statusText = text
    statusTone = tone
    args.onStatus(text, tone)
  }
</script>

<div class="mx-auto grid w-full max-w-[520px] gap-3">
  <ConnectionSettings
    {...args}
    bind:provider
    bind:baseUrl
    bind:apiKey
    bind:clearApiKey
    bind:sandboxMode
    bind:tracing
    bind:decisions
    bind:decisionApiKey
    bind:clearDecisionApiKey
    onStatus={handleStatus}
  />
  <p class="m-0 min-h-4 text-[10px] text-[var(--muted-foreground)]" class:success={statusTone === 'success'} class:warning={statusTone === 'warning'} role="status">{statusText}</p>
</div>
