<script lang="ts">
  import { ArrowRight, ArrowRightLeft, Check, ChevronDown, FileCode2, Globe, LoaderCircle, Pencil, Search, Terminal, Trash2, Wrench, X } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import { renderMarkdown } from '../markdown.js'
  import { toolPresentationLine, type ToolPresentationKind } from '../../shared/tool-presentation.js'
  import { shortenPaths } from '../lib/shorten-paths.js'
  import { isAbsolutePath } from '../../shared/path-guards.js'
  import type { ApprovalView, ToolCallView } from '../types.js'

  let { tool, onapprove, onopenfile }: {
    tool: ToolCallView
    onapprove: (outcome: 'allowed-once' | 'rejected') => void
    /** Opens the file a presenter located, when the call named exactly one. */
    onopenfile?: (path: string, line?: number) => void
  } = $props()

  /** The category a presenter declares picks the icon. The wrench stays for a tool
   * that declares no presenter, which is every MCP tool today. */
  const kindIcons: Record<ToolPresentationKind, Component> = {
    read: FileCode2, edit: Pencil, delete: Trash2, move: ArrowRightLeft, search: Search, execute: Terminal, fetch: Globe, other: Wrench,
  }
  const HeaderIcon = $derived(kindIcons[tool.presentation?.kind ?? 'other'])
  /** The tool's own words first, the model's description argument second. */
  const summaryLine = $derived(toolPresentationLine(tool.presentation) ?? tool.description)
  /** The same line for the screen: a long file path inside it is shortened from
   * the front, so the file name is what survives in the narrow panel. The full
   * line stays in the tooltip. */
  const summaryText = $derived(summaryLine === undefined ? undefined : shortenPaths(summaryLine))
  /** One file is an action: a click opens it. Several are a list to read.
   * A presenter hands back the model-facing path, and the Host opens only an
   * absolute path inside the folders that are open, so a relative path stays text. */
  const location = $derived(tool.presentation?.locations?.length === 1 ? tool.presentation.locations[0] : undefined)
  const openableLocation = $derived(location !== undefined && isAbsolutePath(location.path) ? location : undefined)

  const borderColor = $derived(tool.status === 'error'
    ? 'border-l-[var(--tool-failed-border)]'
    : tool.status === 'completed' ? 'border-l-[var(--tool-completed-border)]' : 'border-l-[#555]')
  const statusColor = $derived(tool.status === 'error' || tool.approval?.status === 'rejected'
    ? 'text-[#d4d4d4]'
    : (tool.status === 'preparing' || tool.status === 'running') && tool.approval?.status === undefined
      ? 'text-[#bcbcbc]' : 'text-[#858585]')

  function formatToolArguments(value: string): string {
    if (!value) return 'No arguments'
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }

  function toolStatusLabel(): string {
    if (tool.approval?.status === 'pending') return tool.approval.decisionPending ? 'sending' : 'approval'
    if (tool.approval?.status === 'allowed-once') return 'allowed once'
    if (tool.approval?.status === 'rejected') return 'denied'
    if (tool.approval?.status === 'cancelled') return 'cancelled'
    if (tool.approval?.status === 'unavailable') return 'unavailable'
    if (tool.status === 'preparing') return 'preparing'
    if (tool.status === 'running') return 'running'
    if (tool.status === 'error') return 'failed'
    return 'completed'
  }

  function approvalResultLabel(status: ApprovalView['status']): string {
    if (status === 'allowed-once') return 'Allowed once'
    if (status === 'rejected') return 'Denied'
    if (status === 'cancelled') return 'Cancelled'
    if (status === 'unavailable') return 'Unavailable'
    return 'Approval required'
  }
</script>

