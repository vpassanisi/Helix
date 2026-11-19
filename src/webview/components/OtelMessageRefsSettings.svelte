<script lang="ts">
  import { Check } from '@lucide/svelte'
  import {
    OTEL_RESYNC_TRIGGERS,
    type OtelTracingResyncTrigger,
    type OtelTracingSettings,
  } from '../../shared/otel-tracing.js'

  interface Props {
    tracing: OtelTracingSettings
  }

  let { tracing = $bindable<OtelTracingSettings>() }: Props = $props()

  /** Trigger names are camelCase settings keys; the labels are what a reader sees. */
  const TRIGGER_LABELS: Record<OtelTracingResyncTrigger, string> = {
    userMessage: 'User message',
    promptSections: 'Prompt sections',
    toolSet: 'Tool set',
    route: 'Model route',
    compaction: 'Compaction',
    feedback: 'Feedback',
    splice: 'Inbox splice',
    seed: 'End seed',
    surfaceReplace: 'Surface replace',
    runtimeContext: 'Runtime context',
    turnRoot: 'Turn root',
    exportGap: 'Export gap',
    unknownEvent: 'Unknown event',
  }

  const MODE_HINTS: Record<OtelTracingSettings['inputMessagesMode'], string> = {
    full: 'Every span repeats the captured context. One dropped span loses that turn only, and most of a long prompt is destroyed by the byte cap.',
    refs: 'Each message publishes once per conversation, as a short content hash. A checkpoint span carries the full ordered list. Vendor dashboards show an empty prompt; a ref resolver rebuilds it from the conversation.',
    objects: 'Same refs as Refs, kept in schema-valid gen_ai message objects.',
    checkpoint: 'Checkpoint spans carry the full captured context; the spans between them carry refs only.',
    omit: 'The input messages attribute stays off. The ref attributes carry the context.',
  }

  let refsMode = $derived(tracing.inputMessagesMode !== 'full')
  let allTriggers = $derived(tracing.resyncOn.length === OTEL_RESYNC_TRIGGERS.length)

  /** Rebuilds the trigger list in the canonical order so the saved array stays stable. */
  function toggleTrigger(trigger: OtelTracingResyncTrigger, checked: boolean): void {
    const selected = new Set(tracing.resyncOn)
    if (checked) selected.add(trigger)
    else selected.delete(trigger)
    tracing = { ...tracing, resyncOn: OTEL_RESYNC_TRIGGERS.filter((name) => selected.has(name)) }
  }

  function setTriggers(checked: boolean): void {
    tracing = { ...tracing, resyncOn: checked ? [...OTEL_RESYNC_TRIGGERS] : [] }
  }
</script>

