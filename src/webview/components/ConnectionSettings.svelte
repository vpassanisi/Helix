<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Check, ChevronDown, LoaderCircle, Plus, Trash2 } from '@lucide/svelte'
  import DecisionSettingsPanel from './DecisionSettings.svelte'
  import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from '../../shared/skills.js'
  import { DEFAULT_OTEL_TRACING_ENDPOINT, type OtelTracingSettings } from '../../shared/otel-tracing.js'
  import type { SandboxMode } from '../types.js'

  interface Props {
    provider: string
    baseUrl: string
    apiKey: string
    clearApiKey: boolean
    sandboxMode: SandboxMode
    decisions: DecisionSettings
    decisionApiKey: string
    clearDecisionApiKey: boolean
    tracing: OtelTracingSettings
    apiKeyConfigured: boolean
    decisionKeyConfigured: boolean
    skillPickerEnabled: boolean
    settingsRestarting: boolean
    onSave: () => void
    onStatus: (text: string, tone: 'success' | 'warning' | '') => void
  }

  let {
    provider = $bindable(),
    baseUrl = $bindable(),
    apiKey = $bindable(''),
    clearApiKey = $bindable(false),
    sandboxMode = $bindable<SandboxMode>('workspace-write'),
    decisions = $bindable<DecisionSettings>({ ...DEFAULT_DECISION_SETTINGS }),
    decisionApiKey = $bindable(''),
    clearDecisionApiKey = $bindable(false),
    tracing = $bindable<OtelTracingSettings>(),
    apiKeyConfigured,
    decisionKeyConfigured,
    skillPickerEnabled,
    settingsRestarting,
    onSave,
    onStatus,
  }: Props = $props()

  let sandboxPickerElement: HTMLDivElement | undefined

  function sandboxModeLabel(mode: SandboxMode = sandboxMode): string {
    if (mode === 'read-only') return 'Read-only'
    if (mode === 'danger-full-access') return 'Danger full access'
    return 'Workspace write'
  }

  function handleSandboxModeChange(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string }>).detail
    const nextMode = detail?.value
    if (nextMode !== 'read-only' && nextMode !== 'workspace-write' && nextMode !== 'danger-full-access') return
    sandboxMode = nextMode
  }

  function clearStoredKey(): void {
    clearApiKey = true
    apiKey = ''
    onStatus('Save settings to remove the stored key.', 'warning')
  }

  function addOtelEndpoint(): void {
    const id = globalThis.crypto?.randomUUID?.() ?? `endpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`
    tracing = { ...tracing, endpoints: [...tracing.endpoints, { ...DEFAULT_OTEL_TRACING_ENDPOINT, id }] }
  }

  function removeOtelEndpoint(index: number): void {
    tracing = { ...tracing, endpoints: tracing.endpoints.filter((_, endpointIndex) => endpointIndex !== index) }
  }

  function changeOtelAuthMethod(endpoint: OtelTracingSettings['endpoints'][number], event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value
    if (value !== 'none' && value !== 'bearer' && value !== 'api-key') return
    endpoint.authMethod = value
    if (value === 'none') {
      endpoint.credentialDraft = ''
      endpoint.clearCredential = false
    }
  }

  function clearOtelCredential(endpoint: OtelTracingSettings['endpoints'][number]): void {
    endpoint.credentialDraft = ''
    endpoint.clearCredential = endpoint.credentialConfigured
  }

  onMount(() => {
    void tick().then(() => {
      const basecoat = (window as Window & { basecoat?: { init?: (component: string) => void } }).basecoat
      basecoat?.init?.('select')
      basecoat?.init?.('popover')
      const picker = sandboxPickerElement as (HTMLDivElement & { refresh?: () => void }) | undefined
      picker?.refresh?.()
    })
  })
</script>

