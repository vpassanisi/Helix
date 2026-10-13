<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Check, ChevronDown, LoaderCircle, Trash2 } from '@lucide/svelte'
  import DecisionSettingsPanel from './DecisionSettings.svelte'
  import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from '../../shared/skills.js'
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
    <input id="base-url" class="input" type="url" bind:value={baseUrl} placeholder="https://api.deepseek.com" />
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

  <div class="flex items-center justify-end gap-2 mt-[2px]">
    <button class="btn inline-flex items-center gap-[6px] border-0 bg-[var(--primary)] text-[var(--primary-foreground)] font-[650]" type="submit" disabled={settingsRestarting}>
      {#if settingsRestarting}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={13} strokeWidth={1.8} /> Applying…{:else}Save connection settings <Check size={13} strokeWidth={1.8} />{/if}
    </button>
  </div>
</form>