<fieldset class="m-0 min-w-0 border-0 border-t border-[var(--border)] p-0 pt-[8px]">
  <legend class="mb-[5px] text-[10px] font-semibold text-[var(--foreground)]">Message content refs</legend>

  <div class="grid gap-[9px]">
    <div class="grid gap-1.5 min-w-0" role="group">
      <label for="otel-input-messages-mode">Input messages</label>
      <select id="otel-input-messages-mode" class="select" bind:value={tracing.inputMessagesMode}>
        <option value="full">Full — repeat the context on every span</option>
        <option value="refs">Refs — publish each message once</option>
        <option value="objects">Objects — refs in schema-valid objects</option>
        <option value="checkpoint">Checkpoint — full context on checkpoint spans</option>
        <option value="omit">Omit — refs only, no attribute</option>
      </select>
      <small class="text-[var(--muted-foreground)] text-[9px] leading-[1.4]">{MODE_HINTS[tracing.inputMessagesMode]}</small>
    </div>

    {#if refsMode}
      <div class="grid gap-1.5 min-w-0" role="group">
        <label for="otel-ref-encoding">Ref encoding</label>
        <select id="otel-ref-encoding" class="select" bind:value={tracing.refEncoding}>
          <option value="base64url">Base64url — 8 characters per ref</option>
          <option value="hex">Hex — queryable string array</option>
        </select>
      </div>

      <div class="grid grid-cols-3 gap-[9px] [@media(max-width:360px)]:grid-cols-1">
        <div class="grid gap-1.5 min-w-0" role="group">
          <label for="otel-resync-cadence">Checkpoint every (spans)</label>
          <input id="otel-resync-cadence" class="input" type="number" min="0" max="100000" step="1" bind:value={tracing.maxSpansBetweenResyncs} />
        </div>
        <div class="grid gap-1.5 min-w-0" role="group">
          <label for="otel-ref-hash-length">Ref hash length</label>
          <input id="otel-ref-hash-length" class="input" type="number" min="8" max="16" step="1" bind:value={tracing.refHashLength} />
        </div>
        <div class="grid gap-1.5 min-w-0" role="group">
          <label for="otel-entry-max-bytes">Entry cap (bytes)</label>
          <input id="otel-entry-max-bytes" class="input" type="number" min="64" max="65536" step="64" bind:value={tracing.messageEntryMaxBytes} />
        </div>
        <div class="grid gap-1.5 min-w-0" role="group">
          <label for="otel-watermark-entries">Watermark entries</label>
          <input id="otel-watermark-entries" class="input" type="number" min="64" max="65536" step="64" bind:value={tracing.watermarkMaxEntries} />
        </div>
      </div>

      <div class="grid gap-1.5 min-w-0" role="group">
        <small class="text-[var(--muted-foreground)] text-[9px] leading-[1.4]">One user turn is one trace. Each entry publishes once, at its birth span; a checkpoint marks the full context in refs; the conversation's pooled traces rebuild any span's context.</small>
      </div>
    {/if}

    <div class="grid grid-cols-2 gap-x-[8px] gap-y-[6px] [@media(max-width:360px)]:grid-cols-1">
      {#if refsMode}
        <div class="grid gap-1.5" role="group" data-orientation="horizontal">
          <input id="otel-export-gap-resyncs" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.exportGapResyncs} />
          <label for="otel-export-gap-resyncs">Checkpoint after an export gap</label>
        </div>
      {/if}
      <div class="grid gap-1.5" role="group" data-orientation="horizontal">
        <input id="otel-capture-prompt-sections" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.captureSystemPromptSections} />
        <label for="otel-capture-prompt-sections">Prompt section refs</label>
      </div>
      <div class="grid gap-1.5" role="group" data-orientation="horizontal">
        <input id="otel-context-pointers" class="input h-[14px] w-[24px] min-w-0 flex-none p-0" type="checkbox" role="switch" data-size="sm" bind:checked={tracing.contextPointers} />
        <label for="otel-context-pointers">Session log pointers</label>
      </div>
    </div>

    {#if refsMode}
      <div class="grid gap-[6px] min-w-0" role="group" aria-label="Resync triggers">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] font-semibold text-[var(--foreground)]">Resync on</span>
          <span class="flex items-center gap-1">
            <button class="btn px-[6px] text-[9px]" data-variant="ghost" type="button" onclick={() => setTriggers(true)}>All</button>
            <button class="btn px-[6px] text-[9px]" data-variant="ghost" type="button" onclick={() => setTriggers(false)}>None</button>
          </span>
        </div>
        <div class="grid grid-cols-2 gap-x-[8px] gap-y-[6px] [@media(max-width:360px)]:grid-cols-1">
          {#each OTEL_RESYNC_TRIGGERS as trigger (trigger)}
            <div class="grid gap-1.5" role="group" data-orientation="horizontal">
              <input
                id={`otel-resync-${trigger}`}
                class="input h-[14px] w-[24px] min-w-0 flex-none p-0"
                type="checkbox"
                role="switch"
                data-size="sm"
                checked={tracing.resyncOn.includes(trigger)}
                onchange={(event) => toggleTrigger(trigger, (event.currentTarget as HTMLInputElement).checked)}
              />
              <label for={`otel-resync-${trigger}`}>{TRIGGER_LABELS[trigger]}</label>
            </div>
          {/each}
        </div>
        <small class="text-[var(--muted-foreground)] text-[9px] leading-[1.4]">
          {#if allTriggers}
            Every event trigger is on. A checkpoint lands on the earliest span the change allows, and each turn opens one.
          {:else}
            {tracing.resyncOn.length === 0
              ? 'No event triggers. The structural checks and session start still checkpoint, so the guarantee never depends on an event name.'
              : `${tracing.resyncOn.length} of ${OTEL_RESYNC_TRIGGERS.length} event triggers on. The structural checks and session start always checkpoint.`}
          {/if}
        </small>
      </div>
    {/if}

    {#if refsMode && tracing.captureSystemPromptSections && !tracing.capturePrompts}
      <small class="flex items-center gap-1 text-[var(--muted-foreground)] text-[9px] leading-[1.4]"><Check size={10} strokeWidth={1.8} /> Prompt section refs need Captured content → Prompts, otherwise no message is published.</small>
    {/if}
    {#if !refsMode}
      <small class="text-[var(--muted-foreground)] text-[9px] leading-[1.4]">Prompt section refs and session log pointers apply to the ref modes. The Max captured length setting caps this mode.</small>
    {/if}
  </div>
</fieldset>