<form class="grid gap-[15px]" onsubmit={(event) => { event.preventDefault(); onSave() }}>
  <div class="grid gap-1.5" role="group">
    <label class="text-[var(--muted-foreground)] text-[10px] tracking-[.08em] uppercase" for="provider">Provider route</label>
    <input id="provider" class="input" type="text" bind:value={provider} placeholder="deepseek-official" />
  </div>

  {#if provider.trim() === 'deepseek-official'}
    <p class="m-0 rounded-[var(--radius)] border border-[#645432] bg-[#201d17] px-[9px] py-2 text-[10px] leading-[1.45] text-[#e2cf9f]" role="status">The direct <code>deepseek-official</code> route uses DSH’s fixed adapter. Model reasoning formats here require an existing <code>llm-pi-ai</code> route; this route will not apply the format settings.</p>
  {/if}

  <div class="grid gap-1.5" role="group">
    <label class="text-[var(--muted-foreground)] text-[10px] tracking-[.08em] uppercase" for="base-url">API base URL</label>
    <input id="base-url" class="input" type="url" bind:value={baseUrl} placeholder={provider === 'deepseek-official' ? 'https://api.deepseek.com/anthropic' : 'https://api.example.com/v1'} />
    <small class="flex items-center gap-1 text-[var(--muted-foreground)] text-[10px] leading-[1.4]">Leave empty to use the provider default.</small>
  </div>



  <div class="grid gap-1.5" role="group">
    <label class="text-[var(--muted-foreground)] text-[10px] tracking-[.08em] uppercase" for="api-key">API key</label>
    <div class="flex min-w-0 items-center gap-[6px]">
      <input id="api-key" class="input min-w-0 flex-1" type="password" bind:value={apiKey} oninput={() => { if (apiKey) clearApiKey = false }} placeholder={apiKeyConfigured ? 'Saved key — enter a new key to replace it' : 'Paste an API key'} autocomplete="off" />
      <button class="btn flex-none h-[30px] w-[30px] p-0 text-[var(--muted-foreground)]" data-variant="ghost" data-size="icon" type="button" aria-label="Clear API key" title="Clear API key" onclick={clearStoredKey} disabled={!apiKeyConfigured && !apiKey}>
        <Trash2 size={13} strokeWidth={1.8} />
      </button>
    </div>
    <small class="flex items-center gap-1 text-[#aaa]! text-[10px] leading-[1.4]">
      {#if clearApiKey}<Trash2 size={11} strokeWidth={1.8} /> The saved key will be removed when you save.
      {:else if apiKeyConfigured}<Check size={11} strokeWidth={1.8} /> A key is currently saved.
      {:else}No key saved yet.{/if}
    </small>
  </div>

  {#if skillPickerEnabled}
    <DecisionSettingsPanel bind:decisions bind:apiKey={decisionApiKey} bind:clearKey={clearDecisionApiKey} mainUrl={baseUrl} {provider} keyConfigured={decisionKeyConfigured} />
  {/if}

  <div class="grid gap-1.5" role="group">
    <label class="text-[var(--muted-foreground)] text-[10px] tracking-[.08em] uppercase" for="sandbox-picker-trigger">Sandbox permissions</label>
    <div id="sandbox-picker" class="select min-w-0 w-full" bind:this={sandboxPickerElement} data-placeholder="Sandbox permissions" onchange={handleSandboxModeChange}>
      <button id="sandbox-picker-trigger" class="btn flex w-full items-center justify-between gap-2" data-variant="outline" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="sandbox-picker-listbox">
        <span>{sandboxModeLabel()}</span>
        <ChevronDown size={13} strokeWidth={1.7} />
      </button>
      <div id="sandbox-picker-popover" class="z-[30] w-max min-w-full max-w-[min(260px,calc(100vw-36px))] p-[5px]" data-popover data-side="bottom" data-align="start" aria-hidden="true">
        <div id="sandbox-picker-listbox" class="grid gap-px" role="listbox" aria-orientation="vertical" aria-labelledby="sandbox-picker-trigger">
          <div class="flex min-w-0 items-center rounded-[4px] px-2 py-[7px] text-[10px] leading-[1.3] text-[var(--muted-foreground)] cursor-pointer hover:bg-[var(--accent)] hover:text-[var(--foreground)] [&.active]:bg-[var(--accent)] [&.active]:text-[var(--foreground)] aria-selected:bg-[var(--accent)] aria-selected:text-[var(--foreground)]" role="option" data-value="read-only" aria-selected={sandboxMode === 'read-only' ? 'true' : undefined}><span>Read-only</span></div>
          <div class="flex min-w-0 items-center rounded-[4px] px-2 py-[7px] text-[10px] leading-[1.3] text-[var(--muted-foreground)] cursor-pointer hover:bg-[var(--accent)] hover:text-[var(--foreground)] [&.active]:bg-[var(--accent)] [&.active]:text-[var(--foreground)] aria-selected:bg-[var(--accent)] aria-selected:text-[var(--foreground)]" role="option" data-value="workspace-write" aria-selected={sandboxMode === 'workspace-write' ? 'true' : undefined}><span>Workspace write</span></div>
          <div class="flex min-w-0 items-center rounded-[4px] px-2 py-[7px] text-[10px] leading-[1.3] text-[var(--muted-foreground)] cursor-pointer hover:bg-[var(--accent)] hover:text-[var(--foreground)] [&.active]:bg-[var(--accent)] [&.active]:text-[var(--foreground)] aria-selected:bg-[var(--accent)] aria-selected:text-[var(--foreground)]" role="option" data-value="danger-full-access" aria-selected={sandboxMode === 'danger-full-access' ? 'true' : undefined}><span>Danger full access</span></div>
        </div>
      </div>
      <input type="hidden" name="sandbox-mode" value={sandboxMode} />
    </div>
  </div>

  <fieldset class="m-0 min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--composer)] px-[10px] pt-[9px] pb-[10px]">
    <legend class="px-[4px] text-[11px] font-[650] tracking-[.04em] text-[var(--foreground)]">OpenTelemetry tracing</legend>
    <div class="grid gap-[10px]">
      <div class="field" role="group" data-orientation="horizontal">
        <section>
          <label for="otel-enabled">Export runtime traces</label>
          <p>Send DSH traces to an OTLP collector.</p>
        </section>
        <input id="otel-enabled" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.enabled} />
      </div>

      <div class="grid gap-[7px]">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] font-semibold text-[var(--foreground)]">Destinations</span>
          <button class="btn inline-flex h-[26px] items-center gap-1 px-[7px] text-[10px]" data-variant="outline" type="button" onclick={addOtelEndpoint}>
            <Plus size={12} strokeWidth={1.8} /> Add endpoint
          </button>
        </div>
        {#if tracing.endpoints.length === 0}
          <small class="text-[var(--muted-foreground)] text-[10px] leading-[1.4]">Add one or more OTLP destinations. Each trace is sent to every destination.</small>
        {/if}
        {#each tracing.endpoints as endpoint, index (index)}
          <section class="grid min-w-0 gap-[8px] rounded-[var(--radius)] border border-[var(--border)] px-[9px] py-[8px]" aria-label={`OTLP destination ${index + 1}`}>
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] font-semibold text-[var(--foreground)]">Destination {index + 1}</span>
              <button class="btn flex h-[26px] w-[26px] items-center justify-center p-0 text-[var(--muted-foreground)]" data-variant="ghost" data-size="icon" type="button" aria-label={`Remove destination ${index + 1}`} title={`Remove destination ${index + 1}`} onclick={() => removeOtelEndpoint(index)}>
                <Trash2 size={12} strokeWidth={1.8} />
              </button>
            </div>
            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-[9px] [@media(max-width:360px)]:grid-cols-1">
              <div class="field min-w-0" role="group">
                <label for={`otel-endpoint-${index}`}>Endpoint</label>
                <input id={`otel-endpoint-${index}`} class="input" type="text" bind:value={endpoint.url} placeholder="https://collector.example/v1/traces or collector:4317" autocomplete="off" spellcheck="false" />
              </div>
              <div class="field min-w-0" role="group">
                <label for={`otel-protocol-${index}`}>Protocol</label>
                <select id={`otel-protocol-${index}`} class="select" bind:value={endpoint.protocol}>
                  <option value="http/protobuf">HTTP / Protobuf</option>
                  <option value="grpc">gRPC</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-[9px] [@media(max-width:360px)]:grid-cols-1">
              <div class="field min-w-0" role="group">
                <label for={`otel-auth-${index}`}>Authentication</label>
                <select id={`otel-auth-${index}`} class="select" value={endpoint.authMethod} onchange={(event) => changeOtelAuthMethod(endpoint, event)}>
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="api-key">API key header</option>
                </select>
              </div>
              <div class="field min-w-0" role="group">
                <label for={`otel-timeout-${index}`}>Export timeout (ms)</label>
                <input id={`otel-timeout-${index}`} class="input" type="number" min="100" max="120000" step="100" bind:value={endpoint.timeoutMs} />
              </div>
            </div>
            {#if endpoint.authMethod === 'api-key'}
              <div class="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] items-start gap-[9px] [@media(max-width:360px)]:grid-cols-1">
                <div class="field min-w-0" role="group">
                  <label for={`otel-header-name-${index}`}>Header name</label>
                  <input id={`otel-header-name-${index}`} class="input" type="text" bind:value={endpoint.headerName} placeholder="x-api-key" autocomplete="off" spellcheck="false" />
                </div>
                <div class="field min-w-0" role="group">
                  <label for={`otel-credential-${index}`}>API key</label>
                  <div class="flex min-w-0 items-center gap-[6px]">
                    <input id={`otel-credential-${index}`} class="input min-w-0 flex-1" type="password" value={endpoint.credentialDraft} oninput={(event) => { endpoint.credentialDraft = (event.currentTarget as HTMLInputElement).value; endpoint.clearCredential = false }} placeholder={endpoint.credentialConfigured ? 'Saved key — enter to replace' : 'Paste an API key'} autocomplete="new-password" />
                    <button class="btn flex-none h-[30px] w-[30px] p-0 text-[var(--muted-foreground)]" data-variant="ghost" data-size="icon" type="button" aria-label={`Clear API key for destination ${index + 1}`} title="Clear saved API key" onclick={() => clearOtelCredential(endpoint)} disabled={!endpoint.credentialConfigured && !endpoint.credentialDraft}>
                      <Trash2 size={12} strokeWidth={1.8} />
                    </button>
                  </div>
                  {#if endpoint.clearCredential}<small class="text-[var(--muted-foreground)] text-[9px]">Saved key will be removed when you save.</small>
                  {:else if endpoint.credentialConfigured}<small class="flex items-center gap-1 text-[var(--muted-foreground)] text-[9px]"><Check size={10} strokeWidth={1.8} /> Key stored securely.</small>
                  {:else}<small class="text-[var(--muted-foreground)] text-[9px]">Key is stored securely after saving.</small>{/if}
                </div>
              </div>
            {:else if endpoint.authMethod === 'bearer'}
              <div class="field min-w-0" role="group">
                <label for={`otel-credential-${index}`}>Bearer token</label>
                <div class="flex min-w-0 items-center gap-[6px]">
                  <input id={`otel-credential-${index}`} class="input min-w-0 flex-1" type="password" value={endpoint.credentialDraft} oninput={(event) => { endpoint.credentialDraft = (event.currentTarget as HTMLInputElement).value; endpoint.clearCredential = false }} placeholder={endpoint.credentialConfigured ? 'Saved token — enter to replace' : 'Paste a bearer token'} autocomplete="new-password" />
                  <button class="btn flex-none h-[30px] w-[30px] p-0 text-[var(--muted-foreground)]" data-variant="ghost" data-size="icon" type="button" aria-label={`Clear bearer token for destination ${index + 1}`} title="Clear saved bearer token" onclick={() => clearOtelCredential(endpoint)} disabled={!endpoint.credentialConfigured && !endpoint.credentialDraft}>
                    <Trash2 size={12} strokeWidth={1.8} />
                  </button>
                </div>
                {#if endpoint.clearCredential}<small class="text-[var(--muted-foreground)] text-[9px]">Saved token will be removed when you save.</small>
                {:else if endpoint.credentialConfigured}<small class="flex items-center gap-1 text-[var(--muted-foreground)] text-[9px]"><Check size={10} strokeWidth={1.8} /> Token stored securely.</small>
                {:else}<small class="text-[var(--muted-foreground)] text-[9px]">Token is stored securely after saving.</small>{/if}
              </div>
            {/if}
            {#if endpoint.authMethod === 'none' && endpoint.legacyHeadersEnv}
              <div class="flex items-center justify-between gap-2 rounded-[4px] border border-[var(--border)] px-[7px] py-[5px]">
                <small class="text-[var(--muted-foreground)] text-[9px] leading-[1.4]">Legacy headers from {endpoint.legacyHeadersEnv} are still active.</small>
                <button class="btn flex-none px-[6px] text-[9px]" data-variant="ghost" type="button" onclick={() => { endpoint.legacyHeadersEnv = '' }}>Stop using</button>
              </div>
            {/if}
            <small class="text-[var(--muted-foreground)] text-[9px] leading-[1.4]">HTTP URLs include /v1/traces. Credentials are kept in VS Code SecretStorage and sent only to this destination.</small>
          </section>
        {/each}
      </div>

      <div class="grid grid-cols-2 gap-[9px] [@media(max-width:360px)]:grid-cols-1">
        <div class="field min-w-0" role="group">
          <label for="otel-service-name">Service name</label>
          <input id="otel-service-name" class="input" bind:value={tracing.serviceName} placeholder="helix" autocomplete="off" />
        </div>
        <div class="field min-w-0" role="group">
          <label for="otel-max-content">Max captured length</label>
          <input id="otel-max-content" class="input" type="number" min="64" max="65536" step="64" bind:value={tracing.maxContentLength} />
        </div>
      </div>

      <fieldset class="m-0 min-w-0 border-0 border-t border-[var(--border)] p-0 pt-[8px]">
        <legend class="mb-[5px] text-[10px] font-semibold text-[var(--foreground)]">Captured content</legend>
        <p class="mb-[7px]! text-[9px] leading-[1.4] text-[var(--muted-foreground)]">Captured content can contain sensitive data. These options are off by default.</p>
        <div class="grid grid-cols-3 gap-x-[8px] gap-y-[6px] [@media(max-width:360px)]:grid-cols-1">
          <div class="field" role="group" data-orientation="horizontal">
            <input id="otel-capture-prompts" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.capturePrompts} />
            <label for="otel-capture-prompts">Prompts</label>
          </div>
          <div class="field" role="group" data-orientation="horizontal">
            <input id="otel-capture-responses" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.captureResponses} />
            <label for="otel-capture-responses">Responses</label>
          </div>
          <div class="field" role="group" data-orientation="horizontal">
            <input id="otel-capture-tool-arguments" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.captureToolArguments} />
            <label for="otel-capture-tool-arguments">Tool arguments</label>
          </div>
        </div>
      </fieldset>
    </div>
  </fieldset>

  <div class="flex items-center justify-end gap-2 mt-[2px]">
    <button class="btn inline-flex items-center gap-[6px] border-0 bg-[var(--primary)] text-[var(--primary-foreground)]! font-[650]" type="submit" disabled={settingsRestarting}>
      {#if settingsRestarting}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={13} strokeWidth={1.8} /> Applying…{:else}Save connection settings <Check size={13} strokeWidth={1.8} />{/if}
    </button>
  </div>
</form>
