<script lang="ts">
  import { Copy, X } from '@lucide/svelte'
  import { JsonUIProvider, Renderer } from '@json-render/svelte'
  import { registry } from '../lib/gen-ui/registry'
  import UnknownBlock from '../lib/gen-ui/components/UnknownBlock.svelte'
  import { GEN_UI_ACTION_TEXT_LIMIT, type GenUiAction, type GenUiView } from '../../shared/gen-ui.js'

  interface Props {
    view: GenUiView
    onui: (action: GenUiAction) => void
  }

  let { view, onui }: Props = $props()

  const title = $derived(view.title ?? '')

  /**
   * The catalog's actions, wired to Helix. Params arrive already resolved from
   * state by json-render, so a button that reads `{"$state":"/form/note"}`
   * hands over the typed text. Every handler is thin on purpose: the card owns
   * no behaviour, the Host decides what an intent may do.
   */
  const handlers = {
    prompt: async (params: Record<string, unknown> | undefined) => textAction('prompt', params),
    inject: async (params: Record<string, unknown> | undefined) => textAction('inject', params),
    copy: async (params: Record<string, unknown> | undefined) => textAction('copy', params),
    openPath: async (params: Record<string, unknown> | undefined) => {
      const path = readText(params?.path)
      if (!path) return
      onui({ kind: 'openPath', path, ...(readText(params?.label) ? { label: readText(params?.label) } : {}) })
    },
    openLink: async (params: Record<string, unknown> | undefined) => {
      const url = readText(params?.url)
      if (!url) return
      onui({ kind: 'openLink', url, ...(readText(params?.label) ? { label: readText(params?.label) } : {}) })
    },
    dismiss: async () => { onui({ kind: 'dismiss' }) },
  }

  function textAction(kind: 'prompt' | 'inject' | 'copy', params: Record<string, unknown> | undefined): void {
    const text = readText(params?.text)
    if (text) onui({ kind, text })
  }

  // The Host re-checks every intent, including length. Bounding it here keeps
  // a card that read a huge value out of state from sending a wall of text.
  function readText(value: unknown): string {
    return typeof value === 'string' ? value.trim().slice(0, GEN_UI_ACTION_TEXT_LIMIT) : ''
  }
</script>

<section
  class="gen-ui-card"
  class:gen-ui-card--dismissed={view.status === 'dismissed'}
  role="group"
  aria-label={title || 'Helix card'}
  aria-hidden={view.status === 'dismissed'}
>
  <header class="gen-ui-card__head">
    <span class="gen-ui-card__title">{title || 'Helix card'}</span>
    {#if view.status !== 'dismissed'}
      <div class="gen-ui-card__tools">
        <button
          class="icon-button gen-ui-card__button"
          type="button"
          title="Copy the card's spec"
          aria-label="Copy the card's spec"
          onclick={() => onui({ kind: 'copy', text: JSON.stringify(view.spec, null, 2) })}
        >
          <Copy size={12} strokeWidth={1.7} />
        </button>
        <button
          class="icon-button gen-ui-card__button"
          type="button"
          title="Dismiss this card"
          aria-label="Dismiss this card"
          onclick={() => onui({ kind: 'dismiss' })}
        >
          <X size={12} strokeWidth={1.7} />
        </button>
      </div>
    {:else}
      <span class="gen-ui-card__dismissed">dismissed</span>
    {/if}
  </header>

  {#if view.status === 'failed'}
    <p class="gen-ui-card__error" role="status">{view.error ?? 'The card was rejected.'}</p>
  {:else}
    <div class="gen-ui-card__body" inert={view.status === 'dismissed'}>
      <JsonUIProvider {handlers} initialState={view.spec.state ?? {}}>
        <Renderer spec={view.spec} {registry} fallback={UnknownBlock} />
      </JsonUIProvider>
    </div>
  {/if}
</section>

<style>
  .gen-ui-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
  }

  .gen-ui-card--dismissed {
    opacity: .45;
  }

  .gen-ui-card__head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .gen-ui-card__title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: -.01em;
    color: var(--brand-gold);
  }

  .gen-ui-card__tools {
    display: flex;
    flex: none;
    gap: 2px;
  }

  .gen-ui-card__button {
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }

  .gen-ui-card__button:hover {
    background: var(--accent);
    color: var(--foreground);
  }

  .gen-ui-card__dismissed {
    flex: none;
    font-size: 10px;
    color: var(--muted-foreground);
  }

  .gen-ui-card__body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .gen-ui-card__error {
    margin: 0;
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    color: var(--tool-failed-border);
  }
</style>