<details open={tool.approval?.status === 'pending'} class={`group/tool border-l pl-[10px] ${borderColor}`}>
  <summary class="group/summary flex flex-col items-start cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
    <div class="flex items-center gap-[6px]">
      <HeaderIcon class="flex-none" size={13} strokeWidth={1.7} />
      <span class="min-w-0 flex-[0_1_auto] truncate text-[#cfcfcf]">{tool.name}</span>
      <ArrowRight class="flex-none text-[#707070]" size={12} strokeWidth={1.7} />
      <span class={`inline-flex flex-none items-center gap-[4px] text-[10px] ${statusColor}`} aria-live="polite">
        {#if tool.status === 'preparing'}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={11} strokeWidth={1.8} aria-hidden="true" />{/if}
        {toolStatusLabel()}
      </span>
      <ChevronDown class="opacity-0 [transition:opacity_.18s_ease,transform_.15s_ease] group-hover/summary:opacity-100 group-focus-visible/summary:opacity-100 group-open/tool:rotate-180 motion-reduce:transition-none" size={13} strokeWidth={1.8} />
    </div>
      {#if summaryText}
        {#if openableLocation}
          <button class="mt-[2px] w-full min-w-0 truncate text-left text-[10px] leading-[1.35] text-[var(--muted-foreground)] hover:text-[var(--foreground)] [transition:color_.15s_ease] motion-reduce:transition-none" type="button" title={`Open ${openableLocation.path}`}
            onclick={(event) => { event.preventDefault(); event.stopPropagation(); onopenfile?.(openableLocation.path, openableLocation.line) }}>{summaryText}</button>
        {:else}
          <div class="mt-[2px] w-full min-w-0 truncate text-[10px] leading-[1.35] text-[var(--muted-foreground)]" title={summaryLine}>{summaryText}</div>
        {/if}
      {/if}
  </summary>
  <div class="mt-[8px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-[8px] [&>div+div]:mt-[10px] [&>div+div]:border-t [&>div+div]:border-[var(--border)] [&>div+div]:pt-[10px]">
    {#if tool.approval}
      <div class={tool.approval.status === 'pending' ? 'mx-[-2px] mt-[-2px] mb-[10px] rounded-[var(--radius)] border border-[var(--thinking-border)] bg-[var(--secondary)] p-[8px]' : undefined}>
        <div class="mb-[5px] text-[10px] tracking-[.08em] text-[#8f8f8f] uppercase">Permission</div>
        {#if tool.approval.reason}<div class="text-[var(--foreground)] leading-[1.45]">{tool.approval.reason}</div>{/if}
        {#if tool.approval.status === 'pending'}
          <div class="mt-[8px] flex flex-wrap gap-[6px]">
            <button class="btn inline-flex items-center gap-[5px]" data-variant="outline" data-size="xs" type="button" onclick={() => onapprove('allowed-once')} disabled={tool.approval.decisionPending}>
              <Check size={12} strokeWidth={1.8} /> Allow once
            </button>
            <button class="btn inline-flex items-center gap-[5px]" data-variant="destructive" data-size="xs" type="button" onclick={() => onapprove('rejected')} disabled={tool.approval.decisionPending}>
              <X size={12} strokeWidth={1.8} /> Deny
            </button>
          </div>
        {:else}
          <div class="text-[var(--muted-foreground)]">{approvalResultLabel(tool.approval.status)}</div>
        {/if}
      </div>
    {/if}
    {#if tool.status !== 'preparing'}
      <div>
        <div class="mb-[5px] text-[10px] tracking-[.08em] text-[#8f8f8f] uppercase">Arguments</div>
        <pre class="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap text-[10px] leading-[1.5] [overflow-wrap:anywhere] text-[#d0d0d0] [font-family:var(--vscode-editor-font-family,monospace)]">{formatToolArguments(tool.arguments)}</pre>
      </div>
    {:else}
      <div>Generating tool request…</div>
    {/if}
    {#if tool.result}
      <div>
        <div class="mb-[5px] text-[10px] tracking-[.08em] text-[#8f8f8f] uppercase">Result</div>
        <div class="markdown m-0 max-h-[220px] overflow-auto whitespace-pre-wrap! text-[11px] leading-[1.5]! [overflow-wrap:anywhere] text-[#d0d0d0] [font-family:inherit]">{@html renderMarkdown(tool.result)}</div>
      </div>
    {/if}
    {#if tool.meta}
      <div>
        <div class="mb-[5px] text-[10px] tracking-[.08em] text-[#8f8f8f] uppercase">Metadata</div>
        <pre class="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap text-[10px] leading-[1.5] [overflow-wrap:anywhere] text-[#d0d0d0] [font-family:var(--vscode-editor-font-family,monospace)]">{tool.meta}</pre>
      </div>
    {/if}
    {#if tool.error}
      <div>
        <div class="mb-[5px] text-[10px] tracking-[.08em] text-[#8f8f8f] uppercase">Error</div>
        <div class="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap text-[10px] leading-[1.5] [overflow-wrap:anywhere] text-[#d4d4d4] [font-family:var(--vscode-editor-font-family,monospace)]">{tool.error}</div>
      </div>
    {/if}
  </div>
</details>
