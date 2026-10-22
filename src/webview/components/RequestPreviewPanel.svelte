<script lang="ts">
  import { ChevronDown, LoaderCircle } from '@lucide/svelte'
  import { createRequestPreviewView } from '../../shared/request-preview-view.js'
  import type { RequestPreviewResult } from '../types.js'

  interface Props {
    showRawJson: boolean
    state: 'idle' | 'loading' | 'success' | 'error' | 'cancelled'
    preview?: RequestPreviewResult
    error: string
    onCancel: () => void
  }

  let { showRawJson = $bindable(), state, preview, error, onCancel }: Props = $props()
  const statusLayoutClass = 'flex items-center gap-[6px] text-[10px] leading-[1.45]'
  const statusClass = `${statusLayoutClass} text-[var(--muted-foreground)]`
  const valueCardClass = 'grid min-w-0 gap-[3px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-[9px] py-[7px]'
  const detailLabelClass = 'text-[9px] text-[var(--muted-foreground)]'
  const detailValueClass = 'text-[10px] font-semibold wrap-anywhere text-[var(--foreground)]'
  const sectionHeadingClass = 'm-0 flex items-center gap-[6px] text-[10px] font-[650] text-[var(--foreground)]'
  const payloadClass = 'm-0 min-w-0 whitespace-pre-wrap text-[9px] leading-[1.5] wrap-anywhere text-[var(--foreground)] [font-family:var(--vscode-editor-font-family,monospace)]'
  const payloadHeadingClass = 'm-0 text-[8px] font-[650] wrap-anywhere text-[var(--muted-foreground)]'
</script>

<div class="settings-fill grid min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-[13px]">
  {#if state === 'loading'}
    <p class={statusClass} role="status">
      <LoaderCircle class="animate-spin motion-reduce:animate-none" size={12} strokeWidth={1.8} /> Starting an isolated DSH session and assembling the request…
      <button class="btn ml-auto h-[24px] flex-none" data-variant="outline" type="button" onclick={onCancel}>Cancel</button>
    </p>
  {:else if state === 'error'}
    <p class={`${statusLayoutClass} text-[var(--destructive)]`} role="alert">{error}</p>
  {:else if state === 'cancelled'}
    <p class={statusClass} role="status">Preview cancelled.</p>
  {:else if preview}
    {@const previewView = createRequestPreviewView(preview)}
    <div class="field m-0 items-center justify-between rounded-[var(--radius)] border border-[var(--border)] px-[9px] py-[7px]" role="group" data-orientation="horizontal">
      <section class="grid gap-[3px]">
        <label class="text-[10px] font-semibold" for="request-preview-raw-json">Show raw JSON</label>
        <p class="text-[9px] leading-[1.4] text-[var(--muted-foreground)]">Switch between the readable breakdown and the captured request.</p>
      </section>
      <input id="request-preview-raw-json" type="checkbox" role="switch" class="input" bind:checked={showRawJson} />
    </div>
    {#if showRawJson}
      <pre class="m-0 min-h-0 overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[#0b0b0b] p-[10px] whitespace-pre text-[10px] leading-[1.5] text-[#d0d0d0] [font-family:var(--vscode-editor-font-family,monospace)]" aria-label="Canonical DSH request"><code class="[font:inherit]">{JSON.stringify(preview.request, null, 2)}</code></pre>
    {:else}
      <div class="grid min-h-0 min-w-0 gap-[10px] overflow-auto py-px pr-[2px] pl-0" aria-label="Readable DSH request">
        <div class="grid grid-cols-2 gap-[7px]">
          <div class={valueCardClass}><span class={detailLabelClass}>Provider</span><strong class={detailValueClass}>{previewView.provider}</strong></div>
          <div class={valueCardClass}><span class={detailLabelClass}>Model</span><strong class={detailValueClass}>{previewView.model}</strong></div>
        </div>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-[6px]" aria-label="Generation settings">
          {#each previewView.details as detail (detail.label)}
            <div class={valueCardClass}><span class={detailLabelClass}>{detail.label}</span><strong class={detailValueClass}>{detail.value}</strong></div>
          {/each}
        </div>
        <section class="grid min-w-0 gap-[7px]" aria-labelledby="request-preview-prompt-heading">
          <h4 id="request-preview-prompt-heading" class={sectionHeadingClass}>Prompt</h4>
          {#if previewView.promptItems.length === 0}
            <p class={statusClass}>No prompt messages were captured.</p>
          {:else}
            {#each previewView.promptItems as item, index (`${index}:${item.role}`)}
              <article class="grid min-w-0 gap-[7px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-[9px]">
                <header class="flex min-w-0 items-center justify-between gap-[8px]">
                  <strong class="text-[9px] font-[650] text-[var(--foreground)] capitalize">{item.role}</strong>
                  {#if item.source}<span class="truncate text-[8px] text-[var(--muted-foreground)]">{item.source}</span>{/if}
                </header>
                {#if item.sections && item.sections.length > 0}
                  <div class="grid gap-[6px]">
                    {#each item.sections as section, sectionIndex (`${index}:${sectionIndex}:${section.name}`)}
                      <section class="grid min-w-0 gap-[5px] rounded-l-none rounded-r-[var(--radius)] border-l-2 border-[var(--primary)] bg-[var(--muted)] px-[8px] py-[7px]">
                        <h5 class={payloadHeadingClass}>{section.name}</h5>
                        <pre class={payloadClass}>{section.text}</pre>
                      </section>
                    {/each}
                  </div>
                {:else}
                  <pre class={payloadClass}>{item.text}</pre>
                {/if}
              </article>
            {/each}
          {/if}
        </section>
        <section class="grid min-w-0 gap-[7px]" aria-labelledby="request-preview-tools-heading">
          <h4 id="request-preview-tools-heading" class={sectionHeadingClass}>Tools available to the model <span class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[var(--muted)] text-[8px] text-[var(--muted-foreground)]">{previewView.tools.length}</span></h4>
          {#if previewView.tools.length === 0}
            <p class={statusClass}>No tools are available for this request.</p>
          {:else}
            <section class="accordion min-w-0 text-[9px]" data-multiple>
              {#each previewView.tools as tool, index (`${index}:${tool.name}`)}
                <details>
                  <summary class="flex items-center justify-between gap-[8px]"><span class="truncate">{tool.name}</span><ChevronDown size={13} strokeWidth={1.8} /></summary>
                  <section class="grid gap-[7px]">
                    {#if tool.description}<p class="text-[9px] leading-[1.45] text-[var(--muted-foreground)]">{tool.description}</p>{/if}
                    <h5 class={payloadHeadingClass}>Parameters</h5>
                    <pre class={`${payloadClass} max-h-[24vh] overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] p-[7px]`}>{JSON.stringify(tool.parameters, null, 2)}</pre>
                  </section>
                </details>
              {/each}
            </section>
          {/if}
        </section>
      </div>
    {/if}
  {:else}
    <p class={statusClass}>The assembled request will appear here.</p>
  {/if}
</div>
