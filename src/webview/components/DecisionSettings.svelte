<script lang="ts">
  import { tick } from 'svelte'
  import { ChevronDown, Trash2 } from '@lucide/svelte'
  import { decisionEndpoint, type DecisionSettings } from '../../shared/skills.js'
  let { decisions = $bindable(), apiKey = $bindable(''), clearKey = $bindable(false), mainUrl, provider, keyConfigured = false }: {
    decisions: DecisionSettings; apiKey?: string; clearKey?: boolean; mainUrl: string; provider: string; keyConfigured?: boolean
  } = $props()
  function endpoint(): string {
    const url = decisions.useMainConnection ? mainUrl || (provider === 'deepseek-official' ? 'https://api.deepseek.com' : '') : decisions.baseUrl
    try { return decisionEndpoint(url, decisions.format) } catch { return 'Enter an API base URL to resolve the endpoint.' }
  }
  $effect(() => {
    const enabled = decisions.enabled
    if (enabled) void tick().then(() => (window as Window & { basecoat?: { init: (name: string) => void } }).basecoat?.init('select'))
  })
</script>

<fieldset class="decision-settings">
  <legend>Skill selection</legend>
  <div class="field" data-orientation="horizontal">
    <label for="decisions-enabled">Enable automatic skill selection</label>
    <input id="decisions-enabled" class="input" role="switch" type="checkbox" bind:checked={decisions.enabled} />
  </div>
  {#if decisions.enabled}
    <div class="field" data-orientation="horizontal">
      <label for="decisions-main">Use main connection for decisions</label>
      <input id="decisions-main" class="input" role="switch" type="checkbox" bind:checked={decisions.useMainConnection} />
    </div>
    <small>{decisions.useMainConnection ? 'The main API URL supports decisions and uses the same saved key.' : 'Decisions use an independent URL and API key.'}</small>
    <div class="field">
      <label for="decisions-format-trigger">Decisions API format</label>
      <div class="select" onchange={(event) => { const value = (event.target as HTMLElement).closest('.select')?.querySelector('input')?.value; if (value === 'typesafe' || value === 'openai') decisions.format = value }}>
        <button id="decisions-format-trigger" class="btn" data-variant="outline" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="decisions-format-list"><span>{decisions.format === 'typesafe' ? 'TypeSafe / Jev' : 'OpenAI Decisions'}</span><ChevronDown size={13} /></button>
        <div data-popover aria-hidden="true" data-side="bottom" data-align="start">
          <div id="decisions-format-list" role="listbox" aria-labelledby="decisions-format-trigger">
            <div role="option" data-value="typesafe" aria-selected={decisions.format === 'typesafe'}>TypeSafe / Jev</div>
            <div role="option" data-value="openai" aria-selected={decisions.format === 'openai'}>OpenAI Decisions</div>
          </div>
        </div>
        <input type="hidden" value={decisions.format} />
      </div>
    </div>
    {#if !decisions.useMainConnection}
      <div class="field"><label for="decisions-url">Decisions API base URL</label><input id="decisions-url" class="input" type="url" bind:value={decisions.baseUrl} placeholder="http://localhost:8080/v1" /></div>
      <div class="field">
        <label for="decisions-key">Decisions API key</label>
        <div class="decision-key-row">
          <input id="decisions-key" class="input" type="password" bind:value={apiKey} oninput={() => { if (apiKey) clearKey = false }} autocomplete="off" placeholder={keyConfigured ? 'Saved key — enter to replace' : 'Optional for local servers'} />
          <span data-tooltip="Clear decisions API key"><button class="btn" data-variant="ghost" data-size="icon" type="button" aria-label="Clear decisions API key" disabled={!keyConfigured && !apiKey} onclick={() => { apiKey = ''; clearKey = keyConfigured }}><Trash2 size={13} /></button></span>
        </div>
        <small>{clearKey ? 'The saved key will be removed when you save.' : keyConfigured ? 'A separate key is saved.' : 'The main API key is never sent to this URL.'}</small>
      </div>
    {/if}
    <small class="resolved-endpoint">POST {endpoint()}</small>
    <div class="field"><label for="decisions-model">Decisions model ID</label><input id="decisions-model" class="input" type="text" bind:value={decisions.model} placeholder="Your decisions model ID" required /></div>
  {/if}
  <small>Manual skill choices remain available when automatic selection is off.</small>
</fieldset>

<style>
  .decision-settings { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); padding-top: 16px; min-width: 0; }
  legend { font-size: 12px; padding-top: 12px; margin-bottom: 10px; }
  .field[data-orientation='horizontal'] { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .field label { font-size: 11px; }
  small { font-size: 10px; line-height: 1.45; color: var(--muted-foreground); }
  .resolved-endpoint { overflow-wrap: anywhere; }
  .decision-key-row { display: flex; align-items: center; gap: 6px; }
  .decision-key-row .input { min-width: 0; flex: 1; }
</style>
