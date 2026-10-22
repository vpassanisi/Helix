<script lang="ts">
  import SettingsView from '../../src/webview/components/SettingsView.svelte'
  import AboutSettings from '../../src/webview/components/AboutSettings.svelte'
  import ConnectionSettings from '../../src/webview/components/ConnectionSettings.svelte'
  import ModelsSettings from '../../src/webview/components/ModelsSettings.svelte'
  import { SettingsPageState } from '../../src/webview/lib/settings-page.svelte.js'
  import { ModelCatalogState } from '../../src/webview/lib/model-catalog.svelte.js'
  import type { SettingsPage } from '../../src/webview/types.js'
  import { discoveredModels as discoveredFixture, modelOptionLabel, models } from '../fixtures.js'
  import manifest from '../../package.json'

  interface Props {
    page: SettingsPage
    status: string
    tone: 'success' | 'warning' | ''
  }

  let { page, status = '', tone = '' }: Props = $props()

  // The connection page is driven by the real controller, so the story exercises
  // the same bindings App uses: page title, status line, and draft round-trips.
  const state = new SettingsPageState()
  state.provider = 'DeepSeek'
  state.baseUrl = 'https://api.deepseek.com/v1'
  state.sandboxMode = 'workspace-write'
  const catalog = new ModelCatalogState()
  catalog.applyCatalog(models)
  catalog.applyDiscovered(discoveredFixture)
  $effect(() => {
    state.open(page)
    state.setStatus(status, tone)
  })

  const info = { name: manifest.displayName, version: manifest.version, vscodeVersion: '1.100.0', license: manifest.license }
</script>

<div class="shell">
  <SettingsView title={state.title(page)} status={state.status} tone={state.tone} onClose={() => {}}>
    {#if page === 'connection'}
      <ConnectionSettings
        bind:provider={state.provider}
        bind:baseUrl={state.baseUrl}
        bind:apiKey={state.apiKey}
        bind:clearApiKey={state.clearApiKey}
        bind:sandboxMode={state.sandboxMode}
        bind:tracing={state.tracing}
        bind:decisions={state.decisions}
        bind:decisionApiKey={state.decisionsApiKey}
        bind:clearDecisionApiKey={state.clearDecisionsApiKey}
        apiKeyConfigured
        decisionKeyConfigured
        skillPickerEnabled
        settingsRestarting={state.restarting}
        onSave={() => state.setStatus(`Save queued for ${state.provider || 'the empty route'}.`, 'success')}
        onStatus={(text, tone) => state.setStatus(text, tone)}
      />
    {:else if page === 'models'}
      <ModelsSettings
        bind:modelDrafts={catalog.drafts}
        discoveredModels={catalog.discovered}
        modelsLoading={catalog.loading}
        modelsError={catalog.error}
        modelCatalogLoading={catalog.catalogLoading}
        modelCatalogSaving={catalog.catalogSaving}
        modelCatalogError={catalog.catalogError}
        {modelOptionLabel}
        onAddModel={(id) => {
          const result = catalog.addDiscovered(id)
          if (result.outcome === 'exists') state.setStatus(`Model "${result.label}" is already in the catalog.`, 'warning')
          if (result.outcome === 'added') state.setStatus(`Added ${result.label}. Edit its details, then save models.`, 'success')
        }}
        onRefreshModels={() => {
          catalog.beginRefresh()
          catalog.applyDiscovered(discoveredFixture)
        }}
        onSaveModels={() => {
          catalog.beginSave()
          state.setStatus(`Saving ${catalog.drafts.length} models…`, 'warning')
        }}
        onStatus={(text, tone) => state.setStatus(text, tone)}
      />
    {:else}
      <AboutSettings {info} />
    {/if}
  </SettingsView>
</div>
